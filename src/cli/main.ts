import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { RepoContext, overlayFiles, type RepoSource } from "../core/repo-context.ts";
import type { Insight } from "../core/types.ts";
import { buildContext } from "../providers/context/index.ts";
import { costProvider, fixtureCostSource, usd } from "../providers/cost/index.ts";
import { gatewayLogsSource, type CostSource } from "../providers/cost/logs.ts";
import type { RollupNode } from "../providers/cost/rollup.ts";
import { STACK_FILE, loadStack } from "../providers/instruction-stack/index.ts";
import { effectiveRules, resolve, type Finding } from "../providers/instruction-stack/resolve.ts";
import type { Rule } from "../providers/instruction-stack/types.ts";
import { resourceMapProvider } from "../providers/resource-map.ts";
import { USAGE, UsageError, parseArgs, type ParsedArgs } from "./args.ts";
import { WORKTREE, localSource } from "./git-source.ts";

export interface CliIo {
	cwd: string;
	out: (text: string) => void;
	err: (text: string) => void;
	env?: Record<string, string | undefined>;
	fetcher?: typeof fetch;
	/** .dev.vars files to read for the gateway token (default: git-next's own, then the cwd's). */
	devVarsFiles?: string[];
}

/** Exit codes: 0 clean, 1 findings that should block (conflicts, --strict additions), 2 usage or runtime error. */
export const EXIT = { ok: 0, findings: 1, error: 2 } as const;

const GATEWAY_ID = "git-next";
const PACKAGE_ROOT = resolvePath(dirname(new URL(import.meta.url).pathname), "../..");

export async function runCli(argv: string[], io: CliIo): Promise<number> {
	let args: ParsedArgs;
	try {
		args = parseArgs(argv);
	} catch (err) {
		if (err instanceof UsageError) {
			io.err(`git next: ${err.message}\n\n${USAGE}`);
			return EXIT.error;
		}
		throw err;
	}
	try {
		switch (args.command) {
			case "help":
				io.out(USAGE);
				return EXIT.ok;
			case "rules":
				return await rulesCommand(args, io);
			case "resources":
				return await resourcesCommand(args, io);
			case "context":
				return await contextCommand(args, io);
			case "cost":
				return await costCommand(args, io);
		}
	} catch (err) {
		io.err(`git next ${args.command}: ${err instanceof Error ? err.message : String(err)}\n`);
		return EXIT.error;
	}
}

// ── Local repo access ─────────────────────────────────────────────────────────

/** Name used for the working tree in output and as the RepoContext repo key. */
const localRepoName = (cwd: string) => basename(gitTopLevel(cwd));
function gitTopLevel(cwd: string): string {
	let dir = resolvePath(cwd);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		dir = dirname(dir);
	}
	return resolvePath(cwd);
}

/** Maps the "HEAD" ref used for other-repo layers onto a directory's working tree. */
const worktreeAtHead = (source: RepoSource): RepoSource => ({ ...source, listFiles: (ref) => source.listFiles(ref === "HEAD" ? WORKTREE : ref) });

/**
 * RepoContext over the working tree. `--layers <stack.json>` overlays that stack file and serves the layer
 * files it names from the stack's project directory (the folder holding `.gitnext/`, else the file's folder).
 */
function localContext(args: ParsedArgs, io: CliIo): { files: RepoContext; repo: string; ref: string } {
	const root = gitTopLevel(io.cwd);
	const repo = localRepoName(io.cwd);
	let target = localSource(root);
	let layersDir: string | undefined;
	if (args.layers) {
		const stackPath = resolvePath(io.cwd, args.layers);
		if (!existsSync(stackPath)) throw new Error(`--layers: ${args.layers} not found`);
		target = overlayFiles(target, { [STACK_FILE]: readFileSync(stackPath, "utf8") });
		const folder = dirname(stackPath);
		layersDir = basename(folder) === ".gitnext" ? dirname(folder) : folder;
	}
	const layerSource = layersDir ? worktreeAtHead(localSource(layersDir)) : undefined;
	const files = new RepoContext(async (name) => {
		if (name === repo) return target;
		if (layerSource) return layerSource;
		throw new Error(`layer repo "${name}" is not available locally (pass --layers <stack.json>)`);
	});
	return { files, repo, ref: args.ref ?? WORKTREE };
}

async function remoteInsights(args: ParsedArgs, io: CliIo, providers: string, extra: Record<string, string> = {}): Promise<Insight[]> {
	const qs = new URLSearchParams({ repo: args.remote!, ref: args.ref ?? "main", providers, ...extra, ...(args.layers === "demo" ? { layers: "demo" } : {}) });
	const res = await (io.fetcher ?? fetch)(`${args.workerUrl}/insights?${qs}`);
	const body = (await res.json()) as { insights?: Insight[]; error?: string; providers?: { id: string; ok: boolean; error?: string }[] };
	if (!res.ok || body.error) throw new Error(`Worker /insights: ${body.error ?? res.status}`);
	const failed = body.providers?.find((p) => !p.ok);
	if (failed) throw new Error(`provider ${failed.id} failed: ${failed.error}`);
	return body.insights ?? [];
}

// ── rules ─────────────────────────────────────────────────────────────────────

interface RuleRow {
	topic: string;
	value: string;
	strength: string;
	kind: string;
	layer: string;
	source: string;
}
interface RulesReport {
	repo: string;
	ref: string;
	layers: { rank: number; depth: number; kind: string; name: string; source: string }[];
	winners: { path: string; rules: RuleRow[] }[];
	conflicts: { topic: string; explanation: string; evidence: string[] }[];
	warnings: { topic: string; kind: string; explanation: string; evidence: string[] }[];
	overrides: { topic: string; explanation: string; evidence: string[] }[];
	errors: string[];
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const governs = (dir: string, p: string) => dir === "" || p === dir || p.startsWith(`${dir}/`);
const reaches = (r: Rule, p: string) => governs(r.layer.scopeDir, p) && (!r.areas || r.areas.includes(p.split("/")[0]));
const loc = (repo: string) => (r: Rule) => `${r.layer.repo === repo ? "" : `${r.layer.repo}:`}${r.layer.path}:${r.line}`;

async function rulesReport(args: ParsedArgs, io: CliIo): Promise<RulesReport> {
	if (args.remote) return remoteRulesReport(args, io);
	const { files, repo, ref } = localContext(args, io);
	const stack = await loadStack(files, repo, ref);
	const findings = resolve(stack.rules, stack.facts);
	const where = loc(repo);
	const root = gitTopLevel(io.cwd);
	// Paths are taken relative to the repo root; a directory argument means "files in that directory".
	const paths = args.positionals.map((p) => resolvePath(io.cwd, p).slice(root.length + 1));
	const inScope = (f: Finding) => !paths.length || paths.some((p) => f.rules.every((r) => reaches(r, p)) && (!f.fact || governs(f.fact.dir, p) || governs(dirOf(p), f.fact.dir)));
	const ev = (f: Finding) => [...f.rules.map(where), ...(f.fact ? [f.fact.path] : [])];
	const row = (r: Rule): RuleRow => ({ topic: r.topic, value: r.value, strength: r.strength, kind: r.layer.kind, layer: r.layer.name, source: where(r) });
	const winnerPaths = paths.length ? paths : [""];
	return {
		repo,
		ref,
		layers: [...stack.layers].sort((a, b) => a.rank - b.rank || a.depth - b.depth).map((l) => ({ rank: l.rank, depth: l.depth, kind: l.kind, name: l.name, source: `${l.repo === repo ? "" : `${l.repo}:`}${l.path}` })),
		winners: winnerPaths.map((p) => ({ path: p || ".", rules: effectiveRules(stack.rules, isDirLike(root, p) ? p : dirOf(p)).map(row) })),
		conflicts: findings.filter((f) => f.kind === "conflict" && inScope(f)).map((f) => ({ topic: f.topic, explanation: f.explanation, evidence: ev(f) })),
		warnings: findings
			.filter((f) => (f.kind === "drift" || (f.policyViolation && f.kind === "overridden")) && inScope(f))
			.map((f) => ({ topic: f.topic, kind: f.kind === "drift" ? "drift" : "policy", explanation: f.explanation, evidence: ev(f) })),
		overrides: findings.filter((f) => f.kind === "overridden" && !f.policyViolation && inScope(f)).map((f) => ({ topic: f.topic, explanation: f.explanation, evidence: ev(f) })),
		errors: stack.errors,
	};
}

/** A path argument that is an existing directory means "files in that directory"; anything else is a file path. */
const isDirLike = (root: string, p: string) => p === "" || (existsSync(join(root, p)) && statSync(join(root, p)).isDirectory());

async function remoteRulesReport(args: ParsedArgs, io: CliIo): Promise<RulesReport> {
	const insights = await remoteInsights(args, io, "instruction-stack");
	const summary = insights.find((i) => i.title.startsWith("Instruction stack"));
	const m = (summary?.metrics ?? {}) as any;
	const effective: Record<string, any[]> = m.effective ?? {};
	// The Worker reports winners per directory that has its own instruction file; use the nearest one.
	const nearest = (p: string) => Object.keys(effective).filter((d) => d === "." || governs(d, p)).sort((a, b) => b.length - a.length)[0] ?? ".";
	const ev = (i: Insight) => i.evidence.map((e) => `${e.repo === args.remote ? "" : `${e.repo}:`}${e.path}${e.line ? `:${e.line}` : ""}`);
	const kindOf = (i: Insight) => (i.metrics as any)?.kind as string;
	const paths = args.positionals.length ? args.positionals : ["."];
	return {
		repo: args.remote!,
		ref: args.ref ?? "main",
		layers: (m.layers ?? []).sort((a: any, b: any) => a.rank - b.rank || a.depth - b.depth).map((l: any) => ({ rank: l.rank, depth: l.depth, kind: l.kind, name: l.name, source: `${l.repo === args.remote ? "" : `${l.repo}:`}${l.path}` })),
		winners: paths.map((p) => ({ path: p, rules: (effective[nearest(p)] ?? []).map((r: any) => ({ topic: r.topic, value: r.value, strength: r.strength, kind: r.kind, layer: r.layer, source: `${r.path}:${r.line}` })) })),
		conflicts: insights.filter((i) => kindOf(i) === "conflict").map((i) => ({ topic: (i.metrics as any).topic, explanation: i.detail, evidence: ev(i) })),
		warnings: insights.filter((i) => i !== summary && i.severity === "warn").map((i) => ({ topic: (i.metrics as any).topic, kind: kindOf(i) === "drift" ? "drift" : "policy", explanation: i.detail, evidence: ev(i) })),
		overrides: insights.filter((i) => kindOf(i) === "overridden" && i.severity === "info").map((i) => ({ topic: (i.metrics as any).topic, explanation: i.detail, evidence: ev(i) })),
		errors: summary?.severity === "warn" ? [summary.detail] : [],
	};
}

async function rulesCommand(args: ParsedArgs, io: CliIo): Promise<number> {
	const report = await rulesReport(args, io);
	const code = report.conflicts.length ? EXIT.findings : EXIT.ok;
	if (args.json) {
		io.out(`${JSON.stringify({ ...report, exitCode: code }, null, 2)}\n`);
		return code;
	}
	const lines: string[] = [];
	if (!args.quiet) {
		lines.push(`Instruction stack for ${report.repo}${report.ref === WORKTREE ? " (working tree)" : `@${report.ref}`}: ${report.layers.length} layers`);
		lines.push("  rank  layer                                   file");
		for (const l of report.layers) lines.push(`  ${`${l.rank}${l.kind === "project" ? `.${l.depth}` : ""}`.padEnd(5)} ${`${l.kind} ${l.name}`.padEnd(39)} ${l.source}`);
		for (const w of report.winners) {
			lines.push("", `Winning rules for ${w.path}`);
			if (!w.rules.length) lines.push("  (none)");
			for (const r of w.rules) lines.push(`  ${r.topic.padEnd(16)} ${`${r.value}${r.strength === "must" ? " (must)" : ""}`.padEnd(38)} ${r.kind.padEnd(8)} ${r.source}`);
		}
	}
	if (report.conflicts.length) {
		lines.push("", `Conflicts (${report.conflicts.length})`);
		for (const c of report.conflicts) lines.push(`  ✗ ${c.topic}: ${c.explanation}`);
	}
	if (report.warnings.length) {
		lines.push("", `Warnings (${report.warnings.length})`);
		for (const w of report.warnings) lines.push(`  ! ${w.kind} ${w.topic}: ${w.explanation}`);
	}
	if (report.overrides.length && !args.quiet) {
		lines.push("", `Overrides (${report.overrides.length})${args.verbose ? "" : " — higher layers win; --verbose to list"}`);
		if (args.verbose) for (const o of report.overrides) lines.push(`  · ${o.topic}: ${o.explanation}`);
	}
	for (const e of report.errors) lines.push("", `  error: ${e}`);
	if (!args.quiet || code) lines.push("", code ? `✗ ${report.conflicts.length} conflict(s)` : "✓ no conflicts");
	const text = lines.join("\n").replace(/^\n+/, "");
	if (text) io.out(`${text}\n`);
	return code;
}

// ── resources ─────────────────────────────────────────────────────────────────

async function resourcesCommand(args: ParsedArgs, io: CliIo): Promise<number> {
	let insights: Insight[];
	let repo: string;
	if (args.remote) {
		insights = await remoteInsights(args, io, "resource-map", args.base ? { base: args.base } : {});
		repo = args.remote;
	} else {
		const ctx = localContext(args, io);
		repo = ctx.repo;
		insights = await resourceMapProvider.analyze({ repo, ref: ctx.ref, base: args.base, files: ctx.files });
	}
	const workers = insights.map((i) => {
		const m = (i.metrics ?? {}) as any;
		return { worker: m.worker ?? i.title, path: i.scope.path ?? "", bindings: m.bindings ?? {}, diff: m.diff, newConfig: !!m.newConfig, removedConfig: i.title.includes("config removed"), error: i.title.startsWith("Could not parse") ? i.detail : undefined };
	});
	const added = workers.reduce((n, w) => n + (w.diff?.added.length ?? 0), 0);
	const removed = workers.reduce((n, w) => n + (w.diff?.removed.length ?? 0), 0);
	const code = args.strict && added > 0 ? EXIT.findings : EXIT.ok;
	if (args.json) {
		io.out(`${JSON.stringify({ repo, base: args.base ?? null, added, removed, workers, exitCode: code }, null, 2)}\n`);
		return code;
	}
	const changed = (w: (typeof workers)[number]) => w.removedConfig || (w.diff && (w.diff.added.length || w.diff.removed.length));
	const shown = args.quiet || (args.base && !args.verbose) ? workers.filter(changed) : workers;
	const lines = [`${workers.length} Worker configs in ${repo}${args.base ? `; vs ${args.base}: +${added} −${removed} bindings` : ""}`];
	for (const w of shown) {
		const counts = Object.entries(w.bindings as Record<string, unknown[]>).map(([t, bs]) => `${t}:${bs.length}`).join(" ");
		const badge = w.removedConfig ? "[removed]" : w.newConfig ? "[new]" : w.diff ? `[+${w.diff.added.length} −${w.diff.removed.length}]` : "";
		lines.push(`  ${String(w.worker).padEnd(36)} ${badge.padEnd(10)} ${w.path}${counts ? `  ${counts}` : ""}${w.error ? `  ! ${w.error}` : ""}`);
		if (args.verbose && w.diff) {
			for (const b of w.diff.added) lines.push(`      + ${b.type} ${b.name}${b.resource ? ` → ${b.resource}` : ""}`);
			for (const b of w.diff.removed) lines.push(`      − ${b.type} ${b.name}${b.resource ? ` → ${b.resource}` : ""}`);
		}
	}
	if (args.base && !args.verbose && !args.quiet) lines.push(`  (${workers.length - shown.length} unchanged; --verbose to list all with binding changes)`);
	if (code) lines.push(`✗ --strict: ${added} binding(s) added vs ${args.base}`);
	io.out(`${lines.join("\n")}\n`);
	return code;
}

// ── context ───────────────────────────────────────────────────────────────────

async function contextCommand(args: ParsedArgs, io: CliIo): Promise<number> {
	const [task, ...paths] = args.positionals;
	let ctx: Awaited<ReturnType<typeof buildContext>>;
	if (args.remote) {
		const res = await (io.fetcher ?? fetch)(`${args.workerUrl}/context`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repo: args.remote, ref: args.ref ?? "main", task, paths, budgetTokens: args.budget, ...(args.layers === "demo" ? { layers: "demo" } : {}) }),
		});
		const body = (await res.json()) as any;
		if (!res.ok || body.error) throw new Error(`Worker /context: ${body.error ?? res.status}`);
		ctx = body;
	} else {
		const local = localContext(args, io);
		const root = gitTopLevel(io.cwd);
		ctx = await buildContext(local.files, { repo: local.repo, ref: local.ref, task, paths: paths.map((p) => resolvePath(io.cwd, p).slice(root.length + 1)), budgetTokens: args.budget });
	}
	if (args.json) {
		io.out(`${JSON.stringify(ctx, null, 2)}\n`);
		return EXIT.ok;
	}
	const s = ctx.stats;
	const lines = [`Context for "${task}"${ctx.paths.length ? ` (${ctx.paths.join(", ")})` : ""}: ${s.tokensServed} of ${args.budget} tokens`, ""];
	lines.push("Rules");
	for (const r of ctx.rules) lines.push(`  ${r.topic.padEnd(16)} ${`${r.value}${r.strength === "must" ? " (must)" : ""}`.padEnd(38)} ${r.kind.padEnd(8)} ${r.source.replace(`${ctx.repo}/`, "")}`);
	for (const c of ctx.conflicts) lines.push(`  ✗ ${c.topic}: ${c.explanation}`);
	lines.push("", `Sections (${ctx.sections.length})`);
	for (const x of ctx.sections) lines.push(`  ${`${x.path}:${x.startLine}`.padEnd(52)} ${(x.headings.at(-1) ?? "").slice(0, 48).padEnd(48)} ${String(x.tokens).padStart(5)} tok`);
	lines.push("", `Omitted ${ctx.omitted.count} matching sections (${ctx.omitted.tokens} tokens, ${ctx.omitted.oversized} oversized). All markdown: ${s.tokensAllMarkdown} tokens in ${s.markdownFiles} files; instruction files on these paths: ${s.tokensInstructionFilesOnPath}.`);
	if (args.print) for (const x of ctx.sections) lines.push("", `--- ${x.path}:${x.startLine} ---`, x.text);
	io.out(`${lines.join("\n")}\n`);
	return EXIT.ok;
}

// ── cost ──────────────────────────────────────────────────────────────────────

/** Reads KEY=VALUE pairs from a .dev.vars-style file. Values are never printed. */
export function readDevVars(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const out: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (m && m[2]) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
	}
	return out;
}

function costSource(io: CliIo): CostSource {
	const env = io.env ?? {};
	const files = io.devVarsFiles ?? [join(PACKAGE_ROOT, ".dev.vars"), join(io.cwd, ".dev.vars")];
	const vars = { ...Object.assign({}, ...files.map(readDevVars)), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) } as Record<string, string>;
	if (vars.CF_ACCOUNT_ID && vars.AIG_LOGS_TOKEN) return gatewayLogsSource({ accountId: vars.CF_ACCOUNT_ID, gatewayId: GATEWAY_ID, token: vars.AIG_LOGS_TOKEN, fetcher: io.fetcher });
	return fixtureCostSource();
}

async function costCommand(args: ParsedArgs, io: CliIo): Promise<number> {
	let insights: Insight[];
	const repo = args.remote ?? args.repo ?? localRepoName(io.cwd);
	if (args.remote) {
		insights = await remoteInsights(args, io, "cost");
	} else {
		const base = costSource(io);
		const source: CostSource = args.fork ? { id: base.id, records: async (f) => (await base.records(f)).filter((r) => r.fork === args.fork) } : base;
		insights = await costProvider(source).analyze({ repo, ref: "main", files: new RepoContext(async () => ({ listFiles: async () => [], readBlob: async () => null, log: async () => [] })) });
	}
	if (args.json) {
		io.out(`${JSON.stringify({ repo, fork: args.fork ?? null, insights }, null, 2)}\n`);
		return EXIT.ok;
	}
	const summary = insights.find((i) => i.title.startsWith("AI spend"));
	if (!summary) {
		io.out(args.fork ? `No AI Gateway usage for fork ${args.fork} in ${repo}.\n` : `${insights[0]?.title ?? "No cost data"}${insights[0]?.detail ? ` — ${insights[0].detail}` : ""}\n`);
		return EXIT.ok;
	}
	const m = summary.metrics as any;
	const lines = [`${summary.title} for ${repo}${args.fork ? ` (fork ${args.fork})` : ""} — source ${m.source}`, `  ${summary.detail}`, "", "By agent"];
	for (const a of m.agents) lines.push(`  ${a.agent.padEnd(20)} ${usd(a.cost).padStart(10)}  ${String(a.requests).padStart(4)} req  ${a.models.join(", ")}`);
	const flags = insights.filter((i) => i.severity === "warn");
	if (flags.length) lines.push("", "Flags", ...flags.map((f) => `  ! ${f.title} — ${f.detail}`));
	const fits = insights.filter((i) => i.title.startsWith("Model fit"));
	if (fits.length) lines.push("", "Model fit", ...fits.map((f) => `  → ${f.title.replace("Model fit: ", "")}: save ${usd((f.metrics as any).estimatedSaving)} (${(f.metrics as any).requests} req)`));
	if (args.verbose) {
		lines.push("", "Rollup");
		const walk = (n: RollupNode, depth: number) => {
			lines.push(`  ${"  ".repeat(depth)}${n.level} ${n.key}: ${usd(n.cost)} · ${n.requests} req · ${n.tokensIn}/${n.tokensOut} tok`);
			for (const c of n.children) walk(c, depth + 1);
		};
		for (const n of m.rollup) walk(n, 0);
	}
	io.out(`${lines.join("\n")}\n`);
	return EXIT.ok;
}
