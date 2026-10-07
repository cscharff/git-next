import { describe, expect, it } from "vitest";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { costProvider, fixtureCostSource, usd } from "../src/providers/cost/index.ts";
import { gatewayLogsSource, parseGatewayLogs, staticCostSource, taskLabelOf, UNATTRIBUTED } from "../src/providers/cost/logs.ts";
import { modelFit } from "../src/providers/cost/model-fit.ts";
import { median, rollup, spendFlags } from "../src/providers/cost/rollup.ts";

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
		expect(out.some((i) => i.title.startsWith("Model fit: changelog on claude-opus-5-5"))).toBe(true);
	});

	it("formats sub-cent spend with precision", () => {
		expect([usd(0.000153), usd(0), usd(12.104)]).toEqual(["$0.000153", "$0.00", "$12.10"]);
	});

	it("says so when a repo has no usage", async () => {
		const files = new RepoContext(async () => memorySource({}));
		const [i] = await costProvider(staticCostSource("empty", [])).analyze({ repo: "x", ref: "main", files });
		expect(i.title).toBe("No AI Gateway usage for this repo");
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
