export interface Section {
	/** `path#slug`, unique within a repo/ref. */
	id: string;
	path: string;
	/** Heading trail from the top of the file, e.g. ["Testing", "Unit tests"]. */
	headings: string[];
	title: string;
	text: string;
	startLine: number;
	tokens: number;
}

/** Rough token estimate (≈4 characters per token), good enough for budgeting and comparisons. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "section";

/** Splits markdown into one section per ATX heading (headings inside code fences don't count). */
export function splitSections(path: string, markdown: string): Section[] {
	const lines = markdown.split(/\r?\n/);
	const sections: Section[] = [];
	const trail: { level: number; title: string }[] = [];
	const used = new Map<string, number>();
	let current: { headings: string[]; title: string; start: number; body: string[] } = { headings: [], title: path.split("/").pop()!, start: 1, body: [] };
	let inFence = false;

	const flush = () => {
		const text = current.body.join("\n").trim();
		// A heading with nothing under it carries no content worth serving.
		if (!text || (current.headings.length && current.body.slice(1).join("").trim() === "")) return;
		const base = slug(current.headings.join(" ") || "intro");
		const n = used.get(base) ?? 0;
		used.set(base, n + 1);
		sections.push({ id: `${path}#${n ? `${base}-${n}` : base}`, path, headings: current.headings, title: current.title, text, startLine: current.start, tokens: estimateTokens(text) });
	};

	lines.forEach((line, i) => {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const m = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (m) {
			flush();
			const level = m[1].length;
			while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
			trail.push({ level, title: m[2] });
			current = { headings: trail.map((t) => t.title), title: m[2], start: i + 1, body: [line] };
		} else {
			current.body.push(line);
		}
	});
	flush();
	return sections;
}
