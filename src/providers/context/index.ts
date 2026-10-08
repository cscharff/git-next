import type { RepoContext } from "../../core/repo-context.ts";
import { loadStack } from "../instruction-stack/index.ts";
import { effectiveRules, resolve } from "../instruction-stack/resolve.ts";
import type { Rule, RuleExtractor } from "../instruction-stack/types.ts";
import { CATALOG_FILE, catalogSummary, parseCatalog, relevantCatalogEntries, type Catalog } from "../catalog.ts";
import { Bm25Retriever, type Retriever, type Scored } from "./retrieve.ts";
import { estimateTokens, splitSections, type Section } from "./sections.ts";

export interface ContextRequest {
	repo: string;
	ref: string;
	task: string;
	paths: string[];
	budgetTokens: number;
	/** Catalog to pin when the repo has none of its own (e.g. the org baseline). */
	catalog?: Catalog;
}

export type RetrieverFactory = (sections: Section[]) => Retriever | Promise<Retriever>;

export const isMarkdown = (path: string) => /\.mdx?$/i.test(path) && !/(^|\/)CHANGELOG\.md$|(^|\/)changelogs?\//i.test(path);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const governs = (dir: string, path: string) => dir === "" || path === dir || path.startsWith(`${dir}/`);
const MANIFEST_LIMIT = 40;
const GENERIC_PATH_WORDS = new Set(["src", "lib", "ts", "tsx", "js", "jsx", "mjs", "index", "packages", "examples", "apps", "test", "tests", "server", "client", "main"]);
/** No single section may take more than this share of the budget; bigger ones are listed for on-demand fetch. */
const MAX_SECTION_SHARE = 0.35;

/** Keeps one section per distinct text (the shortest path, then the first); maps each kept id to its copies' paths. */
export function dedupeSections(all: Section[]): { sections: Section[]; copies: Map<string, string[]> } {
	const groups = new Map<string, Section[]>();
	for (const s of all) {
		const g = groups.get(s.text);
		g ? g.push(s) : groups.set(s.text, [s]);
	}
	const copies = new Map<string, string[]>();
	const keep = new Set<Section>();
	for (const g of groups.values()) {
		const first = g.reduce((a, b) => (b.path.length < a.path.length ? b : a));
		keep.add(first);
		if (g.length > 1) copies.set(first.id, g.filter((s) => s !== first).map((s) => s.path));
	}
	return { sections: all.filter((s) => keep.has(s)), copies };
}

/**
 * Builds a task-sized context: the resolved rules for the touched paths, then the best-matching markdown
 * sections that fit the token budget, plus a manifest of what was left out and why.
 */
/** Every markdown file at a ref, split into heading sections (also used to index embeddings at push time). */
export async function sectionsOf(files: RepoContext, repo: string, ref: string, mdFiles?: { path: string }[]): Promise<Section[]> {
	const list = mdFiles ?? (await files.find(repo, ref, isMarkdown));
	return (await Promise.all(list.map(async (f) => splitSections(f.path, (await files.readFile(repo, ref, f.path)) ?? "")))).flat();
}

export async function buildContext(files: RepoContext, req: ContextRequest, makeRetriever: RetrieverFactory = (s) => new Bm25Retriever(s), extractor?: RuleExtractor) {
	const { repo, ref, task, paths, budgetTokens } = req;
	const [stack, mdFiles] = await Promise.all([loadStack(files, repo, ref, extractor), files.find(repo, ref, isMarkdown)]);

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
	// A conflict matters for this task when both of its rules reach one of the touched paths.
	const reaches = (r: Rule, p: string) => governs(r.layer.scopeDir, p) && (!r.areas || r.areas.includes(p.split("/")[0]));
	const conflicts = resolve(stack.rules)
		.filter((f) => f.kind === "conflict" && (!paths.length || paths.some((p) => f.rules.every((r) => reaches(r, p)))))
		.map((f) => ({ topic: f.topic, explanation: f.explanation }));
	// Pinned (always loaded, never traded for doc sections): inherited musts from org/contract/tool layers,
	// a compact catalog summary, and the catalog entries relevant to this task.
	let catalog = req.catalog;
	const catalogText = await files.readFile(repo, ref, CATALOG_FILE);
	if (catalogText) {
		try {
			catalog = parseCatalog(catalogText);
		} catch {
			// an invalid repo catalog is reported by the catalog provider; fall back to the given one
		}
	}
	const pinnedMusts = [...ruleRows.values()].filter((r) => r.strength === "must" && r.kind !== "project" && r.kind !== "personal");
	const pinned = {
		musts: pinnedMusts.map((r) => ({ topic: r.topic, value: r.value, kind: r.kind, source: r.source })),
		catalog: catalog ? catalogSummary(catalog) : null,
		relevant: catalog ? relevantCatalogEntries(catalog, task) : [],
	};
	const rulesBlock = { rules: [...ruleRows.values()], conflicts };
	const pinnedTokens = estimateTokens(JSON.stringify(pinned));
	const rulesTokens = estimateTokens(JSON.stringify(rulesBlock)) + pinnedTokens;

	// 2. Index every markdown file into heading sections.
	const allSections = await sectionsOf(files, repo, ref, mdFiles);
	const tokensAllMarkdown = allSections.reduce((n, s) => n + s.tokens, 0);
	// Copies of a section (a skill vendored into every template) are indexed once, under the shortest path.
	const { sections, copies } = dedupeSections(allSections);
	const duplicateTokens = allSections.length === sections.length ? 0 : tokensAllMarkdown - sections.reduce((n, s) => n + s.tokens, 0);
	const instructionPaths = new Set(stack.layers.filter((l) => l.repo === repo).map((l) => l.path));
	// Instruction files an agent would load anyway for these paths (on-demand skills and commands aren't).
	const onPath = stack.layers.filter((l) => l.repo === repo && !l.onDemand && (paths.length ? paths.some((p) => governs(l.scopeDir, p)) : l.scopeDir === ""));
	const tokensInstructionFilesOnPath = onPath.reduce((n, l) => n + estimateTokens(stack.texts.get(l) ?? ""), 0);

	// 3. Retrieve and re-weight: governing instruction files and nearby docs up, unrelated instruction files down.
	const retriever = await makeRetriever(sections);
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
	const dup = (s: Section) => (copies.get(s.id)?.length ? { duplicates: copies.get(s.id)!.length, duplicatePaths: copies.get(s.id)!.slice(0, 10) } : {});

	return {
		repo,
		ref,
		task,
		paths,
		budgetTokens,
		retriever: retriever.id,
		pinned,
		...rulesBlock,
		sections: included.map(({ section: s, score }) => ({ id: s.id, path: s.path, headings: s.headings, startLine: s.startLine, tokens: s.tokens, score: round(score), text: s.text, ...dup(s) })),
		manifest: [
			...pinned.musts.map((m) => ({ id: `pinned:${m.topic}`, pinned: true, source: m.source })),
			...(pinned.catalog ? [{ id: `pinned:catalog@${catalog!.version}`, pinned: true, source: CATALOG_FILE }] : []),
			...included.map(({ section: s }) => ({ id: s.id, pinned: false, source: `${s.path}:${s.startLine}`, ...dup(s) })),
		],
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
			// Identical sections in other files (same text), indexed and served once.
			duplicateSections: allSections.length - sections.length,
			duplicateTokens,
			rulesTokens,
			pinnedTokens,
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
