import type { CommitInfo, RepoSource, TreeFile } from "./repo-context.ts";

// Directories that never hold config or instructions worth analysing and can be large.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next", "coverage"]);
const MAX_CONCURRENCY = 24;

/** RepoSource backed by the Artifacts binding: resolves ref -> commit -> tree and walks it. */
export async function artifactsSource(binding: Artifacts, name: string): Promise<RepoSource> {
	const repo = await binding.get(name);
	const decoder = new TextDecoder();

	return {
		async listFiles(ref) {
			const [head] = await repo.log({ ref, limit: 1 });
			if (!head) throw new Error(`ref not found: ${name}@${ref}`);
			const files: TreeFile[] = [];
			let queue: { hash: string; prefix: string }[] = [{ hash: head.treeHash, prefix: "" }];
			while (queue.length) {
				const next: typeof queue = [];
				for (let i = 0; i < queue.length; i += MAX_CONCURRENCY) {
					const batch = queue.slice(i, i + MAX_CONCURRENCY);
					const trees = await Promise.all(batch.map((t) => repo.readTree(t.hash)));
					trees.forEach((entries, j) => {
						for (const e of entries ?? []) {
							const path = batch[j].prefix + e.name;
							if (e.type === "tree") {
								if (!SKIP_DIRS.has(e.name)) next.push({ hash: e.hash, prefix: `${path}/` });
							} else if (e.type === "blob" || e.type === "exec") {
								files.push({ path, hash: e.hash });
							}
						}
					});
				}
				queue = next;
			}
			return files;
		},
		async readBlob(hash) {
			const blob = await repo.readBlob(hash);
			return blob ? decoder.decode(await blob.arrayBuffer()) : null;
		},
		async log(ref, limit): Promise<CommitInfo[]> {
			const commits = await repo.log({ ref, limit });
			return commits.map((c) => ({ hash: c.hash, message: c.message, author: c.author.name, committedAt: c.committedAt }));
		},
	};
}
