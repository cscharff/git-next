import type { ConfigFact } from "./config-facts.ts";
import { precedence, type Rule } from "./types.ts";

export type FindingKind = "overridden" | "conflict" | "drift";

export interface Finding {
	kind: FindingKind;
	topic: Rule["topic"];
	/** Winner first (overridden), the disagreeing rules (conflict), or the effective instruction (drift). */
	rules: Rule[];
	fact?: ConfigFact;
	/** Set when a rule breaks a policy (e.g. a model from a provider not on the approved list). */
	policyViolation?: boolean;
	explanation: string;
}

/** True when a layer governing `dir` also governs `other` (ancestor or same directory). */
const governs = (dir: string, other: string) => dir === "" || other === dir || other.startsWith(`${dir}/`);
/** Whether a rule applies to a directory: inside its layer's scope and, if it names areas, inside one of them. */
const appliesTo = (r: Rule, dir: string) => governs(r.layer.scopeDir, dir) && (!r.areas || dir === "" || r.areas.includes(dir.split("/")[0]));
const disjointAreas = (a: Rule, b: Rule) => !!a.areas && !!b.areas && !a.areas.some((x) => b.areas!.includes(x));
const overlaps = (a: Rule, b: Rule) => (appliesTo(a, b.layer.scopeDir) || appliesTo(b, a.layer.scopeDir)) && !disjointAreas(a, b);
const sameLayer = (a: Rule, b: Rule) => a.layer.repo === b.layer.repo && a.layer.path === b.layer.path;
const where = (r: Rule) => `${r.layer.name} [${r.layer.kind}] (${r.layer.path}:${r.line})`;

/** Infers the vendor behind a model id, for checking model choices against a provider allowlist. */
export function modelProvider(model: string): string {
	if (/^claude-/.test(model)) return "anthropic";
	if (/^(gpt-|o\d)/.test(model)) return "openai";
	if (/^gemini-/.test(model)) return "google";
	if (/^@cf\//.test(model)) return "workers-ai";
	return "unknown";
}

/** Test commands are additive (test, test:react, test:e2e…); they only disagree when the runner differs. */
const runner = (cmd: string) => cmd.split(/\s+/)[0];

/**
 * Topic-specific agreement: test commands with the same runner agree; for allowedModels, a provider allowlist and a
 * model list agree when every model's provider is allowed, and two provider lists agree when one is a subset of the
 * other (a narrower list stays within the broader one).
 */
function compatible(a: Rule, b: Rule): boolean | null {
	if (a.topic === "testCommand") return runner(a.value) === runner(b.value);
	if (a.topic !== "allowedModels") return null;
	if (a.value.startsWith("providers:") && b.value.startsWith("providers:")) {
		const [x, y] = [a, b].map((r) => r.value.slice("providers:".length).split(","));
		return x.every((p) => y.includes(p)) || y.every((p) => x.includes(p));
	}
	const [list, models] = a.value.startsWith("providers:") ? [a, b] : b.value.startsWith("providers:") ? [b, a] : [null, null];
	if (!list || models.value.startsWith("providers:")) return null;
	const allowed = list.value.slice("providers:".length).split(",");
	return models.value.split(",").every((m) => allowed.includes(modelProvider(m)));
}

/**
 * Compares rules on the same topic whose scopes overlap (layer directory plus any areas the rule names).
 * Layer precedence decides the winner (org > contract > project > tool > personal; depth only within a rank).
 * Strength only decides conflicts:
 * - two "must" rules that disagree -> conflict, regardless of rank;
 * - peers (same rank and depth) that disagree -> conflict;
 * - otherwise the higher-precedence rule wins and the other is "overridden".
 * Within a single file, differing values are only flagged when both are "must"
 * (one file often mentions alternatives in passing).
 * Config facts disagreeing with the effective instruction for their directory -> drift.
 */
export function resolve(rules: Rule[], facts: ConfigFact[] = []): Finding[] {
	const findings: Finding[] = [];
	const seen = new Set<string>();
	const byTopic = Map.groupBy(rules, (r) => r.topic);

	for (const [topic, list] of byTopic) {
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i];
				const b = list[j];
				if (a.value === b.value || !overlaps(a, b) || compatible(a, b) === true) continue;
				const pairKey = [topic, ...[a, b].map((r) => `${r.layer.path}=${r.value}`).sort()].join("|");
				if (seen.has(pairKey)) continue;
				seen.add(pairKey);
				const bothMust = a.strength === "must" && b.strength === "must";
				const order = precedence(a.layer, b.layer);
				const violation = compatible(a, b) === false;
				const why = violation ? " (model's provider is not on the approved list)" : "";
				const extra = violation ? { policyViolation: true } : {};

				if (sameLayer(a, b)) {
					if (bothMust) findings.push({ kind: "conflict", topic, rules: [a, b], explanation: `${a.layer.path} requires both "${a.value}" (line ${a.line}) and "${b.value}" (line ${b.line}).` });
				} else if (bothMust || order === 0) {
					const [x, y] = order >= 0 ? [a, b] : [b, a];
					findings.push({
						kind: "conflict",
						topic,
						rules: [x, y],
						...extra,
						explanation: `${where(x)} says "${x.value}" but ${where(y)} says "${y.value}"${why}; ${bothMust ? "both are hard requirements" : "the layers are peers"}.`,
					});
				} else {
					const [win, lose] = order > 0 ? [a, b] : [b, a];
					findings.push({ kind: "overridden", topic, rules: [win, lose], ...extra, explanation: `${where(win)} ("${win.value}") overrides ${where(lose)} ("${lose.value}")${why}.` });
				}
			}
		}
	}

	// Drift: for each fact, compare with the highest-precedence rules governing its directory.
	const driftSeen = new Set<string>();
	for (const fact of facts) {
		const applicable = (byTopic.get(fact.topic) ?? []).filter((r) => appliesTo(r, fact.dir));
		if (!applicable.length) continue;
		const top = applicable.reduce((best, r) => (precedence(r.layer, best.layer) > 0 ? r : best));
		const effective = applicable.filter((r) => precedence(r.layer, top.layer) === 0);
		if (effective.some((r) => r.value === fact.value)) continue;
		const rule = effective[0];
		const k = `${fact.topic}|${fact.path}|${rule.value}`;
		if (driftSeen.has(k)) continue;
		driftSeen.add(k);
		findings.push({ kind: "drift", topic: fact.topic, rules: [rule], fact, explanation: `${where(rule)} says "${rule.value}" but ${fact.path} implies "${fact.value}".` });
	}
	return findings;
}

/** The winning rule per topic for a directory (highest precedence; ties keep every peer value). */
export function effectiveRules(rules: Rule[], dir: string): Rule[] {
	const out: Rule[] = [];
	for (const [, list] of Map.groupBy(rules.filter((r) => appliesTo(r, dir)), (r) => r.topic)) {
		const top = list.reduce((best, r) => (precedence(r.layer, best.layer) > 0 ? r : best));
		const winners = list.filter((r) => precedence(r.layer, top.layer) === 0);
		out.push(...winners.filter((r, i) => winners.findIndex((w) => w.value === r.value) === i));
	}
	return out;
}
