import type { Insight, InsightProvider } from "../core/types.ts";
import { isInstructionFile } from "./instruction-stack/index.ts";

// A deliberately small fifth provider: the template for writing your own. It reads CODEOWNERS and reports
// which instruction files (AGENTS.md / CLAUDE.md) nobody owns, since an unowned agent rulebook drifts.

const CODEOWNERS = /^(\.github\/|docs\/)?CODEOWNERS$/;

/** CODEOWNERS pattern → matcher, covering the common forms: `*`, `*.ext`, `/anchored/path`, `dir/`, `name`. */
function matcher(pattern: string): (path: string) => boolean {
	const anchored = pattern.startsWith("/");
	const body = pattern.replace(/^\//, "").replace(/\/$/, "/**");
	const re = body
		.split("**")
		.map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
		.join(".*");
	const full = new RegExp(`${anchored ? "^" : "(^|/)"}${re}(/.*)?$`);
	return (path) => full.test(path);
}

export function parseCodeowners(text: string): { pattern: string; owners: string[]; matches: (path: string) => boolean }[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/#.*/, "").trim())
		.filter(Boolean)
		.map((line) => {
			const [pattern, ...owners] = line.split(/\s+/);
			return { pattern, owners, matches: matcher(pattern) };
		});
}

/** Owners for a path: the last matching rule wins, as in GitHub. */
export const ownersOf = (rules: ReturnType<typeof parseCodeowners>, path: string) => rules.findLast((r) => r.matches(path))?.owners ?? [];

export const ownersProvider: InsightProvider = {
	id: "owners",
	title: "Instruction file owners",
	needs: ["tree", "files"],
	async analyze({ repo, ref, files }) {
		const [codeowners] = await files.find(repo, ref, (p) => CODEOWNERS.test(p));
		const instructionFiles = await files.find(repo, ref, isInstructionFile);
		if (!codeowners) {
			return [{ provider: "owners", severity: "info", scope: { repo, ref }, title: "No CODEOWNERS file", detail: `${instructionFiles.length} instruction files have no declared owner.`, evidence: [] }];
		}
		const rules = parseCodeowners((await files.readFile(repo, ref, codeowners.path)) ?? "");
		const unowned = instructionFiles.filter((f) => ownersOf(rules, f.path).length === 0);
		return [
			{
				provider: "owners",
				severity: "info",
				scope: { repo, ref, path: codeowners.path },
				title: `${instructionFiles.length - unowned.length}/${instructionFiles.length} instruction files have owners`,
				detail: `${rules.length} CODEOWNERS rules.`,
				evidence: [{ repo, path: codeowners.path }],
				metrics: { owners: Object.fromEntries(instructionFiles.map((f) => [f.path, ownersOf(rules, f.path)])) },
			},
			...unowned.map(
				(f): Insight => ({ provider: "owners", severity: "warn", scope: { repo, ref, path: f.path }, title: `Unowned instruction file: ${f.path}`, detail: "No CODEOWNERS rule covers it, so changes to these agent rules need no review.", evidence: [{ repo, path: f.path }] }),
			),
		];
	},
};
