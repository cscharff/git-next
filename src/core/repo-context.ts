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
}

/** Minimal read surface over one repository. Artifacts in production, in-memory in tests. */
export interface RepoSource {
	listFiles(ref: string): Promise<TreeFile[]>;
	readBlob(hash: string): Promise<string | null>;
	log(ref: string, limit: number): Promise<CommitInfo[]>;
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
	};
}
