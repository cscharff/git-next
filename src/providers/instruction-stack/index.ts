import type { RepoContext } from "../../core/repo-context.ts";
import type { Insight, InsightProvider, Severity } from "../../core/types.ts";
import { parseJsonc } from "../../parse/jsonc.ts";
import { configFacts, isConfigFactFile } from "./config-facts.ts";
import { keywordExtractor } from "./extract.ts";
import { resolve, type Finding } from "./resolve.ts";
import type { Layer, Rule, RuleExtractor } from "./types.ts";

export const STACK_FILE = ".gitnext/stack.json";
/** Project instruction files rank above stack layers by default; deeper directories rank higher. */
export const PROJECT_BASE_RANK = 100;
export const isInstructionFile = (path: string) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export async function collectLayers(files: RepoContext, repo: string, ref: string): Promise<{ layers: Layer[]; errors: string[] }> {
	const errors: string[] = [];
	const layers: Layer[] = (await files.find(repo, ref, isInstructionFile)).map((f) => {
		const dir = dirOf(f.path);
		return { name: dir || "root", rank: PROJECT_BASE_RANK + (dir ? dir.split("/").length : 0), repo, path: f.path, scopeDir: dir, origin: "project" };
	});
	const stackText = await files.readFile(repo, ref, STACK_FILE);
	if (stackText) {
		try {
			const stack = parseJsonc(stackText) as { layers?: { name: string; rank: number; repo?: string; path: string }[] };
			for (const l of stack.layers ?? []) layers.push({ name: l.name, rank: l.rank, repo: l.repo ?? repo, path: l.path, scopeDir: "", origin: "stack" });
		} catch (err) {
			errors.push(`${STACK_FILE}: ${err}`);
		}
	}
	return { layers, errors };
}

const SEVERITY: Record<Finding["kind"], Severity> = { overridden: "info", drift: "warn", conflict: "conflict" };

export function instructionStackProvider(extractor: RuleExtractor = keywordExtractor): InsightProvider {
	return {
		id: "instruction-stack",
		title: "Instruction stack",
		needs: ["tree", "files"],
		async analyze({ repo, ref, files }) {
			const { layers, errors } = await collectLayers(files, repo, ref);
			const rules: Rule[] = [];
			for (const layer of layers) {
				// Stack layers in other repos are read at their default branch (HEAD).
				const text = await files.readFile(layer.repo, layer.repo === repo ? ref : "HEAD", layer.path).catch((e) => {
					errors.push(`${layer.repo}/${layer.path}: ${e}`);
					return null;
				});
				if (text == null) {
					if (layer.origin === "stack") errors.push(`${layer.repo}/${layer.path}: layer not found`);
					continue;
				}
				rules.push(...(await extractor.extract(layer, text)));
			}
			const factFiles = await files.find(repo, ref, isConfigFactFile);
			const facts = (await Promise.all(factFiles.map(async (f) => configFacts(f.path, (await files.readFile(repo, ref, f.path)) ?? "")))).flat();
			const findings = resolve(rules, facts);

			const insights: Insight[] = findings.map((f) => ({
				provider: "instruction-stack",
				severity: SEVERITY[f.kind],
				scope: { repo, ref, path: f.rules[0].layer.path },
				title: `${f.kind}: ${f.topic}`,
				detail: f.explanation,
				evidence: [...f.rules.map((r) => ({ repo: r.layer.repo, path: r.layer.path, line: r.line })), ...(f.fact ? [{ repo, path: f.fact.path }] : [])],
				metrics: { kind: f.kind, topic: f.topic, values: f.rules.map((r) => ({ value: r.value, strength: r.strength, rank: r.layer.rank, text: r.text })), ...(f.fact ? { configValue: f.fact.value } : {}) },
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
					layers: layers.map((l) => ({ name: l.name, rank: l.rank, path: l.path, origin: l.origin })),
					rulesByTopic: Object.fromEntries([...Map.groupBy(rules, (r) => r.topic)].map(([t, rs]) => [t, [...new Set(rs.map((r) => r.value))]])),
					counts: Object.fromEntries([...Map.groupBy(findings, (f) => f.kind)].map(([k, fs]) => [k, fs.length])),
				},
			});
			return insights;
		},
	};
}
