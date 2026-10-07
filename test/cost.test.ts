import { describe, expect, it } from "vitest";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { costProvider, fixtureCostSource, modelPolicy, usd } from "../src/providers/cost/index.ts";
import { parseCatalog } from "../src/providers/catalog.ts";
import { readFileSync } from "node:fs";
import { gatewayLogsSource, parseGatewayLogs, staticCostSource, taskLabelOf, UNATTRIBUTED } from "../src/providers/cost/logs.ts";
import { modelFit } from "../src/providers/cost/model-fit.ts";
import { byCloud, median, rollup, spendFlags } from "../src/providers/cost/rollup.ts";
import { withMockedClouds } from "../src/providers/cost/mocked.ts";

const log = (over: Record<string, unknown>, meta: Record<string, unknown> | string = {}) => ({
	id: "l",
	created_at: "2026-10-07T00:00:00Z",
	provider: "anthropic",
	model: "claude-opus-5-5",
	tokens_in: 1_000_000,
	tokens_out: 100_000,
	cost: 22.5,
	cached: false,
	success: true,
	metadata: meta,
	...over,
});

describe("parseGatewayLogs", () => {
	it("accepts the API envelope, metadata objects and JSON-string metadata", () => {
		const recs = parseGatewayLogs({ result: [log({}, { developer: "chris", repo: "r", fork: "chris/x", agent: "claude-code", task: "format#1" }), log({ id: "2" }, '{"developer":"maya","task":"triage: issue 9"}')] });
		expect(recs[0]).toMatchObject({ developer: "chris", repo: "r", fork: "chris/x", agent: "claude-code", taskLabel: "format", tokensIn: 1_000_000, cost: 22.5 });
		expect(recs[1]).toMatchObject({ developer: "maya", taskLabel: "triage", repo: UNATTRIBUTED });
	});

	it("marks missing metadata as unattributed and tolerates bad fields", () => {
		const [r] = parseGatewayLogs([{ id: 7, tokens_in: "12", metadata: "{not json" }]);
		expect(r).toMatchObject({ developer: UNATTRIBUTED, tokensIn: 12, cost: 0, model: "unknown", taskLabel: UNATTRIBUTED });
		expect(() => parseGatewayLogs({ result: "nope" })).toThrow();
	});

	it("derives task labels", () => {
		expect(taskLabelOf("Changelog#412")).toBe("changelog");
		expect(taskLabelOf("123")).toBe("other");
	});
});

describe("rollup and flags", () => {
	const meta = (developer: string, agent: string, task: string) => ({ developer, repo: "r", fork: `${developer}/f`, agent, task });
	const recs = parseGatewayLogs([
		log({ cost: 10 }, meta("a", "x", "debug#1")),
		log({ cost: 1 }, meta("a", "x", "format#2")),
		log({ cost: 2 }, meta("b", "y", "feature#3")),
		log({ cost: 3 }, meta("c", "z", "feature#4")),
	]);

	it("sums each level project → developer → fork → agent → task", () => {
		const [project] = rollup(recs);
		expect(project).toMatchObject({ level: "project", key: "r", cost: 16, requests: 4 });
		expect(project.children.map((d) => [d.key, d.cost])).toEqual([
			["a", 11],
			["c", 3],
			["b", 2],
		]);
		const task = project.children[0].children[0].children[0].children;
		expect(task.map((t) => t.key)).toEqual(["debug#1", "format#2"]);
	});

	it("flags spend above 2× the median", () => {
		expect(median([1, 3, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(spendFlags(recs).map((f) => `${f.level}:${f.key}:${f.multiple}`)).toEqual(["developer:a:3.67", "agent:x:3.67"]);
	});
});

describe("modelFit", () => {
	it("suggests a cheaper tier for mechanical tasks and estimates the saving", () => {
		const recs = parseGatewayLogs([log({}, { agent: "docs-bot", task: "changelog#1" }), log({ cached: true, cost: 0 }, { agent: "docs-bot", task: "changelog#2" }), log({}, { agent: "cc", task: "feature#3" })]);
		const [s, ...rest] = modelFit(recs);
		expect(rest).toEqual([]);
		expect(s).toMatchObject({ agent: "docs-bot", taskLabel: "changelog", suggest: "@cf/zai-org/glm-5.3-flash", requests: 2, actualCost: 22.5 });
		// 1M in × $0.15 + 0.1M out × $0.50 = $0.20
		expect(s.estimatedCost).toBe(0.2);
		expect(s.estimatedSaving).toBe(22.3);
	});
});

describe("costProvider", () => {
	it("reports totals, agents, spend flags and model-fit suggestions from the fixture", async () => {
		const files = new RepoContext(async () => memorySource({}));
		const out = await costProvider(fixtureCostSource()).analyze({ repo: "agents-demo-full", ref: "main", files });
		expect(out[0].title).toMatch(/^AI spend \$\d+\.\d\d across 62 requests$/);
		expect(out.some((i) => i.severity === "warn" && i.title.startsWith("developer devon"))).toBe(true);
		expect(out.some((i) => i.title.startsWith("Model fit: changelog on anthropic/claude-opus-5.5"))).toBe(true);
	});

	it("formats sub-cent spend with precision", () => {
		expect([usd(0.000153), usd(0), usd(12.104)]).toEqual(["$0.000153", "$0.00", "$12.10"]);
	});

	it("scopes a fork's insights to records tagged with that fork", async () => {
		const files = new RepoContext(async () => memorySource({}));
		const out = await costProvider(fixtureCostSource()).analyze({ repo: "devon/think-repro", ref: "main", files });
		expect(out[0].title).toMatch(/across 20 requests$/);
		expect(out.filter((i) => i.scope.agent).map((i) => i.scope.agent)).toContain("agent-think");
	});

	it("says so when a repo has no usage", async () => {
		const files = new RepoContext(async () => memorySource({}));
		const [i] = await costProvider(staticCostSource("empty", [])).analyze({ repo: "x", ref: "main", files });
		expect(i.title).toBe("No AI Gateway usage for this repo");
	});
});

describe("modelPolicy", () => {
	it("flags models outside the catalog and planning-only models doing code work", () => {
		const catalog = parseCatalog(readFileSync(new URL("../fixtures/org-baseline/catalog.json", import.meta.url), "utf8"));
		const recs = parseGatewayLogs([
			log({ model: "anthropic/claude-fable-5.1" }, { agent: "planner", task: "plan#demo" }),
			log({ model: "anthropic/claude-fable-5.1" }, { agent: "docs-agent", task: "docs#typo" }),
			log({ model: "anthropic/claude-sonnet-5.5" }, { agent: "r2-agent", task: "feature#r2" }),
			log({ model: "anthropic/claude-opus-4.8" }, { agent: "old-agent", task: "docs#x" }),
		]);
		expect(modelPolicy(recs, catalog).map((p) => `${p.agent}:${p.reason}`)).toEqual(["docs-agent:outside-jobs", "old-agent:not-in-catalog"]);
	});
});

describe("gatewayLogsSource", () => {
	it("pages through the logs API, sends the token as a bearer header and filters on metadata.repo", async () => {
		const calls: { url: string; auth: string | null }[] = [];
		const page = (n: number, repo: string) => Array.from({ length: n }, (_, i) => log({ id: `${repo}-${i}`, cost: 0.01 }, { repo, agent: "a", task: "t#1" }));
		const pages = [[...page(30, "r"), ...page(20, "other")], page(5, "r")];
		const fetcher = (async (url: string, init?: RequestInit) => {
			calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
			return Response.json({ success: true, result: pages[calls.length - 1] ?? [] });
		}) as typeof fetch;
		const src = gatewayLogsSource({ accountId: "acct", gatewayId: "git-next", token: "test-token", fetcher });
		const recs = await src.records({ repo: "r" });
		expect(recs).toHaveLength(35);
		expect(calls).toHaveLength(2);
		expect(calls[0].url).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct\/ai-gateway\/gateways\/git-next\/logs\?/);
		expect(new URL(calls[1].url).searchParams.get("page")).toBe("2");
		expect(new URL(calls[0].url).searchParams.get("search")).toBe("r");
		expect(calls[0].auth).toBe("Bearer test-token");
		expect(calls.every((c) => !c.url.includes("test-token"))).toBe(true);
	});

	it("raises API errors without echoing the token", async () => {
		const fetcher = (async () => Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 })) as unknown as typeof fetch;
		const err = await gatewayLogsSource({ accountId: "a", gatewayId: "g", token: "secret-value", fetcher }).records({}).catch((e) => e);
		expect(String(err)).toContain("HTTP 403 Authentication error");
		expect(String(err)).not.toContain("secret-value");
	});
});

describe("cost by cloud (mocked clouds)", () => {
	const catalog = parseCatalog(readFileSync(new URL("../fixtures/org-baseline/catalog.json", import.meta.url), "utf8"));

	it("parses cloud tags, flags mocked records and rolls spend up by cloud", async () => {
		const recs = parseGatewayLogs([log({ cost: 2 }, { cloud: "aws" }), log({ cost: 1, mocked: true }, { cloud: "gcp" }), log({ cost: 4 }, { cloud: "azure" })]);
		expect(recs.map((r) => `${r.cloud}:${r.mocked}`)).toEqual(["aws:false", "gcp:true", "cloudflare:false"]);
		expect(byCloud(recs).map((c) => [c.cloud, c.cost, c.requests, c.mocked])).toEqual([
			["cloudflare", 4, 1, false],
			["aws", 2, 1, false],
			["gcp", 1, 1, true],
		]);
		const all = await withMockedClouds(staticCostSource("live", [])).records({ repo: "agents-demo-full" });
		expect(new Set(all.map((r) => r.cloud))).toEqual(new Set(["aws", "gcp", "private"]));
		expect(all.every((r) => r.mocked)).toBe(true);
	});

	it("suggests a cheaper equivalent on another cloud only where the catalog approves it", () => {
		const recs = parseGatewayLogs([
			log({ model: "bedrock/anthropic.claude-sonnet-5", cost: 4.5 }, { agent: "a", task: "review#1", cloud: "aws" }),
			log({ model: "vllm/glm-5.3-flash", cost: 0.06 }, { agent: "b", task: "summarize#1", cloud: "private" }),
			log({ model: "bedrock/anthropic.claude-sonnet-5", cost: 4.5 }, { agent: "c", task: "triage#1", cloud: "aws" }),
		]);
		const fits = modelFit(recs, catalog);
		// 1M in × $2 + 0.1M out × $10 = $3 on Cloudflare vs $4.50 on Bedrock.
		expect(fits).toEqual([expect.objectContaining({ agent: "a", cloud: "aws", suggest: "anthropic/claude-sonnet-5", suggestCloud: "cloudflare", estimatedCost: 3, estimatedSaving: 1.5 })]);
		// Without the catalog entry for the cheaper cloud, nothing is suggested; private work is never moved.
		const noCf = parseCatalog(JSON.stringify({ ...catalog, models: catalog.models.filter((m) => m.id !== "anthropic/claude-sonnet-5") }));
		expect(modelFit(recs, noCf)).toEqual([]);
		expect(modelFit(recs)).toEqual([]);
	});

	it("reports per-cloud spend and env-scoped insights, badged mocked", async () => {
		const files = new RepoContext(async () => memorySource({}));
		const out = await costProvider(withMockedClouds(fixtureCostSource()), { catalog }).analyze({ repo: "agents-demo-full", ref: "main", files });
		const m = out[0].metrics as { byCloud: { cloud: string; mocked: boolean }[]; clouds: string[]; mockedRequests: number };
		expect(m.clouds.sort()).toEqual(["aws", "cloudflare", "gcp", "private"]);
		expect(m.byCloud.find((c) => c.cloud === "cloudflare")?.mocked).toBe(false);
		expect(m.byCloud.filter((c) => c.mocked).map((c) => c.cloud).sort()).toEqual(["aws", "gcp", "private"]);
		expect(m.mockedRequests).toBe(25);
		expect(out[0].detail).toContain("MOCKED");
		expect(out.filter((i) => i.scope.env && !i.scope.agent).map((i) => i.title.split(":")[0]).sort()).toEqual(["aws (mocked)", "cloudflare", "gcp (mocked)", "private (mocked)"]);
		const cross = out.filter((i) => i.metrics?.suggestCloud);
		expect(cross.map((i) => i.title)).toEqual(["Model fit: feature on vertex/anthropic.claude-opus-5.5 → anthropic/claude-opus-5.5 (cloudflare)", "Model fit: review on bedrock/anthropic.claude-sonnet-5 → anthropic/claude-sonnet-5 (cloudflare)"]);
		expect(cross.every((i) => i.scope.env?.mocked)).toBe(true);
		expect(out.some((i) => i.title === "Catalog: analytics-agent used vertex/gemini-3-flash" && i.scope.env?.cloud === "gcp")).toBe(true);
	});
});
