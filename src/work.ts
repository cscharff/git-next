import { commitTrailers, lineDiff } from "./code.ts";
import type { ChangedFile, RepoContext } from "./core/repo-context.ts";
import { bindingApproval, modelApproved, scanModels, scanSecrets, type Catalog } from "./providers/catalog.ts";
import type { CostRecord } from "./providers/cost/logs.ts";
import { isWranglerConfig, parseWranglerConfig } from "./providers/resource-map.ts";
import type { IndexEntry } from "./results.ts";

// Work in flight on a project: every fork of it and every branch of it other than main that git.next has seen a push
// for, with the files each one changes. Two uses:
//   - overlap: before an agent starts, tell it who else is already changing the files it's about to touch;
//   - attempts: several agents given the same task (same Agent-Task trailer) on separate forks or branches, compared
//     side by side (diff size, what the change itself breaks, spend, overlap with other work) with a pick to merge.

export interface WorkItem {
	repo: string;
	ref: string;
	head: string;
	/** The project's main commit the change is measured from. */
	base: string;
	agent: string | null;
	task: string | null;
	updatedAt: string;
	files: ChangedFile[];
}

export interface WorkDeps {
	/** Live index entries (one per analysed repo/ref). */
	index(): Promise<IndexEntry[]>;
	/** The project a repo was forked from ("agents-demo-full"), or null when it isn't a fork. */
	sourceOf(repo: string): Promise<string | null>;
	files(repo: string): RepoContext;
	/** Forks of the project known to the repo host, so forks nobody has pushed to since analysis still count. */
	forksOf?(project: string): Promise<string[]>;
	/** Immutable per (repo, head, base): a change set never changes once computed. */
	cache?: { get(key: string): Promise<WorkItem | null>; put(key: string, item: WorkItem): Promise<void> };
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * Forks of `project` and its non-main branches, each with the files it changes relative to the project's main.
 * `extra` adds refs by name (e.g. branches just pushed that git.next hasn't analysed yet).
 */
export async function workInFlight(deps: WorkDeps, project: string, mainRef = "main", extra: { repo: string; ref: string }[] = []): Promise<WorkItem[]> {
	const [projectHead] = await deps.files(project).log(project, mainRef, 1);
	if (!projectHead) return [];
	const indexed = await deps.index();
	const forks = ((await deps.forksOf?.(project).catch(() => [])) ?? []).map((repo) => ({ repo, ref: mainRef }));
	const added = (
		await Promise.all(
			[...extra, ...forks]
				.filter((x) => !indexed.some((e) => e.repo === x.repo && e.ref === x.ref))
				.map(async (x): Promise<IndexEntry | null> => {
					const [head] = await deps.files(x.repo).log(x.repo, x.ref, 1).catch(() => []);
					return head ? { repo: x.repo, ref: x.ref, after: head.hash, updatedAt: new Date((head.committedAt < 1e12 ? head.committedAt * 1000 : head.committedAt) || Date.now()).toISOString(), conflicts: 0, warnings: 0, catalogViolations: 0, insights: 0, ms: 0 } : null;
				}),
		)
	).filter((e): e is IndexEntry => !!e);
	const entries = [...indexed, ...added];
	const candidates = (
		await Promise.all(
			entries.map(async (e) => {
				if (!e.after) return null;
				if (e.repo === project) return e.ref !== mainRef ? e : null;
				if (forks.some((f) => f.repo === e.repo)) return e;
				return (await deps.sourceOf(e.repo).catch(() => null)) === project ? e : null;
			}),
		)
	).filter((e): e is IndexEntry => !!e);
	const items = await Promise.all(
		candidates.map(async (e) => {
			const key = `${e.repo}/${e.after}/${projectHead.hash}`;
			const hit = await deps.cache?.get(key).catch(() => null);
			if (hit) return { ...hit, ref: e.ref, updatedAt: e.updatedAt };
			const files = deps.files(e.repo);
			const [[head], changed] = await Promise.all([files.log(e.repo, e.after!, 1), files.changedFiles(e.repo, projectHead.hash, e.after!).catch(() => [] as ChangedFile[])]);
			const t = head ? commitTrailers(head.message) : { agent: null, agentTask: null };
			const item: WorkItem = { repo: e.repo, ref: e.ref, head: e.after!, base: projectHead.hash, agent: t.agent ?? head?.author ?? null, task: t.agentTask, updatedAt: e.updatedAt, files: changed };
			await deps.cache?.put(key, item).catch(() => {});
			return item;
		}),
	);
	return items.filter((i) => i.files.length).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface Overlap {
	repo: string;
	ref: string;
	agent: string | null;
	task: string | null;
	updatedAt: string;
	/** Paths both touch. */
	same: string[];
	/** Paths it changes in the same folders (no exact match). */
	near: string[];
}

/** Other work that touches `paths` (exactly, or in the same folder), excluding the asker's own repo/ref. */
export function overlaps(work: WorkItem[], paths: string[], exclude?: { repo: string; ref?: string }): Overlap[] {
	const wanted = new Set(paths);
	const dirs = new Set(paths.map(dirOf));
	return work
		.filter((w) => !(exclude && w.repo === exclude.repo && (!exclude.ref || w.ref === exclude.ref)))
		.map((w) => {
			const same = w.files.filter((f) => wanted.has(f.path)).map((f) => f.path);
			const near = w.files.filter((f) => !wanted.has(f.path) && dirs.has(dirOf(f.path))).map((f) => f.path);
			return { repo: w.repo, ref: w.ref, agent: w.agent, task: w.task, updatedAt: w.updatedAt, same, near };
		})
		.filter((o) => o.same.length || o.near.length);
}

/** Tasks with two or more attempts in flight. */
export function attemptSets(work: WorkItem[]): { task: string; attempts: WorkItem[] }[] {
	const byTask = Map.groupBy(work.filter((w) => w.task), (w) => w.task!);
	return [...byTask].filter(([, ws]) => ws.length > 1).map(([task, attempts]) => ({ task, attempts }));
}

export interface ChangeFinding {
	kind: "model" | "gateway" | "binding" | "secret";
	title: string;
	path: string;
	line?: number;
}

/**
 * What the change itself introduces, checked against the org catalog: unapproved models, model calls that skip the
 * org gateway, unapproved bindings in changed wrangler configs, and inline secrets. Only changed files are read.
 */
export function checkChange(files: { path: string; text: string }[], catalog: Catalog): ChangeFinding[] {
	const out: ChangeFinding[] = [];
	for (const { path, text } of files) {
		for (const s of scanSecrets(path, text)) out.push({ kind: "secret", title: `Inline secret: ${s.kind}`, path, line: s.line });
		for (const m of scanModels(path, text)) if (!modelApproved(catalog, m.model)) out.push({ kind: "model", title: `Unapproved model: ${m.model}`, path, line: m.line });
		const call = text.split(/\r?\n/).findIndex((l) => /\.AI\.run\s*\(/.test(l) && !/^\s*(\/\/|\/?\*|#)/.test(l));
		if (call >= 0 && catalog.gateway && !text.includes(catalog.gateway.id)) out.push({ kind: "gateway", title: "Model call bypasses the org gateway", path, line: call + 1 });
		if (isWranglerConfig(path))
			for (const b of parseWranglerConfig(path, text).bindings) {
				const a = bindingApproval(catalog, b.type, b.resource);
				if (!a.approved) out.push({ kind: "binding", title: `Unapproved binding: ${b.type} ${b.name}${b.resource ? ` → ${b.resource}` : ""}`, path });
			}
	}
	return out;
}

export interface AttemptReport {
	repo: string;
	ref: string;
	head: string;
	agent: string | null;
	model: string | null;
	files: ChangedFile[];
	added: number;
	removed: number;
	findings: ChangeFinding[];
	cost: { usd: number; requests: number; tokensIn: number; tokensOut: number };
	/** Other in-flight work (outside this set of attempts) touching the same files. */
	overlaps: Overlap[];
	/** git.next's stored push result for the attempt, when there is one. */
	push: { conflicts: number; catalogViolations: number; warnings: number } | null;
	rank: number;
	verdict: "pick" | "ok" | "blocked";
	reasons: string[];
}

/**
 * Compares attempts at one task and picks one to merge. Order: attempts whose change introduces no catalog findings
 * first, then fewest overlaps with other work, then smallest diff, then lowest spend. Every report says why.
 */
export async function compareAttempts(
	attempts: WorkItem[],
	others: WorkItem[],
	deps: { files(repo: string): RepoContext; catalog: Catalog; costs: CostRecord[]; stored(repo: string, ref: string): Promise<IndexEntry | null> },
): Promise<AttemptReport[]> {
	const reports = await Promise.all(
		attempts.map(async (a): Promise<Omit<AttemptReport, "rank" | "verdict" | "reasons">> => {
			const files = deps.files(a.repo);
			const text = async (ref: string, path: string) => {
				const b = await files.readBytes(a.repo, ref, path).catch(() => null);
				return b ? new TextDecoder().decode(b) : null;
			};
			let added = 0;
			let removed = 0;
			const changedText: { path: string; text: string }[] = [];
			for (const f of a.files.slice(0, 60)) {
				const [before, after] = await Promise.all([f.status === "added" ? null : text(a.base, f.path), f.status === "removed" ? null : text(a.head, f.path)]);
				if (after != null) changedText.push({ path: f.path, text: after });
				for (const h of lineDiff(before ?? "", after ?? "") ?? []) for (const l of h) l.op === "+" ? added++ : l.op === "-" && removed++;
			}
			// Spend tagged with the attempt's task, by its agent (attempts can share a repo as branches).
			const mine = deps.costs.filter((r) => r.task === a.task && (a.agent ? r.agent === a.agent : r.fork === a.repo));
			const stored = await deps.stored(a.repo, a.ref).catch(() => null);
			return {
				repo: a.repo,
				ref: a.ref,
				head: a.head,
				agent: a.agent,
				model: mine[0]?.model ?? null,
				files: a.files,
				added,
				removed,
				findings: checkChange(changedText, deps.catalog),
				cost: { usd: mine.reduce((n, r) => n + r.cost, 0), requests: mine.length, tokensIn: mine.reduce((n, r) => n + r.tokensIn, 0), tokensOut: mine.reduce((n, r) => n + r.tokensOut, 0) },
				overlaps: overlaps(others, a.files.map((f) => f.path)),
				push: stored ? { conflicts: stored.conflicts, catalogViolations: stored.catalogViolations, warnings: stored.warnings } : null,
			};
		}),
	);
	const sorted = [...reports].sort((x, y) => x.findings.length - y.findings.length || x.overlaps.length - y.overlaps.length || x.added + x.removed - (y.added + y.removed) || x.cost.usd - y.cost.usd);
	return sorted.map((r, i) => {
		const reasons: string[] = [];
		if (r.findings.length) reasons.push(`its change introduces ${r.findings.length} catalog finding(s): ${[...new Set(r.findings.map((f) => f.title))].slice(0, 3).join("; ")}`);
		else reasons.push("its change introduces no catalog findings");
		if (r.overlaps.length) reasons.push(`overlaps with ${r.overlaps.map((o) => `${o.repo}${o.ref !== "main" ? `@${o.ref}` : ""}`).join(", ")} on ${[...new Set(r.overlaps.flatMap((o) => o.same))].slice(0, 3).join(", ") || "nearby files"}`);
		const best = sorted[0];
		if (i === 0 && sorted.length > 1) {
			const next = sorted[1];
			if (!r.findings.length && next.findings.length) reasons.push(`clean, unlike ${next.agent ?? next.ref}`);
			else if (r.overlaps.length < next.overlaps.length) reasons.push("fewer overlaps with other work");
			else if (r.added + r.removed < next.added + next.removed) reasons.push(`smallest diff (+${r.added} −${r.removed})`);
			else if (r.cost.usd < next.cost.usd) reasons.push("cheapest");
		} else if (i > 0) reasons.push(`ranked below ${best.agent ?? best.ref}`);
		reasons.push(`+${r.added} −${r.removed} across ${r.files.length} file(s), $${r.cost.usd.toFixed(4)} over ${r.cost.requests} call(s)`);
		return { ...r, rank: i + 1, verdict: r.findings.length ? "blocked" : i === 0 ? "pick" : "ok", reasons };
	});
}
