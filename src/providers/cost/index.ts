import type { Insight, InsightProvider } from "../../core/types.ts";
import fixture from "../../../fixtures/ai-gateway-logs.json" with { type: "json" };
import { parseGatewayLogs, staticCostSource, UNATTRIBUTED, type CostSource } from "./logs.ts";
import { modelFit } from "./model-fit.ts";
import { rollup, spendFlags } from "./rollup.ts";
import { catalogModel, type Catalog } from "../catalog.ts";
import type { CostRecord } from "./logs.ts";

/** Which catalog job a task label needs (task ids look like "<label>#<slug>"). Unlisted labels aren't checked. */
const JOB_FOR_LABEL: Record<string, string> = {
	plan: "planning",
	docs: "coding",
	feature: "coding",
	refactor: "coding",
	fix: "coding",
	test: "coding",
	debug: "coding",
	review: "review",
	summarize: "summaries",
	describe: "summaries",
	format: "coding",
	changelog: "coding",
	triage: "coding",
};

export interface ModelPolicyFinding {
	agent: string;
	model: string;
	taskLabel: string;
	requests: number;
	reason: "not-in-catalog" | "outside-jobs";
	detail: string;
}

/** Gateway calls checked against the catalog: unknown models, and models used outside their approved jobs. */
export function modelPolicy(records: CostRecord[], catalog: Catalog): ModelPolicyFinding[] {
	const out: ModelPolicyFinding[] = [];
	for (const [, rs] of Map.groupBy(records, (r) => `${r.agent}|${r.model}|${r.taskLabel}`)) {
		const { agent, model, taskLabel } = rs[0];
		if (model === "unknown" || !rs.some((r) => r.success)) continue;
		const entry = catalogModel(catalog, model);
		const job = JOB_FOR_LABEL[taskLabel];
		if (!entry) out.push({ agent, model, taskLabel, requests: rs.length, reason: "not-in-catalog", detail: `${model} is not in catalog ${catalog.version}` });
		else if (job && entry.jobs?.length && !entry.jobs.includes(job)) out.push({ agent, model, taskLabel, requests: rs.length, reason: "outside-jobs", detail: `${model} is approved for ${entry.jobs.join("/")}, but ran "${taskLabel}" (${job}) work${entry.rule ? `: ${entry.rule}` : ""}` });
	}
	return out;
}

export const fixtureCostSource = (): CostSource => staticCostSource("fixture:ai-gateway-logs", parseGatewayLogs(fixture));

/** Dollars with cents, or more precision for sub-cent amounts so tiny spend doesn't read as $0.00. */
export const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toPrecision(3)}` : `$${n.toFixed(2)}`);

export function costProvider(source: CostSource = fixtureCostSource(), opts: { catalog?: Catalog } = {}): InsightProvider {
	return {
		id: "cost",
		title: "Agent cost",
		needs: [],
		async analyze({ repo, ref }) {
			// For a fork, show only that fork's requests (the source also returns them for the parent repo name).
			const all = await source.records({ repo });
			const records = all.some((r) => r.fork === repo) ? all.filter((r) => r.fork === repo) : all;
			if (!records.length) return [{ provider: "cost", severity: "info", scope: { repo, ref }, title: "No AI Gateway usage for this repo", detail: `Source ${source.id} has no records tagged repo=${repo}.`, evidence: [] }];
			const tree = rollup(records);
			const total = tree.reduce((n, p) => n + p.cost, 0);
			const unattributed = records.filter((r) => r.developer === UNATTRIBUTED);
			const flags = spendFlags(records);
			const fits = modelFit(records);
			const policy = opts.catalog ? modelPolicy(records, opts.catalog) : [];
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
				...policy.map(
					(p): Insight => ({
						provider: "cost",
						severity: "warn",
						scope: { repo, ref, agent: p.agent },
						title: `Catalog: ${p.agent} used ${p.model}${p.reason === "outside-jobs" ? ` for ${p.taskLabel}` : ""}`,
						detail: `${p.detail} (${p.requests} request${p.requests === 1 ? "" : "s"}).`,
						evidence: [],
						metrics: { ...p, catalogVersion: opts.catalog!.version },
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
