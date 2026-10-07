import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageError, parseArgs } from "../src/cli/args.ts";
import { EXIT, readDevVars, runCli } from "../src/cli/main.ts";

describe("parseArgs", () => {
	it("parses commands, positionals and flags in both forms", () => {
		const a = parseArgs(["rules", "src/a.ts", "--json", "--layers=org/stack.json", "-q", "lib/b.ts"]);
		expect(a).toMatchObject({ command: "rules", positionals: ["src/a.ts", "lib/b.ts"], json: true, quiet: true, layers: "org/stack.json" });
		expect(parseArgs(["context", "fix it", "--budget", "1200", "--print"])).toMatchObject({ positionals: ["fix it"], budget: 1200, print: true });
		expect(parseArgs(["resources", "--base", "origin/main", "--strict"])).toMatchObject({ base: "origin/main", strict: true });
		expect(parseArgs(["cost", "--fork", "chris/x", "--remote", "agents-demo-full"])).toMatchObject({ fork: "chris/x", remote: "agents-demo-full", workerUrl: "http://localhost:5173" });
		expect(parseArgs(["rules", "--", "--weird-path"]).positionals).toEqual(["--weird-path"]);
	});

	it("treats no command or -h as help", () => {
		expect(parseArgs([]).command).toBe("help");
		expect(parseArgs(["rules", "--help"]).command).toBe("help");
	});

	it("rejects bad input with usage errors", () => {
		expect(() => parseArgs(["frobnicate"])).toThrow(UsageError);
		expect(() => parseArgs(["rules", "--nope"])).toThrow(/unknown option/);
		expect(() => parseArgs(["rules", "--strict"])).toThrow(/not valid for "rules"/);
		expect(() => parseArgs(["context", "task", "--budget", "-5"])).toThrow(/needs a value|positive integer/);
		expect(() => parseArgs(["context", "task", "--budget", "abc"])).toThrow(/positive integer/);
		expect(() => parseArgs(["context"])).toThrow(/needs a task/);
		expect(() => parseArgs(["rules", "--json=yes"])).toThrow(/takes no value/);
		expect(() => parseArgs(["rules", "--remote", "../etc"])).toThrow(/Artifacts repo name/);
	});
});

describe("readDevVars", () => {
	it("reads KEY=VALUE pairs, skipping comments and blanks", () => {
		const dir = mkdtempSync(join(tmpdir(), "gn-vars-"));
		writeFileSync(join(dir, ".dev.vars"), '# comment\nCF_ACCOUNT_ID="abc"\nEMPTY=\nAIG_LOGS_TOKEN=xyz\n');
		expect(readDevVars(join(dir, ".dev.vars"))).toEqual({ CF_ACCOUNT_ID: "abc", AIG_LOGS_TOKEN: "xyz" });
		expect(readDevVars(join(dir, "missing"))).toEqual({});
		rmSync(dir, { recursive: true });
	});
});

describe("runCli against a temporary git repo", () => {
	let dir: string;
	let layersDir: string;
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	const write = (path: string, text: string) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	const run = async (...argv: string[]) => {
		let out = "";
		let err = "";
		const code = await runCli(argv, { cwd: dir, out: (t) => (out += t), err: (t) => (err += t), env: {}, devVarsFiles: [] });
		return { code, out, err };
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "gn-cli-"));
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		write("AGENTS.md", "# Tools\n- Always use pnpm.\n");
		write("web/AGENTS.md", "# Web\n- Use npm here.\n");
		write("wrangler.jsonc", '{ "name": "api", "kv_namespaces": [{ "binding": "CACHE", "id": "1" }] }');
		// Extra layers live outside the repo, as an org's standards would.
		layersDir = mkdtempSync(join(tmpdir(), "gn-layers-"));
		mkdirSync(join(layersDir, ".gitnext"));
		mkdirSync(join(layersDir, "org"));
		writeFileSync(join(layersDir, ".gitnext/stack.json"), JSON.stringify({ layers: [{ name: "acme", kind: "org", repo: "org", path: "org/AGENTS.md" }] }));
		writeFileSync(join(layersDir, "org/AGENTS.md"), "- You must use yarn.\n");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(layersDir, { recursive: true, force: true });
	});

	it("rules: exits 0 when deeper layers only override", async () => {
		const r = await run("rules", "web/index.ts");
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toContain("Winning rules for web/index.ts");
		expect(r.out).toMatch(/packageManager\s+npm/);
		expect(r.out).toContain("✓ no conflicts");
	});

	it("rules: exits 1 on a conflict from an added layer, with file:line evidence in --json", async () => {
		const r = await run("rules", "--layers", join(layersDir, ".gitnext/stack.json"), "--json");
		expect(r.code).toBe(EXIT.findings);
		const report = JSON.parse(r.out);
		expect(report.exitCode).toBe(1);
		expect(report.conflicts[0].evidence).toEqual(["org:org/AGENTS.md:1", "AGENTS.md:2"]);
		expect(report.layers[0]).toMatchObject({ rank: 1, kind: "org", name: "acme" });
	});

	it("rules -q prints nothing when clean", async () => {
		const r = await run("rules", "-q");
		expect(r).toMatchObject({ code: 0, out: "" });
	});

	it("resources --strict exits 1 only when bindings were added vs base", async () => {
		expect((await run("resources", "--base", "HEAD", "--strict")).code).toBe(EXIT.ok);
		write("wrangler.jsonc", '{ "name": "api", "kv_namespaces": [{ "binding": "CACHE", "id": "1" }], "r2_buckets": [{ "binding": "FILES", "bucket_name": "f" }] }');
		const r = await run("resources", "--base", "HEAD", "--strict", "--verbose");
		expect(r.code).toBe(EXIT.findings);
		expect(r.out).toContain("+ r2_buckets FILES → f");
		expect((await run("resources", "--base", "HEAD")).code).toBe(EXIT.ok);
		git("checkout", "--", "wrangler.jsonc");
	});

	it("context: returns sections and rules as JSON", async () => {
		write("docs/deploy.md", "# Deploying\nRun the deploy script to ship the API worker.\n");
		const r = await run("context", "deploy the API worker", "web/app.ts", "--json", "--budget", "800");
		expect(r.code).toBe(EXIT.ok);
		const ctx = JSON.parse(r.out);
		expect(ctx.sections[0].path).toBe("docs/deploy.md");
		expect(ctx.rules.find((x: any) => x.topic === "packageManager").value).toBe("npm");
	});

	it("cost: falls back to the fixture without a token and filters by fork", async () => {
		const r = await run("cost", "--repo", "agents-demo-full", "--fork", "devon/think-repro");
		expect(r.code).toBe(EXIT.ok);
		expect(r.out).toContain("source fixture:ai-gateway-logs");
		expect(r.out).toContain("agent-think");
		expect(r.out).not.toContain("docs-bot");
	});

	it("exits 2 on usage and runtime errors", async () => {
		expect((await run("nope")).code).toBe(EXIT.error);
		const r = await run("resources", "--base", "no-such-ref");
		expect(r.code).toBe(EXIT.error);
		expect(r.err).toContain("git next resources:");
	});
});
