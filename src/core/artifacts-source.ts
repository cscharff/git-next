import type { ChangedFile, CommitInfo, RepoSource, TreeFile } from "./repo-context.ts";

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
		async readPath(ref, path) {
			const blob = await repo.readFile({ ref, path }).catch(() => null);
			return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
		},
		async changedFiles(baseRef, headRef) {
			const [[base], [head]] = await Promise.all([repo.log({ ref: baseRef, limit: 1 }), repo.log({ ref: headRef, limit: 1 })]);
			if (!base || !head) throw new Error(`ref not found: ${name}@${!base ? baseRef : headRef}`);
			const out: ChangedFile[] = [];
			// Every file under a tree that exists on one side only.
			const all = async (hash: string, prefix: string, status: ChangedFile["status"]) => {
				for (const e of (await repo.readTree(hash)) ?? []) {
					if (e.type === "tree") await all(e.hash, `${prefix}${e.name}/`, status);
					else if (e.type === "blob" || e.type === "exec") out.push({ path: prefix + e.name, status });
				}
			};
			// Walk both trees together, skipping any subtree whose hash is unchanged.
			const walk = async (a: string, b: string, prefix: string): Promise<void> => {
				if (a === b) return;
				const [ea, eb] = await Promise.all([repo.readTree(a), repo.readTree(b)]);
				const before = new Map((ea ?? []).map((e) => [e.name, e]));
				const after = new Map((eb ?? []).map((e) => [e.name, e]));
				const subtrees: Promise<void>[] = [];
				for (const [n, e] of after) {
					const was = before.get(n);
					const path = prefix + n;
					const isTree = e.type === "tree";
					if (!was) subtrees.push(isTree ? all(e.hash, `${path}/`, "added") : Promise.resolve(void out.push({ path, status: "added" })));
					else if (was.hash === e.hash) continue;
					else if (isTree && was.type === "tree") subtrees.push(walk(was.hash, e.hash, `${path}/`));
					else if (!isTree && was.type !== "tree") out.push({ path, status: "modified" });
					else subtrees.push(Promise.all([was.type === "tree" ? all(was.hash, `${path}/`, "removed") : Promise.resolve(void out.push({ path, status: "removed" })), isTree ? all(e.hash, `${path}/`, "added") : Promise.resolve(void out.push({ path, status: "added" }))]).then(() => {}));
				}
				for (const [n, e] of before) if (!after.has(n)) subtrees.push(e.type === "tree" ? all(e.hash, `${prefix}${n}/`, "removed") : Promise.resolve(void out.push({ path: prefix + n, status: "removed" })));
				await Promise.all(subtrees);
			};
			await walk(base.treeHash, head.treeHash, "");
			return out.filter((f) => !f.path.split("/").some((p) => SKIP_DIRS.has(p))).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
		},
		async log(ref, limit): Promise<CommitInfo[]> {
			const commits = await repo.log({ ref, limit });
			return commits.map((c) => ({ hash: c.hash, message: c.message, author: c.author.name, committedAt: c.committedAt, parents: c.parents }));
		},
	};
}
