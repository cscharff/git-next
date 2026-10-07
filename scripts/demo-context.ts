// Offline demo: POST /context equivalents over a local checkout for a few example tasks.
// Usage: node scripts/demo-context.ts <checkout-dir> > samples/context-agents-demo-full.json
//        node scripts/demo-context.ts <checkout-dir> --repo emdash-demo > samples/context-emdash-demo.json
//   (emdash-demo reads every committed file at HEAD, has no demo layers and pins the org baseline catalog)
import { readFileSync } from "node:fs";
import { RepoContext } from "../src/core/repo-context.ts";
import { parseCatalog } from "../src/providers/catalog.ts";
import { buildContext } from "../src/providers/context/index.ts";
import { demoLayers, gitCheckoutSource, localContext, readCheckout } from "./local.ts";

const dir = process.argv[2];
const repo = process.argv.includes("--repo") ? process.argv[process.argv.indexOf("--repo") + 1] : "agents-demo-full";

const TASKS: Record<string, { note: string; tasks: { task: string; paths: string[]; budgetTokens: number }[] }> = {
	"agents-demo-full": {
		note: "Built from a local clone of cloudflare/agents at the same HEAD as agents-demo-full, with the demo layers from fixtures/demo-layers.",
		tasks: [
			{ task: "Fix MCP client reconnect when the transport drops", paths: ["packages/agents/src/mcp/client.ts"], budgetTokens: 4000 },
			{ task: "Add a new example showing scheduled tasks with Workflows", paths: ["examples/workflows/src/server.ts"], budgetTokens: 3000 },
			{ task: "Change how the agent-think repro agent reports results on GitHub issues", paths: ["agent-think/src/index.ts"], budgetTokens: 3000 },
		],
	},
	"emdash-demo": {
		note: "Built from a local clone of emdash-cms/emdash at d4efb97 (git objects at HEAD), no demo layers, org baseline catalog pinned, keyword extractor.",
		tasks: [
			{ task: "Add a new storage adapter for media uploads", paths: ["packages/core/src/storage/index.ts", "packages/core/src/storage/types.ts"], budgetTokens: 4000 },
			{ task: "Build a plugin that adds a reading-time field to posts", paths: ["packages/plugins/reading-time/src/index.ts"], budgetTokens: 4000 },
			{ task: "Harden the sandboxed plugin runner that loads plugin code through the Worker Loader binding", paths: ["packages/cloudflare/src/sandbox/runner.ts"], budgetTokens: 3000 },
		],
	},
};
const spec = TASKS[repo];
if (!spec) throw new Error(`no tasks for ${repo}; known: ${Object.keys(TASKS).join(", ")}`);

let ctx: RepoContext;
let catalog;
if (repo === "agents-demo-full") {
	const files = readCheckout(dir, /(\.mdx?|(^|\/)package\.json|(^|\/)pnpm-lock\.yaml|\.oxfmtrc\.json)$/);
	files[".gitnext/stack.json"] = demoLayers()[".gitnext/stack.json"];
	ctx = localContext(repo, files);
} else {
	ctx = new RepoContext(async () => gitCheckoutSource(dir));
	catalog = parseCatalog(readFileSync(new URL("../fixtures/org-baseline/catalog.json", import.meta.url), "utf8"));
}

const results = [];
for (const t of spec.tasks) results.push(await buildContext(ctx, { repo, ref: "main", ...t, ...(catalog ? { catalog } : {}) }));
console.log(JSON.stringify({ offline: true, note: spec.note, results }, null, 2));
