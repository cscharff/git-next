// Offline demo: every provider over a local checkout, with the demo layers wired in and the resource map
// diffed against an older commit of the same checkout.
// Usage: node scripts/demo-insights.ts <checkout-dir> <base-sha> > samples/insights-demo.json
import { execFileSync } from "node:child_process";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { createRegistry } from "../src/registry.ts";
import { DEMO_LAYERS_REPO, demoLayers, readCheckout } from "./local.ts";

const [dir, baseSha] = process.argv.slice(2);
const wanted = /(^|\/)(wrangler\.(toml|json|jsonc)|AGENTS\.md|CLAUDE\.md|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.oxfmtrc\.jsonc?|\.prettierrc[^/]*|biome\.jsonc?|\.editorconfig)$/;
const main = readCheckout(dir, wanted);
main[".gitnext/stack.json"] = demoLayers()[".gitnext/stack.json"];

// Base ref: wrangler configs as they were at baseSha (read through git, no checkout needed).
const base: Record<string, string> = {};
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
for (const path of git("ls-tree", "-r", "--name-only", baseSha).split("\n")) {
	if (/(^|\/)wrangler\.(toml|json|jsonc)$/.test(path) && !path.includes("node_modules/")) base[path] = git("show", `${baseSha}:${path}`);
}

const repo = "agents-demo-full";
const files = new RepoContext(async (name) => memorySource(name === DEMO_LAYERS_REPO ? { HEAD: demoLayers() } : { main, [baseSha]: base }));
const started = Date.now();
const result = await createRegistry().run({ repo, ref: "main", base: baseSha, files });
console.log(
	JSON.stringify(
		{
			offline: true,
			note: "Local clone of cloudflare/agents at the agents-demo-full HEAD, demo instruction layers from fixtures/demo-layers, cost from fixtures/ai-gateway-logs.json.",
			repo,
			ref: "main",
			base: baseSha,
			ms: Date.now() - started,
			...result,
		},
		null,
		2,
	),
);
