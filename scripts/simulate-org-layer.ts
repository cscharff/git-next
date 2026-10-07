// Offline demo: runs the instruction-stack provider over a local checkout plus a
// simulated org standards layer (via .gitnext/stack.json) to show conflict/drift output.
// Usage: node scripts/simulate-org-layer.ts <checkout-dir> > samples/instruction-stack-simulated-org.json
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { instructionStackProvider } from "../src/providers/instruction-stack/index.ts";

const dir = process.argv[2];
const wanted = /(^|\/)(AGENTS\.md|CLAUDE\.md|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|\.oxfmtrc\.jsonc?|\.prettierrc[^/]*|biome\.jsonc?|\.editorconfig)$/;
const files: Record<string, string> = {};
const walk = (d: string) => {
	for (const name of readdirSync(d)) {
		if (name === "node_modules" || name === ".git") continue;
		const p = join(d, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (wanted.test(relative(dir, p))) files[relative(dir, p)] = name.endsWith(".yaml") ? "" : readFileSync(p, "utf8");
	}
};
walk(dir);
files[".gitnext/stack.json"] = JSON.stringify({ layers: [{ name: "org-standards (simulated)", rank: 100, repo: "org-standards", path: "AGENTS.md" }] });

const org = ["- All repos must use npm workspaces.", "- Format with prettier.", "- Indent with 2 spaces.", "- Commit messages must follow Conventional Commits.", "- Never commit secrets or API keys."].join("\n");
const ctx = new RepoContext(async (name) => memorySource(name === "org-standards" ? { HEAD: { "AGENTS.md": org } } : { main: files }));
const insights = await instructionStackProvider().analyze({ repo: "agents-demo-full", ref: "main", files: ctx });
console.log(JSON.stringify({ simulated: true, note: "Real agents-demo-full instruction/config files plus a hypothetical org layer at equal rank to the root AGENTS.md.", insights }, null, 2));
