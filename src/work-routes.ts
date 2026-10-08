import type { Catalog } from "./providers/catalog.ts";
import type { CostRecord } from "./providers/cost/logs.ts";
import type { IndexEntry } from "./results.ts";
import { attemptSets, compareAttempts, overlaps, workInFlight, type WorkDeps } from "./work.ts";

// GET /work* : work in flight on a project (forks and non-main branches), overlap checks and attempt comparison.
//   /work?repo=                          every fork/branch of the project with its changed files
//   /work/overlap?repo=&paths=a,b[&exclude=repo@ref]   who else is changing these files
//   /work/attempts?repo=                 tasks with two or more attempts in flight
//   /work/compare?repo=&task=            the attempts at one task, compared, with a pick to merge
// `repo` may be the project or any fork of it; `refs=a,b` adds branches of the project not yet analysed.

export interface WorkRouteDeps extends WorkDeps {
	catalog: Catalog;
	costs(project: string): Promise<CostRecord[]>;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** The project a repo belongs to: its fork source, or itself. */
export const projectOf = async (deps: WorkDeps, repo: string) => (await deps.sourceOf(repo).catch(() => null)) ?? repo;

export async function handleWorkRoute(request: Request, url: URL, deps: WorkRouteDeps): Promise<Response | null> {
	if (request.method !== "GET" || (url.pathname !== "/work" && !url.pathname.startsWith("/work/"))) return null;
	const q = url.searchParams;
	const repo = q.get("repo") ?? "";
	if (!REPO_NAME.test(repo)) return bad("repo is required");
	const project = await projectOf(deps, repo);
	// refs=a,b adds branches of the project by name (not yet analysed, e.g. just pushed).
	const refs = (q.get("refs") ?? "").split(",").map((r) => r.trim()).filter((r) => /^[\w./-]{1,100}$/.test(r)).slice(0, 10);
	const work = await workInFlight(deps, project, "main", refs.map((ref) => ({ repo: project, ref })));

	if (url.pathname === "/work") return Response.json({ project, items: work });

	if (url.pathname === "/work/overlap") {
		const paths = (q.get("paths") ?? "").split(",").map((p) => p.trim()).filter(Boolean).slice(0, 200);
		const [exRepo, exRef] = (q.get("exclude") ?? "").split("@");
		return Response.json({ project, overlaps: overlaps(work, paths, exRepo ? { repo: exRepo, ...(exRef ? { ref: exRef } : {}) } : undefined) });
	}

	if (url.pathname === "/work/attempts") return Response.json({ project, sets: attemptSets(work).map((s) => ({ task: s.task, attempts: s.attempts.map((a) => ({ repo: a.repo, ref: a.ref, agent: a.agent, head: a.head, files: a.files.length, updatedAt: a.updatedAt })) })) });

	if (url.pathname === "/work/compare") {
		const task = q.get("task") ?? "";
		const set = attemptSets(work).find((s) => s.task === task);
		if (!set) return bad(`no task with two or more attempts: ${task}`, 404);
		const entries = await deps.index();
		const reports = await compareAttempts(
			set.attempts,
			work.filter((w) => !set.attempts.includes(w)),
			{ files: deps.files, catalog: deps.catalog, costs: await deps.costs(project).catch(() => []), stored: async (r, ref) => entries.find((e: IndexEntry) => e.repo === r && e.ref === ref) ?? null },
		);
		return Response.json({ project, task, catalogVersion: deps.catalog.version, attempts: reports });
	}
	return bad("not found", 404);
}
