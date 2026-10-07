import type { CostRecord } from "./logs.ts";

export const LEVELS = ["project", "developer", "fork", "agent", "task"] as const;
export type Level = (typeof LEVELS)[number];

export interface RollupNode {
	level: Level;
	key: string;
	cost: number;
	requests: number;
	tokensIn: number;
	tokensOut: number;
	cachedRequests: number;
	failedRequests: number;
	children: RollupNode[];
}

const keyFor = (r: CostRecord, level: Level) => (level === "project" ? r.repo : r[level]);
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Rolls records up project → developer → fork → agent → task (each node sums its subtree). */
export function rollup(records: CostRecord[], depth = 0): RollupNode[] {
	const level = LEVELS[depth];
	return [...Map.groupBy(records, (r) => keyFor(r, level))]
		.map(([key, rs]) => ({
			level,
			key,
			cost: round(rs.reduce((n, r) => n + r.cost, 0)),
			requests: rs.length,
			tokensIn: rs.reduce((n, r) => n + r.tokensIn, 0),
			tokensOut: rs.reduce((n, r) => n + r.tokensOut, 0),
			cachedRequests: rs.filter((r) => r.cached).length,
			failedRequests: rs.filter((r) => !r.success).length,
			children: depth + 1 < LEVELS.length ? rollup(rs, depth + 1) : [],
		}))
		.sort((a, b) => b.cost - a.cost);
}

export interface CloudSpend {
	cloud: CostRecord["cloud"];
	/** True when any record for this cloud came from a mocked source. */
	mocked: boolean;
	cost: number;
	requests: number;
	tokensIn: number;
	tokensOut: number;
	models: string[];
}

/** Spend per cloud (the "by cloud" dimension), most expensive first. */
export function byCloud(records: CostRecord[]): CloudSpend[] {
	return [...Map.groupBy(records, (r) => r.cloud)]
		.map(([cloud, rs]) => ({ cloud, mocked: rs.some((r) => r.mocked), cost: round(rs.reduce((n, r) => n + r.cost, 0)), requests: rs.length, tokensIn: rs.reduce((n, r) => n + r.tokensIn, 0), tokensOut: rs.reduce((n, r) => n + r.tokensOut, 0), models: [...new Set(rs.map((r) => r.model))] }))
		.sort((a, b) => b.cost - a.cost);
}

export function median(values: number[]): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface SpendFlag {
	level: "developer" | "agent";
	key: string;
	cost: number;
	median: number;
	multiple: number;
}

/** Flags developers and agents spending more than `factor` × the median of their peers (attributed only). */
export function spendFlags(records: CostRecord[], factor = 2, unattributed = "(unattributed)"): SpendFlag[] {
	const flags: SpendFlag[] = [];
	for (const level of ["developer", "agent"] as const) {
		const totals = [...Map.groupBy(records.filter((r) => r[level] !== unattributed), (r) => r[level])].map(([key, rs]) => ({ key, cost: rs.reduce((n, r) => n + r.cost, 0) }));
		const med = median(totals.map((t) => t.cost));
		for (const t of totals) if (med > 0 && t.cost > factor * med) flags.push({ level, key: t.key, cost: round(t.cost), median: round(med), multiple: Math.round((t.cost / med) * 100) / 100 });
	}
	return flags.sort((a, b) => b.multiple - a.multiple);
}
