import { parseJsonc } from "../../parse/jsonc.ts";
import type { Topic } from "./types.ts";

/** A fact read from a config file, compared against instructions to detect drift. */
export interface ConfigFact {
	topic: Topic;
	value: string;
	path: string;
	/** Directory the fact applies to ("" = repo root). */
	dir: string;
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const safeJson = (text: string): Record<string, any> | null => {
	try {
		return parseJsonc(text) as Record<string, any>;
	} catch {
		return null;
	}
};

const LOCKFILES: Record<string, string> = {
	"pnpm-lock.yaml": "pnpm",
	"package-lock.json": "npm",
	"yarn.lock": "yarn",
	"bun.lock": "bun",
	"bun.lockb": "bun",
};
const FORMATTER_FILES: [RegExp, string][] = [
	[/(^|\/)\.oxfmtrc(\.jsonc?)?$/, "oxfmt"],
	[/(^|\/)\.prettierrc(\.(json|jsonc|ya?ml|js|cjs|mjs|toml))?$/, "prettier"],
	[/(^|\/)prettier\.config\.(js|cjs|mjs|ts)$/, "prettier"],
	[/(^|\/)biome\.jsonc?$/, "biome"],
	[/(^|\/)\.?dprint\.jsonc?$/, "dprint"],
];

export const isConfigFactFile = (path: string) =>
	/(^|\/)package\.json$/.test(path) || /(^|\/)\.editorconfig$/.test(path) || basename(path) in LOCKFILES || FORMATTER_FILES.some(([re]) => re.test(path));
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Derives facts (package manager, formatter, indentation, test script) from config file contents. */
export function configFacts(path: string, text: string): ConfigFact[] {
	const dir = dirOf(path);
	const facts: ConfigFact[] = [];
	const add = (topic: Topic, value: string | undefined | null) => value && facts.push({ topic, value, path, dir });
	const name = basename(path);

	if (name in LOCKFILES) add("packageManager", LOCKFILES[name]);
	if (name === "package.json") {
		const pkg = safeJson(text);
		if (pkg) {
			add("packageManager", typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null);
			if (pkg.prettier) add("formatter", "prettier");
		}
	}
	for (const [re, formatter] of FORMATTER_FILES) {
		if (!re.test(path)) continue;
		add("formatter", formatter);
		const cfg = /\.(json|jsonc)$|rc$/.test(path) ? safeJson(text) : null;
		if (cfg) {
			const tabs = cfg.useTabs ?? (cfg.formatter?.indentStyle ? cfg.formatter.indentStyle === "tab" : cfg.indentStyle ? cfg.indentStyle === "tab" : undefined);
			const width = cfg.tabWidth ?? cfg.indentWidth ?? cfg.formatter?.indentWidth;
			if (tabs === true) add("indentation", "tabs");
			else if (tabs === false) add("indentation", `${width ?? 2} spaces`);
		}
	}
	if (name === ".editorconfig") {
		// Only the [*] section, which sets the repo-wide default.
		const star = text.split(/^\s*\[/m).find((s) => s.startsWith("*]"));
		const style = star?.match(/indent_style\s*=\s*(\w+)/)?.[1];
		const size = star?.match(/indent_size\s*=\s*(\d+)/)?.[1];
		if (style === "tab") add("indentation", "tabs");
		else if (style === "space") add("indentation", `${size ?? 2} spaces`);
	}
	return facts;
}
