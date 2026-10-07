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
] as const;
export type Topic = (typeof TOPICS)[number];

export type Strength = "must" | "should";

export interface Layer {
	name: string;
	/** Higher rank = more specific; wins over lower ranks. */
	rank: number;
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
