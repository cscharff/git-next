export const TOPICS = [
	"packageManager",
	"formatter",
	"indentation",
	"testCommand",
	"commitFormat",
	"changesetPolicy",
	"lintStrictness",
	"allowedModels",
	"secrets",
	"securityScan",
] as const;
export type Topic = (typeof TOPICS)[number];

export type Strength = "must" | "should";

/** Layer kinds in precedence order: org beats contract beats project beats tool beats personal. */
export const LAYER_KINDS = ["org", "contract", "project", "tool", "personal"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];
export const KIND_RANK: Record<LayerKind, number> = { org: 1, contract: 2, project: 3, tool: 4, personal: 5 };

export interface Layer {
	name: string;
	kind: LayerKind;
	/** 1 (org) .. 5 (personal); a lower rank wins. */
	rank: number;
	/** Directory depth; only orders project-layer files (deeper wins) within the same rank. */
	depth: number;
	repo: string;
	path: string;
	/** Directory the layer governs ("" = whole repo). Stack-file layers govern the whole repo. */
	scopeDir: string;
	origin: "project" | "stack";
}

export interface Rule {
	topic: Topic;
	value: string;
	strength: Strength;
	layer: Layer;
	line: number;
	text: string;
	/** Top-level directories the rule names (e.g. "examples, guides"); the rule only applies there. */
	areas?: string[];
}

/** Pluggable so a model-backed extractor can replace the deterministic one later. */
export interface RuleExtractor {
	id: string;
	extract(layer: Layer, markdown: string): Promise<Rule[]>;
}

/** > 0 when layer a takes precedence over b, < 0 when b does, 0 when they are peers. */
export function precedence(a: Layer, b: Layer): number {
	if (a.rank !== b.rank) return b.rank - a.rank;
	return a.depth - b.depth;
}
