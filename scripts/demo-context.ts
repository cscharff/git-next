// Offline demo: POST /context equivalents over a local checkout for a few example tasks.
// Usage: node scripts/demo-context.ts <checkout-dir> > samples/context-agents-demo-full.json
import { buildContext } from "../src/providers/context/index.ts";
import { demoLayers, localContext, readCheckout } from "./local.ts";

const dir = process.argv[2];
const files = readCheckout(dir, /(\.mdx?|(^|\/)package\.json|(^|\/)pnpm-lock\.yaml|\.oxfmtrc\.json)$/);
files[".gitnext/stack.json"] = demoLayers()[".gitnext/stack.json"];
const ctx = localContext("agents-demo-full", files);

const tasks = [
	{ task: "Fix MCP client reconnect when the transport drops", paths: ["packages/agents/src/mcp/client.ts"], budgetTokens: 4000 },
	{ task: "Add a new example showing scheduled tasks with Workflows", paths: ["examples/workflows/src/server.ts"], budgetTokens: 3000 },
	{ task: "Change how the agent-think repro agent reports results on GitHub issues", paths: ["agent-think/src/index.ts"], budgetTokens: 3000 },
];

const results = [];
for (const t of tasks) results.push(await buildContext(ctx, { repo: "agents-demo-full", ref: "main", ...t }));
console.log(JSON.stringify({ offline: true, note: "Built from a local clone of cloudflare/agents at the same HEAD as agents-demo-full, with the demo layers from fixtures/demo-layers.", results }, null, 2));
