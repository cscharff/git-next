// Generates fixtures/org-scale/usage.json: a synthetic month of AI Gateway usage for the Org tab at production scale
// (about $20,000 over 30 days across the demo's projects), plus merged-change counts to match. Seeded, so re-running
// gives the same file. Rows are daily totals per project, developer, agent and model, not single calls, and stored as
// tuples, so the file stays small. Prices come from the cost provider's model table; models per project respect its class (PII-regulated
// projects only use the profile's two models). The Org tab shows these numbers with a footnote and a "Live only"
// toggle; nothing else on the dashboard reads them.
//
//   node scripts/gen-org-scale.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { MODELS } from "../src/providers/cost/model-fit.ts";

const SEED = 20261008;
const DAYS = 30;

/** mulberry32: small, seeded, good enough for demo data. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = rng(SEED);

type Mix = { model: string; agent: string; task: string; share: number; tokensPerCall: number }[];
const PROVIDER = (model: string) => (model.startsWith("@cf/") ? "workers-ai" : "anthropic");

// What each kind of project spends its money on (shares of the project's spend).
const GENERAL: Mix = [
	{ model: "anthropic/claude-sonnet-5.5", agent: "claude-code", task: "feature", share: 0.42, tokensPerCall: 38_000 },
	{ model: "anthropic/claude-opus-5.5", agent: "claude-code", task: "review", share: 0.18, tokensPerCall: 30_000 },
	{ model: "anthropic/claude-fable-5.1", agent: "planner", task: "plan", share: 0.12, tokensPerCall: 18_000 },
	{ model: "anthropic/claude-sonnet-5", agent: "review-bot", task: "review", share: 0.1, tokensPerCall: 22_000 },
	{ model: "@cf/moonshotai/kimi-k2.7-code", agent: "codex-worker", task: "fix", share: 0.08, tokensPerCall: 26_000 },
	{ model: "anthropic/claude-haiku-4.5", agent: "triage-agent", task: "triage", share: 0.09, tokensPerCall: 6_000 },
	{ model: "@cf/zai-org/glm-5.3-flash", agent: "docs-agent", task: "docs", share: 0.01, tokensPerCall: 12_000 },
];
const PII: Mix = [
	{ model: "anthropic/claude-sonnet-5.5", agent: "claude-code", task: "feature", share: 0.8, tokensPerCall: 34_000 },
	{ model: "anthropic/claude-sonnet-5.5", agent: "review-bot", task: "review", share: 0.18, tokensPerCall: 20_000 },
	{ model: "@cf/zai-org/glm-5.3-flash", agent: "docs-agent", task: "summary", share: 0.02, tokensPerCall: 12_000 },
];
const PLATFORM: Mix = [
	{ model: "@cf/zai-org/glm-5.3-flash", agent: "git-next-resolver", task: "extract", share: 0.04, tokensPerCall: 9_000 },
	{ model: "@cf/google/embeddinggemma-300m", agent: "git-next-indexer", task: "embed", share: 0.002, tokensPerCall: 6_000 },
	{ model: "anthropic/claude-sonnet-5.5", agent: "claude-code", task: "feature", share: 0.6, tokensPerCall: 36_000 },
	{ model: "anthropic/claude-opus-5.5", agent: "claude-code", task: "review", share: 0.2, tokensPerCall: 30_000 },
	{ model: "anthropic/claude-haiku-4.5", agent: "triage-agent", task: "triage", share: 0.158, tokensPerCall: 6_000 },
];
// Embedding price isn't in the model table: Workers AI list price.
const PRICE: Record<string, { in: number; out: number }> = { ...MODELS, "@cf/google/embeddinggemma-300m": { in: 0.012, out: 0 } };

// Targets per project over 30 days (USD), the developers who work on it, its mix, and merged changes in the window.
const FIRST = ["ana", "ben", "carla", "dev", "devon", "eli", "farah", "gus", "hana", "ivan", "jo", "kai", "lena", "marco", "nadia", "omar", "priya", "quinn", "rosa", "sam", "tariq", "uma", "vic", "wen", "xavi", "yara", "zeke", "amir", "bea", "cyrus", "dina", "emre", "fen", "gia", "hugo", "isla", "jun", "kemal", "lior", "mae"];
const PROJECTS: { project: string; spend: number; devs: number; mix: Mix; merged: number; heavy?: string }[] = [
	{ project: "agents-demo-full", spend: 8200, devs: 14, mix: GENERAL, merged: 384, heavy: "devon" },
	{ project: "emdash-demo", spend: 3600, devs: 8, mix: GENERAL, merged: 162 },
	{ project: "git-next", spend: 3800, devs: 6, mix: PLATFORM, merged: 141 },
	{ project: "uploads-bare", spend: 1700, devs: 4, mix: PII, merged: 44 },
	{ project: "uploads-smart", spend: 1500, devs: 4, mix: PII, merged: 71 },
	{ project: "claude-plugins", spend: 900, devs: 4, mix: GENERAL, merged: 58 },
];

// Weekdays carry most of the work.
const weekday = (d: number) => [0.35, 1.1, 1.15, 1.2, 1.15, 1.05, 0.3][d % 7];
const dayWeights = Array.from({ length: DAYS }, (_, d) => weekday(d) * (0.85 + rand() * 0.3));
const dayTotal = dayWeights.reduce((n, w) => n + w, 0);

// Compact rows: [daysAgo, project, developer, combo, requests, tokensIn, tokensOut, cost in 1/10000 USD], with the
// strings in lookup tables. A combo is one agent running one kind of task on one model.
const projects: string[] = [];
const developers: string[] = [];
const combos: { agent: string; model: string; provider: string; task: string }[] = [];
const idx = <T>(xs: T[], x: T, eq: (a: T) => boolean) => {
	const i = xs.findIndex(eq);
	return i >= 0 ? i : xs.push(x) - 1;
};
type Row = [number, number, number, number, number, number, number, number];
const rows: Row[] = [];
const merged: [number, number, number][] = [];
let devIndex = 0;
for (const p of PROJECTS) {
	const pi = idx(projects, p.project, (x) => x === p.project);
	const devs = Array.from({ length: p.devs }, () => FIRST[devIndex++ % FIRST.length]);
	if (p.heavy && !devs.includes(p.heavy)) devs[0] = p.heavy;
	// Uneven spend per developer; the heavy one spends about four times the median.
	const devWeights = devs.map((d) => (d === p.heavy ? 4 : 0.6 + rand() * 0.9));
	const devTotal = devWeights.reduce((n, w) => n + w, 0);
	for (let d = 0; d < DAYS; d++) {
		const daySpend = (p.spend * dayWeights[d]) / dayTotal;
		devs.forEach((dev, i) => {
			const di = idx(developers, dev, (x) => x === dev);
			const devSpend = (daySpend * devWeights[i]) / devTotal;
			for (const m of p.mix) {
				const ci = idx(combos, { agent: m.agent, model: m.model, provider: PROVIDER(m.model), task: m.task }, (c) => c.agent === m.agent && c.model === m.model && c.task === m.task);
				const cost = devSpend * m.share * (0.8 + rand() * 0.4);
				const price = PRICE[m.model];
				// 8:1 input to output tokens, priced on the model's $/M rates.
				const perToken = (8 * price.in + price.out) / 9 / 1e6;
				const tokens = Math.round(cost / perToken);
				const requests = Math.max(1, Math.round(tokens / m.tokensPerCall));
				rows.push([DAYS - 1 - d, pi, di, ci, requests, Math.round((tokens * 8) / 9), Math.round(tokens / 9), Math.round(cost * 1e4)]);
			}
		});
		merged.push([DAYS - 1 - d, pi, Math.round((p.merged * dayWeights[d]) / dayTotal)]);
	}
}

const total = rows.reduce((n, r) => n + r[7], 0) / 1e4;
const out = {
	note: "Synthetic AI Gateway usage at production scale for the Org tab (scripts/gen-org-scale.ts). Not real spend.",
	seed: SEED,
	days: DAYS,
	totalUsd: Math.round(total * 100) / 100,
	projects,
	developers,
	combos,
	// [daysAgo (0 is today), project, developer, combo, requests, tokensIn, tokensOut, cost × 10,000]
	rows,
	// [daysAgo, project, merged changes]
	merged,
};
mkdirSync(new URL("../fixtures/org-scale/", import.meta.url), { recursive: true });
writeFileSync(new URL("../fixtures/org-scale/usage.json", import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`${rows.length} rows, ${rows.reduce((n, r) => n + r[4], 0)} requests, $${out.totalUsd.toFixed(2)} over ${DAYS} days, ${merged.reduce((n, m) => n + m[2], 0)} merged changes`);
