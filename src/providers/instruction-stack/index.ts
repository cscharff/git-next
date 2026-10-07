import type { RepoContext } from "../../core/repo-context.ts";
import type { Insight, InsightProvider, Severity } from "../../core/types.ts";
import { parseJsonc } from "../../parse/jsonc.ts";
import { configFacts, isConfigFactFile, type ConfigFact } from "./config-facts.ts";
import { keywordExtractor } from "./extract.ts";
import { effectiveRules, resolve, type Finding } from "./resolve.ts";
import { KIND_RANK, LAYER_KINDS, type Layer, type LayerKind, type Rule, type RuleExtractor } from "./types.ts";

export const STACK_FILE = ".gitnext/stack.json";
export const isInstructionFile = (path: string) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export async function collectLayers(files: RepoContext, repo: string, ref: string): Promise<{ layers: Layer[]; errors: string[] }> {
	const errors: string[] = [];
	const layers: Layer[] = (await files.find(repo, ref, isInstructionFile)).map((f) => {
		const dir = dirOf(f.path);
		return { name: dir || "root", kind: "project", rank: KIND_RANK.project, depth: dir ? dir.split("/").length : 0, repo, path: f.path, scopeDir: dir, origin: "project" };
	});
	const stackText = await files.readFile(repo, ref, STACK_FILE);
	if (stackText) {
		try {
			const stack = parseJsonc(stackText) as { layers?: { name: string; kind?: LayerKind; rank?: number; repo?: string; path: string }[] };
			for (const l of stack.layers ?? []) {
				const kind = l.kind ?? LAYER_KINDS[(l.rank ?? 0) - 1];
				if (!kind || !(kind in KIND_RANK)) {
					errors.push(`${STACK_FILE}: layer "${l.name}" needs a kind (${LAYER_KINDS.join("|")}) or a rank 1-5`);
					continue;
				}
				layers.push({ name: l.name, kind, rank: l.rank ?? KIND_RANK[kind], depth: 0, repo: l.repo ?? repo, path: l.path, scopeDir: "", origin: "stack" });
			}
		} catch (err) {
			errors.push(`${STACK_FILE}: ${err}`);
		}
	}
	return { layers, errors };
}

export interface LoadedStack {
	layers: Layer[];
	rules: Rule[];
	facts: ConfigFact[];
	/** Raw text per layer path, for callers that slice instruction files (e.g. the context provider). */
	texts: Map<Layer, string>;
	errors: string[];
}

/** Collects layers, reads them (stack layers in other repos at HEAD), extracts rules and reads config facts. */
export async function loadStack(files: RepoContext, repo: string, ref: string, extractor: RuleExtractor = keywordExtractor): Promise<LoadedStack> {
	const { layers, errors } = await collectLayers(files, repo, ref);
	const rules: Rule[] = [];
	const texts = new Map<Layer, string>();
	for (const layer of layers) {
		const text = await files.readFile(layer.repo, layer.repo === repo ? ref : "HEAD", layer.path).catch((e) => {
			errors.push(`${layer.repo}/${layer.path}: ${e}`);
			return null;
		});
		if (text == null) {
			if (layer.origin === "stack") errors.push(`${layer.repo}/${layer.path}: layer not found`);
			continue;
		}
		texts.set(layer, text);
		rules.push(...(await extractor.extract(layer, text)));
	}
	const factFiles = await files.find(repo, ref, isConfigFactFile);
	const facts = (await Promise.all(factFiles.map(async (f) => configFacts(f.path, (await files.readFile(repo, ref, f.path)) ?? "")))).flat();
	return { layers, rules, facts, texts, errors };
}

const SEVERITY: Record<Finding["kind"], Severity> = { overridden: "info", drift: "warn", conflict: "conflict" };

export function instructionStackProvider(extractor: RuleExtractor = keywordExtractor): InsightProvider {
	return {
		id: "instruction-stack",
		title: "Instruction stack",
		needs: ["tree", "files"],
		async analyze({ repo, ref, files }) {
			const { layers, rules, facts, errors } = await loadStack(files, repo, ref, extractor);
			const findings = resolve(rules, facts);

			const insights: Insight[] = findings.map((f) => ({
				provider: "instruction-stack",
				severity: f.policyViolation && f.kind === "overridden" ? "warn" : SEVERITY[f.kind],
				scope: { repo, ref, path: f.rules[0].layer.path },
				title: `${f.policyViolation ? "policy " : ""}${f.kind}: ${f.topic}`,
				detail: f.explanation,
				evidence: [...f.rules.map((r) => ({ repo: r.layer.repo, path: r.layer.path, line: r.line })), ...(f.fact ? [{ repo, path: f.fact.path }] : [])],
				metrics: { kind: f.kind, topic: f.topic, ...(f.policyViolation ? { policyViolation: true } : {}), values: f.rules.map((r) => ({ value: r.value, strength: r.strength, layer: r.layer.name, kind: r.layer.kind, rank: r.layer.rank, path: r.layer.path, line: r.line, text: r.text })), ...(f.fact ? { configValue: f.fact.value } : {}) },
			}));
			insights.unshift({
				provider: "instruction-stack",
				severity: errors.length ? "warn" : "info",
				scope: { repo, ref },
				title: `Instruction stack: ${layers.length} layers, ${rules.length} rules`,
				detail: errors.length ? `Errors: ${errors.join("; ")}` : `Extractor ${extractor.id}; ${findings.length} findings.`,
				evidence: layers.map((l) => ({ repo: l.repo, path: l.path })),
				metrics: {
					extractor: extractor.id,
					layers: layers.map((l) => ({ name: l.name, kind: l.kind, rank: l.rank, depth: l.depth, repo: l.repo, path: l.path, origin: l.origin })),
					// Rules each layer contributes, so the dashboard can show how much of the stack comes from where.
					rulesPerLayer: Object.fromEntries([...Map.groupBy(rules, (r) => `${r.layer.repo}:${r.layer.path}`)].map(([k, rs]) => [k, rs.length])),
					rulesByTopic: Object.fromEntries([...Map.groupBy(rules, (r) => r.topic)].map(([t, rs]) => [t, [...new Set(rs.map((r) => r.value))]])),
					// Winning rule per topic at the repo root and in each directory with its own instruction file.
					effective: Object.fromEntries(
						["", ...new Set(layers.filter((l) => l.scopeDir).map((l) => l.scopeDir))].map((dir) => [
							dir || ".",
							effectiveRules(rules, dir).map((r) => ({ topic: r.topic, value: r.value, strength: r.strength, layer: r.layer.name, kind: r.layer.kind, path: r.layer.path, line: r.line })),
						]),
					),
					counts: Object.fromEntries([...Map.groupBy(findings, (f) => f.kind)].map(([k, fs]) => [k, fs.length])),
				},
			});
			return insights;
		},
	};
}
