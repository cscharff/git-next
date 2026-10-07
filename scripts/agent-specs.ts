// The three demo agents (docs, r2, mcp): fork, model, task, paths and edit limits. Shared by
// demo-agents.ts (one agent per fork) and demo-planner.ts (a planner assigns their tasks).
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
export const DEMO_LAYERS = join(ROOT, "fixtures/demo-layers/.gitnext/stack.json");
export const RESOLVED_LAYERS = join(ROOT, "fixtures/demo-layers-resolved/.gitnext/stack.json");

export interface AgentSpec {
	name: string;
	fork: string;
	model: string;
	task: string;
	taskId: string;
	paths: string[];
	/** Files whose full text goes into the prompt (targets to edit, or templates to copy). */
	include: string[];
	/** Edits outside these prefixes are rejected. */
	allowed: string[];
	maxTokens: number;
	instructions: string;
	/** Layers to retry the push with if the hook blocks it (the resolution path). */
	resolveWith?: string;
}

export const AGENTS: AgentSpec[] = [
	{
		name: "docs-agent",
		fork: "agents-demo-docs",
		// Deliberately oversized for a docs fix, so the cost provider suggests a cheaper model.
		model: "anthropic/claude-opus-4.8",
		task: "Fix a small typo or clarify one unclear sentence in the MCP transports docs",
		taskId: "docs#mcp-transports-clarity",
		paths: ["docs/agents/mcp-transports.md"],
		include: ["docs/agents/mcp-transports.md"],
		allowed: ["docs/"],
		maxTokens: 800,
		instructions: "Make exactly one small edit: fix one typo or reword one unclear sentence. Do not restructure the document.",
	},
	{
		name: "r2-agent",
		fork: "agents-demo-r2",
		model: "anthropic/claude-sonnet-5.5",
		task: "Add a small server-only example that stores uploaded files in an R2 bucket",
		taskId: "feature#r2-uploads-example",
		paths: ["examples/r2-uploads/src/index.ts"],
		include: ["examples/mcp-server/package.json", "examples/mcp-server/wrangler.jsonc", "examples/mcp-server/tsconfig.json", "examples/mcp-server/src/index.ts"],
		allowed: ["examples/r2-uploads/"],
		maxTokens: 3000,
		instructions:
			"Create a minimal server-only example in examples/r2-uploads/ following the examples/AGENTS.md structure for server-only examples (package.json, wrangler.jsonc, tsconfig.json, README.md, src/index.ts). Model the files on the examples/mcp-server files shown. wrangler.jsonc must declare an r2_buckets binding named UPLOADS with bucket_name \"agents-demo-uploads\" (the bucket is not created; just declare it). src/index.ts: PUT /files/:key stores the body in UPLOADS, GET /files/:key returns it. Keep every file short.",
	},
	{
		name: "mcp-agent",
		fork: "agents-demo-mcp",
		model: "anthropic/claude-sonnet-5.5",
		task: "Improve the doc comments in the MCP abort helpers without changing behavior",
		taskId: "refactor#mcp-abort-comments",
		paths: ["packages/agents/src/mcp/abort.ts"],
		include: ["packages/agents/src/mcp/abort.ts"],
		allowed: ["packages/agents/src/mcp/"],
		maxTokens: 800,
		instructions: "Add a concise JSDoc comment to abortError and tighten the existing comment on raceWithSignal if useful. Comments only: do not change any code.",
		resolveWith: RESOLVED_LAYERS,
	},
];
