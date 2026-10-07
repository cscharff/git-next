import { describe, expect, it } from "vitest";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { ownersOf, ownersProvider, parseCodeowners } from "../src/providers/owners.ts";

describe("parseCodeowners", () => {
	const rules = parseCodeowners("# owners\n*       @org/everyone\n*.md    @org/docs\n/packages/ @org/core\nexamples/AGENTS.md @org/devrel # inline comment\n");
	it("applies the last matching rule", () => {
		expect(ownersOf(rules, "src/index.ts")).toEqual(["@org/everyone"]);
		expect(ownersOf(rules, "README.md")).toEqual(["@org/docs"]);
		expect(ownersOf(rules, "packages/agents/AGENTS.md")).toEqual(["@org/core"]);
		expect(ownersOf(rules, "examples/AGENTS.md")).toEqual(["@org/devrel"]);
		expect(ownersOf(parseCodeowners("/docs/ @d"), "packages/docs/a.md")).toEqual([]);
	});
});

describe("ownersProvider", () => {
	it("flags instruction files no rule covers", async () => {
		const files = new RepoContext(async () => memorySource({ main: { ".github/CODEOWNERS": "/packages/ @org/core\n", "AGENTS.md": "x", "packages/a/AGENTS.md": "y" } }));
		const out = await ownersProvider.analyze({ repo: "r", ref: "main", files });
		expect(out.map((i) => `${i.severity}:${i.title}`)).toEqual(["info:1/2 instruction files have owners", "warn:Unowned instruction file: AGENTS.md"]);
	});

	it("reports a missing CODEOWNERS file", async () => {
		const files = new RepoContext(async () => memorySource({ main: { "AGENTS.md": "x" } }));
		expect((await ownersProvider.analyze({ repo: "r", ref: "main", files }))[0].title).toBe("No CODEOWNERS file");
	});
});
