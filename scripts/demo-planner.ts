// Demo: a planner and workers. Claude Fable 5.1 (approved in the org catalog for planning only) reads the goal,
// the resolved rules and the catalog, and writes a plan for three worker slots. Three Claude Sonnet 5.5 workers
// then carry it out in parallel, each on a clone of its existing fork (agents-demo-docs / -r2 / -mcp): sliced
// context, one gateway call, edits, a commit, and a push through the fail-closed pre-push hook.
//
// Local only: forks are cloned with short-lived read tokens (env vars only) and pushed to LOCAL bare remotes, so
// nothing is created or pushed on Cloudflare. If Fable refuses or errors, the planner falls back to Claude Opus 5.5.
// Every call carries developer/repo/fork/agent/task metadata; spend is capped (default $0.50) across all runs.
//
// Needs the local Worker (`npm run dev`) and .dev.vars. Usage:
//   node scripts/demo-planner.ts [--worker-url http://localhost:5173] [--budget-usd 0.5] [--keep] [--reuse-plan --only docs-agent,…] [--recheck-pushes]
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { catalogSummary, parseCatalog } from "../src/providers/catalog.ts";
import { AGENTS, DEMO_LAYERS, RESOLVED_LAYERS, type AgentSpec } from "./agent-specs.ts";
import { applyEdits, estimateUsd, gatewaySource, gatewaySpend, parseEdits, workerPost } from "./agent-lib.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const GATEWAY_ID = "git-next";
const PLANNER = "anthropic/claude-fable-5.1";
const PLANNER_FALLBACK = "anthropic/claude-opus-5.5";
const WORKER = "anthropic/claude-sonnet-5.5";
const RUN_TAG = "planner"; // task ids end in "#planner-…", which is how the budget finds earlier runs
const GOAL =
	"Improve agents-demo-full in three independent, reviewable changes: make one confusing passage in the MCP docs clearer, add a minimal server-only example that stores uploads in R2, and tighten the doc comments in the MCP abort helpers without changing behaviour.";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const WORKER_URL = opt("--worker-url", "http://localhost:5173");
const BUDGET_USD = Number(opt("--budget-usd", "0.5"));
const KEEP = argv.includes("--keep");
/** Re-run workers against the plan saved in samples/demo-run-planner/summary.json (no new planner call). */
const REUSE_PLAN = argv.includes("--reuse-plan");
const ONLY = argv.includes("--only") ? opt("--only", "").split(",") : null;
const WORKDIR = join(tmpdir(), "git-next-demo-planner");

const redact = (s: string) => s.replace(/Bearer\s+\S+/g, "Bearer ***").replace(/https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net/g, "https://<account>.artifacts.cloudflare.net").replaceAll(ROOT, "<git-next>").replaceAll(WORKDIR, "<workdir>");
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const post = <T>(path: string, body: unknown) => workerPost<T>(WORKER_URL, path, body);

async function cli(cwd: string, args: string[]) {
	let out = "";
	const code = await runCli(args, { cwd, out: (t) => (out += t), err: (t) => (out += t), env: {} });
	return { code, out };
}

interface PlanItem {
	agent: string;
	taskLabel: "docs" | "feature" | "refactor";
	task: string;
	paths: string[];
	instructions: string;
	acceptance: string;
}

/** Keeps the planner to the three slots, their labels and their allowed paths; anything else fails the run. */
function validatePlan(raw: unknown): PlanItem[] {
	const plan = (raw as { plan?: unknown })?.plan;
	if (!Array.isArray(plan) || plan.length !== AGENTS.length) throw new Error(`planner must return exactly ${AGENTS.length} plan items`);
	return AGENTS.map((spec) => {
		const item = plan.find((p: any) => p?.agent === spec.name) as PlanItem | undefined;
		if (!item) throw new Error(`plan has no item for ${spec.name}`);
		if (!["docs", "feature", "refactor"].includes(item.taskLabel)) throw new Error(`${spec.name}: taskLabel must be docs, feature or refactor`);
		if (typeof item.task !== "string" || typeof item.instructions !== "string" || !Array.isArray(item.paths) || !item.paths.length) throw new Error(`${spec.name}: plan item needs task, instructions and paths`);
		for (const p of item.paths) if (typeof p !== "string" || p.includes("..") || !spec.allowed.some((a) => p.startsWith(a))) throw new Error(`${spec.name}: path outside its slot: ${p}`);
		return { ...item, task: item.task.slice(0, 300), instructions: item.instructions.slice(0, 1500), acceptance: String(item.acceptance ?? "").slice(0, 500) };
	});
}

async function llm(model: string, system: string, prompt: string, maxTokens: number, metadata: Record<string, string>) {
	return post<{ model: string; text: string; usage: any; stopReason: string | null }>("/dev/llm", { model, system, prompt, maxTokens, metadata });
}

// ── --recheck-pushes: redo the pushes through the hook on kept clones (no model calls) ──

if (argv.includes("--recheck-pushes")) {
	const path = join(ROOT, "samples/demo-run-planner/summary.json");
	const summary = JSON.parse(readFileSync(path, "utf8"));
	mkdirSync(join(WORKDIR, "bin"), { recursive: true });
	rmSync(join(WORKDIR, "bin/git-next"), { force: true });
	symlinkSync(join(ROOT, "bin/git-next.ts"), join(WORKDIR, "bin/git-next"));
	for (const w of summary.workers) {
		const spec = AGENTS.find((a) => a.name === w.agent)!;
		const dir = join(WORKDIR, spec.fork);
		const remote = join(WORKDIR, `${spec.fork}-local.git`);
		if (!existsSync(dir)) throw new Error(`${dir} is missing: run with --keep first`);
		rmSync(remote, { recursive: true, force: true });
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
		execFileSync("git", ["push", "-q", "--no-verify", remote, `${w.base}:refs/heads/main`], { cwd: dir });
		cpSync(join(ROOT, "examples/hooks/pre-push"), join(dir, ".git/hooks/pre-push"));
		Object.assign(w, pushThroughHook(spec, dir, remote));
		console.log(`[${w.agent}] ${!w.hook.blocked ? "pushed" : w.pushed ? "hook blocked → resolved → pushed" : "BLOCKED"}`);
	}
	summary.pushesRechecked = new Date().toISOString();
	writeFileSync(path, `${redact(JSON.stringify(summary, null, 2))}\n`);
	process.exit(0);
}

// ── setup ─────────────────────────────────────────────────────────────────────

// A partial re-run (--only) keeps the other agents' clones and their commits; a full run starts clean.
if (!ONLY) rmSync(WORKDIR, { recursive: true, force: true });
mkdirSync(join(WORKDIR, "bin"), { recursive: true });
rmSync(join(WORKDIR, "bin/git-next"), { force: true });
symlinkSync(join(ROOT, "bin/git-next.ts"), join(WORKDIR, "bin/git-next"));

const spentBefore = await gatewaySpend(ROOT, GATEWAY_ID);
const prior = (await gatewaySource(ROOT, GATEWAY_ID).records({ repo: "agents-demo-full" })).filter((r) => r.task.includes(`#${RUN_TAG}`)).reduce((n, r) => n + r.cost, 0);
const budget = { remaining: BUDGET_USD - prior };
console.log(`gateway spend before: $${spentBefore.toFixed(4)}; planner demo so far $${prior.toFixed(4)} of $${BUDGET_USD}`);
if (budget.remaining <= 0) throw new Error("planner demo budget already spent");
const charge = (model: string, chars: number, maxTokens: number) => {
	const est = estimateUsd(model, chars, maxTokens);
	if (est > budget.remaining) throw new Error(`budget: ${model} estimated $${est.toFixed(3)} > remaining $${budget.remaining.toFixed(3)}`);
	budget.remaining -= est;
};

const previousBase = (agent: string): string | undefined => {
	const path = join(ROOT, "samples/demo-run-planner/summary.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).workers.find((w: any) => w.agent === agent)?.base : undefined;
};

// Clone each existing fork (read-only token, env vars only) and seed a local bare remote with its HEAD.
const clones: Record<string, { dir: string; remote: string; base: string }> = {};
for (const spec of AGENTS) {
	const dir = join(WORKDIR, spec.fork);
	if (ONLY && !ONLY.includes(spec.name) && existsSync(dir)) {
		clones[spec.name] = { dir, remote: join(WORKDIR, `${spec.fork}-local.git`), base: previousBase(spec.name) ?? git(dir, "rev-parse", "HEAD~1") };
		continue;
	}
	rmSync(dir, { recursive: true, force: true });
	rmSync(join(WORKDIR, `${spec.fork}-local.git`), { recursive: true, force: true });
	const read = await post<{ token: string; remote: string }>("/dev/token", { repo: spec.fork, scope: "read", ttl: 600 });
	const r = spawnSync("git", ["clone", "-q", read.remote, dir], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${read.token}`, GIT_TERMINAL_PROMPT: "0" } });
	if (r.status !== 0) throw new Error(`clone ${spec.fork}: ${redact(r.stderr)}`);
	const remote = join(WORKDIR, `${spec.fork}-local.git`);
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	execFileSync("git", ["push", "-q", "--no-verify", remote, "HEAD:refs/heads/main"], { cwd: dir });
	cpSync(join(ROOT, "examples/hooks/pre-push"), join(dir, ".git/hooks/pre-push"));
	clones[spec.name] = { dir, remote, base: git(dir, "rev-parse", "HEAD") };
}

/** Pushes HEAD to the local bare remote through the installed pre-push hook; on a block, retries with the resolved layers. */
function pushThroughHook(spec: AgentSpec, dir: string, remote: string) {
	const push = (layers: string) => {
		const r = spawnSync("git", ["push", remote, "HEAD:main"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${join(WORKDIR, "bin")}:${process.env.PATH}`, GIT_NEXT_LAYERS: layers } });
		return { pushed: r.status === 0, output: redact(`${r.stdout}${r.stderr}`).trim() };
	};
	const first = push(DEMO_LAYERS);
	const resolution = !first.pushed && spec.resolveWith === RESOLVED_LAYERS ? push(RESOLVED_LAYERS) : null;
	return {
		hook: { layers: "fixtures/demo-layers", blocked: !first.pushed, output: first.output },
		resolution: resolution ? { layers: "fixtures/demo-layers-resolved", pushed: resolution.pushed, output: resolution.output } : null,
		pushed: first.pushed || !!resolution?.pushed,
	};
}

// ── 1. plan ───────────────────────────────────────────────────────────────────

const catalog = parseCatalog(readFileSync(join(ROOT, "fixtures/org-baseline/catalog.json"), "utf8"));
const slotRules = await Promise.all(
	AGENTS.map(async (spec) => {
		const ctx = await post<any>("/context", { repo: spec.fork, ref: "main", task: spec.task, paths: spec.paths, budgetTokens: 1200, layers: "demo" });
		return { spec, rules: ctx.rules.map((r: any) => `${r.topic}=${r.value}${r.strength === "must" ? " (must)" : ""} [${r.kind}]`), conflicts: ctx.conflicts.map((c: any) => c.explanation), sections: ctx.sections.slice(0, 4).map((s: any) => `${s.path}:${s.startLine} ${s.headings.at(-1) ?? ""}`) };
	}),
);
const plannerSystem =
	'You are the planning agent for a team of three coding agents, each working on its own fork. You do not write code. Reply with ONLY a JSON object: {"plan": [{"agent", "taskLabel": "docs"|"feature"|"refactor", "task", "paths": [...], "instructions", "acceptance"}], "notes"}. One item per agent, each change small and independently reviewable, every path inside that agent\'s slot. Respect the rules and conflicts you are given; if a conflict affects a slot, say how the worker should handle it.';
const plannerPrompt = [
	`Goal: ${GOAL}`,
	"",
	"Org catalog (what workers may use):",
	catalogSummary(catalog),
	"",
	"Worker slots:",
	...slotRules.map(({ spec, rules, conflicts, sections }) =>
		[`- ${spec.name} on fork ${spec.fork} (model ${WORKER}); may edit only: ${spec.allowed.join(", ")}`, `  suggested files: ${spec.include.join(", ")}`, `  resolved rules: ${rules.join("; ")}`, conflicts.length ? `  conflicts: ${conflicts.join(" | ")}` : "  conflicts: none", `  relevant docs: ${sections.join("; ")}`].join("\n"),
	),
].join("\n");

const previous = REUSE_PLAN ? JSON.parse(readFileSync(join(ROOT, "samples/demo-run-planner/summary.json"), "utf8")) : null;
let plannerModel = PLANNER;
let fallback: { from: string; reason: string } | null = null;
let planned: Awaited<ReturnType<typeof llm>>;
let planJson: any;
if (previous) {
	plannerModel = previous.planner.model;
	fallback = previous.planner.fallback;
	planned = { model: plannerModel, text: "", usage: previous.planner.usage, stopReason: null };
	planJson = { plan: previous.workers.map((w: any) => w.plan), notes: previous.planner.notes };
} else {
charge(PLANNER, plannerSystem.length + plannerPrompt.length, 4000);
const plannerMeta = { developer: "chris", repo: "agents-demo-full", fork: "agents-demo-full", agent: "planner", task: `plan#${RUN_TAG}-demo` };
try {
	planned = await llm(PLANNER, plannerSystem, plannerPrompt, 4000, plannerMeta);
	if (planned.stopReason === "refusal" || !planned.text.trim()) throw new Error(`stop reason ${planned.stopReason ?? "empty"}`);
} catch (err) {
	// Fallback on refusal or error: same request on the fallback planner, recorded in the summary.
	fallback = { from: PLANNER, reason: String(err).slice(0, 200) };
	plannerModel = PLANNER_FALLBACK;
	charge(PLANNER_FALLBACK, plannerSystem.length + plannerPrompt.length, 4000);
	planned = await llm(PLANNER_FALLBACK, plannerSystem, plannerPrompt, 4000, plannerMeta);
}
planJson = JSON.parse(planned.text.trim().replace(/^```[a-z]*\s*\n?/, "").replace(/\n?```\s*$/, "").replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
}
const plan = validatePlan(planJson);
console.log(`[planner] ${plannerModel}${fallback ? ` (fallback from ${fallback.from}: ${fallback.reason})` : ""} ${JSON.stringify(planned.usage)}`);
for (const p of plan) console.log(`  → ${p.agent} [${p.taskLabel}] ${p.task}`);

// ── 2. workers ────────────────────────────────────────────────────────────────

const WORKER_SYSTEM =
	'You are a careful coding agent working in a fork of the cloudflare/agents repo. Reply with ONLY a JSON object: {"summary": "<imperative, under 60 chars>", "edits": [{"path", "find", "replace"} | {"path", "content"}]}. Use find/replace for existing files (find must match exactly once) and content for new files. Keep changes small. No prose outside the JSON.';

async function runWorker(spec: AgentSpec, item: PlanItem) {
	const { dir, remote, base } = clones[spec.name];
	const taskId = `${item.taskLabel}#${RUN_TAG}-${spec.name.replace(/-agent$/, "")}`;
	const ctx = await post<any>("/context", { repo: spec.fork, ref: "main", task: item.task, paths: item.paths, budgetTokens: 3000, layers: "demo" });
	const fileList = [...new Set([...spec.include, ...item.paths])].filter((p) => existsSync(join(dir, p)) && statSync(join(dir, p)).size < 16_000);
	const files = fileList.map((p) => `--- ${p} ---\n${readFileSync(join(dir, p), "utf8")}`).join("\n\n");
	const rules = ctx.rules.map((r: any) => `- ${r.topic}: ${r.value}${r.strength === "must" ? " (must)" : ""} [${r.kind}: ${r.source}]`).join("\n");
	const sections = ctx.sections.map((s: any) => `### ${s.path}:${s.startLine}\n${s.text}`).join("\n\n");
	const prompt = `Task (from the planner): ${item.task}\n\nInstructions: ${item.instructions}\nDone when: ${item.acceptance}\n\nResolved rules:\n${rules}\n\nRelevant context:\n${sections}\n\nFiles:\n${files}`;
	// Thinking counts toward output tokens on Sonnet 5.5, so even small edits need headroom.
	const maxTokens = spec.name === "r2-agent" ? 3500 : 3000;
	charge(WORKER, WORKER_SYSTEM.length + prompt.length, maxTokens);
	const out = await llm(WORKER, WORKER_SYSTEM, prompt, maxTokens, { developer: "chris", repo: "agents-demo-full", fork: spec.fork, agent: spec.name, task: taskId });
	const edits = applyEdits(dir, parseEdits(out.text).edits, (p) => spec.allowed.some((a) => p.startsWith(a)));
	const summary = parseEdits(out.text).summary.replace(/^sow-\d+:\s*/i, "");
	git(dir, "add", "-A");
	execFileSync("git", ["-c", `user.name=${spec.name}`, "-c", `user.email=${spec.name}@git-next.local`, "commit", "-q", "-m", `SOW-1042: ${summary}`, "-m", `Agent: ${spec.name} (${WORKER}) via git.next\nPlanned-By: planner (${plannerModel})\nAgent-Task: ${taskId}`], { cwd: dir });
	const head = git(dir, "rev-parse", "HEAD");
	const pushed = pushThroughHook(spec, dir, remote);
	const resources = JSON.parse((await cli(dir, ["resources", "--base", base, "--json"])).out);
	console.log(`[${spec.name}] ${JSON.stringify(out.usage)} · ${edits.length} edit(s) · ${!pushed.hook.blocked ? "pushed" : pushed.pushed ? "blocked → resolved → pushed" : "BLOCKED"}`);
	return {
		agent: spec.name,
		fork: spec.fork,
		model: WORKER,
		taskId,
		plan: item,
		context: { ...ctx.stats, sections: ctx.sections.length, conflicts: ctx.conflicts.length },
		usage: out.usage,
		commit: { sha: head, message: `SOW-1042: ${summary}`, diffstat: git(dir, "diff", "--shortstat", "HEAD~1", "HEAD") },
		edits,
		...pushed,
		resourcesAdded: resources.added,
		base,
	};
}

const selected = AGENTS.map((spec, i) => ({ spec, item: plan[i] })).filter(({ spec }) => !ONLY || ONLY.includes(spec.name));
const settled = await Promise.allSettled(selected.map(({ spec, item }) => runWorker(spec, item)));
const fresh = settled.map((s, i) => (s.status === "fulfilled" ? s.value : { agent: selected[i].spec.name, fork: selected[i].spec.fork, model: WORKER, plan: selected[i].item, error: String(s.reason) }));
// Workers not re-run keep their previous result.
const workers: any[] = AGENTS.map((spec) => fresh.find((w) => w.agent === spec.name) ?? previous?.workers.find((w: any) => w.agent === spec.name)).filter(Boolean);

// ── 3. cost, policy, summary ──────────────────────────────────────────────────

let records = (await gatewaySource(ROOT, GATEWAY_ID).records({ repo: "agents-demo-full" })).filter((r) => r.task.includes(`#${RUN_TAG}`) && r.at >= new Date(Date.now() - 120 * 60_000).toISOString());
for (let i = 0; i < 20 && records.filter((r) => r.success).length < 1 + workers.filter((w: any) => !w.error).length; i++) {
	await new Promise((r) => setTimeout(r, 2000));
	records = (await gatewaySource(ROOT, GATEWAY_ID).records({ repo: "agents-demo-full" })).filter((r) => r.task.includes(`#${RUN_TAG}`) && r.at >= new Date(Date.now() - 120 * 60_000).toISOString());
}
const latestCost = (agent: string) => {
	const mine = records.filter((r) => r.agent === agent).sort((a, b) => b.at.localeCompare(a.at));
	return { cost: mine.reduce((n, r) => n + r.cost, 0), requests: mine.length, models: [...new Set(mine.map((r) => r.model))] };
};
const costRun = JSON.parse((await cli(clones["docs-agent"].dir, ["cost", "--repo", "agents-demo-full", "--catalog", join(ROOT, "fixtures/org-baseline/catalog.json"), "--json"])).out);
const policy = costRun.insights.filter((i: any) => i.title.startsWith("Catalog:") && /planner|docs-agent|r2-agent|mcp-agent/.test(i.title) && i.metrics?.taskLabel !== undefined && records.some((r) => r.agent === i.metrics.agent && r.model === i.metrics.model));
const fits = costRun.insights.filter((i: any) => i.title.startsWith("Model fit") && records.some((r) => r.agent === i.metrics.agent && r.model === i.metrics.model && r.taskLabel === i.metrics.taskLabel));

const summary = {
	generatedAt: new Date().toISOString(),
	goal: GOAL,
	local: "Forks cloned read-only; pushes went to local bare remotes (nothing pushed to Cloudflare).",
	planner: { model: plannerModel, requested: PLANNER, fallback, usage: planned.usage, ...latestCost("planner"), notes: String(planJson.notes ?? "").slice(0, 1000) },
	workers: workers.map((w: any) => ({ ...w, gateway: latestCost(w.agent) })),
	attempts: "gateway costs include every call tagged with this demo, including retries after a worker ran out of output tokens",
	catalogPolicy: policy.map((p: any) => ({ title: p.title, detail: p.detail })),
	modelFit: fits.map((f: any) => ({ title: f.title, detail: f.detail })),
	runCostUsd: records.reduce((n, r) => n + r.cost, 0),
	gatewayTotalUsd: await gatewaySpend(ROOT, GATEWAY_ID),
};
const outDir = join(ROOT, "samples/demo-run-planner");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "summary.json"), `${redact(JSON.stringify(summary, null, 2))}\n`);

console.log(`\nplanner ${plannerModel}: $${summary.planner.cost.toFixed(4)}${fallback ? " (fallback used)" : ""}`);
for (const w of summary.workers as any[]) console.log(`${w.agent.padEnd(11)} ${w.error ? `FAILED: ${w.error}` : `${w.commit.message} · $${w.gateway.cost.toFixed(4)} · ${w.pushed ? (w.hook.blocked ? "hook blocked → resolved" : "pushed") : "blocked"}${w.resourcesAdded ? ` · +${w.resourcesAdded} binding(s)` : ""}`}`);
console.log(`catalog policy findings: ${summary.catalogPolicy.length}; model-fit suggestions: ${summary.modelFit.length}`);
console.log(`run cost $${summary.runCostUsd.toFixed(4)}; gateway total $${summary.gatewayTotalUsd.toFixed(4)}`);
if (!KEEP) rmSync(WORKDIR, { recursive: true, force: true });
if (workers.some((w: any) => w.error)) process.exitCode = 1;
