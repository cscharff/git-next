import type { Insight, InsightProvider } from "../../core/types.ts";
import fixture from "../../../fixtures/ai-gateway-logs.json" with { type: "json" };
import { parseGatewayLogs, staticCostSource, UNATTRIBUTED, type CostSource } from "./logs.ts";
import { modelFit } from "./model-fit.ts";
import { rollup, spendFlags } from "./rollup.ts";

export const fixtureCostSource = (): CostSource => staticCostSource("fixture:ai-gateway-logs", parseGatewayLogs(fixture));

/** Dollars with cents, or more precision for sub-cent amounts so tiny spend doesn't read as $0.00. */
export const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toPrecision(3)}` : `$${n.toFixed(2)}`);

export function costProvider(source: CostSource = fixtureCostSource()): InsightProvider {
	return {
		id: "cost",
		title: "Agent cost",
		needs: [],
		async analyze({ repo, ref }) {
			const records = await source.records({ repo });
			if (!records.length) return [{ provider: "cost", severity: "info", scope: { repo, ref }, title: "No AI Gateway usage for this repo", detail: `Source ${source.id} has no records tagged repo=${repo}.`, evidence: [] }];
			const tree = rollup(records);
			const total = tree.reduce((n, p) => n + p.cost, 0);
			const unattributed = records.filter((r) => r.developer === UNATTRIBUTED);
			const flags = spendFlags(records);
			const fits = modelFit(records);
			const agents = [...Map.groupBy(records, (r) => r.agent)].map(([agent, rs]) => ({ agent, cost: rs.reduce((n, r) => n + r.cost, 0), requests: rs.length, models: [...new Set(rs.map((r) => r.model))] })).sort((a, b) => b.cost - a.cost);

			const insights: Insight[] = [
				{
					provider: "cost",
					severity: "info",
					scope: { repo, ref },
					title: `AI spend ${usd(total)} across ${records.length} requests`,
					detail: `${agents.length} agents; ${unattributed.length} requests have no developer metadata (identity coverage ${Math.round((1 - unattributed.length / records.length) * 100)}%). Source: ${source.id}.`,
					evidence: [],
					metrics: { source: source.id, total, requests: records.length, rollup: tree, agents },
				},
				...agents.map(
					(a): Insight => ({
						provider: "cost",
						severity: "info",
						scope: { repo, ref, agent: a.agent },
						title: `${a.agent}: ${usd(a.cost)} over ${a.requests} requests`,
						detail: `Models: ${a.models.join(", ")}.`,
						evidence: [],
						metrics: a,
					}),
				),
				...flags.map(
					(f): Insight => ({
						provider: "cost",
						severity: "warn",
						scope: { repo, ref, ...(f.level === "agent" ? { agent: f.key } : {}) },
						title: `${f.level} ${f.key} spends ${f.multiple}× the median`,
						detail: `${usd(f.cost)} vs a median ${f.level} spend of ${usd(f.median)}.`,
						evidence: [],
						metrics: { ...f },
					}),
				),
				...fits.map(
					(s): Insight => ({
						provider: "cost",
						severity: "info",
						scope: { repo, ref, agent: s.agent },
						title: `Model fit: ${s.taskLabel} on ${s.model} → ${s.suggest}`,
						detail: `${s.agent} ran ${s.requests} "${s.taskLabel}" requests on a ${s.tier} model (${usd(s.actualCost)}); ${s.why}. Estimated ${usd(s.estimatedCost)}, saving ${usd(s.estimatedSaving)}.`,
						evidence: [],
						metrics: { ...s },
					}),
				),
			];
			return insights;
		},
	};
}
