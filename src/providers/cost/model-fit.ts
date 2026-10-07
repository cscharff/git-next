import type { Cloud } from "../../core/types.ts";
import { cloudOf, equivalentModels, type Catalog } from "../catalog.ts";
import type { CostRecord } from "./logs.ts";

/** Which catalog job a task label needs (task ids look like "<label>#<slug>"). Unlisted labels aren't checked. */
export const JOB_FOR_LABEL: Record<string, string> = {
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
	format: "chores",
	changelog: "chores",
	triage: "chores",
};

export type Tier = "frontier" | "mid" | "small";

/** Model → tier and $/M tokens (in, out). Workers AI prices from the 2026-10-07 catalog; vendor prices illustrative. */
export const MODELS: Record<string, { tier: Tier; in: number; out: number }> = {
	"claude-opus-5-5": { tier: "frontier", in: 15, out: 75 },
	"gpt-5.6-sol": { tier: "frontier", in: 10, out: 40 },
	"claude-sonnet-5-5": { tier: "mid", in: 3, out: 15 },
	"@cf/zai-org/glm-5.3": { tier: "mid", in: 1.4, out: 4.4 },
	"@cf/moonshotai/kimi-k2.7-code": { tier: "mid", in: 0.95, out: 4 },
	"claude-haiku-4-5": { tier: "small", in: 1, out: 5 },
	"@cf/zai-org/glm-5.3-flash": { tier: "small", in: 0.15, out: 0.5 },
	"@cf/openai/gpt-oss-20b": { tier: "small", in: 0.2, out: 0.3 },
	// Unified-billing ids as the gateway logs them.
	// Prices from Anthropic's published per-token rates (2026-09); the gateway's logged cost is authoritative.
	"anthropic/claude-fable-5.1": { tier: "frontier", in: 10, out: 50 },
	"anthropic/claude-opus-4.8": { tier: "frontier", in: 5, out: 25 },
	"anthropic/claude-opus-5.5": { tier: "frontier", in: 4, out: 20 },
	"anthropic/claude-sonnet-5": { tier: "mid", in: 2, out: 10 },
	"anthropic/claude-sonnet-5.5": { tier: "mid", in: 2, out: 10 },
	"anthropic/claude-haiku-4.5": { tier: "small", in: 1, out: 5 },
	"openai/gpt-5.6-sol": { tier: "frontier", in: 10, out: 40 },
	// MOCKED clouds (fixtures/mocked-clouds): illustrative list prices, not read from any provider.
	"bedrock/anthropic.claude-sonnet-5": { tier: "mid", in: 3, out: 15 },
	"bedrock/anthropic.claude-haiku-4.5": { tier: "small", in: 1, out: 5 },
	"vertex/anthropic.claude-opus-5.5": { tier: "frontier", in: 5, out: 25 },
	"vertex/gemini-3-flash": { tier: "small", in: 0.3, out: 2.5 },
	"vllm/glm-5.3-flash": { tier: "small", in: 0.05, out: 0.1 },
};

export interface FitRule {
	labels: string[];
	/** Tiers considered overkill for these labels. */
	from: Tier[];
	suggest: string;
	why: string;
}

/** Task label × model tier → cheaper suggestion. Labels not listed (feature, debug, refactor...) keep their model. */
export const FIT_RULES: FitRule[] = [
	{ labels: ["format", "lint", "changelog", "rename", "triage", "summarize"], from: ["frontier", "mid"], suggest: "@cf/zai-org/glm-5.3-flash", why: "mechanical task; a small model is enough" },
	{ labels: ["docs", "test", "review"], from: ["frontier"], suggest: "@cf/moonshotai/kimi-k2.7-code", why: "well-scoped task; a mid-tier coding model is usually enough" },
];

export interface FitSuggestion {
	agent: string;
	taskLabel: string;
	model: string;
	tier: Tier;
	suggest: string;
	why: string;
	requests: number;
	actualCost: number;
	estimatedCost: number;
	estimatedSaving: number;
	/** Cloud the requests ran on, and whether they came from a mocked source. */
	cloud: Cloud;
	mocked: boolean;
	/** Cross-cloud suggestions: the same model class, approved by the catalog on another cloud. */
	suggestCloud?: Cloud;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Groups records by agent × task label × model and prices each group on the suggested model.
 * Tier rules (FIT_RULES) suggest Cloudflare models, so they apply to Cloudflare records only. With a catalog, a group
 * on another cloud can get the same model class on a cheaper cloud, only where the catalog approves it for the job.
 * Private (on-prem) work is never moved off-prem, and self-hosted models aren't suggested (not billed per token).
 */
export function modelFit(records: CostRecord[], catalog?: Catalog): FitSuggestion[] {
	const out: FitSuggestion[] = [];
	for (const [, rs] of Map.groupBy(records, (r) => `${r.agent}|${r.taskLabel}|${r.model}|${r.cloud}`)) {
		const { agent, taskLabel, model, cloud } = rs[0];
		const mocked = rs.some((r) => r.mocked);
		const tier = MODELS[model]?.tier;
		const billable = rs.filter((r) => !r.cached);
		const actualCost = billable.reduce((n, r) => n + r.cost, 0);
		const priced = (id: string) => billable.reduce((n, r) => n + (r.tokensIn * MODELS[id].in + r.tokensOut * MODELS[id].out) / 1e6, 0);
		const rule = cloud === "cloudflare" && tier && FIT_RULES.find((f) => f.labels.includes(taskLabel) && f.from.includes(tier));
		if (rule) {
			const estimatedCost = priced(rule.suggest);
			if (actualCost - estimatedCost > 0) out.push({ agent, taskLabel, model, tier, suggest: rule.suggest, why: rule.why, requests: rs.length, actualCost: round(actualCost), estimatedCost: round(estimatedCost), estimatedSaving: round(actualCost - estimatedCost), cloud, mocked });
			continue;
		}
		if (!catalog || !tier || cloud === "private") continue;
		const job = JOB_FOR_LABEL[taskLabel];
		const best = equivalentModels(catalog, model)
			.filter((m) => cloudOf(m) !== "private" && MODELS[m.id] && (!job || !m.jobs?.length || m.jobs.includes(job)))
			.map((m) => ({ m, cost: priced(m.id) }))
			.sort((a, b) => a.cost - b.cost)[0];
		// Compare list prices on the same tokens, so a cloud only wins on price, not on how its logs report cost.
		if (!best || best.cost >= priced(model) || actualCost - best.cost <= 0) continue;
		const to = cloudOf(best.m);
		out.push({ agent, taskLabel, model, tier, suggest: best.m.id, suggestCloud: to, why: `same model class (${best.m.class}) is approved on ${to} for ${job ?? "this job"} and costs less there`, requests: rs.length, actualCost: round(actualCost), estimatedCost: round(best.cost), estimatedSaving: round(actualCost - best.cost), cloud, mocked });
	}
	return out.sort((a, b) => b.estimatedSaving - a.estimatedSaving);
}
