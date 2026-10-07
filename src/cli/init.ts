import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve as resolvePath, sep } from "node:path";
import { parseJsonc } from "../parse/jsonc.ts";
import { CATALOG_FILE, parseCatalog } from "../providers/catalog.ts";
import { keywordExtractor } from "../providers/instruction-stack/extract.ts";
import { KIND_RANK, LAYER_KINDS, type Layer, type LayerKind } from "../providers/instruction-stack/types.ts";
import type { ParsedArgs } from "./args.ts";
import type { CliIo } from "./main.ts";

// `git next new <name> --template worker-api` / `git next init <dir>`: a repo that starts smart. It inherits the
// org baseline's layers (vendored at a pinned content hash), its catalog, a template with secure defaults and the
// fail-closed pre-push hook, then runs `git next rules` immediately and refuses to finish on a conflict.
//
// Everything read from the baseline is data. Template files are copied byte for byte except for two
// placeholders, {{name}} and {{owner}}, filled from validated values. Nothing from a layer or the catalog is
// executed, evaluated or substituted into a command.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OWNER = /^@?[A-Za-z0-9][A-Za-z0-9_.\/-]*$/;
const TEXT_FILE = /\.(ts|js|json|jsonc|md|toml|ya?ml|txt)$|(^|\/)(gitignore|CODEOWNERS)$/;

export interface InitDeps {
	/** Runs `git next rules` in the new repo and returns its exit code plus printable text. */
	runRules: (cwd: string) => Promise<{ code: number; text: string }>;
	packageRoot: string;
}

interface BaselineLayer {
	name: string;
	kind: LayerKind;
	rank: number;
	path: string;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Resolves a path inside the baseline, refusing anything that escapes it. */
function inside(root: string, rel: string): string {
	const abs = resolvePath(root, rel);
	if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`baseline path escapes the baseline: ${rel}`);
	return abs;
}

function readBaselineStack(org: string): BaselineLayer[] {
	const stackPath = join(org, ".gitnext/stack.json");
	if (!existsSync(stackPath)) throw new Error(`${org} has no .gitnext/stack.json`);
	const parsed = parseJsonc(readFileSync(stackPath, "utf8")) as { layers?: unknown };
	if (!Array.isArray(parsed.layers)) throw new Error("baseline stack.json needs a layers array");
	return parsed.layers.map((l: any, i: number) => {
		const kind = (l?.kind ?? LAYER_KINDS[(l?.rank ?? 0) - 1]) as LayerKind;
		if (!kind || !(kind in KIND_RANK) || kind === "project") throw new Error(`baseline layer ${i} needs kind org|contract|tool|personal`);
		if (typeof l.path !== "string" || typeof l.name !== "string" || !NAME.test(l.name)) throw new Error(`baseline layer ${i} needs a name and a path`);
		if (!existsSync(inside(org, l.path))) throw new Error(`baseline layer file not found: ${l.path}`);
		return { name: l.name, kind, rank: Number(l.rank) || KIND_RANK[kind], path: l.path };
	});
}

function copyTemplate(from: string, to: string, vars: { name: string; owner: string }, written: string[]) {
	for (const entry of readdirSync(from)) {
		if (entry === "AGENTS.project.md") continue; // folded into the generated AGENTS.md
		const src = join(from, entry);
		const destName = entry === "gitignore" ? ".gitignore" : entry; // npm/git strip dotfiles from templates
		const dest = join(to, destName);
		if (statSync(src).isDirectory()) {
			mkdirSync(dest, { recursive: true });
			copyTemplate(src, dest, vars, written);
		} else if (TEXT_FILE.test(entry)) {
			// Only these two literal placeholders are replaced; the values were validated above.
			writeFileSync(dest, readFileSync(src, "utf8").replaceAll("{{name}}", vars.name).replaceAll("{{owner}}", vars.owner));
			written.push(dest);
		} else {
			copyFileSync(src, dest);
			written.push(dest);
		}
	}
}

/** Inherited musts, rendered from extracted rule values (not copied layer prose) so layer text can't steer agents. */
async function inheritedSummary(layers: { layer: BaselineLayer; vendored: string; text: string }[]): Promise<string[]> {
	const lines: string[] = [];
	for (const { layer, vendored, text } of layers) {
		const l: Layer = { name: layer.name, kind: layer.kind, rank: layer.rank, depth: 0, repo: "baseline", path: vendored, scopeDir: "", origin: "stack" };
		for (const r of await keywordExtractor.extract(l, text)) {
			if (r.strength !== "must") continue;
			const value = r.value.replace(/[`\r\n]/g, "");
			lines.push(`- ${r.topic}: \`${value}\` (${layer.kind} layer, ${vendored}:${r.line})`);
		}
	}
	return lines;
}

export async function initCommand(args: ParsedArgs, io: CliIo, d: InitDeps): Promise<number> {
	const target = resolvePath(io.cwd, args.positionals[0]);
	const name = args.name ?? basename(target);
	if (!NAME.test(name)) throw new Error(`invalid project name: ${name}`);
	if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} already exists and is not empty`);

	const org = resolvePath(io.cwd, args.org ?? io.env?.GIT_NEXT_ORG ?? join(d.packageRoot, "fixtures/org-baseline"));
	const templateDir = inside(org, join("templates", args.template));
	if (!existsSync(templateDir)) throw new Error(`template "${args.template}" not found in ${org}/templates`);
	const catalogText = readFileSync(inside(org, "catalog.json"), "utf8");
	const catalog = parseCatalog(catalogText);
	const baselineLayers = readBaselineStack(org);
	const owner = args.owner ?? catalog.owner ?? "@your-team";
	if (!OWNER.test(owner)) throw new Error(`invalid owner: ${owner}`);

	// Pin: the baseline commit when it is a git repo, plus a content hash of what was vendored.
	let commit: string | null = null;
	try {
		commit = git(org, "log", "-1", "--format=%H", "--", ".") || null;
	} catch {
		commit = null;
	}
	const layerTexts = baselineLayers.map((layer) => ({ layer, text: readFileSync(inside(org, layer.path), "utf8"), vendored: `.gitnext/layers/${layer.kind}-${layer.name}.md` }));
	const contentHash = sha([catalogText, ...layerTexts.map((l) => l.text)].join("\0"));
	// A label, not a path: generated files are committed, so they must not carry this machine's paths.
	const orgLabel = basename(org);

	if (args.initRemote) {
		io.out(
			[
				"Dry run (--remote): would create an Artifacts repo for this project:",
				`  1. fork org-baseline → ${name} (keeps provenance to the baseline)`,
				`  2. push the files generated below to ${name}:main with a short-lived write token passed in GIT_CONFIG_* env vars`,
				"  Not performed: creating Artifacts repos waits for explicit approval. Continuing with the local repo only.",
				"",
			].join("\n"),
		);
	}

	const written: string[] = [];
	try {
		mkdirSync(join(target, ".gitnext/layers"), { recursive: true });
		copyTemplate(templateDir, target, { name, owner }, written);
		for (const l of layerTexts) {
			writeFileSync(join(target, l.vendored), l.text);
			written.push(join(target, l.vendored));
		}
		writeFileSync(join(target, CATALOG_FILE), catalogText);
		written.push(join(target, CATALOG_FILE));
		const stack = {
			baseline: { source: orgLabel, template: args.template, commit, contentHash, catalogVersion: catalog.version },
			layers: layerTexts.map((l) => ({ name: l.layer.name, kind: l.layer.kind, rank: l.layer.rank, path: l.vendored, pinned: { from: l.layer.path, contentHash: sha(l.text) } })),
		};
		writeFileSync(join(target, ".gitnext/stack.json"), `${JSON.stringify(stack, null, "\t")}\n`);
		written.push(join(target, ".gitnext/stack.json"));

		const projectRulesPath = join(templateDir, "AGENTS.project.md");
		const projectRules = existsSync(projectRulesPath) ? readFileSync(projectRulesPath, "utf8").replaceAll("{{name}}", name).replaceAll("{{owner}}", owner) : "## Project rules\n\n- _fill in_\n";
		const inherited = await inheritedSummary(layerTexts);
		const agents = [
			`# ${name}`,
			"",
			`<!-- Generated by git next ${args.command} from ${orgLabel} (template ${args.template}, baseline ${commit?.slice(0, 12) ?? "uncommitted"}, content ${contentHash}). -->`,
			"",
			projectRules.trimEnd(),
			"",
			"## Inherited from the org baseline (pinned)",
			"",
			`Layers are vendored in \`.gitnext/layers/\` at content ${contentHash}; change them in the baseline, not here.`,
			`The catalog of approved models, resources, tools and checks is \`.gitnext/catalog.json\` (version ${catalog.version}).`,
			"",
			...inherited,
			"",
		].join("\n");
		writeFileSync(join(target, "AGENTS.md"), agents);
		written.push(join(target, "AGENTS.md"));

		// Git repo with the fail-closed pre-push hook.
		git(target, "init", "-q", "-b", "main");
		const hook = join(d.packageRoot, "examples/hooks/pre-push");
		copyFileSync(hook, join(target, ".git/hooks/pre-push"));
		chmodSync(join(target, ".git/hooks/pre-push"), 0o755);

		// Check immediately: a project rule that conflicts with an org must fails creation, not the first push.
		const rules = await d.runRules(target);
		if (rules.code !== 0) {
			io.err(`${rules.text}\ngit next ${args.command}: refusing to create ${name}: the new repo does not pass git next rules.${args.keep ? ` Kept ${target} for inspection.` : ""}\n`);
			if (!args.keep) rmSync(target, { recursive: true, force: true });
			return rules.code;
		}

		const hasIdentity = (() => {
			try {
				return !!git(target, "config", "user.name");
			} catch {
				return false;
			}
		})();
		git(target, "add", "-A");
		execFileSync("git", [...(hasIdentity ? [] : ["-c", "user.name=git next", "-c", "user.email=git-next@localhost"]), "commit", "-q", "-m", `Create ${name} from org baseline (catalog ${catalog.version})`], { cwd: target, stdio: "pipe" });

		if (args.json) {
			io.out(`${JSON.stringify({ name, dir: target, template: args.template, baseline: stack.baseline, layers: stack.layers.map((l) => l.path), files: written.map((f) => relative(target, f)).sort(), hook: ".git/hooks/pre-push", rules: "pass" }, null, 2)}\n`);
		} else {
			io.out(
				[
					`Created ${name} in ${relative(io.cwd, target) || "."} from ${orgLabel} (template ${args.template})`,
					`  layers   ${stack.layers.map((l) => `${l.kind}:${l.name}`).join(", ")} pinned at ${contentHash}${commit ? ` (baseline ${commit.slice(0, 12)})` : ""}`,
					`  catalog  ${catalog.version}: ${catalog.models.filter((m) => !m.cloud || m.cloud === "cloudflare").length} models, ${catalog.bindings.filter((b) => !b.cloud || b.cloud === "cloudflare").length} binding types, gateway ${catalog.gateway?.id ?? "none"}`,
					`  files    ${written.map((f) => relative(target, f)).sort().join(", ")}`,
					"  hook     .git/hooks/pre-push (fail-closed; GIT_NEXT_ALLOW_ON_ERROR=1 to bypass on errors)",
					"  rules    ✓ no conflicts or catalog violations",
					"",
				].join("\n"),
			);
		}
		return 0;
	} catch (err) {
		if (!args.keep) rmSync(target, { recursive: true, force: true });
		throw err;
	}
}
