import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath, sep } from "node:path";
import { RepoContext, overlayFiles } from "../core/repo-context.ts";
import { parseJsonc } from "../parse/jsonc.ts";
import { CATALOG_FILE, checkCatalog, compareVersions, parseCatalog } from "../providers/catalog.ts";
import { STACK_FILE, loadStack } from "../providers/instruction-stack/index.ts";
import { effectiveRules, resolve } from "../providers/instruction-stack/resolve.ts";
import type { ParsedArgs } from "./args.ts";
import { WORKTREE, localSource } from "./git-source.ts";
import type { CliIo } from "./main.ts";

// `git next doctor`: how far a repo made with `git next new` has drifted from its org baseline, and what the current
// baseline would change. Baseline files are read as data and compared; nothing from them is executed.

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

interface PinnedLayer {
	name: string;
	kind: string;
	path: string;
	pinned?: { from: string; contentHash: string };
}

export async function doctorCommand(args: ParsedArgs, io: CliIo, d: { packageRoot: string; gitTopLevel: (cwd: string) => string }): Promise<number> {
	const root = d.gitTopLevel(io.cwd);
	const repo = basename(root);
	const stackPath = join(root, STACK_FILE);
	if (!existsSync(stackPath)) {
		io.out(`${repo} has no ${STACK_FILE}: it wasn't created with \`git next new\`, so there is no baseline to compare with.\n`);
		return 0;
	}
	const stack = parseJsonc(readFileSync(stackPath, "utf8")) as { baseline?: { source?: string; contentHash?: string; catalogVersion?: string; commit?: string | null }; layers?: PinnedLayer[] };
	const org = resolvePath(io.cwd, args.org ?? io.env?.GIT_NEXT_ORG ?? join(d.packageRoot, "fixtures/org-baseline"));
	const inside = (rel: string) => {
		const abs = resolvePath(org, rel);
		if (!abs.startsWith(org + sep)) throw new Error(`baseline path escapes the baseline: ${rel}`);
		return abs;
	};
	const baselineCatalogText = readFileSync(inside("catalog.json"), "utf8");
	const baselineCatalog = parseCatalog(baselineCatalogText);
	const repoCatalogPath = join(root, CATALOG_FILE);
	const repoCatalog = existsSync(repoCatalogPath) ? parseCatalog(readFileSync(repoCatalogPath, "utf8")) : null;

	// Layers: pinned content vs the baseline file it came from.
	const layers = (stack.layers ?? []).map((l) => {
		const from = l.pinned?.from;
		const current = from && existsSync(inside(from)) ? readFileSync(inside(from), "utf8") : null;
		const vendored = existsSync(join(root, l.path)) ? readFileSync(join(root, l.path), "utf8") : null;
		return { ...l, current, vendored, changed: current !== null && l.pinned?.contentHash !== sha(current), missing: current === null };
	});
	const changedLayers = layers.filter((l) => l.changed);
	const catalogBehind = !!repoCatalog && compareVersions(repoCatalog.version, baselineCatalog.version) < 0;

	// What the current baseline would add: re-check with the baseline's layers and catalog overlaid (nothing written).
	const overlay: Record<string, string> = Object.fromEntries(changedLayers.map((l) => [l.path, l.current!]));
	if (catalogBehind) overlay[CATALOG_FILE] = baselineCatalogText;
	const pinnedFiles = new RepoContext(async () => localSource(root));
	const currentFiles = new RepoContext(async () => overlayFiles(localSource(root), overlay));
	const analyse = async (files: RepoContext) => {
		const [st, cat] = await Promise.all([loadStack(files, repo, WORKTREE), checkCatalog(files, repo, WORKTREE)]);
		return {
			findings: [...resolve(st.rules, st.facts).filter((f) => f.kind === "conflict" || f.policyViolation).map((f) => `${f.policyViolation ? "policy " : ""}${f.kind}: ${f.topic} — ${f.explanation}`), ...cat.findings.map((f) => `catalog: ${f.title} — ${f.detail}`)],
			winners: new Map(effectiveRules(st.rules, "").map((r) => [`${r.topic}`, `${r.value} (${r.layer.kind})`])),
		};
	};
	const empty = { findings: [] as string[], winners: new Map<string, string>() };
	const [pinnedRun, currentRun] = await Promise.all([analyse(pinnedFiles), changedLayers.length || catalogBehind ? analyse(currentFiles) : Promise.resolve(empty)]);
	const before = pinnedRun.findings;
	const after = currentRun.findings;
	// Rules whose winner at the repo root would change (e.g. a new org must silently replacing a project rule).
	const winnerChanges = changedLayers.length || catalogBehind ? [...new Set([...pinnedRun.winners.keys(), ...currentRun.winners.keys()])].filter((t) => pinnedRun.winners.get(t) !== currentRun.winners.get(t)).map((t) => `${t}: ${pinnedRun.winners.get(t) ?? "(none)"} → ${currentRun.winners.get(t) ?? "(none)"}`) : [];
	const introduced = changedLayers.length || catalogBehind ? after.filter((f) => !before.includes(f)) : [];
	const resolvedByUpdate = changedLayers.length || catalogBehind ? before.filter((f) => !after.includes(f)) : [];

	const hookPath = join(root, ".git/hooks/pre-push");
	const hook = existsSync(hookPath) ? (readFileSync(hookPath, "utf8").includes("fail-closed") ? "installed (fail-closed)" : "installed (not the git.next fail-closed hook)") : "missing";

	let updated = false;
	if (args.update && (changedLayers.length || catalogBehind)) {
		for (const l of changedLayers) writeFileSync(join(root, l.path), l.current!);
		writeFileSync(repoCatalogPath, baselineCatalogText);
		const next = {
			...stack,
			baseline: { ...stack.baseline, catalogVersion: baselineCatalog.version, contentHash: sha([baselineCatalogText, ...layers.map((l) => l.current ?? l.vendored ?? "")].join("\0")), updatedAt: new Date().toISOString() },
			layers: (stack.layers ?? []).map((l) => {
				const cur = layers.find((x) => x.path === l.path);
				return cur?.current ? { ...l, pinned: { from: l.pinned?.from ?? "", contentHash: sha(cur.current) } } : l;
			}),
		};
		writeFileSync(stackPath, `${JSON.stringify(next, null, "\t")}\n`);
		updated = true;
	}

	const behind = changedLayers.length > 0 || catalogBehind;
	// Exit 1 when the current baseline brings new conflicts or violations, whether or not --update applied it.
	const code = behind && introduced.length ? 1 : 0;
	const report = {
		repo,
		baseline: basename(org),
		catalog: { repo: repoCatalog?.version ?? null, baseline: baselineCatalog.version, behind: catalogBehind },
		layers: layers.map((l) => ({ name: l.name, kind: l.kind, path: l.path, status: l.missing ? "missing in baseline" : l.changed ? "changed in baseline" : "up to date" })),
		introduced,
		resolvedByUpdate,
		winnerChanges,
		hook,
		updated,
		exitCode: code,
	};
	if (args.json) {
		io.out(`${JSON.stringify(report, null, 2)}\n`);
		return code;
	}
	const lines = [
		`git next doctor: ${repo} vs ${report.baseline}`,
		`  catalog   ${report.catalog.repo ?? "none"}${catalogBehind ? ` → ${baselineCatalog.version} available (behind)` : " (current)"}`,
		...report.layers.map((l) => `  layer     ${l.kind.padEnd(8)} ${l.name.padEnd(16)} ${l.status}`),
		`  hook      ${hook}`,
	];
	if (behind) {
		lines.push("", introduced.length ? `Updating to the current baseline would introduce ${introduced.length} finding(s):` : "Updating to the current baseline introduces no new findings.");
		lines.push(...introduced.map((f) => `  ✗ ${f}`));
		if (resolvedByUpdate.length) lines.push(`…and resolve ${resolvedByUpdate.length}:`, ...resolvedByUpdate.map((f) => `  ✓ ${f}`));
		if (winnerChanges.length) lines.push("Rules that would change at the repo root:", ...winnerChanges.map((c) => `  ~ ${c}`));
		lines.push("", updated ? `Updated: layers and catalog re-vendored and pins rewritten (review and commit)${introduced.length ? "; resolve the findings above before pushing" : ""}.` : "Run `git next doctor --update` to re-vendor the layers and catalog.");
	} else lines.push("", "✓ Up to date with the baseline.");
	if (hook === "missing") lines.push("", "! No pre-push hook: copy examples/hooks/pre-push to .git/hooks/ (git next new installs it).");
	io.out(`${lines.join("\n")}\n`);
	return code;
}
