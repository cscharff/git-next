import { describe, expect, it } from "vitest";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { configFacts } from "../src/providers/instruction-stack/config-facts.ts";
import { areasOf, instructionLines, keywordExtractor, strengthOf } from "../src/providers/instruction-stack/extract.ts";
import { instructionStackProvider } from "../src/providers/instruction-stack/index.ts";
import { resolve } from "../src/providers/instruction-stack/resolve.ts";
import type { Layer, Rule } from "../src/providers/instruction-stack/types.ts";

const layer = (path: string, rank: number, scopeDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""): Layer => ({
	name: scopeDir || "root",
	rank,
	repo: "r",
	path,
	scopeDir,
	origin: "project",
});
const extract = (md: string, l = layer("AGENTS.md", 100)) => keywordExtractor.extract(l, md);
const values = (rules: Rule[]) => rules.map((r) => `${r.topic}=${r.value}`);

describe("keyword extractor", () => {
	it("extracts each fixed topic", async () => {
		const rules = await extract(
			[
				"- Always use pnpm for installs.",
				"- Format with oxfmt before committing.",
				"- Indent with 2 spaces.",
				"- Run `pnpm run test` before pushing.",
				"- Commit messages must follow Conventional Commits.",
				"- Every package change needs a changeset.",
				"- Lint must pass with --max-warnings 0.",
				"- Only use claude-opus-5-5 or gpt-5.6-sol models.",
				"- Never commit secrets or .env files.",
			].join("\n"),
		);
		expect(values(rules)).toEqual([
			"packageManager=pnpm",
			"formatter=oxfmt",
			"indentation=2 spaces",
			"testCommand=pnpm run test",
			"commitFormat=conventional",
			"changesetPolicy=required",
			"lintStrictness=strict",
			"allowedModels=claude-opus-5-5,gpt-5.6-sol",
			"secrets=never-in-source",
		]);
	});

	it("skips headings and fenced code blocks", async () => {
		const md = "# Use npm\n```sh\nnpm install\n```\nUse tabs for indentation.";
		expect([...instructionLines(md)]).toEqual([{ line: 5, text: "Use tabs for indentation." }]);
		expect(values(await extract(md))).toEqual(["indentation=tabs"]);
	});

	it("records strength, line numbers and named areas", async () => {
		const [rule] = await extract("intro\n\nExamples, guides, and sites don't need changesets.");
		expect(rule).toMatchObject({ topic: "changesetPolicy", value: "not-required", strength: "must", line: 3, areas: ["examples", "guides", "site"] });
		expect(strengthOf("Prefer yarn")).toBe("should");
		expect(areasOf("Changes to `packages/` need a changeset")).toEqual(["packages"]);
	});

	it("scores strength per sentence", async () => {
		const [rule] = await extract("Node 24+ required. Uses pnpm workspaces with Nx.");
		expect(rule).toMatchObject({ topic: "packageManager", value: "pnpm", strength: "should", text: "Uses pnpm workspaces with Nx." });
	});

	it("ignores lines that only mention a tool in passing", async () => {
		expect(await extract("The npm registry hosts our packages.")).toEqual([]);
	});
});

describe("config facts", () => {
	it("reads package manager, formatter and indentation from config files", () => {
		expect(configFacts("package.json", '{"packageManager":"pnpm@11.0.0"}')).toEqual([{ topic: "packageManager", value: "pnpm", path: "package.json", dir: "" }]);
		expect(configFacts("apps/x/package-lock.json", "{}")).toEqual([{ topic: "packageManager", value: "npm", path: "apps/x/package-lock.json", dir: "apps/x" }]);
		expect(configFacts(".prettierrc", '{"useTabs": false, "tabWidth": 4}').map((f) => f.value)).toEqual(["prettier", "4 spaces"]);
		expect(configFacts(".oxfmtrc.json", '{"useTabs": true}').map((f) => f.value)).toEqual(["oxfmt", "tabs"]);
		expect(configFacts(".editorconfig", "root = true\n[*]\nindent_style = tab\n[*.md]\nindent_style = space").map((f) => f.value)).toEqual(["tabs"]);
	});
});

describe("resolver", () => {
	const rule = (topic: Rule["topic"], value: string, l: Layer, strength: Rule["strength"] = "should", extra: Partial<Rule> = {}): Rule => ({ topic, value, strength, layer: l, line: 1, text: "", ...extra });
	const root = layer("AGENTS.md", 100);
	const pkg = layer("packages/a/AGENTS.md", 102);
	const sibling = layer("packages/b/AGENTS.md", 102);

	it("lets a more specific layer override a broader one", () => {
		const [f] = resolve([rule("packageManager", "npm", root), rule("packageManager", "pnpm", pkg)]);
		expect(f.kind).toBe("overridden");
		expect(f.rules.map((r) => r.value)).toEqual(["pnpm", "npm"]);
	});

	it("reports a conflict when both layers say must", () => {
		const [f] = resolve([rule("formatter", "prettier", root, "must"), rule("formatter", "oxfmt", pkg, "must")]);
		expect(f.kind).toBe("conflict");
	});

	it("reports a conflict at equal rank across layers", () => {
		const org = { ...layer("org/AGENTS.md", 100, ""), origin: "stack" as const, repo: "org" };
		expect(resolve([rule("indentation", "tabs", root), rule("indentation", "2 spaces", org)])[0].kind).toBe("conflict");
	});

	it("ignores sibling directories and disjoint areas", () => {
		expect(resolve([rule("packageManager", "npm", pkg), rule("packageManager", "pnpm", sibling)])).toEqual([]);
		const examplesOnly = rule("changesetPolicy", "not-required", root, "must", { areas: ["examples", "guides"] });
		expect(resolve([examplesOnly, rule("changesetPolicy", "required", pkg)])).toEqual([]);
		expect(resolve([examplesOnly, rule("changesetPolicy", "required", root, "should", { areas: ["packages"] })])).toEqual([]);
	});

	it("only flags differing values within one file when both are must", () => {
		expect(resolve([rule("testCommand", "pnpm test", root), rule("testCommand", "pnpm run test:e2e", root)])).toEqual([]);
		expect(resolve([rule("packageManager", "npm", root, "must"), rule("packageManager", "pnpm", root, "must")])[0].kind).toBe("conflict");
	});

	it("detects drift between the effective instruction and config", () => {
		const rules = [rule("packageManager", "npm", root), rule("packageManager", "pnpm", pkg)];
		const facts = [
			{ topic: "packageManager" as const, value: "pnpm", path: "pnpm-lock.yaml", dir: "" },
			{ topic: "packageManager" as const, value: "pnpm", path: "packages/a/package.json", dir: "packages/a" },
		];
		const drift = resolve(rules, facts).filter((f) => f.kind === "drift");
		expect(drift).toHaveLength(1);
		expect(drift[0].fact!.path).toBe("pnpm-lock.yaml");
		expect(drift[0].rules[0].value).toBe("npm");
	});
});

describe("instructionStackProvider", () => {
	it("combines project files, stack layers from other repos and config drift", async () => {
		const sources: Record<string, Record<string, Record<string, string>>> = {
			app: {
				main: {
					"AGENTS.md": "- Use pnpm.\n- Indent with tabs.",
					"web/AGENTS.md": "- Use npm for this package.",
					".gitnext/stack.json": JSON.stringify({ layers: [{ name: "org", rank: 50, repo: "org-standards", path: "AGENTS.md" }] }),
					".prettierrc": '{"useTabs": false}',
					"pnpm-lock.yaml": "",
				},
			},
			"org-standards": { HEAD: { "AGENTS.md": "- You must indent with 2 spaces.\n- Never commit secrets." } },
		};
		const files = new RepoContext(async (name) => memorySource(sources[name]));
		const out = await instructionStackProvider().analyze({ repo: "app", ref: "main", files });
		const [summary, ...findings] = out;
		expect(summary.title).toBe("Instruction stack: 3 layers, 5 rules");
		expect(findings.map((i) => `${i.severity}:${i.title}`).sort()).toEqual([
			"info:overridden: indentation",
			"info:overridden: packageManager",
			"warn:drift: indentation",
		]);
		const drift = findings.find((i) => i.title === "drift: indentation")!;
		expect(drift.detail).toContain('says "tabs" but .prettierrc implies "2 spaces"');
	});
});
