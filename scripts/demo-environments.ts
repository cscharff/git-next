// Offline demo: the MOCKED multi-cloud slice for agents-demo-full. Environments from fixtures/demo-environments
// (staging-cf is real Cloudflare config; prod-aws, analytics-gcp and onprem are declared, never read from a cloud),
// the demo stack with the private-cloud layer, and cost from the gateway fixture plus mocked Bedrock/Vertex/vLLM logs.
// Usage: node scripts/demo-environments.ts [checkout-dir] > samples/environments-demo.json
// Without a checkout, agent-think/wrangler.jsonc is rebuilt from the bindings the live resource-map run recorded
// in samples/insights-demo.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import type { Insight } from "../src/core/types.ts";
import { parseCatalog } from "../src/providers/catalog.ts";
import { fixtureCostSource } from "../src/providers/cost/index.ts";
import { withMockedClouds } from "../src/providers/cost/mocked.ts";
import { createRegistry } from "../src/registry.ts";
import { DEMO_LAYERS_REPO, demoLayers } from "./local.ts";

const WRANGLER = "agent-think/wrangler.jsonc";
const fixture = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");
const dir = process.argv[2];

type B = { name: string; resource?: string };
/** A wrangler config with the recorded bindings (resource-map metrics), enough for the environments provider. */
function fromRecorded(): string {
	const sample = JSON.parse(readFileSync(new URL("../samples/insights-demo.json", import.meta.url), "utf8")) as { insights: Insight[] };
	const i = sample.insights.find((x) => x.provider === "resource-map" && x.scope.path === WRANGLER);
	if (!i) throw new Error(`${WRANGLER} is not in samples/insights-demo.json`);
	const b = (i.metrics!.bindings ?? {}) as Record<string, B[]>;
	const cfg: Record<string, unknown> = { name: i.metrics!.worker };
	if (b.durable_objects) cfg.durable_objects = { bindings: b.durable_objects.map((x) => ({ name: x.name, class_name: x.resource })) };
	if (b.r2_buckets) cfg.r2_buckets = b.r2_buckets.map((x) => ({ binding: x.name, bucket_name: x.resource }));
	if (b.kv_namespaces) cfg.kv_namespaces = b.kv_namespaces.map((x) => ({ binding: x.name, id: x.resource }));
	if (b.d1_databases) cfg.d1_databases = b.d1_databases.map((x) => ({ binding: x.name, database_name: x.resource }));
	if (b.hyperdrive) cfg.hyperdrive = b.hyperdrive.map((x) => ({ binding: x.name, id: x.resource }));
	if (b.vectorize) cfg.vectorize = b.vectorize.map((x) => ({ binding: x.name, index_name: x.resource }));
	if (b.queues) cfg.queues = { producers: b.queues.filter((x) => !x.name.startsWith("consumer:")).map((x) => ({ binding: x.name, queue: x.resource })) };
	if (b.ai) cfg.ai = { binding: b.ai[0].name };
	if (b.services) cfg.services = b.services.map((x) => ({ binding: x.name, service: x.resource?.split("#")[0], entrypoint: x.resource?.split("#")[1] }));
	if (b.containers) cfg.containers = b.containers.map((x) => ({ class_name: x.name, image: x.resource }));
	return JSON.stringify(cfg, null, "\t");
}

const wrangler = dir && existsSync(join(dir, WRANGLER)) ? readFileSync(join(dir, WRANGLER), "utf8") : fromRecorded();
const repo = "agents-demo-full";
const main = { ".gitnext/environments.json": fixture("demo-environments/environments.json"), ".gitnext/stack.json": fixture("demo-environments/stack.json"), [WRANGLER]: wrangler };
const files = new RepoContext(async (name) => memorySource(name === DEMO_LAYERS_REPO ? { HEAD: demoLayers() } : { main }));
const baseline = parseCatalog(fixture("org-baseline/catalog.json"));
const started = Date.now();
const result = await createRegistry(withMockedClouds(fixtureCostSource()), { baseline }).run({ repo, ref: "main", files }, ["environments", "instruction-stack", "cost"]);
console.log(
	JSON.stringify(
		{
			mocked: true,
			note: `MOCKED multi-cloud demo. staging-cf is ${dir ? "the real" : "agents-demo-full's recorded"} ${WRANGLER}; prod-aws, analytics-gcp and onprem are declared in fixtures/demo-environments/environments.json and never read from a cloud. Cost: fixtures/ai-gateway-logs.json plus mocked Bedrock, Vertex AI and vLLM records (fixtures/mocked-clouds). Instruction stack: fixtures/demo-environments/stack.json (demo layers plus an on-prem layer scoped to env=private).`,
			repo,
			ref: "main",
			ms: Date.now() - started,
			...result,
		},
		null,
		2,
	),
);
