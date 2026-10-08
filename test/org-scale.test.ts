import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { orgReport, parseOrgRegistry, profileCatalog, profileOf, resolveApp, type RepoFacts } from "../src/org.ts";
import { expandOrgScale, type OrgScaleData } from "../src/org-scale.ts";
import { catalogModel, parseCatalog } from "../src/providers/catalog.ts";
import type { CostRecord } from "../src/providers/cost/logs.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const ORG = parseOrgRegistry(read("../fixtures/org-baseline/org.json"));
const CATALOG = parseCatalog(read("../fixtures/org-baseline/catalog.json"));
const DATA = JSON.parse(read("../fixtures/org-scale/usage.json")) as OrgScaleData;
const NOW = new Date("2026-10-20T12:00:00Z");

describe("org-scale dataset", () => {
	const scale = expandOrgScale(DATA, NOW);

	it("is about $20k over 30 days, every record synthetic and dated inside the window", () => {
		const total = scale.costs.reduce((n, r) => n + r.cost, 0);
		expect(total).toBeGreaterThan(19_000);
		expect(total).toBeLessThan(21_000);
		expect(Math.abs(total - DATA.totalUsd)).toBeLessThan(0.01);
		expect(scale.costs.every((r) => r.synthetic && !r.mocked && (r.requests ?? 0) >= 1)).toBe(true);
		const ages = scale.costs.map((r) => (NOW.getTime() - Date.parse(r.at)) / 86_400_000);
		expect(Math.min(...ages)).toBe(0);
		expect(Math.max(...ages)).toBe(29);
	});

	it("only uses models each project's class allows", () => {
		for (const r of scale.costs) {
			const cat = profileCatalog(CATALOG, profileOf(ORG, resolveApp(ORG, r.repo, null).class));
			expect(catalogModel(cat, r.model), `${r.repo} ${r.model}`).toBeTruthy();
		}
	});

	it("adds to spend and merged changes, never to risk, controls or flow", () => {
		const fact = (repo: string): RepoFacts => ({ repo, project: repo, app: resolveApp(ORG, repo, null), result: null, hasInstructions: true, precedenceOverridden: false });
		const live: CostRecord = { id: "l", at: "2026-10-19T00:00:00Z", model: "anthropic/claude-sonnet-5", provider: "anthropic", tokensIn: 1, tokensOut: 1, cost: 0.2, cached: false, success: true, developer: "chris", repo: "new-repo-demo", fork: "uploads-smart", agent: "a", task: "t", taskLabel: "t", cloud: "cloudflare", mocked: false };
		const base = { now: NOW, org: ORG, catalog: CATALOG, repos: ["agents-demo-full", "uploads-smart", "uploads-bare"].map(fact), index: [], reviews: [], costs: [live], costSource: "test", work: [], reviewers: [] };
		const withScale = orgReport({ ...base, scale });
		const liveOnly = orgReport({ ...base, scale: null });
		expect(liveOnly.spend.totalUsd).toBe(0.2);
		expect(withScale.spend.liveUsd).toBe(0.2);
		expect(withScale.spend.totalUsd).toBeCloseTo(DATA.totalUsd + 0.2, 1);
		expect(withScale.spend.scale).toMatchObject({ merged: DATA.merged.reduce((n, m) => n + m[2], 0) });
		expect(withScale.spend.requests).toBe(DATA.rows.reduce((n, r) => n + r[4], 0) + 1);
		expect(withScale.spend.overBudget.length).toBeGreaterThan(0);
		expect(withScale.spend.perMergedChange.find((p) => p.project === "agents-demo-full")!.perChangeUsd).toBeGreaterThan(10);
		// Risk and controls see the live record only.
		expect(withScale.risk).toEqual(liveOnly.risk);
		expect(withScale.repos.map((r) => r.controls)).toEqual(liveOnly.repos.map((r) => r.controls));
		expect(withScale.flow).toEqual(liveOnly.flow);
	});
});
