import type { Cloud, EnvScope, Insight, InsightProvider } from "../../core/types.ts";
import fixture from "../../../fixtures/ai-gateway-logs.json" with { type: "json" };
import { parseGatewayLogs, staticCostSource, UNATTRIBUTED, type CostSource } from "./logs.ts";
import { JOB_FOR_LABEL, modelFit } from "./model-fit.ts";
import { byCloud, rollup, spendFlags } from "./rollup.ts";
import { catalogModel, type Catalog } from "../catalog.ts";
import type { CostRecord } from "./logs.ts";

export interface ModelPolicyFinding {
	agent: string;
	model: string;
	taskLabel: string;
	requests: number;
	reason: "not-in-catalog" | "outside-jobs";
	detail: string;
	cloud: CostRecord["cloud"];
	mocked: boolean;
}

/** Gateway calls checked against the catalog: unknown models, and models used outside their approved jobs. */
export function modelPolicy(records: CostRecord[], catalog: Catalog): ModelPolicyFinding[] {
	const out: ModelPolicyFinding[] = [];
	for (const [, rs] of Map.groupBy(records, (r) => `${r.agent}|${r.model}|${r.taskLabel}`)) {
		const { agent, model, taskLabel, cloud } = rs[0];
		const mocked = rs.some((r) => r.mocked);
		if (model === "unknown" || !rs.some((r) => r.success)) continue;
		const entry = catalogModel(catalog, model);
		const job = JOB_FOR_LABEL[taskLabel];
		if (!entry) out.push({ agent, model, taskLabel, requests: rs.length, reason: "not-in-catalog", detail: `${model} is not in catalog ${catalog.version}`, cloud, mocked });
		else if (job && entry.jobs?.length && !entry.jobs.includes(job)) out.push({ agent, model, taskLabel, requests: rs.length, cloud, mocked, reason: "outside-jobs", detail: `${model} is approved for ${entry.jobs.join("/")}, but ran "${taskLabel}" (${job}) work${entry.rule ? `: ${entry.rule}` : ""}` });
	}
	return out;
}

export const fixtureCostSource = (): CostSource => staticCostSource("fixture:ai-gateway-logs", parseGatewayLogs(fixture));

/** Dollars with cents, or more precision for sub-cent amounts so tiny spend doesn't read as $0.00. */
export const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toPrecision(3)}` : `$${n.toFixed(2)}`);

/** Scope env for insights about one cloud; absent for Cloudflare (the default) so live-only output is unchanged. */
const envFor = (cloud: Cloud, mocked: boolean): { env?: EnvScope } => (cloud === "cloudflare" && !mocked ? {} : { env: { cloud, mocked } });

export function costProvider(source: CostSource = fixtureCostSource(), opts: { catalog?: Catalog } = {}): InsightProvider {
	return {
		id: "cost",
		title: "Agent cost",
		needs: [],
		async analyze({ repo, ref }) {
			// For a fork, show only that fork's requests (the source also returns them for the parent repo name).
			const all = await source.records({ repo });
			// (A repo that has records of its own is the parent view, even if some calls were tagged fork=<repo>.)
			const forkView = !all.some((r) => r.repo === repo) && all.some((r) => r.fork === repo);
			const records = forkView ? all.filter((r) => r.fork === repo) : all;
			if (!records.length) return [{ provider: "cost", severity: "info", scope: { repo, ref }, title: "No AI Gateway usage for this repo", detail: `Source ${source.id} has no records tagged repo=${repo}.`, evidence: [] }];
			const tree = rollup(records);
			const total = tree.reduce((n, p) => n + p.cost, 0);
			const unattributed = records.filter((r) => r.developer === UNATTRIBUTED);
			const flags = spendFlags(records);
			const fits = modelFit(records, opts.catalog);
			const clouds = byCloud(records);
			const multi = clouds.length > 1;
			const mockedCount = records.filter((r) => r.mocked).length;
			const policy = opts.catalog ? modelPolicy(records, opts.catalog) : [];
			const agents = [...Map.groupBy(records, (r) => r.agent)].map(([agent, rs]) => ({ agent, cost: rs.reduce((n, r) => n + r.cost, 0), requests: rs.length, models: [...new Set(rs.map((r) => r.model))], ...(multi ? { clouds: [...new Set(rs.map((r) => r.cloud))], mocked: rs.some((r) => r.mocked) } : {}) })).sort((a, b) => b.cost - a.cost);

			const insights: Insight[] = [
				{
					provider: "cost",
					severity: "info",
					scope: { repo, ref },
					title: `AI spend ${usd(total)} across ${records.length} requests`,
					detail: `${agents.length} agents; ${unattributed.length} requests have no developer metadata (identity coverage ${Math.round((1 - unattributed.length / records.length) * 100)}%). Source: ${source.id}.${mockedCount ? ` Includes ${mockedCount} MOCKED requests (${clouds.filter((c) => c.mocked).map((c) => c.cloud).join(", ")}), not real spend.` : ""}`,
					evidence: [],
					metrics: { source: source.id, total, requests: records.length, rollup: tree, agents, byCloud: clouds, clouds: clouds.map((c) => c.cloud), mockedRequests: mockedCount },
				},
				...(multi ? clouds : []).map(
					(c): Insight => ({
						provider: "cost",
						severity: "info",
						scope: { repo, ref, env: { cloud: c.cloud, mocked: c.mocked } },
						title: `${c.cloud}${c.mocked ? " (mocked)" : ""}: ${usd(c.cost)} over ${c.requests} requests`,
						detail: `Models: ${c.models.join(", ")}.${c.mocked ? " Mocked records, not real spend." : ""}`,
						evidence: [],
						metrics: { ...c },
					}),
				),
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
						detail: `${usd(f.cost)} vs a median ${f.level} spend of ${usd(f.median)}.${multi && records.some((r) => r[f.level] === f.key && r.mocked) ? " Includes mocked records." : ""}`,
						evidence: [],
						metrics: { ...f, ...(multi ? { clouds: [...new Set(records.filter((r) => r[f.level] === f.key).map((r) => r.cloud))], mocked: records.some((r) => r[f.level] === f.key && r.mocked) } : {}) },
					}),
				),
				...policy.map(
					(p): Insight => ({
						provider: "cost",
						severity: "warn",
						scope: { repo, ref, agent: p.agent, ...envFor(p.cloud, p.mocked) },
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
						scope: { repo, ref, agent: s.agent, ...envFor(s.cloud, s.mocked) },
						title: `Model fit: ${s.taskLabel} on ${s.model} → ${s.suggest}${s.suggestCloud ? ` (${s.suggestCloud})` : ""}`,
						detail: `${s.agent} ran ${s.requests} "${s.taskLabel}" requests on a ${s.tier} model (${usd(s.actualCost)}); ${s.why}. Estimated ${usd(s.estimatedCost)}, saving ${usd(s.estimatedSaving)}.${s.mocked ? " Mocked records." : ""}`,
						evidence: [],
						metrics: { ...s },
					}),
				),
			];
			return insights;
		},
	};
}
