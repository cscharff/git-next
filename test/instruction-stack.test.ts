import { describe, expect, it } from "vitest";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { configFacts } from "../src/providers/instruction-stack/config-facts.ts";
import { areasOf, instructionLines, keywordExtractor, strengthOf } from "../src/providers/instruction-stack/extract.ts";
import { instructionStackProvider } from "../src/providers/instruction-stack/index.ts";
import { resolve } from "../src/providers/instruction-stack/resolve.ts";
import { KIND_RANK, type Layer, type LayerKind, type Rule } from "../src/providers/instruction-stack/types.ts";

/** A project layer for a path (depth from its directory), or a repo-wide stack layer of another kind. */
const layer = (path: string, kind: LayerKind = "project"): Layer => {
	const scopeDir = kind === "project" && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	return { name: kind === "project" ? scopeDir || "root" : kind, kind, rank: KIND_RANK[kind], depth: scopeDir ? scopeDir.split("/").length : 0, repo: kind === "project" ? "r" : kind, path, scopeDir, origin: kind === "project" ? "project" : "stack" };
};
const extract = (md: string, l = layer("AGENTS.md")) => keywordExtractor.extract(l, md);
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

	it("does not read a formatter choice from prettier-ignore style directives", async () => {
		const md = ["Tool directives are exempt: `eslint-disable`, `prettier-ignore`, `biome-ignore` and similar.", "- **oxfmt** -- formatting (tabs, configured in `.prettierrc`)."].join("\n");
		expect(values(await extract(md))).toEqual(["formatter=oxfmt", "indentation=tabs"]);
		expect(values(await extract("Use `prettier-ignore` sparingly; we format with biome."))).toEqual(["formatter=biome"]);
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

	it("extracts contract, org and tool layer rules", async () => {
		const rules = await extract(
			[
				"- Every commit message must start with the SOW ticket ID, e.g. `SOW-1234: fix`.",
				"- You must skip changesets for internal fixes.",
				"- Only use approved model providers: Workers AI and Anthropic (via AI Gateway).",
				"- Run a security scan before opening a pull request.",
			].join("\n"),
		);
		expect(values(rules)).toEqual(["commitFormat=ticket-id-prefix", "changesetPolicy=not-required", "allowedModels=providers:anthropic,workers-ai", "securityScan=before-pr"]);
		expect(rules.slice(0, 3).every((r) => r.strength === "must")).toBe(true);
	});

	it("treats deferring to the project as no rule", async () => {
		expect(await extract("- For changesets, defer to the project's own changeset rules.")).toEqual([]);
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
	const root = layer("AGENTS.md");
	const pkg = layer("packages/a/AGENTS.md");
	const sibling = layer("packages/b/AGENTS.md");
	const org = layer("AGENTS.md", "org");
	const personal = layer("AGENTS.md", "personal");

	it("lets a deeper project file override a shallower one", () => {
		const [f] = resolve([rule("packageManager", "npm", root), rule("packageManager", "pnpm", pkg)]);
		expect(f.kind).toBe("overridden");
		expect(f.rules.map((r) => r.value)).toEqual(["pnpm", "npm"]);
	});

	it("decides winners by layer rank, not depth: org beats a nested project file", () => {
		const [f] = resolve([rule("formatter", "prettier", org), rule("formatter", "oxfmt", pkg, "must")]);
		expect(f.kind).toBe("overridden");
		expect(f.rules.map((r) => `${r.layer.kind}:${r.value}`)).toEqual(["org:prettier", "project:oxfmt"]);
	});

	it("lets project override personal preferences", () => {
		const [f] = resolve([rule("packageManager", "npm", personal), rule("packageManager", "pnpm", root)]);
		expect(f.rules.map((r) => r.layer.kind)).toEqual(["project", "personal"]);
	});

	it("reports a conflict when both rules say must, regardless of rank", () => {
		const [f] = resolve([rule("formatter", "prettier", org, "must"), rule("formatter", "oxfmt", pkg, "must")]);
		expect(f.kind).toBe("conflict");
		expect(f.rules[0].layer.kind).toBe("org");
	});

	it("reports a conflict between peer layers", () => {
		const otherOrg = { ...org, name: "org-2", repo: "org-2" };
		expect(resolve([rule("indentation", "tabs", org), rule("indentation", "2 spaces", otherOrg)])[0].kind).toBe("conflict");
	});

	it("treats test suites with the same runner as additive", () => {
		expect(resolve([rule("testCommand", "pnpm run test", root, "must"), rule("testCommand", "pnpm run test:react", pkg, "must")])).toEqual([]);
		expect(resolve([rule("testCommand", "pnpm run test", root, "must"), rule("testCommand", "npm test", pkg, "must")])[0].kind).toBe("conflict");
	});

	it("lets a narrower provider list sit inside a broader one", () => {
		expect(resolve([rule("allowedModels", "providers:anthropic,workers-ai", org, "must"), rule("allowedModels", "providers:workers-ai", pkg, "must")])).toEqual([]);
		expect(resolve([rule("allowedModels", "providers:anthropic", org, "must"), rule("allowedModels", "providers:openai", pkg, "must")])[0].kind).toBe("conflict");
	});

	it("checks model choices against an approved-provider list", () => {
		const policy = rule("allowedModels", "providers:anthropic,workers-ai", org, "must");
		expect(resolve([policy, rule("allowedModels", "claude-opus-5-5", pkg)])).toEqual([]);
		const [f] = resolve([policy, rule("allowedModels", "gpt-5.6-sol", pkg, "must")]);
		expect(f.kind).toBe("conflict");
		expect(f.explanation).toContain("not on the approved list");
		expect(f.policyViolation).toBe(true);
	});

	it("ignores sibling directories and disjoint areas", () => {
		expect(resolve([rule("packageManager", "npm", pkg), rule("packageManager", "pnpm", sibling)])).toEqual([]);
		const examplesOnly = rule("changesetPolicy", "not-required", root, "must", { areas: ["examples", "guides"] });
		expect(resolve([examplesOnly, rule("changesetPolicy", "required", org)])).toHaveLength(1);
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
					".gitnext/stack.json": JSON.stringify({ layers: [{ name: "personal", kind: "personal", repo: "org-standards", path: "AGENTS.md" }] }),
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

describe("layer dedupe", () => {
	const root = "- Use pnpm.\n- Indent with tabs.";
	const run = (main: Record<string, string>) => instructionStackProvider().analyze({ repo: "app", ref: "main", files: new RepoContext(async () => memorySource({ main })) });

	it("skips symlink blobs and copies of a covering layer, and reports them", async () => {
		const [summary] = await run({
			"AGENTS.md": root,
			".claude/CLAUDE.md": "../AGENTS.md\n", // a symlink as git stores it
			"CLAUDE.md": root, // same directory, same bytes
			"docs/AGENTS.md": root, // under the root layer, same bytes (e.g. read through a symlink)
			"web/AGENTS.md": "- Use npm here.",
		});
		expect(summary.title).toBe("Instruction stack: 2 layers, 3 rules");
		expect((summary.metrics as any).layers.map((l: any) => l.path)).toEqual(["AGENTS.md", "web/AGENTS.md"]);
		expect((summary.metrics as any).skippedLayers).toEqual([
			{ path: ".claude/CLAUDE.md", reason: "symlink", of: "AGENTS.md" },
			{ path: "CLAUDE.md", reason: "duplicate", of: "AGENTS.md" },
			{ path: "docs/AGENTS.md", reason: "duplicate", of: "AGENTS.md" },
		]);
		expect(summary.detail).toContain("Skipped 3 file(s)");
	});

	it("keeps identical copies in sibling directories, since each governs its own files", async () => {
		const [summary] = await run({ "AGENTS.md": "- Use pnpm.", "templates/a/AGENTS.md": root, "templates/b/AGENTS.md": root });
		expect(summary.title).toBe("Instruction stack: 3 layers, 5 rules");
		expect((summary.metrics as any).skippedLayers).toEqual([]);
	});
});
