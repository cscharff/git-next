import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { gitNextMcpServer, type McpDeps } from "../src/mcp.ts";

// Drives the git.next MCP server over real JSON-RPC (Streamable HTTP, stateless) with fake backing functions.

const calls: { tool: string; args: unknown }[] = [];
const deps: McpDeps = {
	async context(args) {
		calls.push({ tool: "context", args });
		return { rules: [{ topic: "packageManager", value: "pnpm", source: "AGENTS.md:9" }], conflicts: [], pinned: { musts: [] }, stats: { tokensServed: 120 }, inFlight: [{ repo: "agents-demo-r2", same: ["examples/x.ts"] }], sections: [{ path: "examples/AGENTS.md", startLine: 3, headings: ["Examples", "Server-only"], text: "Keep it small.", tokens: 4 }] };
	},
	async overlap(args) {
		calls.push({ tool: "overlap", args });
		return [{ repo: "agents-demo-mcp", same: args.paths }];
	},
	attempts: async () => [{ task: "feature#uploads-ai", attempts: [] }],
	async compare({ task }) {
		if (task !== "feature#uploads-ai") throw new Error(`no task with two or more attempts: ${task}`);
		return { task, attempts: [{ agent: "attempt-haiku", verdict: "pick" }] };
	},
};

const handler = createMcpHandler(() => gitNextMcpServer(deps));
let id = 0;
async function rpc(method: string, params?: unknown) {
	const res = await handler.fetch(
		new Request("http://localhost/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
		}),
	);
	const text = await res.text();
	// Either a JSON body or an SSE stream with one `data:` line per message.
	const body = text.trim().startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}");
	return JSON.parse(body);
}
const tool = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).result;

describe("git.next MCP server", () => {
	it("initializes and lists its tools", async () => {
		const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
		expect(init.result.serverInfo.name).toBe("git-next");
		const tools = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
		expect(tools).toEqual(["get_context", "rules_for", "check_overlap", "list_attempts", "compare_attempts"]);
	});

	it("get_context returns rules, overlap and trimmed sections", async () => {
		const r = await tool("get_context", { repo: "agents-demo-full", task: "add a delete endpoint", paths: ["examples/x.ts"] });
		expect(r.isError).toBeFalsy();
		expect(r.structuredContent).toMatchObject({ rules: [{ topic: "packageManager" }], inFlight: [{ repo: "agents-demo-r2" }], sections: [{ path: "examples/AGENTS.md", line: 3, heading: "Server-only", text: "Keep it small." }] });
	});

	it("rules_for asks for a small context on one path", async () => {
		calls.length = 0;
		const r = await tool("rules_for", { repo: "agents-demo-full", path: "packages/agents/src/index.ts" });
		expect(r.structuredContent.path).toBe("packages/agents/src/index.ts");
		expect(calls[0]).toEqual({ tool: "context", args: { repo: "agents-demo-full", task: "rules for packages/agents/src/index.ts", paths: ["packages/agents/src/index.ts"], ref: undefined, budgetTokens: 500 } });
	});

	it("check_overlap, list_attempts and compare_attempts pass through; errors come back as tool errors", async () => {
		expect((await tool("check_overlap", { repo: "agents-demo-full", paths: ["a.ts"], exclude: "agents-demo-r2@main" })).structuredContent.overlaps).toEqual([{ repo: "agents-demo-mcp", same: ["a.ts"] }]);
		expect((await tool("list_attempts", { repo: "agents-demo-full" })).structuredContent.sets[0].task).toBe("feature#uploads-ai");
		expect((await tool("compare_attempts", { repo: "agents-demo-full", task: "feature#uploads-ai" })).structuredContent.attempts[0].verdict).toBe("pick");
		const missing = await tool("compare_attempts", { repo: "agents-demo-full", task: "nope" });
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toMatch(/no task with two or more attempts/);
	});

	it("rejects bad repo names before calling anything", async () => {
		calls.length = 0;
		const r = await rpc("tools/call", { name: "check_overlap", arguments: { repo: "../etc", paths: ["a"] } });
		expect(r.error ?? r.result?.isError).toBeTruthy();
		expect(calls).toEqual([]);
	});
});
