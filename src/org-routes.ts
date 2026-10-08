import type { RepoContext } from "./core/repo-context.ts";
import { APP_FILE, orgReport, type OrgScale, parseAppDeclaration, resolveApp, summarizeStored, type OrgRegistry, type OrgReport, type RepoFacts, type WorkSnapshot } from "./org.ts";
import type { Catalog } from "./providers/catalog.ts";
import type { CostRecord } from "./providers/cost/logs.ts";
import type { IndexEntry } from "./results.ts";
import type { ReviewRecord } from "./review.ts";

// GET /org : the Org tab. Reads what git.next already stores and nothing else:
//   repos and fork sources (Artifacts), .gitnext/app.json per project (Artifacts), stored push results and the index
//   (KV), review records (KV, written by the PushReview Workflow), AI Gateway logs (cost source), work in flight.
// Each source that fails is reported in `errors` and left out, so one slow read never blanks the whole view.

export interface OrgRouteDeps {
	org: OrgRegistry;
	catalog: Catalog;
	listRepos(): Promise<{ name: string; source: string | null; defaultBranch: string }[]>;
	files(repo: string): RepoContext;
	index(): Promise<IndexEntry[]>;
	stored(repo: string, ref: string): Promise<Record<string, any> | null>;
	reviews(): Promise<ReviewRecord[]>;
	precedenceOverridden(repo: string): Promise<boolean>;
	costs(): Promise<CostRecord[]>;
	costSource: string;
	work(project: string): Promise<WorkSnapshot>;
	reviewers: string[];
	/** The synthetic production-scale dataset, or null for the "Live only" view. */
	scale?: (now: Date) => OrgScale | null;
	now?: () => Date;
}

const forkSource = (source: string | null) => source?.match(/^artifacts:default\/(.+)$/)?.[1] ?? null;
const settle = async <T>(errors: string[], what: string, p: Promise<T>, fallback: T): Promise<T> => {
	try {
		return await p;
	} catch (err) {
		errors.push(`${what}: ${String(err).slice(0, 200)}`);
		return fallback;
	}
};

export async function buildOrg(deps: OrgRouteDeps): Promise<OrgReport & { errors: string[] }> {
	const errors: string[] = [];
	const [listed, index, reviews, costs] = await Promise.all([
		settle(errors, "repos", deps.listRepos(), []),
		settle(errors, "results index", deps.index(), []),
		settle(errors, "reviews", deps.reviews(), []),
		settle(errors, "AI Gateway logs", deps.costs(), []),
	]);
	// Imported mirrors (git:https://…) are projects of their own; artifacts:default/<x> sources are forks of <x>.
	const names = new Set(listed.map((r) => r.name));
	const projectOf = (r: { name: string; source: string | null }) => {
		const src = forkSource(r.source);
		return src && names.has(src) ? src : r.name;
	};
	const branchOf = (name: string) => {
		const b = listed.find((r) => r.name === name)?.defaultBranch;
		return b && b !== "HEAD" ? b : "main";
	};
	const repos: RepoFacts[] = await Promise.all(
		listed.map(async (r): Promise<RepoFacts> => {
			const project = projectOf(r);
			const ref = branchOf(r.name);
			const files = deps.files(r.name);
			// Forks carry their project's declaration; only the project's own file counts.
			const [declText, stored, overridden] = await Promise.all([
				settle(errors, `${project} ${APP_FILE}`, files.readBytes(project, branchOf(project), APP_FILE).then((b) => (b ? new TextDecoder().decode(b) : null)), null),
				settle(errors, `${r.name} stored result`, deps.stored(r.name, ref), null),
				settle(errors, `${r.name} precedence`, deps.precedenceOverridden(r.name), false),
			]);
			const { decl, error } = parseAppDeclaration(declText);
			const result = stored ? summarizeStored(stored, ref) : null;
			// No stored result: look for a root AGENTS.md or CLAUDE.md (two direct reads, no tree listing).
			const rootFile = async () => (await Promise.all(["AGENTS.md", "CLAUDE.md"].map((p) => files.readBytes(r.name, ref, p)))).some((b) => b != null);
			const hasInstructions = result ? result.projectLayers > 0 : r.name === project ? await settle(errors, `${r.name} instruction files`, rootFile(), null) : null;
			return { repo: r.name, project, app: resolveApp(deps.org, project, decl, error), result, hasInstructions, precedenceOverridden: overridden };
		}),
	);
	const busy = [...new Set(repos.filter((r) => r.repo !== r.project || index.some((e) => e.repo === r.repo && e.ref !== "main" && e.ref !== "master")).map((r) => r.project))];
	const work = (await Promise.all(busy.map((p) => settle(errors, `${p} work in flight`, deps.work(p), null)))).filter((w): w is WorkSnapshot => !!w);
	const now = deps.now?.() ?? new Date();
	const report = orgReport({ now, scale: deps.scale?.(now) ?? null, org: deps.org, catalog: deps.catalog, repos, index, reviews, costs, costSource: deps.costSource, work, reviewers: deps.reviewers });
	return { ...report, errors };
}
