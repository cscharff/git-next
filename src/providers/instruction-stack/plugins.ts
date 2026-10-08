import type { RepoContext } from "../../core/repo-context.ts";
import { parseJsonc } from "../../parse/jsonc.ts";
import { parseYamlSubset } from "../../parse/yaml.ts";
import type { Layer, Rule, RuleExtractor } from "./types.ts";

// Claude Code plugins and skills as instruction layers. A plugin (a directory with .claude-plugin/plugin.json) ships
// skills (skills/<name>/SKILL.md), subagents (agents/<name>.md), slash commands (commands/**.md), hooks and MCP
// servers; repos can also keep their own under .claude/ (and skills under .agents/). Skills, subagents and commands
// are instructions an agent reads when they load, so they join the stack as tool-rank layers marked on-demand: their
// rules are checked for conflicts and policy, but don't change what wins in a directory by default. Hooks and MCP
// servers aren't instructions; they're inventoried and checked (risky hook commands, unlisted MCP servers).
// Everything is read as data; nothing from a plugin is executed.

export const isPluginManifest = (path: string) => /(^|\/)\.claude-plugin\/plugin\.json$/.test(path);
export const isMarketplace = (path: string) => /(^|\/)\.claude-plugin\/marketplace\.json$/.test(path);

export type ComponentKind = "skill" | "subagent" | "command";

export interface PluginComponent {
	kind: ComponentKind;
	/** Skill directory name, or the agent/command file name without .md (commands keep their namespace: "git/commit"). */
	name: string;
	path: string;
	/** Root of the plugin that ships it ("" = the repo itself), or null for a repo's own .claude/.agents component. */
	pluginRoot: string | null;
	/** Directory it governs: the plugin's or the .claude/.agents directory's parent. */
	scopeDir: string;
}

export interface HookCommand {
	event: string;
	matcher?: string;
	command: string;
	/** Why the command deserves a look (network fetch, piping to a shell, deleting, sudo, eval), if anything. */
	risk?: string;
}

export interface McpServer {
	name: string;
	command?: string;
	url?: string;
}

export interface PluginInfo {
	name: string;
	root: string;
	manifest: string;
	version: string | null;
	description: string | null;
	/** The version the repo's marketplace lists for it, when it has one. */
	marketplaceVersion: string | null;
	skills: string[];
	subagents: string[];
	commands: string[];
	hooks: HookCommand[];
	/** Code modules the plugin registers to run inside the app (hooks.json "modules"), relative to the plugin. */
	modules: string[];
	mcpServers: McpServer[];
}

export interface PluginFinding {
	title: string;
	detail: string;
	severity: "info" | "warn";
	evidence: { path: string; line?: number }[];
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (dir: string, rest: string) => (dir ? `${dir}/${rest}` : rest);
const rel = (root: string, p: string) => join(root, p.replace(/^\.\//, "").replace(/\/$/, ""));
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/**
 * Finds plugin components and repo-level ones. `manifests` maps a plugin root to its parsed plugin.json, whose
 * optional "skills"/"agents"/"commands" paths add to the default directories.
 */
export function findComponents(paths: string[], manifests: Map<string, Record<string, unknown>>): PluginComponent[] {
	const out: PluginComponent[] = [];
	const seen = new Set<string>();
	const add = (c: PluginComponent) => {
		if (seen.has(c.path)) return;
		seen.add(c.path);
		out.push(c);
	};
	const under = (dir: string) => paths.filter((p) => p.startsWith(`${dir}/`));
	for (const [root, manifest] of manifests) {
		for (const dir of ["skills", ...asList(manifest.skills)].map((d) => rel(root, d)))
			for (const p of under(dir)) {
				const m = p.slice(dir.length + 1).match(/^([^/]+)\/SKILL\.md$/);
				if (m) add({ kind: "skill", name: m[1], path: p, pluginRoot: root, scopeDir: root });
			}
		for (const dir of ["agents", ...asList(manifest.agents)].map((d) => rel(root, d)))
			for (const p of under(dir)) {
				const m = p.slice(dir.length + 1).match(/^([^/]+)\.md$/);
				if (m) add({ kind: "subagent", name: m[1], path: p, pluginRoot: root, scopeDir: root });
			}
		for (const dir of ["commands", ...asList(manifest.commands)].map((d) => rel(root, d)))
			for (const p of under(dir)) {
				const m = p.slice(dir.length + 1).match(/^(.+)\.md$/);
				if (m) add({ kind: "command", name: m[1], path: p, pluginRoot: root, scopeDir: root });
			}
	}
	// A repo's own: <dir>/.claude/{skills/<n>/SKILL.md, agents/<n>.md, commands/**.md} and <dir>/.agents/skills/<n>/SKILL.md.
	for (const p of paths) {
		const m = p.match(/^(?:(.*)\/)?\.(claude|agents)\/(skills\/([^/]+)\/SKILL\.md|agents\/([^/]+)\.md|commands\/(.+)\.md)$/);
		if (!m) continue;
		const [, dir = "", tool, , skill, agent, command] = m;
		if (skill) add({ kind: "skill", name: skill, path: p, pluginRoot: null, scopeDir: dir });
		else if (tool === "claude" && agent) add({ kind: "subagent", name: agent, path: p, pluginRoot: null, scopeDir: dir });
		else if (tool === "claude" && command) add({ kind: "command", name: command, path: p, pluginRoot: null, scopeDir: dir });
	}
	return out;
}

/** YAML frontmatter (between leading --- lines) and the body with the frontmatter blanked, so line numbers hold. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { data: {}, body: text };
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (end < 0) return { data: {}, body: text };
	return { data: parseYamlSubset(lines.slice(1, end).join("\n")), body: [...lines.slice(0, end + 1).map(() => ""), ...lines.slice(end + 1)].join("\n") };
}

/** Claude Code model aliases (frontmatter `model: sonnet`) resolve to Anthropic models; `inherit` means no choice. */
const MODEL_ALIAS = /^(sonnet|opus|haiku|fable)(\[1m\])?$/;
export const normalizeModel = (m: string) => {
	const t = m.trim().toLowerCase().replace(/^anthropic\/(?=claude)/, "");
	return MODEL_ALIAS.test(t) ? `claude-${t.replace(/\[1m\]$/, "")}` : t;
};

/**
 * Rules from a skill, subagent or command: its frontmatter model as an allowedModels rule (checked against the org's
 * provider policy like agent.yaml models), and its body through the normal extractor with real line numbers.
 */
export async function componentRules(layer: Layer, text: string, extractor: RuleExtractor): Promise<Rule[]> {
	const { data, body } = splitFrontmatter(text);
	const rules: Rule[] = [];
	const model = typeof data.model === "string" ? data.model : null;
	if (model && model !== "inherit" && /^[@a-z0-9./\[\]-]+$/i.test(model)) {
		const lines = text.split(/\r?\n/);
		const line = Math.max(1, lines.findIndex((l) => /^model\s*:/.test(l)) + 1);
		rules.push({ topic: "allowedModels", value: normalizeModel(model), strength: "must", layer, line, text: lines[line - 1].trim().slice(0, 240) });
	}
	if (body.trim()) rules.push(...(await extractor.extract(layer, body)));
	return rules;
}

/** What a component says about when it loads: a skill's or subagent's description, a command's name. */
export function triggerOf(c: PluginComponent, text: string): string {
	const { data } = splitFrontmatter(text);
	const description = typeof data.description === "string" ? data.description.trim() : "";
	if (c.kind === "command") return `/${c.name.replace(/\//g, ":")}${description ? `: ${description}` : ""}`.slice(0, 300);
	return description.slice(0, 300);
}

const RISKY: [RegExp, string][] = [
	[/\b(curl|wget|nc|ncat|ssh|scp)\b/, "network access"],
	[/\|\s*(ba|z)?sh\b|\beval\b/, "runs fetched or generated code"],
	[/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, "recursive delete"],
	[/\bsudo\b/, "sudo"],
];
export const hookRisk = (command: string) => RISKY.filter(([re]) => re.test(command)).map(([, why]) => why).join(", ") || undefined;

/** Hook commands from a hooks.json-shaped object: { hooks: { Event: [{ matcher, hooks: [{ type: "command", command }] }] } }. */
export function parseHooks(doc: unknown): HookCommand[] {
	const hooks = (doc as { hooks?: Record<string, unknown> })?.hooks;
	if (!hooks || typeof hooks !== "object") return [];
	const out: HookCommand[] = [];
	for (const [event, groups] of Object.entries(hooks))
		for (const g of Array.isArray(groups) ? groups : []) {
			const matcher = typeof g?.matcher === "string" && g.matcher ? g.matcher : undefined;
			for (const h of Array.isArray(g?.hooks) ? g.hooks : [])
				if (h?.type === "command" && typeof h.command === "string") out.push({ event, ...(matcher ? { matcher } : {}), command: h.command.slice(0, 500), ...(hookRisk(h.command) ? { risk: hookRisk(h.command) } : {}) });
		}
	return out;
}

/** MCP servers from an .mcp.json-shaped object ({ mcpServers: { name: { command | url } } }) or a bare server map. */
export function parseMcpServers(doc: unknown): McpServer[] {
	const d = doc as Record<string, unknown> | null;
	const map = (d && typeof d.mcpServers === "object" ? d.mcpServers : d) as Record<string, { command?: unknown; args?: unknown; url?: unknown }> | null;
	if (!map || typeof map !== "object") return [];
	return Object.entries(map)
		.filter(([, v]) => v && typeof v === "object" && (typeof v.command === "string" || typeof v.url === "string"))
		.map(([name, v]) => ({ name, ...(typeof v.command === "string" ? { command: [v.command, ...asList(v.args)].join(" ").slice(0, 300) } : {}), ...(typeof v.url === "string" ? { url: v.url } : {}) }));
}

const lineOf = (text: string, needle: string) => Math.max(1, text.split(/\r?\n/).findIndex((l) => l.includes(needle)) + 1);

/** Parsed plugin.json per plugin root ("" = the repo itself is a plugin), plus manifests that aren't valid JSON. */
export async function readManifests(files: RepoContext, repo: string, ref: string) {
	const paths = (await files.readTree(repo, ref)).map((f) => f.path);
	const manifests = new Map<string, Record<string, unknown>>();
	const texts = new Map<string, string>();
	const unreadable: string[] = [];
	for (const path of paths.filter(isPluginManifest)) {
		const text = await files.readFile(repo, ref, path).catch(() => null);
		let doc: unknown = null;
		try {
			doc = text == null ? null : parseJsonc(text);
		} catch {}
		if (!doc || typeof doc !== "object") {
			unreadable.push(path);
			continue;
		}
		manifests.set(dirOf(dirOf(path)), doc as Record<string, unknown>);
		texts.set(dirOf(dirOf(path)), text!);
	}
	return { paths, manifests, texts, unreadable };
}

export interface PluginScan {
	plugins: PluginInfo[];
	components: PluginComponent[];
	marketplace: { path: string; name: string | null; plugins: number } | null;
	findings: PluginFinding[];
}

/** Reads the repo's plugins, marketplace and components (no layer building; see collectLayers). */
export async function scanPlugins(files: RepoContext, repo: string, ref: string): Promise<PluginScan> {
	const { paths, manifests, texts: manifestText, unreadable } = await readManifests(files, repo, ref);
	const read = async (path: string) => (await files.readFile(repo, ref, path).catch(() => null)) ?? null;
	const json = (text: string | null) => {
		if (text == null) return null;
		try {
			return parseJsonc(text) as Record<string, unknown>;
		} catch {
			return null;
		}
	};
	const findings: PluginFinding[] = unreadable.map((path) => ({ severity: "warn" as const, title: `Unreadable plugin manifest: ${path}`, detail: `${path} isn't valid JSON, so Claude Code can't load this plugin.`, evidence: [{ path }] }));
	const components = findComponents(paths, manifests);

	// Marketplace: every listed local plugin should exist, and its listed version should match plugin.json.
	let marketplace: PluginScan["marketplace"] = null;
	const listed = new Map<string, { version: string | null; path: string; line: number }>();
	const marketPath = paths.find((p) => isMarketplace(p) && !dirOf(dirOf(p)));
	if (marketPath) {
		const text = await read(marketPath);
		const doc = json(text);
		const entries = Array.isArray(doc?.plugins) ? (doc!.plugins as Record<string, unknown>[]) : [];
		marketplace = { path: marketPath, name: typeof doc?.name === "string" ? doc.name : null, plugins: entries.length };
		for (const e of entries) {
			const name = typeof e?.name === "string" ? e.name : null;
			if (!name) continue;
			const source = typeof e.source === "string" ? e.source : null;
			const line = lineOf(text ?? "", `"${name}"`);
			if (source && /^\.{0,2}\//.test(source)) {
				const root = rel("", source);
				if (!manifests.has(root)) findings.push({ severity: "warn", title: `Marketplace lists a missing plugin: ${name}`, detail: `${marketPath} points ${name} at ${source}, but there's no ${join(root, ".claude-plugin/plugin.json")}.`, evidence: [{ path: marketPath, line }] });
				else listed.set(root, { version: typeof e.version === "string" ? e.version : null, path: marketPath, line });
			}
		}
	}

	const plugins: PluginInfo[] = [];
	for (const [root, m] of manifests) {
		const manifest = join(root, ".claude-plugin/plugin.json");
		const name = typeof m.name === "string" ? m.name : root.split("/").pop() || "plugin";
		const version = typeof m.version === "string" ? m.version : null;
		const hooksPath = typeof m.hooks === "string" ? rel(root, m.hooks) : join(root, "hooks/hooks.json");
		const hooksDoc = typeof m.hooks === "object" && m.hooks ? m.hooks : json(await read(hooksPath));
		const hooks = parseHooks(hooksDoc);
		const modules = asList((hooksDoc as { modules?: unknown } | null)?.modules).map((x) => x.slice(0, 200));
		const mcpServers = typeof m.mcpServers === "object" && m.mcpServers ? parseMcpServers(m.mcpServers) : parseMcpServers(json(await read(typeof m.mcpServers === "string" ? rel(root, m.mcpServers) : join(root, ".mcp.json"))));
		const mine = components.filter((c) => c.pluginRoot === root);
		const market = listed.get(root);
		plugins.push({ name, root, manifest, version, description: typeof m.description === "string" ? m.description : null, marketplaceVersion: market?.version ?? null, skills: mine.filter((c) => c.kind === "skill").map((c) => c.name), subagents: mine.filter((c) => c.kind === "subagent").map((c) => c.name), commands: mine.filter((c) => c.kind === "command").map((c) => c.name), hooks, modules, mcpServers });
		if (market?.version && version && market.version !== version)
			findings.push({ severity: "warn", title: `Plugin version drift: ${name}`, detail: `${market.path} lists ${name} ${market.version}, but ${manifest} says ${version}. Users installing from the marketplace see one, Claude Code loads the other.`, evidence: [{ path: market.path, line: market.line }, { path: manifest, line: lineOf(manifestText.get(root)!, `"version"`) }] });
		for (const h of hooks.filter((x) => x.risk)) findings.push({ severity: "warn", title: `Plugin hook needs review: ${name} (${h.event})`, detail: `${name} runs \`${h.command.slice(0, 160)}\` on ${h.event}${h.matcher ? ` (matcher ${h.matcher})` : ""} automatically, without asking: ${h.risk}.`, evidence: [{ path: typeof m.hooks === "object" ? manifest : hooksPath }] });
	}
	// Skills and subagents are picked by their description; without one an agent can't tell when to load them.
	for (const c of components.filter((x) => x.kind !== "command")) {
		const text = (await read(c.path)) ?? "";
		if (!triggerOf(c, text)) findings.push({ severity: "warn", title: `${c.kind === "skill" ? "Skill" : "Subagent"} without a description: ${c.name}`, detail: `${c.path} has no description in its frontmatter, so an agent can't tell when to use it.`, evidence: [{ path: c.path, line: 1 }] });
	}
	return { plugins, components, marketplace, findings };
}
