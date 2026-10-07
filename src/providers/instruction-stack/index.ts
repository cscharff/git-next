import type { RepoContext } from "../../core/repo-context.ts";
import type { Insight, InsightProvider, Severity } from "../../core/types.ts";
import { parseJsonc } from "../../parse/jsonc.ts";
import { parseYamlSubset } from "../../parse/yaml.ts";
import { configFacts, isConfigFactFile, type ConfigFact } from "./config-facts.ts";
import { keywordExtractor } from "./extract.ts";
import { effectiveRules, resolve, type Finding } from "./resolve.ts";
import { DEFAULT_ORDER, KIND_RANK, LAYER_KINDS, ranksFor, validOrder, type Layer, type LayerKind, type PrecedenceOverride, type Rule, type RuleExtractor } from "./types.ts";

export const STACK_FILE = ".gitnext/stack.json";
export const isInstructionFile = (path: string) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path);
/** gitagent-style agent definitions: their model choices and rules join the stack as tool-rank layers. */
export const isAgentFile = (path: string) => /(^|\/)agent\.ya?ml$/.test(path) && !/(^|\/)(node_modules|\.github)\//.test(path);
/** Agent-written memory: the lowest-rank layer, so it never overrides a human-authored rule. */
export const isMemoryFile = (path: string) => /^\.gitnext\/memory\/.+\.md$/.test(path) || /(^|\/)AGENT_MEMORY\.md$/.test(path);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * Collects the repo's instruction files (project layer) and the layers listed in its stack file. With an
 * admin-approved precedence override, every layer's rank comes from the override's order (explicit ranks in the stack
 * file are ignored, so an override can't be undone or bypassed by a repo-level edit).
 */
export async function collectLayers(files: RepoContext, repo: string, ref: string, override?: PrecedenceOverride | null): Promise<{ layers: Layer[]; errors: string[] }> {
	const errors: string[] = [];
	const ranks = override && validOrder(override.order) ? ranksFor(override.order) : KIND_RANK;
	const layers: Layer[] = (await files.find(repo, ref, isInstructionFile)).map((f) => {
		const dir = dirOf(f.path);
		return { name: dir || "root", kind: "project", rank: ranks.project, depth: dir ? dir.split("/").length : 0, repo, path: f.path, scopeDir: dir, origin: "project" };
	});
	for (const f of await files.find(repo, ref, isAgentFile)) {
		const dir = dirOf(f.path);
		layers.push({ name: `agent ${f.path}`, kind: "tool", rank: ranks.tool, depth: dir ? dir.split("/").length : 0, repo, path: f.path, scopeDir: dir, origin: "agent" });
	}
	for (const f of await files.find(repo, ref, isMemoryFile)) {
		const dir = f.path.startsWith(".gitnext/") ? "" : dirOf(f.path);
		layers.push({ name: `memory ${f.path}`, kind: "memory", rank: ranks.memory, depth: dir ? dir.split("/").length : 0, repo, path: f.path, scopeDir: dir, origin: "memory" });
	}
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
				layers.push({ name: l.name, kind, rank: override ? ranks[kind] : (l.rank ?? KIND_RANK[kind]), depth: 0, repo: l.repo ?? repo, path: l.path, scopeDir: "", origin: "stack" });
			}
		} catch (err) {
			errors.push(`${STACK_FILE}: ${err}`);
		}
	}
	return { layers, errors };
}

/**
 * Rules from an agent.yaml: its model(s) as an allowedModels rule (checked against the org's provider policy), and its
 * rules/instructions list run through the normal extractor, one item per line, keeping real line numbers.
 */
export async function agentYamlRules(layer: Layer, text: string, extractor: RuleExtractor): Promise<Rule[]> {
	const doc = parseYamlSubset(text);
	const lines = text.split(/\r?\n/);
	const lineOf = (needle: string) => Math.max(1, lines.findIndex((l) => l.includes(needle)) + 1);
	const rules: Rule[] = [];
	const modelField = doc.model ?? doc.models;
	const models = (Array.isArray(modelField) ? modelField : modelField ? [modelField] : []).map(String).map((m) => m.toLowerCase().replace(/^anthropic\/(?=claude)/, "")).filter((m) => /^[@a-z0-9./-]+$/.test(m));
	if (models.length) {
		const line = lineOf(String(Array.isArray(modelField) ? modelField[0] : modelField));
		rules.push({ topic: "allowedModels", value: [...new Set(models)].sort().join(","), strength: "must", layer, line, text: lines[line - 1].trim().slice(0, 240) });
	}
	const items = [doc.rules, doc.instructions].flatMap((v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []));
	if (items.length) {
		// Rebuild a document with each item on its original line so extracted line numbers point into agent.yaml.
		const synthetic = lines.map(() => "");
		for (const item of items) synthetic[lineOf(item) - 1] = item;
		rules.push(...(await extractor.extract(layer, synthetic.join("\n"))));
	}
	return rules;
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
export async function loadStack(files: RepoContext, repo: string, ref: string, extractor: RuleExtractor = keywordExtractor, override?: PrecedenceOverride | null): Promise<LoadedStack> {
	const { layers, errors } = await collectLayers(files, repo, ref, override);
	const texts = new Map<Layer, string>();
	// Read and extract every layer in parallel (model-backed extraction makes this matter); keep layer order.
	const perLayer = await Promise.all(
		layers.map(async (layer) => {
			const text = await files.readFile(layer.repo, layer.repo === repo ? ref : "HEAD", layer.path).catch((e) => {
				errors.push(`${layer.repo}/${layer.path}: ${e}`);
				return null;
			});
			if (text == null) {
				if (layer.origin === "stack") errors.push(`${layer.repo}/${layer.path}: layer not found`);
				return [];
			}
			texts.set(layer, text);
			return layer.origin === "agent" ? agentYamlRules(layer, text, extractor) : extractor.extract(layer, text);
		}),
	);
	const rules: Rule[] = perLayer.flat();
	const factFiles = await files.find(repo, ref, isConfigFactFile);
	const facts = (await Promise.all(factFiles.map(async (f) => configFacts(f.path, (await files.readFile(repo, ref, f.path)) ?? "")))).flat();
	return { layers, rules, facts, texts, errors };
}

const SEVERITY: Record<Finding["kind"], Severity> = { overridden: "info", drift: "warn", conflict: "conflict" };

export interface StackProviderOptions {
	/** Admin-approved precedence override for a repo (stored outside the repo, e.g. in KV), with its audit trail. */
	precedence?: (repo: string) => Promise<{ override: PrecedenceOverride | null; audit: unknown[] } | null>;
}

export function instructionStackProvider(extractor: RuleExtractor = keywordExtractor, opts: StackProviderOptions = {}): InsightProvider {
	return {
		id: "instruction-stack",
		title: "Instruction stack",
		needs: ["tree", "files"],
		async analyze({ repo, ref, files }) {
			const prec = (await opts.precedence?.(repo).catch(() => null)) ?? null;
			const override = prec?.override && validOrder(prec.override.order) ? prec.override : null;
			const { layers, rules, facts, errors } = await loadStack(files, repo, ref, extractor, override);
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
				title: `Instruction stack: ${layers.length} layers, ${rules.length} rules${override ? " (precedence overridden)" : ""}`,
				detail: errors.length ? `Errors: ${errors.join("; ")}` : `Extractor ${extractor.id}; ${findings.length} findings.`,
				evidence: layers.map((l) => ({ repo: l.repo, path: l.path })),
				metrics: {
					extractor: extractor.id,
					layers: layers.map((l) => ({ name: l.name, kind: l.kind, rank: l.rank, depth: l.depth, repo: l.repo, path: l.path, origin: l.origin })),
					// Rules each layer contributes, so the dashboard can show how much of the stack comes from where.
					// Layer order in force, and any admin override with its audit trail (always shown in the UI).
					precedence: {
						order: override?.order ?? DEFAULT_ORDER,
						overridden: !!override,
						...(override ? { by: override.by, at: override.at, reason: override.reason, note: `${override.order.join(" › ")} (set by ${override.by}: ${override.reason})` } : {}),
						audit: prec?.audit ?? [],
					},
					// How each layer was read: by the model, from cache, or by the keyword fallback.
					extraction: Object.fromEntries(layers.map((l) => [`${l.repo}:${l.path}`, extractor.describe?.(l.path) ?? { source: "keyword" }])),
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
