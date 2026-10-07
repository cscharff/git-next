import type { ConfigFact } from "./config-facts.ts";
import type { Rule } from "./types.ts";

export type FindingKind = "overridden" | "conflict" | "drift";

export interface Finding {
	kind: FindingKind;
	topic: Rule["topic"];
	/** The rule that wins (overridden), or the rules that disagree (conflict), or the instruction (drift). */
	rules: Rule[];
	fact?: ConfigFact;
	explanation: string;
}

/** True when a layer governing `dir` also governs `other` (ancestor or same directory). */
const governs = (dir: string, other: string) => dir === "" || other === dir || other.startsWith(`${dir}/`);
/** Whether a rule applies to a directory: inside its layer's scope and, if it names areas, inside one of them. */
const appliesTo = (r: Rule, dir: string) => governs(r.layer.scopeDir, dir) && (!r.areas || dir === "" || r.areas.includes(dir.split("/")[0]));
const disjointAreas = (a: Rule, b: Rule) => !!a.areas && !!b.areas && !a.areas.some((x) => b.areas!.includes(x));
const overlaps = (a: Rule, b: Rule) => (appliesTo(a, b.layer.scopeDir) || appliesTo(b, a.layer.scopeDir)) && !disjointAreas(a, b);
const sameLayer = (a: Rule, b: Rule) => a.layer.repo === b.layer.repo && a.layer.path === b.layer.path;
const where = (r: Rule) => `${r.layer.name} (${r.layer.path}:${r.line})`;

/**
 * Compares rules on the same topic whose scopes overlap (layer directory plus any areas the rule names).
 * - Different values, both "must" or equal rank (across layers) -> conflict.
 * - Different values otherwise -> the higher-rank layer overrides the lower one.
 * - Within a single file, differing values are only flagged when both are "must"
 *   (one file often mentions alternatives in passing).
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
				if (a.value === b.value || !overlaps(a, b)) continue;
				const bothMust = a.strength === "must" && b.strength === "must";
				const pairKey = [topic, ...[a, b].map((r) => `${r.layer.path}=${r.value}`).sort()].join("|");
				if (seen.has(pairKey)) continue;
				seen.add(pairKey);

				if (sameLayer(a, b)) {
					if (bothMust) findings.push({ kind: "conflict", topic, rules: [a, b], explanation: `${a.layer.path} requires both "${a.value}" (line ${a.line}) and "${b.value}" (line ${b.line}).` });
				} else if (bothMust || a.layer.rank === b.layer.rank) {
					findings.push({
						kind: "conflict",
						topic,
						rules: [a, b],
						explanation: `${where(a)} says "${a.value}" but ${where(b)} says "${b.value}"${bothMust ? "; both are hard requirements" : " at equal rank"}.`,
					});
				} else {
					const [win, lose] = a.layer.rank > b.layer.rank ? [a, b] : [b, a];
					findings.push({ kind: "overridden", topic, rules: [win, lose], explanation: `${where(win)} ("${win.value}") overrides ${where(lose)} ("${lose.value}").` });
				}
			}
		}
	}

	// Drift: for each fact, find the most specific rule governing its directory.
	const driftSeen = new Set<string>();
	for (const fact of facts) {
		const applicable = (byTopic.get(fact.topic) ?? []).filter((r) => appliesTo(r, fact.dir));
		if (!applicable.length) continue;
		const top = Math.max(...applicable.map((r) => r.layer.rank));
		const effective = applicable.filter((r) => r.layer.rank === top);
		if (effective.some((r) => r.value === fact.value)) continue;
		const rule = effective[0];
		const k = `${fact.topic}|${fact.path}|${rule.value}`;
		if (driftSeen.has(k)) continue;
		driftSeen.add(k);
		findings.push({ kind: "drift", topic: fact.topic, rules: [rule], fact, explanation: `${where(rule)} says "${rule.value}" but ${fact.path} implies "${fact.value}".` });
	}
	return findings;
}
