import type { CommitInfo } from "./core/repo-context.ts";

// Read-only code browsing for the dashboard's Code view: file listings, file contents, commit history joined with
// git.next's stored push results, and line diffs. Pure helpers here; the routes in index.ts wire them to Artifacts/KV.

/** Files larger than this are listed but not shown inline. */
export const MAX_VIEW_BYTES = 1024 * 1024;
/** Line diffs above this many lines per side fall back to "changed" without hunks (LCS is quadratic). */
const MAX_DIFF_LINES = 4000;

export interface FileView {
	path: string;
	size: number;
	binary: boolean;
	truncated: boolean;
	text: string | null;
}

/** Decides how a blob is shown: text (possibly truncated), or binary with no content. */
export function fileView(path: string, bytes: Uint8Array): FileView {
	const size = bytes.byteLength;
	// A NUL byte in the first 8 KB is git's own binary heuristic.
	const binary = bytes.subarray(0, 8192).includes(0);
	if (binary) return { path, size, binary, truncated: false, text: null };
	const truncated = size > MAX_VIEW_BYTES;
	return { path, size, binary, truncated, text: new TextDecoder().decode(truncated ? bytes.subarray(0, MAX_VIEW_BYTES) : bytes) };
}

export { diffTrees, type ChangedFile } from "./core/repo-context.ts";

export interface DiffLine {
	op: " " | "+" | "-";
	/** 1-based line numbers on each side (absent on the side the line isn't in). */
	a?: number;
	b?: number;
	text: string;
}

/**
 * Line diff (LCS) grouped into hunks with `context` unchanged lines around each change. Returns null when either side
 * is too long to diff here.
 */
export function lineDiff(before: string, after: string, context = 3): DiffLine[][] | null {
	// A final newline ends the last line; it doesn't start an empty one.
	const linesOf = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
	const a = linesOf(before);
	const b = linesOf(after);
	// Trim the common prefix and suffix first: most edits are small, so the LCS table stays tiny.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES) return null;
	const lcs: number[][] = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0));
	for (let i = midA.length - 1; i >= 0; i--) for (let j = midB.length - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

	const lines: DiffLine[] = [];
	for (let k = 0; k < start; k++) lines.push({ op: " ", a: k + 1, b: k + 1, text: a[k] });
	let i = 0;
	let j = 0;
	while (i < midA.length || j < midB.length) {
		if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
			lines.push({ op: " ", a: start + i + 1, b: start + j + 1, text: midA[i] });
			i++;
			j++;
		} else if (i < midA.length && (j >= midB.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
			// Removals before additions, as git shows them.
			lines.push({ op: "-", a: start + i + 1, text: midA[i] });
			i++;
		} else {
			lines.push({ op: "+", b: start + j + 1, text: midB[j] });
			j++;
		}
	}
	for (let k = 0; k < a.length - endA; k++) lines.push({ op: " ", a: endA + k + 1, b: endB + k + 1, text: a[endA + k] });

	// Keep changed lines plus `context` lines either side; adjacent windows merge into one hunk.
	const keep = lines.map(() => false);
	lines.forEach((l, n) => {
		if (l.op === " ") return;
		for (let k = Math.max(0, n - context); k <= Math.min(lines.length - 1, n + context); k++) keep[k] = true;
	});
	const hunks: DiffLine[][] = [];
	let cur: DiffLine[] | null = null;
	lines.forEach((l, n) => {
		if (!keep[n]) return void (cur = null);
		if (!cur) hunks.push((cur = []));
		cur.push(l);
	});
	return hunks;
}

/** git trailers git.next's agents write: `Agent-Task: <task id>` joins a commit to its gateway spend. */
export function commitTrailers(message: string): { agentTask: string | null; agent: string | null } {
	const task = message.match(/^Agent-Task:\s*(\S+)\s*$/m)?.[1] ?? null;
	const agent = message.match(/^Agent:\s*(\S+)/m)?.[1] ?? null;
	return { agentTask: task, agent };
}

interface RollupNode {
	level: string;
	key: string;
	cost: number;
	requests: number;
	children?: RollupNode[];
}

/** Gateway spend per task for one fork, from a stored cost insight's rollup (project › developer › fork › agent › task). */
export function taskCosts(rollup: RollupNode[] | undefined, fork: string): Map<string, { cost: number; requests: number }> {
	const out = new Map<string, { cost: number; requests: number }>();
	const walk = (nodes: RollupNode[] | undefined, inFork: boolean) => {
		for (const n of nodes ?? []) {
			const here = inFork || (n.level === "fork" && n.key === fork);
			if (here && n.level === "task") {
				const prev = out.get(n.key) ?? { cost: 0, requests: 0 };
				out.set(n.key, { cost: prev.cost + n.cost, requests: prev.requests + n.requests });
			}
			walk(n.children, here);
		}
	};
	walk(rollup, false);
	return out;
}

export interface PushEvent {
	repo: string;
	after: string;
	receivedAt: string;
	conflicts: number;
	catalogViolations: number;
}

export interface LogRow extends CommitInfo {
	parents: string[];
	agent: string | null;
	agentTask: string | null;
	/** git.next's analysis of the push that brought this commit in, when one was recorded. */
	push: { receivedAt: string; conflicts: number; catalogViolations: number; warnings?: number; insights?: number } | null;
	/** Gateway spend for the commit's Agent-Task; `commits` > 1 when several listed commits share that task (and its spend). */
	cost: { cost: number; requests: number; commits: number } | null;
}

/**
 * Commit history with git.next's results joined in: push results by commit hash (the recorded events, plus the latest
 * stored analysis for its commit), and gateway spend by the commit's Agent-Task trailer.
 */
export function annotateLog(
	commits: (CommitInfo & { parents?: string[] })[],
	repo: string,
	events: PushEvent[],
	latest: { commit?: string | null; updatedAt?: string; insights?: { provider: string; severity: string; metrics?: Record<string, any> }[] } | null,
): LogRow[] {
	const byCommit = new Map<string, LogRow["push"]>();
	for (const e of events) if (e.repo === repo && !byCommit.has(e.after)) byCommit.set(e.after, { receivedAt: e.receivedAt, conflicts: e.conflicts, catalogViolations: e.catalogViolations });
	const insights = latest?.insights ?? [];
	if (latest?.commit) {
		const prev = byCommit.get(latest.commit);
		byCommit.set(latest.commit, {
			receivedAt: prev?.receivedAt ?? latest.updatedAt ?? "",
			conflicts: insights.filter((i) => i.provider === "instruction-stack" && i.severity === "conflict").length,
			catalogViolations: insights.filter((i) => i.provider === "catalog" && i.severity === "conflict").length,
			warnings: insights.filter((i) => i.severity === "warn").length,
			insights: insights.length,
		});
	}
	const rollup = insights.find((i) => i.provider === "cost" && Array.isArray(i.metrics?.rollup))?.metrics?.rollup as RollupNode[] | undefined;
	const costs = taskCosts(rollup, repo);
	const trailers = commits.map((c) => commitTrailers(c.message));
	const perTask = new Map<string, number>();
	for (const t of trailers) if (t.agentTask) perTask.set(t.agentTask, (perTask.get(t.agentTask) ?? 0) + 1);
	return commits.map((c, i) => {
		const t = trailers[i];
		const spend = t.agentTask ? costs.get(t.agentTask) : undefined;
		return { ...c, parents: c.parents ?? [], ...t, push: byCommit.get(c.hash) ?? null, cost: spend ? { ...spend, commits: perTask.get(t.agentTask!) ?? 1 } : null };
	});
}
