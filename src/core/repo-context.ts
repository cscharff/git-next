export interface TreeFile {
	path: string;
	/** Git blob hash; identical content shares a hash, so it doubles as a cache key. */
	hash: string;
}

export interface CommitInfo {
	hash: string;
	message: string;
	author: string;
	committedAt: number;
	/** Parent commit hashes (first parent first), when the source knows them. */
	parents?: string[];
}

export interface ChangedFile {
	path: string;
	status: "added" | "removed" | "modified";
}

/** Files that differ between two file lists (by blob hash), sorted by path. */
export function diffTrees(base: TreeFile[], head: TreeFile[]): ChangedFile[] {
	const before = new Map(base.map((f) => [f.path, f.hash]));
	const after = new Map(head.map((f) => [f.path, f.hash]));
	const out: ChangedFile[] = [];
	for (const [path, hash] of after) {
		const was = before.get(path);
		if (was === undefined) out.push({ path, status: "added" });
		else if (was !== hash) out.push({ path, status: "modified" });
	}
	for (const path of before.keys()) if (!after.has(path)) out.push({ path, status: "removed" });
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Minimal read surface over one repository. Artifacts in production, in-memory in tests. */
export interface RepoSource {
	listFiles(ref: string): Promise<TreeFile[]>;
	readBlob(hash: string): Promise<string | null>;
	log(ref: string, limit: number): Promise<CommitInfo[]>;
	/** Optional fast path: one file's bytes by ref and path, without listing the tree (null when absent). */
	readPath?(ref: string, path: string): Promise<Uint8Array | null>;
	/** Optional fast path: files that differ between two refs, skipping subtrees whose hash didn't change. */
	changedFiles?(baseRef: string, headRef: string): Promise<ChangedFile[]>;
}

/** Resolves repo names to sources, so providers can read other repos (e.g. org instruction layers). */
export type SourceFactory = (repo: string) => Promise<RepoSource>;

/**
 * Read access to one or more repos at refs, with per-ref tree caching and
 * blob-hash content caching shared across refs and repos.
 */
export class RepoContext {
	private trees = new Map<string, Promise<TreeFile[]>>();
	private blobs = new Map<string, Promise<string | null>>();
	private sources = new Map<string, Promise<RepoSource>>();
	private factory: SourceFactory;

	constructor(factory: SourceFactory) {
		this.factory = factory;
	}

	private source(repo: string): Promise<RepoSource> {
		let s = this.sources.get(repo);
		if (!s) this.sources.set(repo, (s = this.factory(repo)));
		return s;
	}

	readTree(repo: string, ref: string): Promise<TreeFile[]> {
		const key = `${repo}@${ref}`;
		let t = this.trees.get(key);
		// Sorted by code unit so every source (Artifacts, fixtures, local checkouts) yields the same order.
		if (!t) this.trees.set(key, (t = this.source(repo).then(async (s) => (await s.listFiles(ref)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))));
		return t;
	}

	async readFile(repo: string, ref: string, path: string): Promise<string | null> {
		const entry = (await this.readTree(repo, ref)).find((f) => f.path === path);
		if (!entry) return null;
		let b = this.blobs.get(entry.hash);
		if (!b) this.blobs.set(entry.hash, (b = this.source(repo).then((s) => s.readBlob(entry.hash))));
		return b;
	}

	async log(repo: string, ref: string, limit = 50): Promise<CommitInfo[]> {
		return (await this.source(repo)).log(ref, limit);
	}

	/** One file's bytes: the source's direct read when it has one, else via the tree (null when absent). */
	async readBytes(repo: string, ref: string, path: string): Promise<Uint8Array | null> {
		const source = await this.source(repo);
		if (source.readPath) return source.readPath(ref, path);
		const text = await this.readFile(repo, ref, path);
		return text === null ? null : new TextEncoder().encode(text);
	}

	/** Files that differ between two refs: the source's fast path when it has one, else a full comparison of both trees. */
	async changedFiles(repo: string, baseRef: string, headRef: string): Promise<ChangedFile[]> {
		const source = await this.source(repo);
		if (source.changedFiles) return source.changedFiles(baseRef, headRef);
		const [base, head] = await Promise.all([this.readTree(repo, baseRef), this.readTree(repo, headRef)]);
		return diffTrees(base, head);
	}

	/** Files at a ref whose path matches the predicate. */
	async find(repo: string, ref: string, match: (path: string) => boolean): Promise<TreeFile[]> {
		return (await this.readTree(repo, ref)).filter((f) => match(f.path));
	}
}

/** Builds a RepoSource from in-memory files keyed by ref then path. Used by tests and fixtures. */
export function memorySource(refs: Record<string, Record<string, string>>): RepoSource {
	const byHash = new Map<string, string>();
	const hashOf = (content: string) => {
		let h = 0;
		for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
		const hash = (h >>> 0).toString(16).padStart(40, "0");
		byHash.set(hash, content);
		return hash;
	};
	return {
		async listFiles(ref) {
			return Object.entries(refs[ref] ?? {}).map(([path, content]) => ({ path, hash: hashOf(content) }));
		},
		async readBlob(hash) {
			return byHash.get(hash) ?? null;
		},
		async log() {
			return [];
		},
	};
}

/** Adds or replaces files in a source's listings (every ref) without touching the underlying repo. */
export function overlayFiles(source: RepoSource, files: Record<string, string>): RepoSource {
	const entries = Object.entries(files).map(([path, content], i) => ({ path, content, hash: `overlay${String(i).padStart(33, "0")}` }));
	const byHash = new Map(entries.map((e) => [e.hash, e.content]));
	return {
		...source,
		async listFiles(ref) {
			const paths = new Set(entries.map((e) => e.path));
			return [...(await source.listFiles(ref)).filter((f) => !paths.has(f.path)), ...entries.map(({ path, hash }) => ({ path, hash }))];
		},
		async readBlob(hash) {
			return byHash.has(hash) ? byHash.get(hash)! : source.readBlob(hash);
		},
		...(source.readPath && {
			async readPath(ref: string, path: string) {
				const hit = entries.find((e) => e.path === path);
				return hit ? new TextEncoder().encode(hit.content) : source.readPath!(ref, path);
			},
		}),
	};
}
