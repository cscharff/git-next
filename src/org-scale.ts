import type { CostRecord } from "./providers/cost/logs.ts";
import type { OrgScale } from "./org.ts";

// The Org tab's production-scale dataset: fixtures/org-scale/usage.json (scripts/gen-org-scale.ts), daily totals
// stored as tuples, expanded here into cost records dated relative to now so the window always has 30 days of it.
// Every record is marked `synthetic`; the dashboard footnotes it and offers a "Live only" view without it.

export interface OrgScaleData {
	note: string;
	days: number;
	totalUsd: number;
	projects: string[];
	developers: string[];
	combos: { agent: string; model: string; provider: string; task: string }[];
	/** [daysAgo, project, developer, combo, requests, tokensIn, tokensOut, cost × 10,000] */
	rows: [number, number, number, number, number, number, number, number][];
	/** [daysAgo, project, merged changes] */
	merged: [number, number, number][];
}

const DAY = 86_400_000;

export function expandOrgScale(data: OrgScaleData, now: Date): OrgScale {
	// Each day's totals sit at the same time of day as now, so "today" is never in the future.
	const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString();
	const costs = data.rows.map(([d, p, dev, c, requests, tokensIn, tokensOut, cost], k): CostRecord => {
		const combo = data.combos[c];
		const project = data.projects[p];
		return { id: `scale-${k}`, at: at(d), model: combo.model, provider: combo.provider, tokensIn, tokensOut, cost: cost / 1e4, cached: false, success: true, developer: data.developers[dev], repo: project, fork: project, agent: combo.agent, task: combo.task, taskLabel: combo.task, cloud: "cloudflare", mocked: false, requests, synthetic: true };
	});
	return { costs, merged: data.merged.map(([d, p, count]) => ({ project: data.projects[p], at: at(d), count })), note: data.note };
}
