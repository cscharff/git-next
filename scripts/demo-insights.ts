// Offline demo: every provider over a local checkout, with the demo layers wired in and the resource map
// diffed against an older commit of the same checkout.
// Usage: node scripts/demo-insights.ts <checkout-dir> <base-sha> > samples/insights-demo.json
//   or, reading every committed file at HEAD (catalog scans need code, not just config):
//        node scripts/demo-insights.ts <checkout-dir> --git --repo emdash-demo --catalog org [--no-layers] > samples/insights-emdash-demo-main.json
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { parseCatalog } from "../src/providers/catalog.ts";
import { createRegistry } from "../src/registry.ts";
import { DEMO_LAYERS_REPO, demoLayers, gitCheckoutSource, readCheckout } from "./local.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const [dir, baseSha] = argv.filter((a, i) => !a.startsWith("--") && !["--repo", "--catalog", "--note"].includes(argv[i - 1]));
const repo = option("--repo") ?? "agents-demo-full";
const layers = !flag("--no-layers");
const stack: Record<string, string> = layers ? { ".gitnext/stack.json": demoLayers()[".gitnext/stack.json"] } : {};

let files: RepoContext;
if (flag("--git")) {
	files = new RepoContext(async (name) => (name === DEMO_LAYERS_REPO ? memorySource({ HEAD: demoLayers() }) : gitCheckoutSource(dir, stack)));
} else {
	const wanted = /(^|\/)(wrangler\.(toml|json|jsonc)|AGENTS\.md|CLAUDE\.md|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.oxfmtrc\.jsonc?|\.prettierrc[^/]*|biome\.jsonc?|\.editorconfig)$/;
	const main = { ...readCheckout(dir, wanted), ...stack };
	// Base ref: wrangler configs as they were at baseSha (read through git, no checkout needed).
	const base: Record<string, string> = {};
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (baseSha) {
		for (const path of git("ls-tree", "-r", "--name-only", baseSha).split("\n")) {
			if (/(^|\/)wrangler\.(toml|json|jsonc)$/.test(path) && !path.includes("node_modules/")) base[path] = git("show", `${baseSha}:${path}`);
		}
	}
	files = new RepoContext(async (name) => memorySource(name === DEMO_LAYERS_REPO ? { HEAD: demoLayers() } : { main, ...(baseSha ? { [baseSha]: base } : {}) }));
}

// --catalog org: check the repo against the org baseline, as GET /insights?catalog=org does (no file cap offline).
const baseline = parseCatalog(readFileSync(new URL("../fixtures/org-baseline/catalog.json", import.meta.url), "utf8"));
const catalog = option("--catalog") === "org" ? { baseline, enforceBaseline: true, maxFiles: 100_000 } : undefined;
const started = Date.now();
const result = await createRegistry(undefined, catalog).run({ repo, ref: "main", ...(baseSha ? { base: baseSha } : {}), files });
console.log(
	JSON.stringify(
		{
			offline: true,
			note:
				option("--note") ??
				"Local clone of cloudflare/agents at the agents-demo-full HEAD, demo instruction layers from fixtures/demo-layers, cost from fixtures/ai-gateway-logs.json.",
			repo,
			ref: "main",
			base: baseSha ?? null,
			ms: Date.now() - started,
			...result,
		},
		null,
		2,
	),
);
