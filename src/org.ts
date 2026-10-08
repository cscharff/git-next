import { memorySource, type ChangedFile, type RepoSource, type SourceFactory } from "./core/repo-context.ts";
import { parseJsonc } from "./parse/jsonc.ts";
import { catalogModel, type Catalog } from "./providers/catalog.ts";
import type { CostRecord } from "./providers/cost/logs.ts";
import { STACK_FILE } from "./providers/instruction-stack/index.ts";
import type { IndexEntry } from "./results.ts";
import type { ReviewRecord, SensitiveReason } from "./review.ts";

// The Org view: every repo's classification profile (public / internal / PII-regulated), owner, team and cost
// centre, and the org-wide roll-ups built from what git.next already stores: push results (KV), review records
// (PushReview Workflow) and AI Gateway logs. A repo declares its class in .gitnext/app.json; the org registry
// (fixtures/org-baseline/org.json) is the fallback and holds what a repo can't set for itself: budgets.
//
// A profile is real policy, not a label: a class with a `layer` adds that rules file to the repo's instruction stack
// at org rank, `limits.models` narrows the catalog for the repo, and `limits.reviewPaths` sends changes to data paths
// to a person in the PushReview Workflow.

export const APP_FILE = ".gitnext/app.json";
/** The repo name profile layers are served under (bundled files, never a real Artifacts repo). */
export const PROFILES_REPO = "git-next-org-profiles";
export const CLASSES = ["public", "internal", "pii-regulated"] as const;
export type AppClass = (typeof CLASSES)[number];
const isClass = (v: unknown): v is AppClass => typeof v === "string" && (CLASSES as readonly string[]).includes(v);

export interface ProfileLimits {
	/** Only these catalog models (and only where the org catalog approves them too). */
	models?: string[];
	guardrails?: boolean;
	dataLocation?: string;
	/** Globs: a push touching any of these always waits for a person. */
	reviewPaths?: string[];
}
export interface Profile {
	id: AppClass;
	title: string;
	summary: string;
	/** Path of the profile's rules layer inside the org baseline (added to the stack at org rank). */
	layer?: string;
	limits: ProfileLimits;
}
export interface Team {
	id: string;
	name: string;
	owner?: string;
	costCentre?: string;
	/** Monthly AI budget in USD. */
	budgetUsd?: number;
}
export interface ProjectEntry {
	repo: string;
	class?: AppClass;
	team?: string;
	owner?: string;
	costCentre?: string;
	environment?: string;
	budgetUsd?: number;
}
export interface OrgRegistry {
	version: string;
	owner?: string;
	defaultClass: AppClass;
	profiles: Profile[];
	teams: Team[];
	projects: ProjectEntry[];
}

/** What a repo says about itself in .gitnext/app.json. Budgets are the org's call, so they're ignored here. */
export interface AppDeclaration {
	class?: AppClass;
	owner?: string;
	team?: string;
	costCentre?: string;
	environment?: string;
	controls?: { guardrails?: boolean; dataLocation?: string };
}

const OWNER = /^@?[A-Za-z0-9][A-Za-z0-9_.\/-]{0,80}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : undefined);

/** Parses and shape-checks the org registry; throws with a readable message. */
export function parseOrgRegistry(text: string): OrgRegistry {
	const o = parseJsonc(text) as Partial<OrgRegistry>;
	if (!o || typeof o !== "object" || typeof o.version !== "string") throw new Error("org registry needs a version");
	if (!isClass(o.defaultClass)) throw new Error(`org defaultClass must be one of ${CLASSES.join(", ")}`);
	if (!Array.isArray(o.profiles) || !o.profiles.every((p) => p && isClass(p.id) && typeof p.title === "string")) throw new Error("org profiles must be a list of { id, title }");
	for (const c of CLASSES) if (!o.profiles.some((p) => p.id === c)) throw new Error(`org profiles must define ${c}`);
	if (!Array.isArray(o.teams) || !o.teams.every((t) => t && str(t.id, ID))) throw new Error("org teams must be a list of { id }");
	if (!Array.isArray(o.projects) || !o.projects.every((p) => p && str(p.repo, ID) && (p.class === undefined || isClass(p.class)))) throw new Error("org projects must be a list of { repo, class? }");
	return { ...o, profiles: o.profiles.map((p) => ({ ...p, limits: p.limits ?? {} })) } as OrgRegistry;
}

/** Parses .gitnext/app.json, keeping only well-formed fields (the file is repo data, not trusted config). */
export function parseAppDeclaration(text: string | null): { decl: AppDeclaration | null; error?: string } {
	if (text == null) return { decl: null };
	let raw: Record<string, unknown>;
	try {
		raw = parseJsonc(text) as Record<string, unknown>;
	} catch (err) {
		return { decl: null, error: `${APP_FILE}: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!raw || typeof raw !== "object") return { decl: null, error: `${APP_FILE} must be a JSON object` };
	const decl: AppDeclaration = {};
	if (raw.class !== undefined) {
		if (!isClass(raw.class)) return { decl: null, error: `${APP_FILE}: class must be one of ${CLASSES.join(", ")}` };
		decl.class = raw.class;
	}
	for (const k of ["owner"] as const) if (str(raw[k], OWNER)) decl[k] = raw[k] as string;
	for (const k of ["team", "costCentre", "environment"] as const) if (str(raw[k], ID)) decl[k] = raw[k] as string;
	const c = raw.controls as Record<string, unknown> | undefined;
	if (c && typeof c === "object") decl.controls = { ...(typeof c.guardrails === "boolean" ? { guardrails: c.guardrails } : {}), ...(str(c.dataLocation, /^[a-z]{2,10}$/) ? { dataLocation: c.dataLocation as string } : {}) };
	return { decl };
}

export interface ResolvedApp {
	repo: string;
	class: AppClass;
	/** Where the class came from: the repo's own .gitnext/app.json, the org registry, or the org default. */
	classSource: "repo" | "org" | "default";
	owner: string | null;
	team: string | null;
	teamName: string | null;
	costCentre: string | null;
	environment: string;
	budgetUsd: number | null;
	controls: { guardrails?: boolean; dataLocation?: string };
	error?: string;
}

/** A repo's class, owner, team and cost centre: its own declaration first, then the org registry, then defaults. */
export function resolveApp(org: OrgRegistry, repo: string, decl: AppDeclaration | null, error?: string): ResolvedApp {
	const entry = org.projects.find((p) => p.repo === repo);
	const teamId = decl?.team ?? entry?.team ?? null;
	const team = org.teams.find((t) => t.id === teamId) ?? null;
	// A repo can raise its own class, never lower it below what the org registry says.
	const declared = decl?.class;
	const registered = entry?.class;
	const repoWins = !!declared && (!registered || CLASSES.indexOf(declared) >= CLASSES.indexOf(registered));
	return {
		repo,
		class: repoWins ? declared! : (registered ?? org.defaultClass),
		classSource: repoWins ? "repo" : registered ? "org" : "default",
		owner: decl?.owner ?? entry?.owner ?? null,
		team: teamId,
		teamName: team?.name ?? null,
		costCentre: decl?.costCentre ?? entry?.costCentre ?? team?.costCentre ?? null,
		environment: decl?.environment ?? entry?.environment ?? "unknown",
		budgetUsd: entry?.budgetUsd ?? null,
		controls: decl?.controls ?? {},
		...(error ? { error } : {}),
	};
}

export const profileOf = (org: OrgRegistry, cls: AppClass): Profile => org.profiles.find((p) => p.id === cls)!;

/** The org catalog as one class sees it: `limits.models` narrows the approved models (the catalog still has to approve them). */
export function profileCatalog(catalog: Catalog, profile: Profile): Catalog {
	const allow = profile.limits.models;
	if (!allow?.length) return catalog;
	return { ...catalog, version: `${catalog.version}+${profile.id}`, models: catalog.models.filter((m) => allow.some((a) => catalogModel({ ...catalog, models: [m] }, a))) };
}

const globToRegExp = (glob: string) =>
	new RegExp(
		`^${glob
			.split("**/")
			.map((part) => part.split("**").map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join(".*"))
			.join("(?:.*/)?")}$`,
	);
export const matchesGlob = (glob: string, path: string) => globToRegExp(glob).test(path);

/** Profile reasons a change needs a person: paths the class says always need review. */
export function profileReviewReasons(profile: Profile, changed: ChangedFile[]): SensitiveReason[] {
	const globs = profile.limits.reviewPaths ?? [];
	if (!globs.length) return [];
	return changed.filter((f) => globs.some((g) => matchesGlob(g, f.path))).map((f) => ({ kind: "profile" as const, path: f.path, why: `${f.status === "removed" ? "removes" : f.status === "added" ? "adds" : "modifies"} a data path that ${profile.title} repos always send to a person` }));
}

// ── profile rules layer ───────────────────────────────────────────────────────

/**
 * Adds the class's rules layer to the repo's instruction stack at org rank. Reads `.gitnext/app.json` (and the org
 * registry) at each ref, appends `{ kind: "org", repo: PROFILES_REPO }` to the stack file the repo already has (or
 * starts one), and serves the layer files under PROFILES_REPO. The repo itself is never written.
 */
export function withProfileLayers(factory: SourceFactory, org: OrgRegistry, layerTexts: Record<string, string>): SourceFactory {
	const layers = memorySource({ HEAD: layerTexts });
	return async (name) => (name === PROFILES_REPO ? layers : profiledSource(await factory(name), name, org, layerTexts));
}

const STACK_HASH = (cls: string, base: string) => `profile-${cls}-${base}`.slice(0, 80);

function profiledSource(source: RepoSource, repo: string, org: OrgRegistry, layerTexts: Record<string, string>): RepoSource {
	const stacks = new Map<string, string>();
	const read = async (files: { path: string; hash: string }[], path: string) => {
		const f = files.find((x) => x.path === path);
		return f ? source.readBlob(f.hash) : null;
	};
	const listFiles = async (ref: string) => {
		const files = await source.listFiles(ref);
		const { decl } = parseAppDeclaration(await read(files, APP_FILE).catch(() => null));
		const profile = profileOf(org, resolveApp(org, repo, decl).class);
		if (!profile.layer || layerTexts[profile.layer] == null) return files;
		const existing = files.find((f) => f.path === STACK_FILE);
		let stack: { layers?: unknown[] } = { layers: [] };
		if (existing) {
			try {
				stack = parseJsonc((await source.readBlob(existing.hash)) ?? "{}") as { layers?: unknown[] };
			} catch {
				// A broken stack file is reported by the instruction stack; the profile layer still applies.
				stack = { layers: [] };
			}
		}
		const merged = { ...stack, layers: [...(Array.isArray(stack.layers) ? stack.layers : []), { name: `profile-${profile.id}`, kind: "org", repo: PROFILES_REPO, path: profile.layer }] };
		const hash = STACK_HASH(profile.id, existing?.hash ?? "none");
		stacks.set(hash, JSON.stringify(merged, null, "\t"));
		return [...files.filter((f) => f.path !== STACK_FILE), { path: STACK_FILE, hash }];
	};
	return {
		...source,
		listFiles,
		async readBlob(hash) {
			return stacks.has(hash) ? stacks.get(hash)! : source.readBlob(hash);
		},
		...(source.readPath && {
			async readPath(ref: string, path: string) {
				if (path !== STACK_FILE) return source.readPath!(ref, path);
				const entry = (await listFiles(ref)).find((f) => f.path === STACK_FILE);
				const text = entry ? (stacks.get(entry.hash) ?? (await source.readBlob(entry.hash))) : null;
				return text == null ? null : new TextEncoder().encode(text);
			},
		}),
	};
}

// ── the org report ────────────────────────────────────────────────────────────

/** What the dashboard's Org tab shows. Every number comes from stored data unless its section says `mock: true`. */
export interface RepoFacts {
	repo: string;
	/** The project it belongs to (its fork source, or itself). */
	project: string;
	app: ResolvedApp;
	/** Stored analysis of main (or the default branch), when there is one. */
	result: StoredSummary | null;
	/** Whether the repo has an AGENTS.md/CLAUDE.md at main; null when unknown. */
	hasInstructions: boolean | null;
	precedenceOverridden: boolean;
}

/** The parts of a stored push result (insights/{repo}/{ref}) the Org view reads. */
export interface StoredSummary {
	ref: string;
	updatedAt: string;
	conflicts: number;
	catalog: { source: string | null; version: string | null; behind: boolean; models: string[]; findings: number; byKind: Record<string, number> };
	riskyHooks: { plugin: string; title: string }[];
	copyDrift: number;
	projectLayers: number;
}

/** Reduces a stored result to what the Org view needs (stored results run to hundreds of KB). */
export function summarizeStored(stored: Record<string, any>, ref: string): StoredSummary {
	const insights: any[] = Array.isArray(stored.insights) ? stored.insights : [];
	const catSummary = insights.find((i) => i.provider === "catalog" && i.severity !== "conflict" && i.metrics?.source !== undefined);
	const catFindings = insights.filter((i) => i.provider === "catalog" && i.severity === "conflict");
	const stack = insights.find((i) => i.provider === "instruction-stack" && i.metrics?.layers);
	return {
		ref,
		updatedAt: String(stored.updatedAt ?? ""),
		conflicts: insights.filter((i) => i.provider === "instruction-stack" && i.severity === "conflict").length,
		catalog: {
			source: catSummary?.metrics?.source ?? null,
			version: catSummary?.metrics?.version ?? null,
			behind: !!catSummary?.metrics?.behind,
			models: catFindings.filter((i) => i.metrics?.kind === "model").map((i) => String(i.title).replace(/^.*?: /, "")),
			findings: catFindings.length,
			byKind: (catSummary?.metrics?.byKind as Record<string, number>) ?? {},
		},
		riskyHooks: insights.filter((i) => i.provider === "instruction-stack" && /^Plugin hook needs review: /.test(i.title)).map((i) => ({ plugin: String(i.title).replace(/^Plugin hook needs review: /, "").replace(/ \(.*$/, ""), title: String(i.title) })),
		copyDrift: insights.filter((i) => i.provider === "instruction-stack" && i.metrics?.kind === "drift").length,
		projectLayers: ((stack?.metrics?.layers as { kind: string; origin: string }[] | undefined) ?? []).filter((l) => l.origin === "project").length,
	};
}

export interface WorkSnapshot {
	project: string;
	items: { repo: string; ref: string; agent: string | null; task: string | null; files: string[]; updatedAt: string }[];
}

export interface OrgInputs {
	now: Date;
	org: OrgRegistry;
	catalog: Catalog;
	repos: RepoFacts[];
	index: IndexEntry[];
	reviews: ReviewRecord[];
	costs: CostRecord[];
	costSource: string;
	work: WorkSnapshot[];
	/** People who may decide reviews (Access identities). */
	reviewers: string[];
	/**
	 * The synthetic production-scale dataset (fixtures/org-scale), added to live spend and merged changes only. Risk,
	 * controls and review flow always use live data. Null for the "Live only" view.
	 */
	scale?: OrgScale | null;
}

export interface OrgScale {
	costs: CostRecord[];
	merged: { project: string; at: string; count: number }[];
	note: string;
}

/** Spend and cost per change cover the last 30 days. */
export const WINDOW_DAYS = 30;

const round = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p;
const hours = (ms: number) => round(ms / 3_600_000, 1);
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
type Top = { key: string; cost: number; requests: number };
/** Requests a record stands for (the org-scale dataset stores daily totals). */
const weight = (r: CostRecord) => r.requests ?? 1;
function topN(records: CostRecord[], key: (r: CostRecord) => string, n = 5): Top[] {
	return [...Map.groupBy(records, key)].map(([k, rs]) => ({ key: k, cost: round(sum(rs.map((r) => r.cost))), requests: sum(rs.map(weight)) })).sort((a, b) => b.cost - a.cost).slice(0, n);
}

const WAITING = new Set(["needs-review"]);
const OPEN = new Set(["running", "needs-review"]);
const MERGEABLE = new Set(["approved", "auto-approved"]);

export function orgReport(i: OrgInputs) {
	const since = i.now.getTime() - WINDOW_DAYS * 86_400_000;
	const inWindow = (at: string) => Date.parse(at) >= since;
	const projectOf = new Map(i.repos.map((r) => [r.repo, r.project]));
	const appOf = new Map(i.repos.map((r) => [r.repo, r.app]));
	// Gateway records name the repo in metadata.repo and the fork in metadata.fork: a known fork or repo maps to its
	// project; anything else (e.g. git.next's own calls) keeps its name.
	const projectFor = (r: CostRecord) => projectOf.get(r.fork) ?? projectOf.get(r.repo) ?? r.repo;
	const appFor = (project: string) => appOf.get(project) ?? resolveApp(i.org, project, null);
	const liveCosts = i.costs.filter((r) => inWindow(r.at));
	const monthCosts = [...liveCosts, ...(i.scale?.costs ?? []).filter((r) => inWindow(r.at))];
	const reviewsThisMonth = i.reviews.filter((r) => inWindow(r.startedAt));
	const scaleMerged = (project: string) => sum((i.scale?.merged ?? []).filter((m) => m.project === project && inWindow(m.at)).map((m) => m.count));

	// ── repos ──
	const projects = [...new Set(i.repos.map((r) => r.project))];
	const reviewsBy = Map.groupBy(i.reviews, (r) => projectOf.get(r.repo) ?? r.repo);
	const repos = i.repos
		.filter((r) => r.repo === r.project)
		.map((r) => {
			const profile = profileOf(i.org, r.app.class);
			const forks = i.repos.filter((x) => x.project === r.repo && x.repo !== r.repo).map((x) => x.repo);
			const spend = sum(monthCosts.filter((c) => projectFor(c) === r.repo).map((c) => c.cost));
			const pending = (reviewsBy.get(r.repo) ?? []).filter((x) => WAITING.has(x.status)).length;
			return { forks, ...r.app, profile: profile.title, analysedAt: r.result?.updatedAt ?? null, conflicts: r.result?.conflicts ?? null, catalogViolations: r.result?.catalog.findings ?? null, hasInstructions: r.hasInstructions, spendUsd: round(spend), pendingReviews: pending, controls: controlsFor(i, r, profile) };
		})
		.sort((a, b) => CLASSES.indexOf(b.class) - CLASSES.indexOf(a.class) || a.repo.localeCompare(b.repo));

	// ── spend ──
	const total = round(sum(monthCosts.map((r) => r.cost)));
	const teams = i.org.teams.map((t) => {
		const mine = projects.filter((p) => appFor(p).team === t.id);
		const extra = [...new Set(monthCosts.map(projectFor))].filter((p) => !projects.includes(p) && appFor(p).team === t.id);
		const spend = round(sum(monthCosts.filter((c) => appFor(projectFor(c)).team === t.id).map((c) => c.cost)));
		return { id: t.id, name: t.name, owner: t.owner ?? null, costCentre: t.costCentre ?? null, budgetUsd: t.budgetUsd ?? null, spendUsd: spend, projects: [...mine, ...extra] };
	});
	const projectBudgets = [...new Set([...projects, ...monthCosts.map(projectFor)])].map((p) => ({ project: p, budgetUsd: appFor(p).budgetUsd, spendUsd: round(sum(monthCosts.filter((c) => projectFor(c) === p).map((c) => c.cost))) }));
	const overBudget = [
		...teams.filter((t) => t.budgetUsd != null && t.spendUsd > t.budgetUsd).map((t) => ({ level: "team" as const, key: t.name, budgetUsd: t.budgetUsd!, spendUsd: t.spendUsd, pct: Math.round((t.spendUsd / t.budgetUsd!) * 100) })),
		...projectBudgets.filter((p) => p.budgetUsd != null && p.spendUsd > p.budgetUsd).map((p) => ({ level: "project" as const, key: p.project, budgetUsd: p.budgetUsd!, spendUsd: p.spendUsd, pct: Math.round((p.spendUsd / p.budgetUsd!) * 100) })),
	].sort((a, b) => b.pct - a.pct);
	const perMergedChange = projectBudgets
		.map((p) => {
			const merged = reviewsThisMonth.filter((r) => (projectOf.get(r.repo) ?? r.repo) === p.project && MERGEABLE.has(r.status)).length + scaleMerged(p.project);
			return { project: p.project, spendUsd: p.spendUsd, merged, perChangeUsd: merged ? round(p.spendUsd / merged) : null };
		})
		.filter((p) => p.spendUsd > 0 || p.merged > 0)
		.sort((a, b) => (b.perChangeUsd ?? -1) - (a.perChangeUsd ?? -1) || b.spendUsd - a.spendUsd);
	const lastWeek = sum(monthCosts.filter((r) => Date.parse(r.at) >= i.now.getTime() - 7 * 86_400_000).map((r) => r.cost));
	const budgetTotal = sum(i.org.teams.map((t) => t.budgetUsd ?? 0));

	// ── reviews and flow ──
	const waiting = i.reviews.filter((r) => WAITING.has(r.status)).map((r) => ({ repo: r.repo, ref: r.ref, after: r.after, since: r.updatedAt, ageHours: hours(i.now.getTime() - Date.parse(r.updatedAt)), class: appFor(projectOf.get(r.repo) ?? r.repo).class, reasons: [...new Set(r.reasons.map((x) => x.kind))] }));
	waiting.sort((a, b) => b.ageHours - a.ageHours);
	const decided = i.reviews.filter((r) => r.decision);
	// Reviewers by the name part of their Access identity: the view is shown on screen, full addresses aren't needed.
	const person = (by: string) => by.split("@")[0];
	const byReviewer = [...Map.groupBy(decided, (r) => person(r.decision!.by))].map(([by, rs]) => ({ by, approved: rs.filter((r) => r.decision!.decision === "approve").length, rejected: rs.filter((r) => r.decision!.decision === "reject").length }));
	for (const by of i.reviewers.map(person)) if (!byReviewer.some((r) => r.by === by)) byReviewer.push({ by, approved: 0, rejected: 0 });
	const status = Object.fromEntries([...Map.groupBy(i.reviews, (r) => r.status)].map(([s, rs]) => [s, rs.length]));
	const attempts = i.work.flatMap((w) => [...Map.groupBy(w.items.filter((x) => x.task), (x) => x.task!)].filter(([, xs]) => xs.length > 1).map(([task, xs]) => ({ project: w.project, task, attempts: xs.map((x) => `${x.repo}${x.ref !== "main" ? `@${x.ref}` : ""}`) })));
	const slaHours: Record<AppClass, number> = { "pii-regulated": 24, internal: 72, public: 72 };

	// ── risk and instruction health ──
	const flagged = i.reviews.filter((r) => r.reasons.length).map((r) => ({ repo: r.repo, ref: r.ref, after: r.after, status: r.status, at: r.updatedAt, kinds: [...new Set(r.reasons.map((x) => x.kind))] }));
	const latestMain = new Map(i.index.filter((e) => e.ref === "main" || e.ref === "master").map((e) => [e.repo, e]));
	const catalogByRepo = i.repos
		.map((r) => {
			const profile = profileOf(i.org, appFor(r.project).class);
			const cat = profileCatalog(i.catalog, profile);
			const offProfile = [...new Set(i.costs.filter((c) => (c.repo === r.repo || c.fork === r.repo) && c.model !== "unknown" && c.success && !catalogModel(cat, c.model)).map((c) => c.model))];
			return { repo: r.repo, code: r.result?.catalog.findings ?? latestMain.get(r.repo)?.catalogViolations ?? 0, byKind: r.result?.catalog.byKind ?? {}, gatewayModels: r.repo === r.project ? offProfile : [] };
		})
		.filter((r) => r.code > 0 || r.gatewayModels.length);
	const drift = i.repos.flatMap((r) => [
		...(r.result?.catalog.behind ? [{ repo: r.repo, what: `catalog ${r.result.catalog.version} is behind the org's ${i.catalog.version}` }] : []),
		...(r.result && r.result.catalog.source === "none" ? [{ repo: r.repo, what: "no catalog: only the secrets scan runs" }] : []),
		...(r.precedenceOverridden ? [{ repo: r.repo, what: "layer precedence overridden by an admin" }] : []),
		...(r.result?.copyDrift ? [{ repo: r.repo, what: `${r.result.copyDrift} vendored instruction or skill copies out of date` }] : []),
	]);
	const overlap = i.work.flatMap((w) =>
		[...Map.groupBy(w.items.flatMap((x) => x.files.map((path) => ({ path, who: `${x.repo}${x.ref !== "main" ? `@${x.ref}` : ""}` }))), (x) => x.path)]
			.filter(([, xs]) => new Set(xs.map((x) => x.who)).size > 1)
			.map(([path, xs]) => ({ project: w.project, path, who: [...new Set(xs.map((x) => x.who))] })),
	);
	overlap.sort((a, b) => b.who.length - a.who.length || a.path.localeCompare(b.path));

	return {
		generatedAt: i.now.toISOString(),
		windowDays: WINDOW_DAYS,
		registryVersion: i.org.version,
		catalogVersion: i.catalog.version,
		sources: { costs: i.costSource, costRecords: i.costs.length, reviews: i.reviews.length, storedResults: i.repos.filter((r) => r.result).length },
		profiles: i.org.profiles.map((p) => ({ ...p, repos: repos.filter((r) => r.class === p.id).map((r) => r.repo), models: p.limits.models ?? null })),
		repos,
		spend: {
			totalUsd: total,
			liveUsd: round(sum(liveCosts.map((r) => r.cost))),
			requests: sum(monthCosts.map(weight)),
			scale: i.scale ? { usd: round(sum((i.scale.costs ?? []).filter((r) => inWindow(r.at)).map((r) => r.cost))), requests: sum(i.scale.costs.filter((r) => inWindow(r.at)).map(weight)), merged: sum(i.scale.merged.filter((m) => inWindow(m.at)).map((m) => m.count)), note: i.scale.note } : null,
			top: { project: topN(monthCosts, projectFor), environment: topN(monthCosts, (r) => appFor(projectFor(r)).environment), resource: topN(monthCosts, (r) => r.provider), model: topN(monthCosts, (r) => r.model), developer: topN(monthCosts, (r) => r.developer) },
			teams,
			overBudget,
			perMergedChange,
			forecast: { mock: true, note: "Mock-up: the next 30 days at the last 7 days' run rate; no seasonality or commitments.", projectedUsd: round((lastWeek / 7) * 30, 2), budgetUsd: budgetTotal },
		},
		flow: {
			open: i.reviews.filter((r) => OPEN.has(r.status)).length,
			waiting,
			avgWaitHours: waiting.length ? round(sum(waiting.map((w) => w.ageHours)) / waiting.length, 1) : null,
			oldest: waiting[0] ?? null,
			status,
			approved: (status.approved ?? 0) + (status["auto-approved"] ?? 0),
			rejected: status.rejected ?? 0,
			reviewers: byReviewer.map((r) => ({ ...r, share: i.reviewers.length ? round(waiting.length / i.reviewers.length, 1) : null })),
			inFlight: sum(i.work.map((w) => w.items.length)),
			attempts,
			sla: { mock: true, note: "Mock-up: SLA targets per class are illustrative, not an agreed policy.", targetHours: slaHours, breached: waiting.filter((w) => w.ageHours > slaHours[w.class]).length },
		},
		risk: {
			flaggedPushes: flagged,
			catalogByRepo,
			drift,
			piiMissingControls: repos.filter((r) => r.class === "pii-regulated" && r.controls.some((c) => !c.ok)).map((r) => ({ repo: r.repo, missing: r.controls.filter((c) => !c.ok).map((c) => c.label) })),
			conflicts: i.repos.filter((r) => (r.result?.conflicts ?? 0) > 0).map((r) => ({ repo: r.repo, conflicts: r.result!.conflicts })),
			noInstructions: repos.filter((r) => r.hasInstructions === false).map((r) => r.repo),
			riskyHooks: i.repos.flatMap((r) => (r.result?.riskyHooks ?? []).map((h) => ({ repo: r.repo, ...h }))),
			overlap: overlap.slice(0, 10),
		},
	};
}

export type OrgReport = ReturnType<typeof orgReport>;

/** The class's required controls, each checked against real evidence (and saying which). */
function controlsFor(i: OrgInputs, r: RepoFacts, profile: Profile): { id: string; label: string; ok: boolean; evidence: string }[] {
	const out: { id: string; label: string; ok: boolean; evidence: string }[] = [
		{ id: "owner", label: "Owner", ok: !!r.app.owner, evidence: r.app.owner ? `${r.app.owner} (${r.app.classSource === "repo" ? APP_FILE : "org registry"})` : "no owner declared" },
		{ id: "instructions", label: "AGENTS.md", ok: r.hasInstructions === true, evidence: r.hasInstructions == null ? "not analysed yet" : r.hasInstructions ? "instruction file at the root or below" : "no AGENTS.md or CLAUDE.md" },
	];
	if (profile.id !== "pii-regulated") return out;
	const limits = profile.limits;
	const cat = profileCatalog(i.catalog, profile);
	const used = [...new Set(i.costs.filter((c) => (c.repo === r.repo || c.fork === r.repo) && c.model !== "unknown" && c.success).map((c) => c.model))];
	const off = used.filter((m) => !catalogModel(cat, m));
	const codeModels = r.result?.catalog.models ?? [];
	out.push({ id: "models", label: "Approved models only", ok: !off.length && !codeModels.length && r.result?.catalog.source !== "none" && !!r.result, evidence: !r.result ? "not analysed yet" : r.result.catalog.source === "none" ? "no catalog: models in code aren't checked" : off.length || codeModels.length ? `outside ${limits.models?.join(", ")}: ${[...off, ...codeModels].join(", ")}` : `${used.length ? `gateway calls use ${used.join(", ")}` : "no gateway calls yet"}; code checked against catalog ${r.result.catalog.version}` });
	if (limits.guardrails) out.push({ id: "guardrails", label: "Guardrails on", ok: r.app.controls.guardrails === true, evidence: r.app.controls.guardrails ? `declared in ${APP_FILE}` : `not declared in ${APP_FILE}` });
	if (limits.dataLocation) out.push({ id: "data-location", label: `Data in ${limits.dataLocation.toUpperCase()}`, ok: r.app.controls.dataLocation === limits.dataLocation, evidence: r.app.controls.dataLocation ? `${APP_FILE} says ${r.app.controls.dataLocation}` : `no dataLocation in ${APP_FILE}` });
	const reviewed = i.reviews.filter((x) => (i.repos.find((y) => y.repo === x.repo)?.project ?? x.repo) === r.repo);
	out.push({ id: "human-review", label: "Human review on data paths", ok: reviewed.length > 0, evidence: reviewed.length ? `push review active (${reviewed.length} recent run${reviewed.length === 1 ? "" : "s"}); data paths always wait for a person` : "no push reviews: the repo isn't subscribed to git.next" });
	return out;
}
