import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { buildOrg } from "../src/org-routes.ts";
import { APP_FILE, PROFILES_REPO, matchesGlob, orgReport, parseAppDeclaration, parseOrgRegistry, profileCatalog, profileOf, profileReviewReasons, resolveApp, summarizeStored, withProfileLayers, type OrgInputs, type RepoFacts } from "../src/org.ts";
import { parseCatalog } from "../src/providers/catalog.ts";
import type { CostRecord } from "../src/providers/cost/logs.ts";
import { collectLayers } from "../src/providers/instruction-stack/index.ts";
import type { ReviewRecord } from "../src/review.ts";

const ORG = parseOrgRegistry(readFileSync(new URL("../fixtures/org-baseline/org.json", import.meta.url), "utf8"));
const CATALOG = parseCatalog(readFileSync(new URL("../fixtures/org-baseline/catalog.json", import.meta.url), "utf8"));
// The registry with demo-scale budgets (cents), so a handful of test records can go over them.
const TEAM_BUDGETS: Record<string, number> = { agents: 0.75, cms: 0.5, storage: 0.25, platform: 1 };
const PROJECT_BUDGETS: Record<string, number> = { "agents-demo-full": 0.6, "emdash-demo": 0.5, "uploads-smart": 0.1, "uploads-bare": 0.1, "git-next": 1 };
const SMALL = { ...ORG, teams: ORG.teams.map((t) => ({ ...t, budgetUsd: TEAM_BUDGETS[t.id] })), projects: ORG.projects.map((p) => ({ ...p, budgetUsd: PROJECT_BUDGETS[p.repo] })) };
const PII_LAYER = readFileSync(new URL("../fixtures/org-baseline/profiles/pii-regulated.md", import.meta.url), "utf8");

const cost = (over: Partial<CostRecord>): CostRecord => ({ id: "x", at: "2026-10-05T10:00:00Z", model: "anthropic/claude-sonnet-5.5", provider: "anthropic", tokensIn: 1, tokensOut: 1, cost: 0.1, cached: false, success: true, developer: "chris", repo: "agents-demo-full", fork: "main", agent: "a", task: "t#1", taskLabel: "t", cloud: "cloudflare", mocked: false, ...over });
const review = (over: Partial<ReviewRecord>): ReviewRecord => ({ repo: "uploads-smart", ref: "main", after: "a".repeat(40), before: null, instanceId: "i", status: "auto-approved", startedAt: "2026-10-08T01:00:00Z", updatedAt: "2026-10-08T01:00:00Z", commit: null, reasons: [], steps: [], ...over });

describe("org registry and declarations", () => {
	it("validates the bundled registry and rejects a bad one", () => {
		expect(ORG.profiles.map((p) => p.id)).toEqual(["public", "internal", "pii-regulated"]);
		expect(() => parseOrgRegistry(JSON.stringify({ version: "1", defaultClass: "secret", profiles: [], teams: [], projects: [] }))).toThrow(/defaultClass/);
		expect(() => parseOrgRegistry(JSON.stringify({ ...ORG, profiles: ORG.profiles.filter((p) => p.id !== "public") }))).toThrow(/must define public/);
	});

	it("keeps only well-formed fields from .gitnext/app.json", () => {
		expect(parseAppDeclaration('{ "class": "pii-regulated", "owner": "@acme/x", "team": "storage", "budgetUsd": 99, "controls": { "guardrails": true, "dataLocation": "eu" } }').decl).toEqual({ class: "pii-regulated", owner: "@acme/x", team: "storage", controls: { guardrails: true, dataLocation: "eu" } });
		expect(parseAppDeclaration('{ "class": "top-secret" }').error).toMatch(/class must be one of/);
		expect(parseAppDeclaration('{ "owner": "rm -rf /; echo" }').decl).toEqual({});
		expect(parseAppDeclaration(null)).toEqual({ decl: null });
	});

	it("lets a repo raise its class but never lower it below the registry", () => {
		expect(resolveApp(ORG, "uploads-smart", { class: "public" })).toMatchObject({ class: "pii-regulated", classSource: "org" });
		expect(resolveApp(ORG, "agents-demo-full", { class: "pii-regulated" })).toMatchObject({ class: "pii-regulated", classSource: "repo", team: "agents", costCentre: "CC-4100", budgetUsd: 7000 });
		expect(resolveApp(ORG, "somewhere-new", null)).toMatchObject({ class: "internal", classSource: "default", owner: null, budgetUsd: null });
	});
});

describe("profiles as policy", () => {
	const pii = profileOf(ORG, "pii-regulated");

	it("narrows the catalog to the profile's models", () => {
		const cat = profileCatalog(CATALOG, pii);
		expect(cat.models.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5.5", "@cf/zai-org/glm-5.3-flash"]);
		expect(cat.version).toBe(`${CATALOG.version}+pii-regulated`);
		expect(profileCatalog(CATALOG, profileOf(ORG, "internal"))).toBe(CATALOG);
	});

	it("sends data paths to a person", () => {
		expect(["migrations/0001.sql", "src/uploads/handler.ts", "deep/x/schema.sql", "wrangler.jsonc", "apps/a/wrangler.jsonc"].every((p) => pii.limits.reviewPaths!.some((g) => matchesGlob(g, p)))).toBe(true);
		expect(matchesGlob("src/data/**", "src/database.ts")).toBe(false);
		const reasons = profileReviewReasons(pii, [{ path: "src/storage/r2.ts", status: "modified" }, { path: "README.md", status: "modified" }]);
		expect(reasons).toEqual([{ kind: "profile", path: "src/storage/r2.ts", why: "modifies a data path that PII-regulated repos always send to a person" }]);
		expect(profileReviewReasons(profileOf(ORG, "public"), [{ path: "migrations/1.sql", status: "added" }])).toEqual([]);
	});

	it("adds the profile layer to the stack at org rank without touching the repo", async () => {
		const repo = memorySource({ main: { [APP_FILE]: '{ "class": "pii-regulated" }', "AGENTS.md": "# Hi\n", ".gitnext/stack.json": '{ "layers": [{ "name": "contract", "kind": "contract", "path": "contract.md" }] }', "contract.md": "x" } });
		const ctx = new RepoContext(withProfileLayers(async () => repo, ORG, { "profiles/pii-regulated.md": PII_LAYER }));
		const { layers, errors } = await collectLayers(ctx, "app", "main");
		expect(errors).toEqual([]);
		expect(layers.map((l) => `${l.kind}:${l.repo}:${l.path}`)).toEqual(["project:app:AGENTS.md", "contract:app:contract.md", `org:${PROFILES_REPO}:profiles/pii-regulated.md`]);
		expect(await ctx.readFile(PROFILES_REPO, "HEAD", "profiles/pii-regulated.md")).toContain("Only use approved models");
		// An internal repo is read as it is.
		const plain = memorySource({ main: { "AGENTS.md": "# Hi\n" } });
		const internal = new RepoContext(withProfileLayers(async () => plain, ORG, { "profiles/pii-regulated.md": PII_LAYER }));
		expect((await internal.readTree("agents-demo-full", "main")).map((f) => f.path)).toEqual(["AGENTS.md"]);
	});
});

describe("orgReport", () => {
	const stored = summarizeStored(
		{
			updatedAt: "2026-10-08T00:00:00Z",
			insights: [
				{ provider: "instruction-stack", severity: "info", title: "Instruction stack: 2 layers", metrics: { layers: [{ kind: "project", origin: "project" }] } },
				{ provider: "instruction-stack", severity: "conflict", title: "conflict: packageManager" },
				{ provider: "instruction-stack", severity: "warn", title: "Plugin hook needs review: tidy (PostToolUse)", metrics: { kind: "plugin" } },
				{ provider: "catalog", severity: "info", title: "Catalog 2026.9.1 (repo): behind 2026.10.5", metrics: { source: "repo", version: "2026.9.1", behind: true, byKind: { model: 1 } } },
				{ provider: "catalog", severity: "conflict", title: "Unapproved model: gpt-5", metrics: { kind: "model" } },
			],
		},
		"main",
	);
	const fact = (repo: string, over: Partial<RepoFacts> = {}): RepoFacts => ({ repo, project: repo, app: resolveApp(SMALL, repo, null), result: null, hasInstructions: true, precedenceOverridden: false, ...over });
	const inputs: OrgInputs = {
		now: new Date("2026-10-08T05:00:00Z"),
		org: SMALL,
		catalog: CATALOG,
		repos: [
			fact("agents-demo-full", { result: stored, precedenceOverridden: true }),
			fact("agents-demo-r2", { project: "agents-demo-full", app: resolveApp(SMALL, "agents-demo-full", null), hasInstructions: null }),
			fact("uploads-smart", { app: resolveApp(SMALL, "uploads-smart", { controls: { guardrails: true, dataLocation: "eu" } }) }),
			fact("uploads-bare", { hasInstructions: false }),
		],
		index: [],
		reviews: [
			review({ repo: "uploads-bare", status: "needs-review", updatedAt: "2026-10-07T05:00:00Z", reasons: [{ kind: "catalog", path: "src/index.ts", why: "x" }] }),
			review({ repo: "agents-demo-full", ref: "attempt/haiku", status: "needs-review", updatedAt: "2026-10-08T04:00:00Z", reasons: [{ kind: "instructions", path: "AGENTS.md", why: "x" }] }),
			review({ repo: "uploads-smart", status: "auto-approved" }),
			review({ repo: "agents-demo-r2", status: "rejected", decision: { by: "ana@example.com", at: "2026-10-08T02:00:00Z", decision: "reject", reason: "too broad" } }),
			review({ repo: "agents-demo-r2", status: "approved", decision: { by: "ana@example.com", at: "2026-10-08T02:00:00Z", decision: "approve", reason: "fine now" } }),
		],
		costs: [
			cost({ cost: 0.5, fork: "agents-demo-r2", developer: "chris" }),
			cost({ cost: 0.2, repo: "new-repo-demo", fork: "uploads-smart", model: "anthropic/claude-sonnet-5", developer: "maya" }),
			cost({ cost: 0.05, repo: "git-next", fork: "resolver", provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", developer: "git-next" }),
			cost({ cost: 9, at: "2026-09-01T00:00:00Z" }),
		],
		costSource: "test",
		work: [{ project: "agents-demo-full", items: [
			{ repo: "agents-demo-full", ref: "attempt/haiku", agent: "haiku", task: "add-docs", files: ["docs/a.md", "src/x.ts"], updatedAt: "" },
			{ repo: "agents-demo-full", ref: "attempt/sonnet", agent: "sonnet", task: "add-docs", files: ["docs/a.md"], updatedAt: "" },
			{ repo: "agents-demo-r2", ref: "main", agent: "r2", task: null, files: ["src/x.ts"], updatedAt: "" },
		] }],
		reviewers: ["ana@example.com", "lee@example.com"],
	};
	const r = orgReport(inputs);

	it("rolls spend up by project (forks included), team and dimension, over the last 30 days", () => {
		expect(r.spend.totalUsd).toBe(0.75);
		expect(r.spend.liveUsd).toBe(0.75);
		expect(r.spend.scale).toBeNull();
		expect(r.spend.top.project).toEqual([{ key: "agents-demo-full", cost: 0.5, requests: 1 }, { key: "uploads-smart", cost: 0.2, requests: 1 }, { key: "git-next", cost: 0.05, requests: 1 }]);
		expect(r.spend.top.environment.map((t) => t.key)).toEqual(["production", "staging"]);
		expect(r.spend.top.resource.map((t) => t.key)).toEqual(["anthropic", "workers-ai"]);
		expect(r.spend.top.developer.map((t) => t.key)).toEqual(["chris", "maya", "git-next"]);
		expect(r.spend.teams.find((t) => t.id === "storage")).toMatchObject({ spendUsd: 0.2, budgetUsd: 0.25 });
		expect(r.spend.overBudget).toEqual([{ level: "project", key: "uploads-smart", budgetUsd: 0.1, spendUsd: 0.2, pct: 200 }]);
		expect(r.spend.perMergedChange.find((p) => p.project === "uploads-smart")).toEqual({ project: "uploads-smart", spendUsd: 0.2, merged: 1, perChangeUsd: 0.2 });
		expect(r.spend.forecast).toMatchObject({ mock: true, projectedUsd: 3.21, budgetUsd: 2.5 });
	});

	it("reports review flow from the review records", () => {
		expect(r.flow.waiting.map((w) => [w.repo, w.ageHours, w.class])).toEqual([["uploads-bare", 24, "pii-regulated"], ["agents-demo-full", 1, "internal"]]);
		expect(r.flow.avgWaitHours).toBe(12.5);
		expect(r.flow).toMatchObject({ open: 2, approved: 2, rejected: 1, inFlight: 3 });
		expect(r.flow.reviewers).toEqual([{ by: "Reviewer 1", approved: 1, rejected: 1, share: 1 }, { by: "Reviewer 2", approved: 0, rejected: 0, share: 1 }]);
		// No names or ids on screen: a service token appears under its short label.
		const svc = orgReport({ ...inputs, reviewers: ["service:abcdef123456.access"], reviews: [review({ status: "approved", decision: { by: "service token abcdef", at: "", decision: "approve", reason: "fine, merged" } })] });
		expect(svc.flow.reviewers).toEqual([{ by: "service token abcdef", approved: 1, rejected: 0, share: 0 }]);
		expect(r.flow.attempts).toEqual([{ project: "agents-demo-full", task: "add-docs", attempts: ["agents-demo-full@attempt/haiku", "agents-demo-full@attempt/sonnet"] }]);
		expect(r.flow.sla).toMatchObject({ mock: true, breached: 0 });
	});

	it("finds risk across repos: controls, catalog, drift, conflicts, hooks, overlap", () => {
		expect(r.risk.piiMissingControls).toEqual([
			{ repo: "uploads-bare", missing: ["Owner", "AGENTS.md", "Approved models only", "Guardrails on", "Data in EU"] },
			{ repo: "uploads-smart", missing: ["Approved models only"] },
		]);
		expect(r.repos.find((x) => x.repo === "uploads-smart")!.controls.find((c) => c.id === "models")!.evidence).toBe("not analysed yet");
		expect(r.risk.catalogByRepo).toEqual([{ repo: "agents-demo-full", code: 1, byKind: { model: 1 }, gatewayModels: [] }, { repo: "uploads-smart", code: 0, byKind: {}, gatewayModels: ["anthropic/claude-sonnet-5"] }]);
		expect(r.risk.drift.map((d) => d.what)).toEqual(["catalog 2026.9.1 is behind the org's 2026.10.5", "layer precedence overridden by an admin"]);
		expect(r.risk.conflicts).toEqual([{ repo: "agents-demo-full", conflicts: 1 }]);
		expect(r.risk.riskyHooks).toEqual([{ repo: "agents-demo-full", plugin: "tidy", title: "Plugin hook needs review: tidy (PostToolUse)" }]);
		expect(r.risk.noInstructions).toEqual(["uploads-bare"]);
		expect(r.risk.overlap.map((o) => [o.path, o.who])).toEqual([["docs/a.md", ["agents-demo-full@attempt/haiku", "agents-demo-full@attempt/sonnet"]], ["src/x.ts", ["agents-demo-full@attempt/haiku", "agents-demo-r2"]]]);
		expect(r.risk.flaggedPushes.map((f) => f.kinds)).toEqual([["catalog"], ["instructions"]]);
		// Forks fold into their project; the PII class sorts first.
		expect(r.repos.map((x) => x.repo)).toEqual(["uploads-bare", "uploads-smart", "agents-demo-full"]);
		expect(r.repos.find((x) => x.repo === "agents-demo-full")!.forks).toEqual(["agents-demo-r2"]);
	});
});

describe("buildOrg", () => {
	it("reads declarations and stored results, maps forks to projects, and reports sources that fail", async () => {
		const sources: Record<string, ReturnType<typeof memorySource>> = {
			"app-a": memorySource({ main: { [APP_FILE]: '{ "class": "pii-regulated", "owner": "@acme/a" }', "AGENTS.md": "# a" } }),
			"app-a-fork": memorySource({ main: { "AGENTS.md": "# a" } }),
			mirror: memorySource({ master: { "README.md": "hi" } }),
		};
		const org = await buildOrg({
			org: ORG,
			catalog: CATALOG,
			listRepos: async () => [
				{ name: "app-a", source: null, defaultBranch: "main" },
				{ name: "app-a-fork", source: "artifacts:default/app-a", defaultBranch: "main" },
				{ name: "mirror", source: "git:https://github.com/x/y.git", defaultBranch: "master" },
			],
			files: () => new RepoContext(async (name) => sources[name]),
			index: async () => [],
			stored: async () => null,
			reviews: async () => [],
			precedenceOverridden: async () => false,
			costs: async () => {
				throw new Error("AI Gateway logs: HTTP 403");
			},
			costSource: "test",
			work: async (project) => ({ project, items: [] }),
			reviewers: [],
			now: () => new Date("2026-10-08T00:00:00Z"),
		});
		expect(org.repos.map((r) => [r.repo, r.class, r.classSource, r.owner, r.hasInstructions, r.forks])).toEqual([
			["app-a", "pii-regulated", "repo", "@acme/a", true, ["app-a-fork"]],
			["mirror", "internal", "default", null, false, []],
		]);
		expect(org.errors).toEqual(["AI Gateway logs: Error: AI Gateway logs: HTTP 403"]);
	});
});
