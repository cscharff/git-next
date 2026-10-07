// Demo: three coding agents work on forks of agents-demo-full through git.next.
//
// Each agent: sliced context (POST /context) → one Claude call through the git-next AI Gateway (tagged with
// developer/repo/fork/agent/task metadata) → apply edits on a local clone of its fork → commit "SOW-1042: …" →
// push through the git.next pre-push hook (demo layers) → push with a short-lived write token passed only via
// GIT_CONFIG_* env vars. Afterwards it runs /insights for each fork and writes samples/demo-run/*.json.
//
// Needs the local Worker (`npm run dev`) and .dev.vars with CF_ACCOUNT_ID + AIG_LOGS_TOKEN for spend checks.
// Usage: node scripts/demo-agents.ts [--worker-url http://localhost:5173] [--budget-usd 10] [--only docs-agent,…] [--keep] [--insights-only]
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { estimateUsd, gatewaySource as gatewaySourceFor, gatewaySpend as gatewaySpendFor, parseEdits } from "./agent-lib.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SOURCE_REPO = "agents-demo-full";
const GATEWAY_ID = "git-next";
const DEMO_LAYERS = join(ROOT, "fixtures/demo-layers/.gitnext/stack.json");
const RESOLVED_LAYERS = join(ROOT, "fixtures/demo-layers-resolved/.gitnext/stack.json");

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : fallback;
};
const WORKER = opt("--worker-url", "http://localhost:5173")!;
const BUDGET_USD = Number(opt("--budget-usd", "10"));
const ONLY = opt("--only")?.split(",");
const KEEP = argv.includes("--keep");
/** Skip the agents; refresh gateway costs and /insights for the forks recorded in samples/demo-run/summary.json. */
const INSIGHTS_ONLY = argv.includes("--insights-only");
const WORKDIR = join(tmpdir(), "git-next-demo-agents");

interface AgentSpec {
	name: string;
	fork: string;
	model: string;
	task: string;
	taskId: string;
	paths: string[];
	/** Files whose full text goes into the prompt (targets to edit, or templates to copy). */
	include: string[];
	/** Edits outside these prefixes are rejected. */
	allowed: string[];
	maxTokens: number;
	instructions: string;
	/** Layers to retry the push with if the hook blocks it (the resolution path). */
	resolveWith?: string;
}

const AGENTS: AgentSpec[] = [
	{
		name: "docs-agent",
		fork: "agents-demo-docs",
		// Deliberately oversized for a docs fix, so the cost provider suggests a cheaper model.
		model: "anthropic/claude-opus-4.8",
		task: "Fix a small typo or clarify one unclear sentence in the MCP transports docs",
		taskId: "docs#mcp-transports-clarity",
		paths: ["docs/agents/mcp-transports.md"],
		include: ["docs/agents/mcp-transports.md"],
		allowed: ["docs/"],
		maxTokens: 800,
		instructions: "Make exactly one small edit: fix one typo or reword one unclear sentence. Do not restructure the document.",
	},
	{
		name: "r2-agent",
		fork: "agents-demo-r2",
		model: "anthropic/claude-sonnet-5",
		task: "Add a small server-only example that stores uploaded files in an R2 bucket",
		taskId: "feature#r2-uploads-example",
		paths: ["examples/r2-uploads/src/index.ts"],
		include: ["examples/mcp-server/package.json", "examples/mcp-server/wrangler.jsonc", "examples/mcp-server/tsconfig.json", "examples/mcp-server/src/index.ts"],
		allowed: ["examples/r2-uploads/"],
		maxTokens: 3000,
		instructions:
			"Create a minimal server-only example in examples/r2-uploads/ following the examples/AGENTS.md structure for server-only examples (package.json, wrangler.jsonc, tsconfig.json, README.md, src/index.ts). Model the files on the examples/mcp-server files shown. wrangler.jsonc must declare an r2_buckets binding named UPLOADS with bucket_name \"agents-demo-uploads\" (the bucket is not created; just declare it). src/index.ts: PUT /files/:key stores the body in UPLOADS, GET /files/:key returns it. Keep every file short.",
	},
	{
		name: "mcp-agent",
		fork: "agents-demo-mcp",
		model: "anthropic/claude-sonnet-5",
		task: "Improve the doc comments in the MCP abort helpers without changing behavior",
		taskId: "refactor#mcp-abort-comments",
		paths: ["packages/agents/src/mcp/abort.ts"],
		include: ["packages/agents/src/mcp/abort.ts"],
		allowed: ["packages/agents/src/mcp/"],
		maxTokens: 800,
		instructions: "Add a concise JSDoc comment to abortError and tighten the existing comment on raceWithSignal if useful. Comments only: do not change any code.",
		resolveWith: RESOLVED_LAYERS,
	},
];

// ── helpers ───────────────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${WORKER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const out = (await res.json()) as T & { error?: string };
	if (!res.ok || out.error) throw new Error(`${path}: ${out.error ?? res.status}`);
	return out;
}

async function retry<T>(what: string, fn: () => Promise<T>, tries = 30): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (err) {
			if (i >= tries || !/IN_PROGRESS|in progress|not found|NOT_FOUND|fetch failed/i.test(String(err))) throw err;
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

/** Runs git with an Authorization header supplied only through GIT_CONFIG_* env vars (never argv, config or URLs). */
function gitWithToken(cwd: string, args: string[], token: string, extraEnv: Record<string, string> = {}) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...extraEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`, GIT_TERMINAL_PROMPT: "0" },
	});
}
/** Hides tokens and this machine's paths in anything recorded to samples/. */
const redact = (s: string) => s.replace(/Bearer\s+\S+/g, "Bearer ***").replaceAll(ROOT, "<git-next>").replaceAll(WORKDIR, "<workdir>");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const gatewaySpend = () => gatewaySpendFor(ROOT, GATEWAY_ID);
const gatewaySource = () => gatewaySourceFor(ROOT, GATEWAY_ID);

// ── one agent ─────────────────────────────────────────────────────────────────

async function runAgent(spec: AgentSpec, binDir: string, budget: { remaining: number }, fork: { name: string; remote: string; created: boolean }) {
	const log: string[] = [];
	const note = (s: string) => {
		log.push(s);
		console.log(`[${spec.name}] ${s}`);
	};
	const result: Record<string, any> = { agent: spec.name, fork: spec.fork, model: spec.model, task: spec.task, taskId: spec.taskId, paths: spec.paths };

	note(`${fork.created ? "forked" : "reusing"} ${fork.name}`);
	result.remote = fork.remote;

	// Clone the fork (read token, env only).
	const dir = join(WORKDIR, spec.fork);
	rmSync(dir, { recursive: true, force: true });
	const read = await retry("token", () => post<{ token: string; remote: string }>("/dev/token", { repo: spec.fork, scope: "read", ttl: 600 }));
	const clone = gitWithToken(WORKDIR, ["clone", "-q", read.remote, dir], read.token);
	if (clone.status !== 0) throw new Error(`clone failed: ${redact(clone.stderr)}`);
	result.base = git(dir, "rev-parse", "HEAD");

	// Sliced context for the task.
	const ctx = await retry("context", () => post<any>("/context", { repo: spec.fork, ref: "main", task: spec.task, paths: spec.paths, budgetTokens: 3000, layers: "demo" }), 3);
	result.context = { ...ctx.stats, sections: ctx.sections.length, rules: ctx.rules.length, conflicts: ctx.conflicts.length };
	note(`context: ${ctx.stats.tokensServed} tokens served (${ctx.sections.length} sections) of ${ctx.stats.tokensAllMarkdown} in all markdown`);

	const files = spec.include.map((p) => `--- ${p} ---\n${readFileSync(join(dir, p), "utf8")}`).join("\n\n");
	const rules = ctx.rules.map((r: any) => `- ${r.topic}: ${r.value}${r.strength === "must" ? " (must)" : ""} [${r.kind}: ${r.source}]`).join("\n");
	const sections = ctx.sections.map((s: any) => `### ${s.path}:${s.startLine}\n${s.text}`).join("\n\n");
	const system =
		'You are a careful coding agent working in a fork of the cloudflare/agents repo. Reply with ONLY a JSON object: {"summary": "<imperative, under 60 chars>", "edits": [{"path", "find", "replace"} | {"path", "content"}]}. Use find/replace for existing files (find must match the file exactly, once) and content for new files. No prose outside the JSON.';
	const prompt = `Task: ${spec.task}\n\n${spec.instructions}\n\nResolved rules for these paths:\n${rules}\n\nRelevant context:\n${sections}\n\nFiles:\n${files}`;

	const estimate = estimateUsd(spec.model, system.length + prompt.length, spec.maxTokens);
	if (estimate > budget.remaining) throw new Error(`budget: estimated $${estimate.toFixed(3)} exceeds remaining $${budget.remaining.toFixed(3)}`);
	budget.remaining -= estimate;

	const metadata = { developer: "chris", repo: SOURCE_REPO, fork: spec.fork, agent: spec.name, task: spec.taskId };
	const llm = await post<{ text: string; usage: any }>("/dev/llm", { model: spec.model, system, prompt, maxTokens: spec.maxTokens, metadata });
	result.usage = llm.usage;
	result.promptChars = system.length + prompt.length;
	note(`model ${spec.model}: ${JSON.stringify(llm.usage)}`);

	// Apply edits, restricted to the agent's allowed paths.
	const plan = parseEdits(llm.text);
	result.summary = plan.summary;
	result.edits = [];
	for (const e of plan.edits) {
		if (!spec.allowed.some((a) => e.path.startsWith(a)) || e.path.includes("..")) throw new Error(`edit outside allowed paths: ${e.path}`);
		const abs = join(dir, e.path);
		if ("content" in e) {
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, e.content.endsWith("\n") ? e.content : `${e.content}\n`);
			result.edits.push({ path: e.path, kind: "create", bytes: e.content.length });
		} else {
			const before = readFileSync(abs, "utf8");
			const count = before.split(e.find).length - 1;
			if (count !== 1) throw new Error(`find text matched ${count} times in ${e.path}`);
			writeFileSync(abs, before.replace(e.find, e.replace));
			result.edits.push({ path: e.path, kind: "edit", find: e.find.slice(0, 160), replace: e.replace.slice(0, 160) });
		}
	}
	note(`applied ${result.edits.length} edit(s): ${plan.summary}`);

	git(dir, "add", "-A");
	const message = `SOW-1042: ${plan.summary.replace(/^SOW-\d+:\s*/, "")}`;
	execFileSync("git", ["-c", `user.name=${spec.name}`, "-c", `user.email=${spec.name}@git-next.local`, "commit", "-q", "-m", message, "-m", `Agent: ${spec.name} (${spec.model}) via git.next\nAgent-Task: ${spec.taskId}`], { cwd: dir });
	result.commit = { sha: git(dir, "rev-parse", "HEAD"), message, diffstat: git(dir, "diff", "--shortstat", "HEAD~1", "HEAD") };

	// Push through the pre-push hook with the demo layers; on a block, retry with the resolution layers.
	cpSync(join(ROOT, "examples/hooks/pre-push"), join(dir, ".git/hooks/pre-push"));
	const push = async (layers: string) => {
		const write = await post<{ token: string }>("/dev/token", { repo: spec.fork, scope: "write", ttl: 600 });
		const r = gitWithToken(dir, ["push", "origin", "HEAD:main"], write.token, { PATH: `${binDir}:${process.env.PATH}`, GIT_NEXT_LAYERS: layers });
		return { ok: r.status === 0, output: redact(`${r.stdout}${r.stderr}`).trim() };
	};
	const first = await push(DEMO_LAYERS);
	result.hook = { layers: "fixtures/demo-layers", blocked: !first.ok, output: first.output };
	if (!first.ok && spec.resolveWith) {
		note("pre-push hook blocked the push; retrying with the amended contract layer");
		const second = await push(spec.resolveWith);
		result.resolution = { layers: "fixtures/demo-layers-resolved", pushed: second.ok, output: second.output };
		if (!second.ok) throw new Error(`push still blocked after resolution: ${second.output}`);
	} else if (!first.ok) {
		throw new Error(`push blocked: ${first.output}`);
	}
	result.pushed = true;
	result.head = result.commit.sha;
	note(`pushed ${result.head.slice(0, 10)} to ${spec.fork}`);
	result.log = log;
	return result;
}

// ── main ──────────────────────────────────────────────────────────────────────

const agents = AGENTS.filter((a) => !ONLY || ONLY.includes(a.name));
rmSync(WORKDIR, { recursive: true, force: true });
mkdirSync(WORKDIR, { recursive: true });
const binDir = join(WORKDIR, "bin");
mkdirSync(binDir);
symlinkSync(join(ROOT, "bin/git-next.ts"), join(binDir, "git-next"));

const spentBefore = await gatewaySpend();
console.log(`gateway spend before: $${spentBefore.toFixed(6)} (budget $${BUDGET_USD})`);
const budget = { remaining: BUDGET_USD - spentBefore };
if (budget.remaining <= 0) throw new Error("budget already spent");

// Forks are created one at a time (skipped with --insights-only) (concurrent fork() calls failed with internal errors); the agents then run in parallel.
const forks: { name: string; remote: string; created: boolean }[] = [];
if (!INSIGHTS_ONLY) for (const a of agents) forks.push(await retry("fork", () => post<{ name: string; remote: string; created: boolean }>("/dev/fork", { name: a.fork })));
let results: any[];
if (INSIGHTS_ONLY) {
	const prev = JSON.parse(readFileSync(join(ROOT, "samples/demo-run/summary.json"), "utf8")).agents as any[];
	results = prev.filter((p) => agents.some((a) => a.name === p.agent));
} else {
	const settled = await Promise.allSettled(agents.map((a, i) => runAgent(a, binDir, budget, forks[i])));
	results = settled.map((s, i) => (s.status === "fulfilled" ? s.value : { agent: agents[i].name, fork: agents[i].fork, model: agents[i].model, error: String(s.reason) }));
}

// Gateway logs can lag a few seconds; wait until every agent's call shows up (or give up after ~60 s).
let records = await gatewaySource().records({ repo: SOURCE_REPO });
for (let i = 0; i < 30 && agents.some((a) => !records.some((r) => r.agent === a.name)); i++) {
	await new Promise((r) => setTimeout(r, 2000));
	records = await gatewaySource().records({ repo: SOURCE_REPO });
}
for (const r of results as any[]) {
	const mine = records.filter((x) => x.agent === r.agent && x.fork === r.fork);
	r.gateway = { requests: mine.length, cost: mine.reduce((n, x) => n + x.cost, 0), tokensIn: mine.reduce((n, x) => n + x.tokensIn, 0), tokensOut: mine.reduce((n, x) => n + x.tokensOut, 0) };
}
const spentAfter = await gatewaySpend();

// Insights per fork, diffed against the source repo's main at fork time.
const outDir = join(ROOT, "samples/demo-run");
mkdirSync(outDir, { recursive: true });
for (const r of results as any[]) {
	if (!r.base) continue;
	const qs = new URLSearchParams({ repo: r.fork, ref: "main", base: r.base, layers: "demo" });
	const res = await fetch(`${WORKER}/insights?${qs}`);
	const insights = (await res.json()) as Record<string, unknown>;
	writeFileSync(join(outDir, `${r.fork}.json`), `${JSON.stringify({ live: true, generatedBy: "scripts/demo-agents.ts", ...insights }, null, 2)}\n`);
}
// A partial run (--only) keeps the other agents' last results.
const summaryPath = join(outDir, "summary.json");
const previous = (ONLY || INSIGHTS_ONLY) && existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, "utf8")).agents as any[]) : [];
const merged = [...previous.filter((p) => !results.some((r: any) => r.agent === p.agent)), ...results].sort((a, b) => AGENTS.findIndex((x) => x.name === a.agent) - AGENTS.findIndex((x) => x.name === b.agent));
const summary = {
	generatedAt: new Date().toISOString(),
	sourceRepo: SOURCE_REPO,
	gateway: GATEWAY_ID,
	budgetUsd: BUDGET_USD,
	gatewayTotalUsd: spentAfter,
	agentsCostUsd: merged.reduce((n, r) => n + (r.gateway?.cost ?? 0), 0),
	agents: merged,
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nrun cost $${(spentAfter - spentBefore).toFixed(6)}; gateway total $${spentAfter.toFixed(6)}`);
for (const r of results as any[]) console.log(`${r.agent.padEnd(11)} ${r.error ? `FAILED: ${r.error}` : `${r.fork} ${r.head?.slice(0, 10)} ${r.commit?.message} · $${r.gateway.cost.toFixed(5)}${r.hook?.blocked ? " · hook blocked, resolved" : ""}`}`);
if (!KEEP) rmSync(WORKDIR, { recursive: true, force: true });
if (results.some((r: any) => r.error)) process.exitCode = 1;
