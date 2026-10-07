import type { RepoContext } from "../../core/repo-context.ts";
import { isCloud, type Cloud, type Insight, type InsightProvider, type Severity } from "../../core/types.ts";
import { parseJsonc } from "../../parse/jsonc.ts";
import { describeDrift, findCopyDrift, groupDrift, symlinkTarget } from "./copy-drift.ts";
import { configFacts, isConfigFactFile, type ConfigFact } from "./config-facts.ts";
import { keywordExtractor } from "./extract.ts";
import { effectiveRules, resolve, type Finding } from "./resolve.ts";
import { DEFAULT_ORDER, KIND_RANK, LAYER_KINDS, ranksFor, ruleEnv, validOrder, type Layer, type LayerKind, type PrecedenceOverride, type Rule, type RuleExtractor } from "./types.ts";

export const STACK_FILE = ".gitnext/stack.json";
export const isInstructionFile = (path: string) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * Collects the repo's instruction files (project layer) and the layers listed in its stack file. With an
 * admin-approved precedence override, every layer's rank comes from the override's order (explicit ranks in the stack
 * file are ignored, so an override can't be undone or bypassed by a repo-level edit).
 */
export async function collectLayers(files: RepoContext, repo: string, ref: string, override?: PrecedenceOverride | null): Promise<{ layers: Layer[]; errors: string[] }> {
	const errors: string[] = [];
	const ranks = override && validOrder(override.order) ? ranksFor(override.order) : KIND_RANK;
	const layers: Layer[] = (await files.find(repo, ref, isInstructionFile)).map((f) => {
		const dir = dirOf(f.path);
		return { name: dir || "root", kind: "project", rank: ranks.project, depth: dir ? dir.split("/").length : 0, repo, path: f.path, scopeDir: dir, origin: "project" };
	});
	const stackText = await files.readFile(repo, ref, STACK_FILE);
	if (stackText) {
		try {
			const stack = parseJsonc(stackText) as { layers?: { name: string; kind?: LayerKind; rank?: number; repo?: string; path: string; env?: Cloud }[] };
			for (const l of stack.layers ?? []) {
				const kind = l.kind ?? LAYER_KINDS[(l.rank ?? 0) - 1];
				if (!kind || !(kind in KIND_RANK)) {
					errors.push(`${STACK_FILE}: layer "${l.name}" needs a kind (${LAYER_KINDS.join("|")}) or a rank 1-5`);
					continue;
				}
				if (l.env !== undefined && !isCloud(l.env)) {
					errors.push(`${STACK_FILE}: layer "${l.name}" env must be one of cloudflare, gcp, aws, private`);
					continue;
				}
				layers.push({ name: l.name, kind, rank: override ? ranks[kind] : (l.rank ?? KIND_RANK[kind]), depth: 0, repo: l.repo ?? repo, path: l.path, scopeDir: "", origin: "stack", ...(l.env ? { env: l.env } : {}) });
			}
		} catch (err) {
			errors.push(`${STACK_FILE}: ${err}`);
		}
	}
	return { layers, errors };
}

export interface SkippedLayer {
	path: string;
	reason: "symlink" | "duplicate";
	/** The layer it points to or repeats. */
	of: string;
}

export interface LoadedStack {
	layers: Layer[];
	rules: Rule[];
	facts: ConfigFact[];
	/** Raw text per layer path, for callers that slice instruction files (e.g. the context provider). */
	texts: Map<Layer, string>;
	/** Project files not counted as layers: symlinks, and copies of a layer that already governs their directory. */
	skipped: SkippedLayer[];
	errors: string[];
}

const normalizePath = (path: string) => {
	const out: string[] = [];
	for (const seg of path.split("/")) seg === ".." ? out.pop() : seg && seg !== "." && out.push(seg);
	return out.join("/");
};
const covers = (dir: string, sub: string) => dir === "" || sub === dir || sub.startsWith(`${dir}/`);

/**
 * Drops project layers that add nothing: symlinks (`.claude/CLAUDE.md -> ../AGENTS.md`, read through the link or
 * as a link blob) and byte-identical copies of a layer whose scope already covers theirs. Identical files in
 * sibling directories stay: each governs its own files.
 */
export function dedupeLayers(layers: Layer[], texts: Map<Layer, string>): { kept: Layer[]; skipped: SkippedLayer[] } {
	const skipped: SkippedLayer[] = [];
	const seen: Layer[] = [];
	// Shallowest first, so a copy is compared against the layer that covers it.
	for (const l of [...layers].sort((a, b) => (a.origin === "project" ? a.depth : -1) - (b.origin === "project" ? b.depth : -1))) {
		const text = texts.get(l);
		if (l.origin === "project" && text != null) {
			const target = symlinkTarget(text);
			if (target) {
				skipped.push({ path: l.path, reason: "symlink", of: normalizePath(`${l.scopeDir}/${target}`) });
				continue;
			}
			const same = seen.find((k) => k.origin === "project" && texts.get(k) === text && covers(k.scopeDir, l.scopeDir));
			if (same) {
				skipped.push({ path: l.path, reason: "duplicate", of: same.path });
				continue;
			}
		}
		seen.push(l);
	}
	const order = (path: string) => layers.findIndex((l) => l.path === path);
	return { kept: layers.filter((l) => seen.includes(l)), skipped: skipped.sort((a, b) => order(a.path) - order(b.path)) };
}

/** Collects layers, reads them (stack layers in other repos at HEAD), extracts rules and reads config facts. */
export async function loadStack(files: RepoContext, repo: string, ref: string, extractor: RuleExtractor = keywordExtractor, override?: PrecedenceOverride | null): Promise<LoadedStack> {
	const { layers: collected, errors } = await collectLayers(files, repo, ref, override);
	const texts = new Map<Layer, string>();
	await Promise.all(
		collected.map(async (layer) => {
			const text = await files.readFile(layer.repo, layer.repo === repo ? ref : "HEAD", layer.path).catch((e) => {
				errors.push(`${layer.repo}/${layer.path}: ${e}`);
				return null;
			});
			if (text != null) texts.set(layer, text);
			else if (layer.origin === "stack") errors.push(`${layer.repo}/${layer.path}: layer not found`);
		}),
	);
	const { kept: layers, skipped } = dedupeLayers(collected, texts);
	for (const s of skipped) texts.delete(collected.find((l) => l.path === s.path && l.origin === "project")!);
	// Extract every layer in parallel (model-backed extraction makes this matter); keep layer order.
	const perLayer = await Promise.all(layers.map((layer) => (texts.has(layer) ? extractor.extract(layer, texts.get(layer)!) : [])));
	const rules: Rule[] = perLayer.flat();
	const factFiles = await files.find(repo, ref, isConfigFactFile);
	const facts = (await Promise.all(factFiles.map(async (f) => configFacts(f.path, (await files.readFile(repo, ref, f.path)) ?? "")))).flat();
	return { layers, rules, facts, texts, skipped, errors };
}

const SEVERITY: Record<Finding["kind"], Severity> = { overridden: "info", drift: "warn", conflict: "conflict" };

export interface StackProviderOptions {
	/** Admin-approved precedence override for a repo (stored outside the repo, e.g. in KV), with its audit trail. */
	precedence?: (repo: string) => Promise<{ override: PrecedenceOverride | null; audit: unknown[] } | null>;
}

export function instructionStackProvider(extractor: RuleExtractor = keywordExtractor, opts: StackProviderOptions = {}): InsightProvider {
	return {
		id: "instruction-stack",
		title: "Instruction stack",
		needs: ["tree", "files"],
		async analyze({ repo, ref, files }) {
			const prec = (await opts.precedence?.(repo).catch(() => null)) ?? null;
			const override = prec?.override && validOrder(prec.override.order) ? prec.override : null;
			const [{ layers, rules, facts, skipped, errors }, drift] = await Promise.all([loadStack(files, repo, ref, extractor, override), findCopyDrift(files, repo, ref).then(groupDrift)]);
			const findings = resolve(rules, facts);

			const insights: Insight[] = findings.map((f) => ({
				provider: "instruction-stack",
				severity: f.policyViolation && f.kind === "overridden" ? "warn" : SEVERITY[f.kind],
				scope: { repo, ref, path: f.rules[0].layer.path, ...(f.env ? { env: { cloud: f.env, ...(f.env !== "cloudflare" ? { mocked: true } : {}) } } : {}) },
				title: `${f.policyViolation ? "policy " : ""}${f.kind}: ${f.topic}${f.env ? ` (env ${f.env})` : ""}`,
				detail: f.explanation,
				evidence: [...f.rules.map((r) => ({ repo: r.layer.repo, path: r.layer.path, line: r.line })), ...(f.fact ? [{ repo, path: f.fact.path }] : [])],
				metrics: { kind: f.kind, topic: f.topic, ...(f.policyViolation ? { policyViolation: true } : {}), ...(f.env ? { env: f.env } : {}), values: f.rules.map((r) => ({ value: r.value, strength: r.strength, layer: r.layer.name, kind: r.layer.kind, rank: r.layer.rank, path: r.layer.path, line: r.line, text: r.text, ...(ruleEnv(r) ? { env: ruleEnv(r) } : {}) })), ...(f.fact ? { configValue: f.fact.value } : {}) },
			}));
			// Instruction files and skills meant to be copies that no longer match their source.
			for (const g of drift) {
				const [lead] = g.files;
				insights.push({
					provider: "instruction-stack",
					severity: "warn",
					scope: { repo, ref, path: lead.source },
					title: `drift: copies of ${g.unit}`,
					detail: describeDrift(g),
					evidence: [{ repo, path: lead.source, ...(lead.onlyInSource ? { line: lead.onlyInSource.line } : {}) }, ...lead.stale.map((path) => ({ repo, path, ...(lead.onlyInCopy?.path === path ? { line: lead.onlyInCopy.line } : {}) }))],
					metrics: { kind: "drift", topic: "copies", ...g },
				});
			}
			insights.unshift({
				provider: "instruction-stack",
				severity: errors.length ? "warn" : "info",
				scope: { repo, ref },
				title: `Instruction stack: ${layers.length} layers, ${rules.length} rules${override ? " (precedence overridden)" : ""}`,
				detail: errors.length
					? `Errors: ${errors.join("; ")}`
					: `Extractor ${extractor.id}; ${findings.length} findings.${skipped.length ? ` Skipped ${skipped.length} file(s) that repeat a layer: ${skipped.map((s) => `${s.path} (${s.reason} of ${s.of})`).join(", ")}.` : ""}`,
				evidence: layers.map((l) => ({ repo: l.repo, path: l.path })),
				metrics: {
					extractor: extractor.id,
					layers: layers.map((l) => ({ name: l.name, kind: l.kind, rank: l.rank, depth: l.depth, repo: l.repo, path: l.path, origin: l.origin, ...(l.env ? { env: l.env } : {}) })),
					// Rules each layer contributes, so the dashboard can show how much of the stack comes from where.
					// Layer order in force, and any admin override with its audit trail (always shown in the UI).
					precedence: {
						order: override?.order ?? DEFAULT_ORDER,
						overridden: !!override,
						...(override ? { by: override.by, at: override.at, reason: override.reason, note: `${override.order.join(" › ")} (set by ${override.by}: ${override.reason})` } : {}),
						audit: prec?.audit ?? [],
					},
					// How each layer was read: by the model, from cache, or by the keyword fallback.
					extraction: Object.fromEntries(layers.map((l) => [`${l.repo}:${l.path}`, extractor.describe?.(l.path) ?? { source: "keyword" }])),
					rulesPerLayer: Object.fromEntries([...Map.groupBy(rules, (r) => `${r.layer.repo}:${r.layer.path}`)].map(([k, rs]) => [k, rs.length])),
					rulesByTopic: Object.fromEntries([...Map.groupBy(rules, (r) => r.topic)].map(([t, rs]) => [t, [...new Set(rs.map((r) => r.value))]])),
					// Winning rule per topic at the repo root and in each directory with its own instruction file.
					effective: Object.fromEntries(
						["", ...new Set(layers.filter((l) => l.scopeDir).map((l) => l.scopeDir))].map((dir) => [
							dir || ".",
							effectiveRules(rules, dir).map((r) => ({ topic: r.topic, value: r.value, strength: r.strength, layer: r.layer.name, kind: r.layer.kind, path: r.layer.path, line: r.line })),
						]),
					),
					skippedLayers: skipped,
					counts: { ...Object.fromEntries([...Map.groupBy(findings, (f) => f.kind)].map(([k, fs]) => [k, fs.length])), ...(drift.length ? { copyDrift: drift.length } : {}) },
				},
			});
			return insights;
		},
	};
}
