import type { RepoContext } from "../../core/repo-context.ts";

// Instruction files that are meant to be copies (a skill vendored into every template, the same AGENTS.md in each
// demo) drift when the source changes and the copies don't. Files are grouped by their tail path; when most of a
// group agrees, the files that disagree with the source (or with the majority) are reported with the first line
// that differs.

export interface CopyDrift {
	/** Tail path shared by the group, e.g. "skills/creating-plugins/SKILL.md". */
	tail: string;
	/** The file the stale copies are compared with. */
	source: string;
	/** "source": the shallowest file changed and its copies did not; "majority": a few copies differ from the rest. */
	basis: "source" | "majority";
	stale: string[];
	total: number;
	/** First line the source has that the stale copies lack, and vice versa. */
	onlyInSource?: { line: number; text: string };
	onlyInCopy?: { path: string; line: number; text: string };
}

/** A git symlink arrives as a blob holding its target, e.g. `../AGENTS.md`. */
export const symlinkTarget = (text: string) => text.trim().match(/^(?!\/)[^\s]*\.md$/i)?.[0] ?? null;

const isCandidate = (path: string) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path) || /(^|\/)skills\/[^/]+\/.+\.md$/i.test(path);
/** `.../skills/<name>/<rest>` from the last skills/ segment; otherwise the file name. */
export const tailOf = (path: string) => path.match(/(?:^|\/)(skills\/[^/]+\/.+)$/i)?.[1] ?? path.split("/").pop()!;
const norm = (text: string) => text.replace(/\r\n/g, "\n").trimEnd();
const depth = (path: string) => path.split("/").length;

/** Share of b's distinct lines that a also has; a cheap check that two files are versions of one another. */
function overlap(a: string, b: string): number {
	const la = new Set(a.split("\n").filter((l) => l.trim()));
	const lb = [...new Set(b.split("\n").filter((l) => l.trim()))];
	return lb.length ? lb.filter((l) => la.has(l)).length / lb.length : 0;
}

function firstOnlyIn(a: string, b: string): { line: number; text: string } | undefined {
	const other = new Set(b.split("\n"));
	const lines = a.split("\n");
	const i = lines.findIndex((l) => l.trim() && !other.has(l));
	return i < 0 ? undefined : { line: i + 1, text: lines[i].trim().slice(0, 200) };
}

export async function findCopyDrift(files: RepoContext, repo: string, ref: string): Promise<CopyDrift[]> {
	const candidates = await files.find(repo, ref, isCandidate);
	const groups = Map.groupBy(candidates, (f) => tailOf(f.path));
	const out: CopyDrift[] = [];
	for (const [tail, members] of groups) {
		if (members.length < 3) continue;
		const texts = new Map<string, string>();
		for (const f of members) {
			const text = await files.readFile(repo, ref, f.path);
			if (text != null && !symlinkTarget(text)) texts.set(f.path, norm(text));
		}
		const variants = Map.groupBy(texts.keys(), (p) => texts.get(p)!);
		if (variants.size < 2) continue;
		const [majorityText, majority] = [...variants].sort((a, b) => b[1].length - a[1].length)[0];
		if (majority.length < 2 || majority.length * 2 < texts.size) continue;
		// The source is the one shallowest file (skills/x/SKILL.md, not templates/t/.agents/skills/x/SKILL.md).
		const paths = [...texts.keys()];
		const minDepth = Math.min(...paths.map(depth));
		const shallowest = paths.filter((p) => depth(p) === minDepth);
		const source = shallowest.length === 1 ? shallowest[0] : undefined;
		const basis = source && texts.get(source) !== majorityText ? "source" : "majority";
		const ref0 = basis === "source" ? source! : source && majority.includes(source) ? source : majority[0];
		const refText = texts.get(ref0)!;
		const stale = paths.filter((p) => texts.get(p) !== refText && overlap(refText, texts.get(p)!) >= 0.5);
		if (!stale.length) continue;
		const copyText = texts.get(stale[0])!;
		const onlyInCopy = firstOnlyIn(copyText, refText);
		out.push({
			tail,
			source: ref0,
			basis,
			stale,
			total: texts.size,
			onlyInSource: firstOnlyIn(refText, copyText),
			...(onlyInCopy ? { onlyInCopy: { path: stale[0], ...onlyInCopy } } : {}),
		});
	}
	return out;
}

export interface CopyDriftGroup {
	/** What was copied: a skill directory ("skills/creating-plugins") or a single file tail ("AGENTS.md"). */
	unit: string;
	basis: CopyDrift["basis"];
	/** Where the source of the unit lives, e.g. "skills/creating-plugins". */
	source: string;
	/** Where the stale copies live, e.g. "templates/blog/.agents/skills/creating-plugins". */
	staleCopies: string[];
	/** Per-file drift, the SKILL.md (or first file) leading. */
	files: CopyDrift[];
}

const unitOf = (tail: string) => tail.match(/^skills\/[^/]+/i)?.[0] ?? tail;
/** `templates/x/.agents/skills/a/SKILL.md` with tail `skills/a/SKILL.md` and unit `skills/a` → `templates/x/.agents/skills/a`. */
const unitPath = (path: string, tail: string, unit: string) => path.slice(0, path.length - tail.length) + unit;

/** One group per copied skill (all its drifted files together) or per copied file. */
export function groupDrift(drifts: CopyDrift[]): CopyDriftGroup[] {
	return [...Map.groupBy(drifts, (d) => `${unitOf(d.tail)}|${d.basis}|${unitPath(d.source, d.tail, unitOf(d.tail))}`).values()].map((ds) => {
		const files = [...ds].sort((a, b) => Number(/SKILL\.md$/i.test(b.tail)) - Number(/SKILL\.md$/i.test(a.tail)) || a.tail.localeCompare(b.tail));
		const unit = unitOf(files[0].tail);
		return {
			unit,
			basis: files[0].basis,
			source: unitPath(files[0].source, files[0].tail, unit),
			staleCopies: [...new Set(files.flatMap((d) => d.stale.map((p) => unitPath(p, d.tail, unit))))].sort(),
			files,
		};
	});
}

/** Collapses whitespace, starts near where two versions of a line diverge, and caps the length. */
function clip(text: string, other = ""): string {
	const t = text.replace(/\s+/g, " ");
	const o = other.replace(/\s+/g, " ");
	let p = 0;
	while (p < t.length && t[p] === o[p]) p++;
	const from = p > 60 ? `…${t.slice(p - 30)}` : t;
	return from.length > 120 ? `${from.slice(0, 117)}…` : from;
}
const listOf = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more` : xs.join(", "));

export function describeDrift(g: CopyDriftGroup): string {
	const [lead] = g.files;
	const n = g.staleCopies.length;
	const what = g.files.length > 1 ? ` ${g.files.length} files differ (${listOf(g.files.map((d) => d.tail.slice(g.unit.length + 1) || d.tail))}).` : "";
	const head =
		g.basis === "source"
			? `${g.source} changed but ${n === lead.total - 1 ? `none of its ${n} copies` : `${n} of its ${lead.total - 1} copies`} did: ${listOf(g.staleCopies)}.${what}`
			: `${n} of ${lead.total} copies of ${g.unit} differ from the rest: ${listOf(g.staleCopies)}.${what}`;
	const diff = [
		lead.onlyInSource && `${lead.source}:${lead.onlyInSource.line} has "${clip(lead.onlyInSource.text, lead.onlyInCopy?.text)}", which the stale cop${n === 1 ? "y lacks" : "ies lack"}`,
		lead.onlyInCopy && `${lead.onlyInCopy.path}:${lead.onlyInCopy.line} has "${clip(lead.onlyInCopy.text, lead.onlyInSource?.text)}" instead`,
	].filter(Boolean);
	return `${head}${diff.length ? ` First difference: ${diff.join("; ")}.` : ""} Re-sync the copies from ${g.source}.`;
}
