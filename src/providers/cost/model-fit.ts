import type { CostRecord } from "./logs.ts";

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
	"anthropic/claude-opus-4.8": { tier: "frontier", in: 15, out: 75 },
	"anthropic/claude-opus-5.5": { tier: "frontier", in: 15, out: 75 },
	"anthropic/claude-sonnet-5": { tier: "mid", in: 3, out: 15 },
	"anthropic/claude-sonnet-5.5": { tier: "mid", in: 3, out: 15 },
	"anthropic/claude-haiku-4.5": { tier: "small", in: 1, out: 5 },
	"openai/gpt-5.6-sol": { tier: "frontier", in: 10, out: 40 },
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
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Groups records by agent × task label × model and prices each group on the suggested model. */
export function modelFit(records: CostRecord[]): FitSuggestion[] {
	const out: FitSuggestion[] = [];
	for (const [, rs] of Map.groupBy(records, (r) => `${r.agent}|${r.taskLabel}|${r.model}`)) {
		const { agent, taskLabel, model } = rs[0];
		const tier = MODELS[model]?.tier;
		const rule = tier && FIT_RULES.find((f) => f.labels.includes(taskLabel) && f.from.includes(tier));
		if (!rule) continue;
		const target = MODELS[rule.suggest];
		const billable = rs.filter((r) => !r.cached);
		const actualCost = billable.reduce((n, r) => n + r.cost, 0);
		const estimatedCost = billable.reduce((n, r) => n + (r.tokensIn * target.in + r.tokensOut * target.out) / 1e6, 0);
		if (actualCost - estimatedCost <= 0) continue;
		out.push({ agent, taskLabel, model, tier, suggest: rule.suggest, why: rule.why, requests: rs.length, actualCost: round(actualCost), estimatedCost: round(estimatedCost), estimatedSaving: round(actualCost - estimatedCost) });
	}
	return out.sort((a, b) => b.estimatedSaving - a.estimatedSaving);
}
