import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { insightClouds, type Insight } from "../src/core/types.ts";
import { bindingApproval, catalogSummary, equivalentApproval, equivalentModels, parseCatalog } from "../src/providers/catalog.ts";
import { instructionStackProvider } from "../src/providers/instruction-stack/index.ts";
import { effectiveRules, resolve } from "../src/providers/instruction-stack/resolve.ts";
import { KIND_RANK, type Layer, type Rule } from "../src/providers/instruction-stack/types.ts";
import { cloudflareResources, ENVIRONMENTS_FILE, environmentsProvider, parseEnvironments } from "../src/providers/environments.ts";

const catalog = parseCatalog(readFileSync(new URL("../fixtures/org-baseline/catalog.json", import.meta.url), "utf8"));
const demoEnvs = readFileSync(new URL("../fixtures/demo-environments/environments.json", import.meta.url), "utf8");
// Bindings as recorded for agent-think/wrangler.jsonc in samples/insights-demo.json.
const agentThink = JSON.stringify({
	name: "agent-think",
	durable_objects: { bindings: [{ name: "ThinkAgent", class_name: "ThinkAgent" }, { name: "Sandbox", class_name: "Sandbox" }] },
	r2_buckets: [{ binding: "R2_SKILLS", bucket_name: "agent-think-skills" }],
	ai: { binding: "AI" },
	services: [{ binding: "GITHUB_AUTH", service: "gh-app" }],
	containers: [{ class_name: "Sandbox", image: "./Dockerfile" }],
});

describe("catalog equivalents", () => {
	it("approves object-store as R2, GCS, S3 and MinIO/Ceph by cloud", () => {
		expect(equivalentApproval(catalog, { cloud: "cloudflare", kind: "object-store", service: "R2", type: "r2_buckets" }).approved).toBe(true);
		for (const [cloud, service] of [["gcp", "GCS"], ["aws", "S3"], ["private", "MinIO"], ["private", "ceph"]] as const) expect(equivalentApproval(catalog, { cloud, kind: "object-store", service }).approved).toBe(true);
		const s3OnGcp = equivalentApproval(catalog, { cloud: "gcp", kind: "object-store", service: "S3" });
		expect(s3OnGcp).toMatchObject({ approved: false, reason: "S3 is not an approved object-store on gcp", alternative: "approved on gcp: GCS" });
		expect(s3OnGcp.equivalents).toContainEqual({ cloud: "private", service: "Ceph" });
		expect(equivalentApproval(catalog, { cloud: "gcp", kind: "sql-db", service: "BigQuery" }).approved).toBe(false);
	});

	it("keeps Cloudflare checks and agent summaries to Cloudflare entries", () => {
		expect(bindingApproval(catalog, "s3")).toMatchObject({ approved: false });
		expect(bindingApproval(catalog, "r2_buckets", "acme-shared-uploads").approved).toBe(true);
		const summary = catalogSummary(catalog);
		expect(summary).not.toMatch(/bedrock|vertex|vllm|minio|\bs3\b/i);
	});

	it("finds the same model approved on other clouds", () => {
		expect(equivalentModels(catalog, "bedrock/anthropic.claude-sonnet-5").map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
		expect(equivalentModels(catalog, "anthropic/claude-sonnet-5.5")).toEqual([]);
	});

	it("rejects unknown clouds and kinds", () => {
		expect(() => parseCatalog('{"version":"1","models":[{"id":"m","cloud":"azure"}],"bindings":[]}')).toThrow(/cloud/);
		expect(() => parseCatalog('{"version":"1","models":[],"bindings":[{"type":"x","class":"blob"}]}')).toThrow(/resource kind/);
	});
});

describe("environments", () => {
	it("maps wrangler bindings to normalized kinds", () => {
		const rs = cloudflareResources(
			"wrangler.jsonc",
			JSON.stringify({
				name: "w",
				r2_buckets: [{ binding: "B", bucket_name: "b" }],
				d1_databases: [{ binding: "D", database_name: "d" }],
				hyperdrive: [{ binding: "H", id: "h" }],
				kv_namespaces: [{ binding: "K", id: "k" }],
				queues: { producers: [{ binding: "Q", queue: "q" }], consumers: [{ queue: "q" }] },
				durable_objects: { bindings: [{ name: "O", class_name: "O" }] },
				containers: [{ class_name: "C", image: "./Dockerfile" }],
				worker_loaders: [{ binding: "LOADER" }],
				ai: { binding: "AI" },
				vectorize: [{ binding: "V", index_name: "v" }],
				workflows: [{ binding: "WF", class_name: "WF" }],
			}),
		);
		expect(rs.map((r) => `${r.kind}:${r.service}:${r.name}`)).toEqual([
			"compute:Workers:w",
			"compute:Durable Objects:O",
			"kv-cache:Workers KV:k",
			"object-store:R2:b",
			"sql-db:D1:d",
			"queue:Queues:q",
			"ai:Workers AI:AI",
			"vector:Vectorize:v",
			"sql-db:Hyperdrive:h",
			"compute:Containers:./Dockerfile",
			"compute:Worker Loaders:LOADER",
		]);
		expect(rs.find((r) => r.name === "b")?.alias).toBe("B");
	});

	it("forces non-Cloudflare environments to mocked and reports bad entries", () => {
		const { file, errors } = parseEnvironments('{"environments":[{"name":"x","cloud":"aws","mocked":false,"resources":[{"kind":"blob","name":"b","service":"S3"}]},{"name":"y","cloud":"azure"}]}');
		expect(file.environments).toMatchObject([{ name: "x", cloud: "aws", mocked: true, resources: [] }]);
		expect(errors).toHaveLength(2);
	});

	const run = async () => {
		const files = new RepoContext(async () => memorySource({ main: { [ENVIRONMENTS_FILE]: demoEnvs, "agent-think/wrangler.jsonc": agentThink } }));
		return environmentsProvider({ baseline: catalog }).analyze({ repo: "agents-demo-full", ref: "main", files });
	};

	it("emits a kinds × environments matrix with the real Cloudflare column", async () => {
		const out = await run();
		const [summary] = out;
		expect(summary.title).toBe("Environments: 4 for agent-think (1 live, 3 mocked)");
		const m = summary.metrics as any;
		expect(m.kinds).toEqual(["object-store", "sql-db", "compute", "ai", "secrets"]);
		expect(m.matrix["object-store"]["staging-cf"]).toEqual([{ service: "R2", name: "agent-think-skills", approved: true }]);
		expect(m.matrix["object-store"]["prod-aws"][0]).toMatchObject({ service: "S3", approved: true });
		expect(m.matrix["sql-db"]["analytics-gcp"][0]).toMatchObject({ service: "BigQuery", approved: false });
		expect(m.environments.find((e: any) => e.name === "staging-cf")).toMatchObject({ mocked: false, resources: 6 });
		const prod = out.find((i) => i.scope.env?.name === "prod-aws")!;
		expect(prod.scope.env).toEqual({ cloud: "aws", name: "prod-aws", account: "acme-prod (mock)", region: "us-east-1", mocked: true });
		expect(prod.title).toContain("(mocked)");
	});

	it("flags drift, cross-cloud edges and unapproved mocked resources", async () => {
		const out = await run();
		const drift = out.filter((i) => i.title.startsWith("Environment drift"));
		expect(drift.map((d) => d.metrics!.kind)).toEqual(["object-store", "sql-db", "compute", "ai", "secrets"]);
		expect(drift[0].title).toBe("Environment drift: object-store is R2 on staging-cf, S3 on prod-aws, GCS on analytics-gcp, MinIO on onprem");
		expect(drift.every((d) => d.severity === "warn")).toBe(true);
		const edges = out.filter((i) => i.title.startsWith("Cross-cloud edge"));
		expect(edges.map((e) => e.title)).toEqual([
			"Cross-cloud edge: staging-cf:agent-think-skills (R2) → prod-aws:acme-prod-skills (S3)",
			"Cross-cloud edge: analytics-gcp:agent_events (BigQuery) → prod-aws:acme-prod-db (RDS Postgres)",
			"Cross-cloud edge: onprem:acme-skills-mirror (MinIO) → staging-cf:agent-think-skills (R2)",
		]);
		expect(edges[2].detail).toMatch(/private network/);
		expect(edges[0].scope.env).toMatchObject({ cloud: "cloudflare", mocked: false });
		const unapproved = out.filter((i) => i.title.startsWith("Not in catalog"));
		expect(unapproved.map((i) => i.title)).toEqual(["Not in catalog: BigQuery as sql-db on analytics-gcp"]);
		expect(unapproved[0].detail).toContain("Approved on gcp: Cloud SQL");
	});

	it("emits nothing without an environments file", async () => {
		const files = new RepoContext(async () => memorySource({ main: {} }));
		expect(await environmentsProvider().analyze({ repo: "r", ref: "main", files })).toEqual([]);
	});
});

describe("insightClouds", () => {
	const base = { severity: "info", title: "", detail: "", evidence: [] } as const;
	it("defaults to cloudflare, honours scope env and cross-cutting clouds", () => {
		expect(insightClouds({ ...base, provider: "resource-map", scope: { repo: "r", ref: "m" } } as Insight)).toEqual(["cloudflare"]);
		expect(insightClouds({ ...base, provider: "x", scope: { repo: "r", ref: "m", env: { cloud: "gcp" } } } as Insight)).toEqual(["gcp"]);
		expect(insightClouds({ ...base, provider: "x", scope: { repo: "r", ref: "m" }, metrics: { clouds: ["aws", "private"] } } as Insight)).toEqual(["aws", "private"]);
		expect(insightClouds({ ...base, provider: "instruction-stack", scope: { repo: "r", ref: "m" } } as Insight)).toHaveLength(4);
	});
});

describe("environment-scoped rules", () => {
	const layer = (name: string, env?: Layer["env"]): Layer => ({ name, kind: "org", rank: KIND_RANK.org, depth: 0, repo: "layers", path: `${name}/AGENTS.md`, scopeDir: "", origin: "stack", ...(env ? { env } : {}) });
	const rule = (value: string, l: Layer): Rule => ({ topic: "modelRouting", value, strength: "must", layer: l, line: 1, text: value });
	const org = rule("org-gateway", layer("org"));

	it("reports a conflict with an env-scoped layer only for that environment", () => {
		const [f, ...rest] = resolve([org, rule("on-prem", layer("onprem", "private"))]);
		expect(rest).toEqual([]);
		expect(f).toMatchObject({ kind: "conflict", topic: "modelRouting", env: "private" });
		expect(f.explanation).toContain("in private environments");
		// Rules scoped to different environments never meet.
		expect(resolve([rule("on-prem", layer("a", "private")), rule("org-gateway", layer("b", "aws"))])).toEqual([]);
		// Effective rules: unscoped by default, plus the env's own when asked.
		expect(effectiveRules([org, rule("on-prem", layer("onprem", "private"))], "").map((r) => r.value)).toEqual(["org-gateway"]);
		expect(effectiveRules([org, rule("on-prem", layer("onprem", "private"))], "", "private").map((r) => r.value)).toEqual(["org-gateway", "on-prem"]);
	});

	it("flows from stack.json through the extractor and resolver to an env-scoped insight", async () => {
		const read = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");
		const layers = { "org/AGENTS.md": read("demo-layers/org/AGENTS.md"), "private/AGENTS.md": read("demo-layers/private/AGENTS.md"), "contract/AGENTS.md": read("demo-layers/contract/AGENTS.md"), "tool/AGENTS.md": read("demo-layers/tool/AGENTS.md"), "personal/AGENTS.md": read("demo-layers/personal/AGENTS.md") };
		const files = new RepoContext(async (name) => memorySource(name === "git-next-demo-layers" ? { HEAD: layers } : { main: { ".gitnext/stack.json": read("demo-environments/stack.json"), "AGENTS.md": "# Project\n" } }));
		const out = await instructionStackProvider().analyze({ repo: "agents-demo-full", ref: "main", files });
		const scoped = out.filter((i) => i.scope.env);
		expect(scoped.map((i) => i.title)).toEqual(["conflict: modelRouting (env private)"]);
		expect(scoped[0].scope.env).toEqual({ cloud: "private", mocked: true });
		expect((scoped[0].metrics!.values as { value: string; env?: string }[]).map((v) => `${v.value}${v.env ? `@${v.env}` : ""}`)).toEqual(["org-gateway", "on-prem@private"]);
		expect(insightClouds(scoped[0])).toEqual(["private"]);
		expect((out[0].metrics!.layers as { name: string; env?: string }[]).find((l) => l.name === "onprem-platform")?.env).toBe("private");
	});

	it("rejects an unknown env on a stack layer", async () => {
		const files = new RepoContext(async () => memorySource({ main: { ".gitnext/stack.json": '{"layers":[{"name":"x","kind":"org","path":"x.md","env":"azure"}]}' } }));
		const [summary] = await instructionStackProvider().analyze({ repo: "r", ref: "main", files });
		expect(summary.detail).toMatch(/env must be one of/);
	});
});
