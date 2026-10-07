import type { RepoContext } from "../../core/repo-context.ts";
import { loadStack } from "../instruction-stack/index.ts";
import { effectiveRules, resolve } from "../instruction-stack/resolve.ts";
import type { Rule } from "../instruction-stack/types.ts";
import { Bm25Retriever, type Retriever, type Scored } from "./retrieve.ts";
import { estimateTokens, splitSections, type Section } from "./sections.ts";

export interface ContextRequest {
	repo: string;
	ref: string;
	task: string;
	paths: string[];
	budgetTokens: number;
}

export type RetrieverFactory = (sections: Section[]) => Retriever;

export const isMarkdown = (path: string) => /\.mdx?$/i.test(path) && !/(^|\/)CHANGELOG\.md$/i.test(path);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const governs = (dir: string, path: string) => dir === "" || path === dir || path.startsWith(`${dir}/`);
const MANIFEST_LIMIT = 40;
const GENERIC_PATH_WORDS = new Set(["src", "lib", "ts", "tsx", "js", "jsx", "mjs", "index", "packages", "examples", "apps", "test", "tests", "server", "client", "main"]);
/** No single section may take more than this share of the budget; bigger ones are listed for on-demand fetch. */
const MAX_SECTION_SHARE = 0.35;

/**
 * Builds a task-sized context: the resolved rules for the touched paths, then the best-matching markdown
 * sections that fit the token budget, plus a manifest of what was left out and why.
 */
export async function buildContext(files: RepoContext, req: ContextRequest, makeRetriever: RetrieverFactory = (s) => new Bm25Retriever(s)) {
	const { repo, ref, task, paths, budgetTokens } = req;
	const [stack, mdFiles] = await Promise.all([loadStack(files, repo, ref), files.find(repo, ref, isMarkdown)]);

	// 1. Rules: winners per topic for each touched directory, and conflicts that reach those paths.
	const dirs = [...new Set(paths.map(dirOf))];
	const ruleRows = new Map<string, { topic: string; value: string; strength: string; layer: string; kind: string; source: string; appliesTo: string[] }>();
	for (const dir of dirs.length ? dirs : [""]) {
		for (const r of effectiveRules(stack.rules, dir)) {
			const key = `${r.topic}|${r.value}|${r.layer.path}`;
			const row = ruleRows.get(key) ?? { topic: r.topic, value: r.value, strength: r.strength, layer: r.layer.name, kind: r.layer.kind, source: `${r.layer.repo}/${r.layer.path}:${r.line}`, appliesTo: [] };
			row.appliesTo.push(dir || ".");
			ruleRows.set(key, row);
		}
	}
	const touches = (r: Rule) => (paths.length ? paths.some((p) => governs(r.layer.scopeDir, p)) : true);
	const conflicts = resolve(stack.rules)
		.filter((f) => f.kind === "conflict" && f.rules.some(touches))
		.map((f) => ({ topic: f.topic, explanation: f.explanation }));
	const rulesBlock = { rules: [...ruleRows.values()], conflicts };
	const rulesTokens = estimateTokens(JSON.stringify(rulesBlock));

	// 2. Index every markdown file into heading sections.
	const sections = (await Promise.all(mdFiles.map(async (f) => splitSections(f.path, (await files.readFile(repo, ref, f.path)) ?? "")))).flat();
	const tokensAllMarkdown = sections.reduce((n, s) => n + s.tokens, 0);
	const instructionPaths = new Set(stack.layers.filter((l) => l.repo === repo).map((l) => l.path));
	const onPath = stack.layers.filter((l) => l.repo === repo && (paths.length ? paths.some((p) => governs(l.scopeDir, p)) : l.scopeDir === ""));
	const tokensInstructionFilesOnPath = onPath.reduce((n, l) => n + estimateTokens(stack.texts.get(l) ?? ""), 0);

	// 3. Retrieve and re-weight: governing instruction files and nearby docs up, unrelated instruction files down.
	const retriever = makeRetriever(sections);
	// Task words count double; path words only when specific (not "src", "ts", "packages"...).
	const pathWords = paths.flatMap((p) => p.split(/[/._-]/)).filter((w) => w && !GENERIC_PATH_WORDS.has(w.toLowerCase()));
	const query = `${task} ${task} ${pathWords.join(" ")}`;
	const topDirs = new Set(paths.map((p) => p.split("/")[0]));
	const weight = (s: Section) => {
		if (instructionPaths.has(s.path)) return paths.some((p) => governs(dirOf(s.path), p)) ? 1.5 : 0.4;
		return topDirs.has(s.path.split("/")[0]) ? 1.2 : 1;
	};
	const ranked: Scored[] = (await retriever.search(query, sections.length))
		.map((r) => ({ section: r.section, score: r.score * weight(r.section) }))
		.sort((a, b) => b.score - a.score);

	// 4. Pack greedily within the budget left after the rules block.
	let remaining = budgetTokens - rulesTokens;
	const maxSection = Math.floor(budgetTokens * MAX_SECTION_SHARE);
	const included: Scored[] = [];
	const omitted: (Scored & { reason: "budget" | "oversized" })[] = [];
	for (const r of ranked) {
		if (r.section.tokens > maxSection) {
			omitted.push({ ...r, reason: "oversized" });
		} else if (r.section.tokens <= remaining) {
			included.push(r);
			remaining -= r.section.tokens;
		} else {
			omitted.push({ ...r, reason: "budget" });
		}
	}
	const sectionTokens = included.reduce((n, r) => n + r.section.tokens, 0);
	const tokensServed = rulesTokens + sectionTokens;
	const round = (n: number) => Math.round(n * 1000) / 1000;

	return {
		repo,
		ref,
		task,
		paths,
		budgetTokens,
		retriever: retriever.id,
		...rulesBlock,
		sections: included.map(({ section: s, score }) => ({ id: s.id, path: s.path, headings: s.headings, startLine: s.startLine, tokens: s.tokens, score: round(score), text: s.text })),
		omitted: {
			count: omitted.length,
			oversized: omitted.filter((o) => o.reason === "oversized").length,
			tokens: omitted.reduce((n, r) => n + r.section.tokens, 0),
			unmatchedSections: sections.length - ranked.length,
			top: omitted.slice(0, MANIFEST_LIMIT).map(({ section: s, score, reason }) => ({ id: s.id, path: s.path, title: s.title, tokens: s.tokens, score: round(score), reason })),
		},
		stats: {
			markdownFiles: mdFiles.length,
			sections: sections.length,
			rulesTokens,
			sectionTokens,
			tokensServed,
			tokensAllMarkdown,
			tokensInstructionFilesOnPath,
			servedVsAllMarkdown: round(tokensServed / Math.max(1, tokensAllMarkdown)),
			servedVsInstructionFilesOnPath: round(tokensServed / Math.max(1, tokensInstructionFilesOnPath)),
		},
		errors: stack.errors,
	};
}
