// Demo: "smart by default" new repositories. Two agents get the same task and the same model:
//   bare-agent  works in a plain repo (just a README), with only the repo's files as context;
//   smart-agent works in a repo made by `git next new … --template worker-api`, with `git next context`
//               (pinned org musts, the catalog, task-relevant catalog entries) plus the repo's files.
// Each makes ONE Claude Sonnet 5 call through the git-next AI Gateway, commits, and pushes through the
// fail-closed pre-push hook to a LOCAL bare remote. The bare repo is checked as org CI would check it
// (org baseline layers + catalog); the smart repo uses its own pinned layers and catalog.
//
// Needs the local Worker (`npm run dev`) and .dev.vars (CF_ACCOUNT_ID, AIG_LOGS_TOKEN). Spend cap: --budget-usd 0.5.
// Usage: node scripts/demo-new-repo.ts [--worker-url http://localhost:5173] [--budget-usd 0.5] [--keep] [--recheck]
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { applyEdits, estimateUsd, gatewaySource, gatewaySpend, parseEdits, workerPost } from "./agent-lib.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const GATEWAY_ID = "git-next";
const BASELINE = join(ROOT, "fixtures/org-baseline");
const MODEL = "anthropic/claude-sonnet-5";
const TASK = "Build a small Cloudflare Worker endpoint that stores uploaded files (PUT /files/:name stores the request body, GET /files/:name returns it) and returns a one-sentence AI-generated description of each upload. Only callers with the shared API key may upload.";
const TASK_ID = "feature#uploads-endpoint";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const WORKER = opt("--worker-url", "http://localhost:5173");
const BUDGET_USD = Number(opt("--budget-usd", "0.5"));
const KEEP = argv.includes("--keep") || argv.includes("--recheck");
/** Reuse the repos from a previous --keep run: redo the pushes and checks without calling the model again. */
const RECHECK = argv.includes("--recheck");
const WORKDIR = join(tmpdir(), "git-next-demo-new-repo");

const redact = (s: string) => s.replace(/Bearer\s+\S+/g, "Bearer ***").replace(/https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net/g, "https://<account>.artifacts.cloudflare.net").replaceAll(ROOT, "<git-next>").replaceAll(WORKDIR, "<workdir>");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=demo-agent", "-c", "user.email=demo-agent@git-next.local", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function cli(cwd: string, args: string[]) {
	let out = "";
	let err = "";
	const code = await runCli(args, { cwd, out: (t) => (out += t), err: (t) => (err += t), env: {} });
	return { code, out, err };
}

/** Text files in a repo (minus .git, .gitnext and lockfiles), for the agent prompt. */
function repoFiles(dir: string): string {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			if ([".git", ".gitnext", "node_modules"].includes(name)) continue;
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else out.push(`--- ${relative(dir, p)} ---\n${readFileSync(p, "utf8")}`);
		}
	};
	walk(dir);
	return out.join("\n\n");
}

const SYSTEM =
	'You are a coding agent working in a git repository. Reply with ONLY a JSON object: {"summary": "<commit subject, under 70 chars>", "edits": [{"path", "content"} | {"path", "find", "replace"}]}. Use content for new or fully rewritten files, find/replace for small edits. Write production-ready code, but keep it compact: at most 3 files, no tests, about 120 lines in total. No prose outside the JSON.';

async function runAgent(name: "bare-agent" | "smart-agent", dir: string, context: string, budget: { remaining: number }) {
	const prompt = `Task: ${TASK}\n\n${context ? `${context}\n\n` : ""}Repository files:\n${repoFiles(dir)}`;
	const maxTokens = 8000;
	const estimate = estimateUsd(MODEL, SYSTEM.length + prompt.length, maxTokens);
	if (estimate > budget.remaining) throw new Error(`budget: estimated $${estimate.toFixed(3)} > remaining $${budget.remaining.toFixed(3)}`);
	budget.remaining -= estimate;
	const metadata = { developer: "chris", repo: "new-repo-demo", fork: name === "bare-agent" ? "uploads-bare" : "uploads-smart", agent: name, task: TASK_ID };
	const llm = await workerPost<{ text: string; usage: any }>(WORKER, "/dev/llm", { model: MODEL, system: SYSTEM, prompt, maxTokens, metadata });
	const plan = parseEdits(llm.text);
	const edits = applyEdits(dir, plan.edits, (p) => !p.startsWith(".git/") && !p.startsWith(".gitnext/"));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", plan.summary, "-m", `Agent: ${name} (${MODEL}) via git.next\nAgent-Task: ${TASK_ID}`);
	console.log(`[${name}] ${JSON.stringify(llm.usage)} · ${edits.length} file(s): ${plan.summary}`);
	return { usage: llm.usage, promptChars: SYSTEM.length + prompt.length, summary: plan.summary, edits };
}

/** Pushes through the installed pre-push hook to a local bare remote; returns whether it went through. */
function push(dir: string, remote: string, env: Record<string, string>, binDir: string) {
	const r = spawnSync("git", ["push", remote, "HEAD:main"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH}` } });
	return { pushed: r.status === 0, output: redact(`${r.stdout}${r.stderr}`).trim() };
}

// ── main ──────────────────────────────────────────────────────────────────────

const runStart = new Date().toISOString();
if (!RECHECK) {
	rmSync(WORKDIR, { recursive: true, force: true });
	mkdirSync(WORKDIR, { recursive: true });
}
const binDir = join(WORKDIR, "bin");
rmSync(binDir, { recursive: true, force: true });
mkdirSync(binDir);
symlinkSync(join(ROOT, "bin/git-next.ts"), join(binDir, "git-next"));

const spentBefore = await gatewaySpend(ROOT, GATEWAY_ID);
// The cap covers every run of this demo: earlier calls tagged with this task count against it.
const priorDemoSpend = (await gatewaySource(ROOT, GATEWAY_ID).records({ repo: "new-repo-demo" })).filter((r) => r.task === TASK_ID).reduce((n, r) => n + r.cost, 0);
const budget = { remaining: BUDGET_USD - priorDemoSpend };
console.log(`gateway spend before: $${spentBefore.toFixed(6)}; this demo so far $${priorDemoSpend.toFixed(4)} of $${BUDGET_USD}`);
if (budget.remaining <= 0) throw new Error("demo budget already spent");

const bare = join(WORKDIR, "uploads-bare");
const smart = join(WORKDIR, "uploads-smart");
const previous = RECHECK ? JSON.parse(readFileSync(join(ROOT, "samples/new-repo-demo/summary.json"), "utf8")) : null;
let bareRun: Awaited<ReturnType<typeof runAgent>>;
let smartRun: Awaited<ReturnType<typeof runAgent>>;
let ctxJson: any;
if (RECHECK) {
	const fromSummary = (a: any) => a.run ?? { usage: a.usage, promptChars: 0, summary: a.commit, edits: a.files };
	bareRun = fromSummary(previous.agents[0]);
	smartRun = fromSummary(previous.agents[1]);
	ctxJson = { stats: previous.agents[1].contextFromGitNext, pinned: previous.agents[1].contextFromGitNext.pinned };
} else {
// 1. A plain repo, as anyone would start one today.
mkdirSync(bare);
writeFileSync(join(bare, "README.md"), "# uploads-bare\n\nA small upload service.\n");
git(bare, "init", "-q", "-b", "main");
git(bare, "add", "-A");
git(bare, "commit", "-q", "-m", "Initial commit");
cpSync(join(ROOT, "examples/hooks/pre-push"), join(bare, ".git/hooks/pre-push"));

// 2. The same project created with `git next new`.
const created = await cli(WORKDIR, ["new", "uploads-smart", "--template", "worker-api", "--org", BASELINE]);
if (created.code !== 0) throw new Error(`git next new failed: ${created.err}`);
console.log(created.out.trim());

// 3. Context: the bare agent gets nothing from git.next; the smart agent gets `git next context` (pinned + catalog).
const ctx = await cli(smart, ["context", TASK, "src/index.ts", "--budget", "2000", "--print"]);
ctxJson = JSON.parse((await cli(smart, ["context", TASK, "src/index.ts", "--budget", "2000", "--json"])).out);

[bareRun, smartRun] = await Promise.all([runAgent("bare-agent", bare, "", budget), runAgent("smart-agent", smart, `Context from git next (rules and org catalog for this repo):\n${ctx.out}`, budget)]);
}

// 4. First push of each, through the fail-closed hook to a local bare remote. The org checks the bare repo
//    against its baseline (as org CI would); the smart repo carries its own pinned layers and catalog.
const remotes = { bare: join(WORKDIR, "remote-bare.git"), smart: join(WORKDIR, "remote-smart.git") };
for (const r of Object.values(remotes)) {
	rmSync(r, { recursive: true, force: true });
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", r]);
}
const orgEnv = { GIT_NEXT_LAYERS: join(BASELINE, ".gitnext/stack.json") };
// Seed each remote with the repo's first commit so the hook checks exactly what the agent pushed.
for (const [dir, remote] of [[bare, remotes.bare], [smart, remotes.smart]] as const) execFileSync("git", ["push", "-q", "--no-verify", remote, "HEAD~1:refs/heads/main"], { cwd: dir });
const barePush = push(bare, remotes.bare, orgEnv, binDir);
const smartPush = push(smart, remotes.smart, {}, binDir);

// 5. Findings at first push, as JSON.
const bareRules = JSON.parse((await cli(bare, ["rules", "--json", "--layers", orgEnv.GIT_NEXT_LAYERS])).out);
const smartRules = JSON.parse((await cli(smart, ["rules", "--json"])).out);
const count = (r: any) => r.conflicts.length + r.catalog.violations.length;

// 6. Cost from the gateway logs (they can lag a few seconds).
let records = (await gatewaySource(ROOT, GATEWAY_ID).records({ repo: "new-repo-demo" })).filter((r) => r.task === TASK_ID);
for (let i = 0; i < 20 && records.length < 2; i++) {
	await new Promise((r) => setTimeout(r, 2000));
	records = (await gatewaySource(ROOT, GATEWAY_ID).records({ repo: "new-repo-demo" })).filter((r) => r.task === TASK_ID);
}
// "Run" cost is the agent's latest call (this run's, or the run being rechecked); "all attempts" includes retries.
const latest = (agent: string) => records.filter((r) => r.agent === agent).sort((a, b) => b.at.localeCompare(a.at))[0];
const costOf = (agent: string) => latest(agent)?.cost ?? 0;
const allAttempts = (agent: string) => records.filter((r) => r.agent === agent).reduce((n, r) => n + r.cost, 0);
const spentAfter = await gatewaySpend(ROOT, GATEWAY_ID);

const summary = {
	generatedAt: new Date().toISOString(),
	task: TASK,
	model: MODEL,
	gatewayTotalUsd: spentAfter,
	runCostUsd: costOf("bare-agent") + costOf("smart-agent"),
	allAttemptsCostUsd: allAttempts("bare-agent") + allAttempts("smart-agent"),
	note: RECHECK ? `Pushes and checks re-run at ${runStart} on the repos from the previous run (no new model calls).` : undefined,
	agents: [
		{
			agent: "bare-agent",
			repo: "uploads-bare (plain repo)",
			contextFromGitNext: null,
			run: bareRun,
			usage: bareRun.usage,
			cost: costOf("bare-agent"),
			commit: bareRun.summary,
			files: bareRun.edits,
			firstPush: barePush,
			findings: count(bareRules),
			conflicts: bareRules.conflicts,
			catalogViolations: bareRules.catalog.violations,
		},
		{
			agent: "smart-agent",
			repo: "uploads-smart (git next new --template worker-api)",
			contextFromGitNext: { tokensServed: ctxJson.stats.tokensServed, pinnedTokens: ctxJson.stats.pinnedTokens, pinned: ctxJson.pinned },
			run: smartRun,
			usage: smartRun.usage,
			cost: costOf("smart-agent"),
			commit: smartRun.summary,
			files: smartRun.edits,
			firstPush: smartPush,
			findings: count(smartRules),
			conflicts: smartRules.conflicts,
			catalogViolations: smartRules.catalog.violations,
		},
	],
};
const outDir = join(ROOT, "samples/new-repo-demo");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "summary.json"), `${redact(JSON.stringify(summary, null, 2))}\n`);
for (const [name, dir] of [["uploads-bare", bare], ["uploads-smart", smart]] as const) {
	const wrangler = readdirSync(dir).find((f) => /^wrangler\.(jsonc?|toml)$/.test(f));
	const files: Record<string, string> = {};
	for (const e of summary.agents.find((a) => a.repo.startsWith(name))!.files) files[e.path] = readFileSync(join(dir, e.path), "utf8");
	if (wrangler && !files[wrangler]) files[wrangler] = readFileSync(join(dir, wrangler), "utf8");
	writeFileSync(join(outDir, `${name}.files.json`), `${JSON.stringify(files, null, 2)}\n`);
}

console.log(`\nbare-agent : ${count(bareRules)} finding(s) at first push; push ${barePush.pushed ? "went through" : "BLOCKED"}; $${costOf("bare-agent").toFixed(4)}`);
for (const v of [...bareRules.conflicts.map((c: any) => `${c.topic}: ${c.explanation}`), ...bareRules.catalog.violations.map((v: any) => v.title)]) console.log(`   ✗ ${v}`);
console.log(`smart-agent: ${count(smartRules)} finding(s) at first push; push ${smartPush.pushed ? "went through" : "BLOCKED"}; $${costOf("smart-agent").toFixed(4)}; ${ctxJson.stats.tokensServed} context tokens (${ctxJson.stats.pinnedTokens} pinned)`);
for (const v of [...smartRules.conflicts.map((c: any) => `${c.topic}: ${c.explanation}`), ...smartRules.catalog.violations.map((v: any) => v.title)]) console.log(`   ✗ ${v}`);
console.log(`run cost $${summary.runCostUsd.toFixed(4)} (all attempts $${summary.allAttemptsCostUsd.toFixed(4)}); gateway total $${spentAfter.toFixed(4)}`);
if (!KEEP) rmSync(WORKDIR, { recursive: true, force: true });
