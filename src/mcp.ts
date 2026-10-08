import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// git.next as a remote MCP server, so coding agents (Claude Code and others) ask git.next directly before they edit:
// the rules and docs for the files they'll touch, who else is already changing them, and which of several attempts
// at a task should ship. Tools are thin wrappers over the same functions the HTTP routes and dashboard use.

export interface McpDeps {
	context(args: { repo: string; task: string; paths: string[]; ref?: string; budgetTokens?: number }): Promise<{ rules: unknown[]; conflicts: unknown[]; sections: { path: string; startLine: number; headings: string[]; text: string; tokens: number }[]; pinned: unknown; stats: Record<string, unknown>; inFlight: unknown[] }>;
	overlap(args: { repo: string; paths: string[]; exclude?: string }): Promise<unknown[]>;
	attempts(repo: string): Promise<unknown[]>;
	compare(args: { repo: string; task: string; refs?: string[] }): Promise<unknown>;
}

const REPO = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).describe("Artifacts repo name, e.g. agents-demo-full or a fork of it");
const PATHS = z.array(z.string().max(500)).max(100);
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });
const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `git.next error: ${String(err).slice(0, 500)}` }], isError: true });

/** One MCP server per request (stateless): tools only, no sessions. */
export function gitNextMcpServer(deps: McpDeps): McpServer {
	const server = new McpServer({ name: "git-next", version: "0.1.0" });

	server.registerTool(
		"get_context",
		{
			title: "Get context for a task",
			description:
				"Call before editing. Returns the rules that win for the files you'll touch (with the layer and file:line each comes from), hard-rule conflicts a person must settle, pinned org rules and catalog entries, the most relevant doc sections within a token budget, and inFlight: other forks/branches already changing the same files.",
			inputSchema: z.object({ repo: REPO, task: z.string().min(3).max(2000).describe("What you're about to do"), paths: PATHS.describe("Files you expect to change"), ref: z.string().max(100).optional(), budgetTokens: z.number().int().min(500).max(20000).optional() }),
		},
		async (args) => {
			try {
				const c = await deps.context(args);
				// Sections can be long; keep the text but drop scoring internals.
				return json({ rules: c.rules, conflicts: c.conflicts, pinned: c.pinned, inFlight: c.inFlight, sections: c.sections.map((s) => ({ path: s.path, line: s.startLine, heading: s.headings.at(-1) ?? s.path, text: s.text })), stats: c.stats });
			} catch (err) {
				return fail(err);
			}
		},
	);

	server.registerTool(
		"rules_for",
		{
			title: "Rules for a path",
			description: "The winning rule per topic for a file or folder, where each comes from, and any conflicts that reach it. Cheaper than get_context when you only need the rules.",
			inputSchema: z.object({ repo: REPO, path: z.string().max(500), ref: z.string().max(100).optional() }),
		},
		async ({ repo, path, ref }) => {
			try {
				const c = await deps.context({ repo, task: `rules for ${path}`, paths: [path], ref, budgetTokens: 500 });
				return json({ path, rules: c.rules, conflicts: c.conflicts, pinned: c.pinned });
			} catch (err) {
				return fail(err);
			}
		},
	);

	server.registerTool(
		"check_overlap",
		{
			title: "Check overlap with other agents",
			description: "Which other forks or branches of the project are already changing these files (same file) or files beside them (same folder), with their agent and task. Pass exclude as repo@ref to leave out your own work.",
			inputSchema: z.object({ repo: REPO, paths: PATHS.min(1), exclude: z.string().max(200).optional() }),
		},
		async (args) => {
			try {
				return json({ overlaps: await deps.overlap(args) });
			} catch (err) {
				return fail(err);
			}
		},
	);

	server.registerTool(
		"list_attempts",
		{
			title: "List competing attempts",
			description: "Tasks that two or more agents are attempting in parallel (same Agent-Task trailer on separate forks or branches).",
			inputSchema: z.object({ repo: REPO }),
		},
		async ({ repo }) => {
			try {
				return json({ sets: await deps.attempts(repo) });
			} catch (err) {
				return fail(err);
			}
		},
	);

	server.registerTool(
		"compare_attempts",
		{
			title: "Compare attempts and pick one",
			description: "Compares the attempts at one task: what each change introduces against the org catalog, overlap with other work, diff size and spend, and recommends one to merge with the reasons.",
			inputSchema: z.object({ repo: REPO, task: z.string().max(200).describe("The Agent-Task id, e.g. feature#uploads-ai"), refs: z.array(z.string().regex(/^[\w./-]{1,100}$/)).max(10).optional().describe("Branches of the project to include even if git.next hasn't analysed them yet") }),
		},
		async (args) => {
			try {
				return json(await deps.compare(args));
			} catch (err) {
				return fail(err);
			}
		},
	);

	return server;
}
