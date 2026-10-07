// Offline demo: the instruction-stack provider over a local checkout with the demo layers wired in
// via fixtures/demo-layers/.gitnext/stack.json.
// Usage: node scripts/demo-stack.ts <checkout-dir> > samples/instruction-stack-demo-layers.json
import { instructionStackProvider } from "../src/providers/instruction-stack/index.ts";
import { demoLayers, localContext, readCheckout } from "./local.ts";

const dir = process.argv[2];
const files = readCheckout(dir, /(^|\/)(AGENTS\.md|CLAUDE\.md|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.oxfmtrc\.jsonc?|\.prettierrc[^/]*|biome\.jsonc?|\.editorconfig)$/);
files[".gitnext/stack.json"] = demoLayers()[".gitnext/stack.json"];

const insights = await instructionStackProvider().analyze({ repo: "agents-demo-full", ref: "main", files: localContext("agents-demo-full", files) });
console.log(
	JSON.stringify({ simulated: true, note: "Real agents-demo-full AGENTS.md/config files plus the hypothetical layers in fixtures/demo-layers.", repo: "agents-demo-full", ref: "main", insights }, null, 2),
);
