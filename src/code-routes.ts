import { annotateLog, fileView, lineDiff, type PushEvent } from "./code.ts";
import type { RepoContext, TreeFile } from "./core/repo-context.ts";

// GET /code/* : read-only browsing for the dashboard's Code view. Callers have already passed the Access check.
//   /code/repos                                  repos the viewer can open
//   /code/tree?repo=&ref=[&via=]                 every file at a ref (flat; the page builds the tree) + head commit
//   /code/file?repo=&ref=&path=[&via=]           one file: text, or binary/too-large markers
//   /code/log?repo=&ref=[&limit=]                commits with git.next's push results and gateway spend joined in
//   /code/diff?repo=&ref=[&base=][&path=]        changed files vs base (default: first parent), or one file's hunks
// `via` names the analysed repo when browsing a layer repo that only exists as its overlay (the demo layers).

export interface CodeDeps {
	/** Reader for `repo` (as seen while analysing `via`, which defaults to repo). */
	context(repo: string, via: string): RepoContext;
	listRepos(): Promise<{ name: string; description: string | null; defaultBranch: string; lastPushAt: string | null; source: string | null }[]>;
	events(): Promise<PushEvent[]>;
	/** File listings by commit: a commit's tree never changes, so a listing can be reused until it expires. */
	treeCache?: { get(key: string): Promise<TreeFile[] | null>; put(key: string, files: TreeFile[]): Promise<void> };
	latest(repo: string, ref: string): Promise<Record<string, any> | null>;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF = /^[\w./-]{1,100}$/;
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const ok = (body: unknown) => Response.json(body, { headers: { "cache-control": "private, max-age=15" } });

export async function handleCodeRoute(request: Request, url: URL, deps: CodeDeps): Promise<Response | null> {
	if (request.method !== "GET" || !url.pathname.startsWith("/code/")) return null;
	const q = url.searchParams;
	if (url.pathname === "/code/repos") return ok({ repos: await deps.listRepos() });

	const repo = q.get("repo") ?? "";
	const via = q.get("via") || repo;
	const ref = q.get("ref") || "main";
	if (!REPO_NAME.test(repo) || !REPO_NAME.test(via) || !REF.test(ref)) return bad("repo and ref are required");
	const files = deps.context(repo, via);

	if (url.pathname === "/code/tree") {
		const [head] = await files.log(repo, ref, 1).catch(() => []);
		// Keyed by commit and by how the repo is read (`via` decides the demo overlays).
		const key = head ? `${repo}/${head.hash}/${via}` : null;
		let tree = key ? await deps.treeCache?.get(key).catch(() => null) : null;
		if (!tree) {
			tree = await files.readTree(repo, ref);
			if (key) await deps.treeCache?.put(key, tree).catch(() => {});
		}
		return ok({ repo, ref, head: head ?? null, files: tree });
	}

	if (url.pathname === "/code/file") {
		const path = q.get("path") ?? "";
		if (!path || path.length > 1000) return bad("path is required");
		const bytes = await files.readBytes(repo, ref, path);
		if (!bytes) return bad(`no such file: ${path}`, 404);
		return ok({ ...fileView(path, bytes), repo, ref });
	}

	if (url.pathname === "/code/log") {
		const limit = Math.min(Math.max(Number(q.get("limit")) || 30, 1), 100);
		const [commits, events, latest] = await Promise.all([files.log(repo, ref, limit), deps.events(), deps.latest(repo, ref === "HEAD" ? "main" : ref)]);
		return ok({ repo, ref, commits: annotateLog(commits, repo, events, latest) });
	}

	if (url.pathname === "/code/diff") {
		let base = q.get("base");
		if (!base) {
			const [head] = await files.log(repo, ref, 1);
			base = head?.parents?.[0] ?? null;
		}
		if (!base) return ok({ repo, ref, base: null, changed: [] });
		if (!REF.test(base)) return bad("bad base");
		const path = q.get("path");
		if (!path) return ok({ repo, ref, base, changed: await files.changedFiles(repo, base, ref) });
		const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));
		const [before, after] = (await Promise.all([files.readBytes(repo, base, path), files.readBytes(repo, ref, path)])).map(text);
		const status = before === null ? "added" : after === null ? "removed" : "modified";
		return ok({ repo, ref, base, path, status, hunks: lineDiff(before ?? "", after ?? "") });
	}

	return bad("not found", 404);
}
