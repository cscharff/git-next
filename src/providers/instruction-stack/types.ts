import type { Cloud } from "../../core/types.ts";

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
	"modelRouting",
] as const;
export type Topic = (typeof TOPICS)[number];

export type Strength = "must" | "should";

/**
 * Layer kinds in precedence order: org beats contract beats project beats tool beats personal; agent-written memory
 * ranks last, so anything an agent "remembers" yields to every human-authored layer.
 */
export const LAYER_KINDS = ["org", "contract", "project", "tool", "personal", "memory"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];
export const KIND_RANK: Record<LayerKind, number> = { org: 1, contract: 2, project: 3, tool: 4, personal: 5, memory: 6 };

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
	origin: "project" | "stack" | "agent" | "memory" | "skill" | "subagent" | "command";
	/**
	 * Loaded only when needed (skills, subagents, slash commands): its rules are checked for conflicts and policy but
	 * don't decide what wins in a directory. `trigger` says when it loads (a description, or the command name).
	 */
	onDemand?: boolean;
	trigger?: string;
	/** The Claude Code plugin that ships the layer, if any. */
	plugin?: string;
	/** Stack layers only: the layer applies in this cloud's environments only (e.g. an on-prem platform layer). */
	env?: Cloud;
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
	/** Environment scope; defaults to the layer's. Unscoped rules apply in every environment. */
	env?: Cloud;
}

/** A rule's environment scope (its own, else its layer's); undefined = every environment. */
export const ruleEnv = (r: Rule): Cloud | undefined => r.env ?? r.layer.env;

/** Pluggable so a model-backed extractor can replace the deterministic one later. */
export interface RuleExtractor {
	id: string;
	extract(layer: Layer, markdown: string): Promise<Rule[]>;
	/** How the last extraction of this layer path went (model, cache or fallback), for the dashboard and logs. */
	describe?(path: string): ExtractionInfo | undefined;
}

export interface ExtractionInfo {
	source: "cache" | "model" | "fallback" | "keyword";
	rules: number;
	dropped?: number;
	error?: string;
}

/** An admin-approved change to the default layer order, with who, when and why (shown in the UI and audit trail). */
export interface PrecedenceOverride {
	order: LayerKind[];
	by: string;
	at: string;
	reason: string;
}

export const DEFAULT_ORDER: LayerKind[] = ["org", "contract", "project", "tool", "personal", "memory"];

/** Validates an order: every layer kind exactly once. */
export function validOrder(order: unknown): order is LayerKind[] {
	return Array.isArray(order) && order.length === LAYER_KINDS.length && LAYER_KINDS.every((k) => order.includes(k));
}

/** Ranks (1 = highest) for an order of layer kinds. */
export const ranksFor = (order: LayerKind[]): Record<LayerKind, number> => Object.fromEntries(order.map((k, i) => [k, i + 1])) as Record<LayerKind, number>;

/** > 0 when layer a takes precedence over b, < 0 when b does, 0 when they are peers. */
export function precedence(a: Layer, b: Layer): number {
	if (a.rank !== b.rank) return b.rank - a.rank;
	return a.depth - b.depth;
}
