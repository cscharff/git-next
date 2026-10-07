import { describe, expect, it } from "vitest";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { buildContext } from "../src/providers/context/index.ts";
import { Bm25Retriever, VectorRetriever, tokenize, type Embedder } from "../src/providers/context/retrieve.ts";
import { estimateTokens, splitSections } from "../src/providers/context/sections.ts";

describe("splitSections", () => {
	it("splits on headings, keeps heading trails and ignores headings in code fences", () => {
		const md = ["intro text", "# Setup", "install it", "## Testing", "run tests", "```sh", "# not a heading", "```", "# Deploy", "ship it"].join("\n");
		const s = splitSections("docs/a.md", md);
		expect(s.map((x) => [x.id, x.headings, x.startLine])).toEqual([
			["docs/a.md#intro", [], 1],
			["docs/a.md#setup", ["Setup"], 2],
			["docs/a.md#setup-testing", ["Setup", "Testing"], 4],
			["docs/a.md#deploy", ["Deploy"], 9],
		]);
		expect(s[2].text).toContain("# not a heading");
		expect(s[0].title).toBe("a.md");
	});

	it("de-duplicates ids and skips empty sections", () => {
		const s = splitSections("x.md", "# A\none\n# A\ntwo\n# Empty\n");
		expect(s.map((x) => x.id)).toEqual(["x.md#a", "x.md#a-1"]);
	});

	it("estimates tokens at about four characters each", () => {
		expect(estimateTokens("abcdefgh")).toBe(2);
	});
});

describe("retrievers", () => {
	const sections = [
		...splitSections("docs/mcp.md", "# MCP client\nThe MCP client reconnects when the transport drops.\n# OAuth\nOAuth flows for MCP servers."),
		...splitSections("docs/email.md", "# Email\nRoute inbound email to agents."),
		...splitSections("docs/schedule.md", "# Scheduling\nUse this.schedule for cron tasks."),
	];

	it("tokenizes with stopwords and light plural stemming", () => {
		expect(tokenize("The agents use schedules for tasks")).toEqual(["agent", "schedule", "task"]);
	});

	it("ranks the most relevant section first with BM25", async () => {
		const out = await new Bm25Retriever(sections).search("fix MCP reconnect after transport drops", 3);
		expect(out[0].section.id).toBe("docs/mcp.md#mcp-client");
		expect(out.every((r) => r.score > 0)).toBe(true);
		expect(out.map((r) => r.section.path)).not.toContain("docs/email.md");
	});

	it("supports any Embedder through VectorRetriever", async () => {
		const vocab = ["mcp", "email", "schedule"];
		const fake: Embedder = { id: "fake", embed: async (texts) => texts.map((t) => vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0))) };
		const out = await new VectorRetriever(sections, fake).search("email routing", 1);
		expect(out[0].section.path).toBe("docs/email.md");
	});
});

describe("buildContext", () => {
	const repo = "demo";
	const big = "Lorem ipsum dolor sit amet. ".repeat(200);
	const main = {
		"AGENTS.md": "# Tooling\n- Always use pnpm.\n# Changesets\n- Changes to packages need a changeset.",
		"packages/core/AGENTS.md": "# Core\n- Run `pnpm run test` before pushing.\n# MCP\nThe MCP client lives in src/mcp; reconnect logic is in client.ts.",
		"examples/AGENTS.md": "# Examples\n- Examples don't need changesets.\n- Use npm in examples.",
		"docs/mcp.md": "# MCP reconnect\nHow the MCP client reconnects after transport errors.",
		"docs/email.md": `# Email\n${big}`,
		"docs/huge-mcp.md": `# MCP deep dive\nMCP reconnect transport internals. ${big}`,
		"CHANGELOG.md": "# 1.0.0\n- MCP reconnect fix",
	};
	const files = new RepoContext(async () => memorySource({ main }));

	it("serves rules for the touched paths and the best sections within budget", async () => {
		const ctx = await buildContext(files, { repo, ref: "main", task: "Fix MCP client reconnect when the transport drops", paths: ["packages/core/src/mcp/client.ts"], budgetTokens: 600 });
		expect(ctx.rules.map((r) => `${r.topic}=${r.value}`).sort()).toEqual(["changesetPolicy=required", "packageManager=pnpm", "testCommand=pnpm run test"]);
		expect(ctx.sections[0].id).toBe("packages/core/AGENTS.md#mcp");
		expect(ctx.sections.map((s) => s.path)).toContain("docs/mcp.md");
		expect(ctx.sections.map((s) => s.path)).not.toContain("CHANGELOG.md");
		expect(ctx.omitted.top.find((o) => o.id === "docs/huge-mcp.md#mcp-deep-dive")?.reason).toBe("oversized");
		expect(ctx.stats.tokensServed).toBeLessThanOrEqual(600);
		expect(ctx.stats.tokensServed).toBeLessThan(ctx.stats.tokensAllMarkdown);
		expect(ctx.stats.tokensServed).toBe(ctx.stats.rulesTokens + ctx.stats.sectionTokens);
	});

	it("applies area-scoped rules only where they reach", async () => {
		const ctx = await buildContext(files, { repo, ref: "main", task: "Add an example", paths: ["examples/chat/src/index.ts"], budgetTokens: 2000 });
		const byTopic = Object.fromEntries(ctx.rules.map((r) => [r.topic, r.value]));
		expect(byTopic).toMatchObject({ packageManager: "npm", changesetPolicy: "not-required" });
		expect(ctx.conflicts).toEqual([]);
	});
});

describe("section dedupe", () => {
	it("serves a section copied into several files once, under the shortest path, and says so", async () => {
		const skill = "# Plugin storage\nPlugins store data in collections with indexes on hot fields.";
		const files = new RepoContext(async () =>
			memorySource({
				main: {
					"skills/plugins/SKILL.md": skill,
					"templates/a/.agents/skills/plugins/SKILL.md": skill,
					"templates/b/.agents/skills/plugins/SKILL.md": skill,
					"docs/other.md": "# Other\nUnrelated text about themes.",
					"pkg/changelog/0.1-to-0.9.md": "# Plugin storage changes\nPlugins store data in collections.",
				},
			}),
		);
		const ctx = await buildContext(files, { repo: "r", ref: "main", task: "plugin storage indexes", paths: [], budgetTokens: 2000 });
		const served = ctx.sections.filter((s) => s.text === skill);
		expect(served.map((s) => s.path)).toEqual(["skills/plugins/SKILL.md"]);
		expect(served[0]).toMatchObject({ duplicates: 2, duplicatePaths: ["templates/a/.agents/skills/plugins/SKILL.md", "templates/b/.agents/skills/plugins/SKILL.md"] });
		expect(ctx.manifest.find((m: any) => m.source.startsWith("skills/"))).toMatchObject({ duplicates: 2 });
		expect(ctx.stats).toMatchObject({ markdownFiles: 4, sections: 2, duplicateSections: 2 });
		expect(ctx.sections.some((s) => s.path.includes("changelog/"))).toBe(false);
	});
});
