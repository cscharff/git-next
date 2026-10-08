import { describe, expect, it } from "vitest";
import { RepoContext, memorySource, type CommitInfo, type RepoSource } from "../src/core/repo-context.ts";
import { parseCatalog } from "../src/providers/catalog.ts";
import type { CostRecord } from "../src/providers/cost/logs.ts";
import type { IndexEntry } from "../src/results.ts";
import { handleWorkRoute, type WorkRouteDeps } from "../src/work-routes.ts";
import { attemptSets, checkChange, compareAttempts, overlaps, workInFlight, type WorkDeps, type WorkItem } from "../src/work.ts";

const catalog = parseCatalog(
	JSON.stringify({
		version: "2026.10.5",
		gateway: { id: "git-next" },
		models: [{ id: "anthropic/claude-sonnet-5.5" }, { id: "@cf/zai-org/glm-5.3-flash" }],
		bindings: [{ type: "r2_buckets", shared: [{ binding: "UPLOADS", name: "acme-shared-uploads" }] }, { type: "ai" }],
	}),
);

const base = { "README.md": "# Project\n", "examples/AGENTS.md": "- Server-only examples need a README.\n", "packages/agents/src/mcp/abort.ts": "export const abort = 1;\n" };
// Commits are refs in the memory sources; each repo knows the project's main commit ("base1") as an ancestor.
const project = {
	base1: base,
	main: base,
	"c-sonnet": { ...base, "examples/uploads/src/index.ts": 'export default { fetch: (r, env) => env.AI.run("@cf/zai-org/glm-5.3-flash", {}, { gateway: { id: "git-next" } }) };\n', "examples/uploads/wrangler.jsonc": '{ "name": "uploads", "r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "acme-shared-uploads" }] }\n' },
	"c-haiku": { ...base, "examples/uploads/src/index.ts": 'export default { fetch: (r, env) => env.AI.run("@cf/meta/llama-3-8b-instruct", {}) };\n', "examples/uploads/wrangler.jsonc": '{ "name": "uploads", "r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "uploads-bare-files" }] }\n' },
};
const fork = { base1: base, "c-r2": { ...base, "examples/uploads/src/index.ts": "export default {};\n", "examples/uploads/README.md": "# Uploads\n" } };
const mcp = { base1: base, "c-mcp": { ...base, "packages/agents/src/mcp/abort.ts": "/** Abort. */\nexport const abort = 1;\n" } };

const commits: Record<string, CommitInfo> = {
	main: { hash: "base1", message: "upstream", author: "someone", committedAt: 1 },
	"c-sonnet": { hash: "c-sonnet", message: "SOW-1042: Add uploads example\n\nAgent: attempt-sonnet (anthropic/claude-sonnet-5.5) via git.next\nAgent-Task: feature#uploads", author: "attempt-sonnet", committedAt: 3 },
	"c-haiku": { hash: "c-haiku", message: "SOW-1042: Add uploads example\n\nAgent: attempt-haiku (anthropic/claude-haiku-4.5) via git.next\nAgent-Task: feature#uploads", author: "attempt-haiku", committedAt: 3 },
	"c-r2": { hash: "c-r2", message: "SOW-1042: Add r2 example\n\nAgent: r2-agent (x) via git.next\nAgent-Task: feature#r2", author: "r2-agent", committedAt: 2 },
	"c-mcp": { hash: "c-mcp", message: "SOW-1042: Comment abort\n\nAgent: mcp-agent (x) via git.next\nAgent-Task: refactor#mcp", author: "mcp-agent", committedAt: 2 },
};
const withLog = (refs: Record<string, Record<string, string>>): RepoSource => ({ ...memorySource(refs), log: async (ref) => (commits[ref] ? [commits[ref]] : []) });
const sources: Record<string, RepoSource> = { "agents-demo-full": withLog(project), "agents-demo-r2": withLog(fork), "agents-demo-mcp": withLog(mcp), other: withLog({ main: base }) };

const entry = (repo: string, ref: string, after: string, updatedAt: string): IndexEntry => ({ repo, ref, after, updatedAt, conflicts: 2, warnings: 0, catalogViolations: 0, insights: 10, ms: 1 });
const index = [
	entry("agents-demo-full", "main", "base1", "2026-10-08T01:00:00Z"),
	entry("agents-demo-full", "attempt/sonnet", "c-sonnet", "2026-10-08T03:00:00Z"),
	entry("agents-demo-full", "attempt/haiku", "c-haiku", "2026-10-08T03:01:00Z"),
	entry("agents-demo-r2", "main", "c-r2", "2026-10-08T02:00:00Z"),
	entry("agents-demo-mcp", "main", "c-mcp", "2026-10-08T02:30:00Z"),
	entry("other", "main", "base1", "2026-10-08T02:00:00Z"),
];
const deps: WorkDeps = {
	index: async () => index,
	sourceOf: async (repo) => (repo.startsWith("agents-demo-") && repo !== "agents-demo-full" ? "agents-demo-full" : null),
	files: (repo) => new RepoContext(async () => sources[repo]),
};
const cost = (agent: string, usd: number, model: string): CostRecord => ({ id: agent, at: "", model, provider: "x", tokensIn: 1000, tokensOut: 500, cost: usd, cached: false, success: true, developer: "chris", repo: "agents-demo-full", fork: "agents-demo-full", agent, task: "feature#uploads", taskLabel: "feature", cloud: "cloudflare", mocked: false });

describe("work in flight", () => {
	it("lists forks and non-main branches with their changes, agent and task", async () => {
		const work = await workInFlight(deps, "agents-demo-full");
		expect(work.map((w) => `${w.repo}@${w.ref}:${w.agent}:${w.task}:${w.files.map((f) => f.path).join("+")}`)).toEqual([
			"agents-demo-full@attempt/haiku:attempt-haiku:feature#uploads:examples/uploads/src/index.ts+examples/uploads/wrangler.jsonc",
			"agents-demo-full@attempt/sonnet:attempt-sonnet:feature#uploads:examples/uploads/src/index.ts+examples/uploads/wrangler.jsonc",
			"agents-demo-mcp@main:mcp-agent:refactor#mcp:packages/agents/src/mcp/abort.ts",
			"agents-demo-r2@main:r2-agent:feature#r2:examples/uploads/README.md+examples/uploads/src/index.ts",
		]);
	});

	it("adds named branches that haven't been analysed yet", async () => {
		const unindexed: WorkDeps = { ...deps, index: async () => index.filter((e) => e.ref !== "attempt/haiku") };
		const work = await workInFlight(unindexed, "agents-demo-full", "main", [{ repo: "agents-demo-full", ref: "c-haiku" }, { repo: "agents-demo-full", ref: "missing" }]);
		expect(work.map((w) => w.ref)).toContain("c-haiku");
		expect(work.find((w) => w.ref === "c-haiku")).toMatchObject({ agent: "attempt-haiku", task: "feature#uploads", head: "c-haiku" });
	});

	it("includes forks from the repo host that the index hasn't seen", async () => {
		const forksOnly: WorkDeps = { ...deps, index: async () => [], forksOf: async () => ["agents-demo-r2", "agents-demo-mcp"] };
		const commitsByMain = { ...commits };
		// A fork's main resolves to its latest commit.
		const files = (repo: string) => new RepoContext(async () => ({ ...sources[repo], log: async (ref: string) => [commitsByMain[ref === "main" ? (repo === "agents-demo-r2" ? "c-r2" : repo === "agents-demo-mcp" ? "c-mcp" : "main") : ref]].filter(Boolean) }));
		const work = await workInFlight({ ...forksOnly, files }, "agents-demo-full");
		expect(work.map((w) => `${w.repo}@${w.ref}:${w.agent}`).sort()).toEqual(["agents-demo-mcp@main:mcp-agent", "agents-demo-r2@main:r2-agent"]);
	});

	it("caches change sets by repo, head and base", async () => {
		const store = new Map<string, WorkItem>();
		const cached: WorkDeps = { ...deps, cache: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) } };
		await workInFlight(cached, "agents-demo-full");
		expect([...store.keys()].sort()).toEqual(["agents-demo-full/c-haiku/base1", "agents-demo-full/c-sonnet/base1", "agents-demo-mcp/c-mcp/base1", "agents-demo-r2/c-r2/base1"]);
	});

	it("finds who else touches the same files or folders, not the asker", async () => {
		const work = await workInFlight(deps, "agents-demo-full");
		const o = overlaps(work, ["examples/uploads/src/index.ts"], { repo: "agents-demo-r2" });
		expect(o.map((x) => `${x.repo}@${x.ref} same=${x.same.join(",")} near=${x.near.join(",")}`)).toEqual([
			"agents-demo-full@attempt/haiku same=examples/uploads/src/index.ts near=",
			"agents-demo-full@attempt/sonnet same=examples/uploads/src/index.ts near=",
		]);
		expect(overlaps(work, ["examples/uploads/package.json"], { repo: "agents-demo-full" }).map((x) => `${x.repo} near=${x.near.join(",")}`)).toEqual(["agents-demo-r2 near=examples/uploads/README.md"]);
		expect(overlaps(work, ["docs/x.md"])).toEqual([]);
	});
});

describe("attempts", () => {
	it("groups work by task when two or more attempts share it", async () => {
		const sets = attemptSets(await workInFlight(deps, "agents-demo-full"));
		expect(sets.map((s) => `${s.task}:${s.attempts.map((a) => a.ref).join(",")}`)).toEqual(["feature#uploads:attempt/haiku,attempt/sonnet"]);
	});

	it("checks only what the change introduces", () => {
		const findings = checkChange([{ path: "src/index.ts", text: project["c-haiku"]["examples/uploads/src/index.ts"] }, { path: "wrangler.jsonc", text: project["c-haiku"]["examples/uploads/wrangler.jsonc"] }], catalog);
		expect(findings.map((f) => f.title)).toEqual(["Unapproved model: @cf/meta/llama-3-8b-instruct", "Model call bypasses the org gateway", "Unapproved binding: r2_buckets UPLOADS → uploads-bare-files"]);
	});

	it("picks the clean attempt and says why, with cost and overlap", async () => {
		const work = await workInFlight(deps, "agents-demo-full");
		const [set] = attemptSets(work);
		const reports = await compareAttempts(set.attempts, work.filter((w) => !set.attempts.includes(w)), {
			files: deps.files,
			catalog,
			costs: [cost("attempt-sonnet", 0.05, "anthropic/claude-sonnet-5.5"), cost("attempt-haiku", 0.01, "anthropic/claude-haiku-4.5")],
			stored: async (repo, ref) => index.find((e) => e.repo === repo && e.ref === ref) ?? null,
		});
		expect(reports.map((r) => `${r.rank}:${r.agent}:${r.verdict}:${r.findings.length}:${r.model}`)).toEqual(["1:attempt-sonnet:pick:0:anthropic/claude-sonnet-5.5", "2:attempt-haiku:blocked:3:anthropic/claude-haiku-4.5"]);
		expect(reports[0]).toMatchObject({ added: 2, removed: 0, cost: { usd: 0.05, requests: 1 }, push: { conflicts: 2, catalogViolations: 0 } });
		expect(reports[0].overlaps.map((o) => o.repo)).toEqual(["agents-demo-r2"]);
		expect(reports[0].reasons[0]).toBe("its change introduces no catalog findings");
		expect(reports[0].reasons).toContain("clean, unlike attempt-haiku");
		expect(reports[1].reasons[0]).toMatch(/^its change introduces 3 catalog finding\(s\): Unapproved model/);
	});
});

describe("/work routes", () => {
	const routeDeps: WorkRouteDeps = { ...deps, catalog, costs: async () => [] };
	const get = async (path: string) => {
		const res = await handleWorkRoute(new Request(`http://x${path}`), new URL(`http://x${path}`), routeDeps);
		return { status: res!.status, body: (await res!.json()) as any };
	};

	it("resolves a fork to its project and serves work, overlap, attempts and compare", async () => {
		expect((await get("/work?repo=agents-demo-r2")).body.project).toBe("agents-demo-full");
		expect((await get("/work/overlap?repo=agents-demo-full&paths=packages/agents/src/mcp/abort.ts")).body.overlaps.map((o: any) => o.repo)).toEqual(["agents-demo-mcp"]);
		expect((await get("/work/attempts?repo=agents-demo-full")).body.sets[0]).toMatchObject({ task: "feature#uploads" });
		expect((await get("/work/compare?repo=agents-demo-full&task=feature%23uploads")).body.attempts[0].verdict).toBe("pick");
		expect((await get("/work/compare?repo=agents-demo-full&task=nope")).status).toBe(404);
		expect((await get("/work?repo=../x")).status).toBe(400);
	});
});
