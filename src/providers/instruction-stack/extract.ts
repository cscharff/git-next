import type { Layer, Rule, RuleExtractor, Strength, Topic } from "./types.ts";

const MUST = /\b(must|always|never|required?|do not|don't|only|mandatory|shall|needs?)\b/i;
const NEGATED = /\b(never|do not|don't|no need|not required|avoid|without|skip|omit)\b/i;

/** A formatter named as a tool; `prettier-ignore`/`biome-ignore` style directives mention one without choosing it. */
export const FORMATTER = /\b(prettier|oxfmt|biome|dprint)\b(?![-:](?:ignore|disable))/i;

type Matcher = (line: string) => string | null;

const firstOf = (re: RegExp, map: (m: RegExpMatchArray) => string = (m) => m[1].toLowerCase()): Matcher => (line) => {
	const m = line.match(re);
	return m ? map(m) : null;
};

/** Deterministic per-topic matchers. Each returns the normalized value, or null if the line is not about the topic. */
const MATCHERS: Record<Topic, Matcher> = {
	packageManager: (line) => {
		const m =
			line.match(/\b(?:use|using|uses|via|with)\s+`?(npm|pnpm|yarn|bun)\b/i) ??
			line.match(/`(npm|pnpm|yarn|bun)\s+(?:install|i|add|ci)\b/i) ??
			line.match(/\bpackage manager\b[^.]*?\b(npm|pnpm|yarn|bun)\b/i);
		return m ? m[1].toLowerCase() : null;
	},
	formatter: firstOf(FORMATTER),
	indentation: (line) => {
		if (!/\b(indent|indentation|tabs?|spaces)\b/i.test(line)) return null;
		const spaces = line.match(/\b(\d)[- ]?space/i);
		if (spaces) return `${spaces[1]} spaces`;
		if (/\btabs\b|\btab indentation\b|\bindent with tabs?\b/i.test(line)) return "tabs";
		return null;
	},
	testCommand: (line) => {
		const m = line.match(/`((?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:test|vitest|jest)[^`]*)`/i);
		return m ? m[1].trim().replace(/\s+/g, " ") : null;
	},
	commitFormat: (line) => {
		if (/\bcommit/i.test(line) && /\b(ticket|jira|sow|issue)\b[^.]*\b(id|number|key|prefix)\b/i.test(line)) return "ticket-id-prefix";
		if (/conventional commits?/i.test(line) || /\b(feat|fix|chore)(\([^)]*\))?:/.test(line)) return "conventional";
		return null;
	},
	changesetPolicy: (line) => {
		if (!/\bchangesets?\b/i.test(line)) return null;
		// "Defer to the project's changeset rules" hands the decision to the project layer: no rule of its own.
		if (/\bdefers? to\b|\bfollow (the )?project/i.test(line)) return null;
		return NEGATED.test(line) && !/\bnever (forget|skip|omit)\b/i.test(line) ? "not-required" : "required";
	},
	lintStrictness: (line) => {
		if (!/\blint/i.test(line)) return null;
		if (/max-warnings[ =]0|no (lint )?warnings|warnings? (are|as) errors?|must pass|zero warnings/i.test(line)) return "strict";
		if (/warnings? (are|is) (ok|fine|acceptable)|ignore (lint )?warnings/i.test(line)) return "lenient";
		return null;
	},
	allowedModels: (line) => {
		if (/\bapproved (model )?providers?\b/i.test(line)) {
			const providers = [...line.matchAll(/\b(workers ai|anthropic|openai|google|mistral|deepseek|meta)\b/gi)].map((m) => m[1].toLowerCase().replace(" ", "-"));
			return providers.length ? `providers:${[...new Set(providers)].sort().join(",")}` : null;
		}
		const models = line.match(/\b(claude-[a-z0-9.-]+|gpt-[a-z0-9.-]+|gemini-[a-z0-9.-]+|o\d(?:-mini)?)\b/gi);
		if (!models || !/\b(model|use|allowed|only)\b/i.test(line)) return null;
		return [...new Set(models.map((m) => m.toLowerCase()))].sort().join(",");
	},
	securityScan: (line) => (/\bsecurity (scan|review|audit)\b/i.test(line) && /\b(before|prior to)\b[^.]*\b(pr|pull request|merge|push)/i.test(line) ? "before-pr" : null),
	modelRouting: (line) => {
		if (!/\b(models?|inference|llms?)\b/i.test(line)) return null;
		if (/\bon-?prem(ises)?\b|\bself-hosted\b|\b(no|nothing|no data) (may |must |should )?leaves? the network\b|\bnever leaves? the network\b/i.test(line)) return "on-prem";
		if (/\bai gateway\b/i.test(line) && /\b(call|calls|calling|route|routed|send)\b/i.test(line)) return "org-gateway";
		return null;
	},
	secrets: (line) => {
		if (!/\b(secrets?|api keys?|credentials?|tokens?|\.env|\.dev\.vars)\b/i.test(line)) return null;
		if (/\b(never|do not|don't|must not)\b[^.]*\b(commit|check in|hard-?code|log|print|expose)/i.test(line)) return "never-in-source";
		return null;
	},
};

/** Splits markdown into sentences (keeping source line numbers), skipping fenced code blocks and headings. */
export function* instructionLines(markdown: string): Generator<{ line: number; text: string }> {
	let inFence = false;
	const lines = markdown.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (/^\s*(```|~~~)/.test(raw)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || /^\s*#/.test(raw)) continue;
		const text = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
		// Split so a "required" in one sentence does not make the next sentence a hard rule.
		for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z`*])/)) if (sentence) yield { line: i + 1, text: sentence };
	}
}

// Words that name top-level areas of a repo, mapped to the directory they usually live in.
const AREA_WORDS: Record<string, string> = {
	examples: "examples",
	example: "examples",
	guides: "guides",
	sites: "site",
	site: "site",
	docs: "docs",
	packages: "packages",
	design: "design",
	experimental: "experimental",
};

/** Areas named as the subject of an instruction, e.g. "Examples, guides, and sites don't need changesets". */
export function areasOf(text: string): string[] | undefined {
	const found = new Set<string>();
	for (const m of text.matchAll(/`?\b(examples?|guides|sites?|docs|packages|design|experimental)\b\/?`?/gi)) found.add(AREA_WORDS[m[1].toLowerCase()]);
	return found.size ? [...found].sort() : undefined;
}

export const strengthOf = (text: string): Strength => (MUST.test(text) ? "must" : "should");

export const keywordExtractor: RuleExtractor = {
	id: "keyword-v1",
	async extract(layer: Layer, markdown: string): Promise<Rule[]> {
		const rules: Rule[] = [];
		for (const { line, text } of instructionLines(markdown)) {
			for (const topic of Object.keys(MATCHERS) as Topic[]) {
				const value = MATCHERS[topic](text);
				if (!value) continue;
				const areas = areasOf(text);
				rules.push({ topic, value, strength: strengthOf(text), layer, line, text: text.slice(0, 240), ...(areas ? { areas } : {}) });
			}
		}
		return rules;
	},
};
