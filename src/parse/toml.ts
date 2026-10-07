/**
 * Minimal TOML reader covering what wrangler.toml uses: tables, arrays of tables,
 * dotted keys, strings, numbers, booleans, arrays and inline tables.
 * Not a full TOML implementation (no dates, no multi-line strings).
 */
export function parseToml(text: string): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	let current = root;
	for (const raw of logicalLines(text)) {
		const line = raw.trim();
		if (!line) continue;
		let m: RegExpMatchArray | null;
		if ((m = line.match(/^\[\[\s*([^\]]+?)\s*\]\]$/))) {
			const keys = splitKey(m[1]);
			const parent = descend(root, keys.slice(0, -1));
			const last = keys[keys.length - 1];
			const arr = (parent[last] ??= []) as Record<string, unknown>[];
			current = {};
			arr.push(current);
		} else if ((m = line.match(/^\[\s*([^\]]+?)\s*\]$/))) {
			current = descend(root, splitKey(m[1]));
		} else {
			const eq = findTopLevel(line, "=");
			if (eq < 0) throw new Error(`TOML: cannot parse line: ${line}`);
			const keys = splitKey(line.slice(0, eq));
			const target = descend(current, keys.slice(0, -1));
			target[keys[keys.length - 1]] = parseValue(line.slice(eq + 1).trim());
		}
	}
	return root;
}

/** Joins lines while inside [ ] or { } so multi-line arrays parse; strips comments. */
function* logicalLines(text: string): Generator<string> {
	let buf = "";
	let depth = 0;
	for (const line of text.split(/\r?\n/)) {
		const stripped = stripComment(line);
		buf += (buf ? " " : "") + stripped;
		const isHeader = depth === 0 && /^\s*\[/.test(stripped) && !stripped.includes("=");
		if (!isHeader) depth += countBrackets(stripped);
		if (depth <= 0) {
			yield buf;
			buf = "";
			depth = 0;
		}
	}
	if (buf) yield buf;
}

function stripComment(line: string): string {
	let q: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) {
			if (c === "\\" && q === '"') i++;
			else if (c === q) q = null;
		} else if (c === '"' || c === "'") q = c;
		else if (c === "#") return line.slice(0, i);
	}
	return line;
}

function countBrackets(s: string): number {
	let d = 0;
	let q: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			if (c === "\\" && q === '"') i++;
			else if (c === q) q = null;
		} else if (c === '"' || c === "'") q = c;
		else if (c === "[" || c === "{") d++;
		else if (c === "]" || c === "}") d--;
	}
	return d;
}

function findTopLevel(s: string, ch: string): number {
	let q: string | null = null;
	let d = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			if (c === "\\" && q === '"') i++;
			else if (c === q) q = null;
		} else if (c === '"' || c === "'") q = c;
		else if (c === "[" || c === "{") d++;
		else if (c === "]" || c === "}") d--;
		else if (c === ch && d === 0) return i;
	}
	return -1;
}

function splitKey(k: string): string[] {
	const parts: string[] = [];
	let rest = k.trim();
	while (rest) {
		let m = rest.match(/^"((?:[^"\\]|\\.)*)"\s*(?:\.\s*|$)/) ?? rest.match(/^'([^']*)'\s*(?:\.\s*|$)/);
		if (!m) m = rest.match(/^([A-Za-z0-9_-]+)\s*(?:\.\s*|$)/);
		if (!m) throw new Error(`TOML: bad key: ${k}`);
		parts.push(m[1]);
		rest = rest.slice(m[0].length);
	}
	return parts;
}

function descend(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	let o = obj;
	for (const k of keys) {
		let v = o[k];
		if (Array.isArray(v)) v = v[v.length - 1];
		if (v === undefined) o[k] = v = {};
		o = v as Record<string, unknown>;
	}
	return o;
}

function splitTopLevel(s: string, sep: string): string[] {
	const parts: string[] = [];
	let rest = s;
	let i: number;
	while ((i = findTopLevel(rest, sep)) >= 0) {
		parts.push(rest.slice(0, i));
		rest = rest.slice(i + 1);
	}
	parts.push(rest);
	return parts.map((p) => p.trim()).filter(Boolean);
}

function parseValue(v: string): unknown {
	if (v.startsWith('"')) return JSON.parse(v);
	if (v.startsWith("'")) return v.slice(1, -1);
	if (v === "true") return true;
	if (v === "false") return false;
	if (v.startsWith("[")) return splitTopLevel(v.slice(1, -1), ",").map(parseValue);
	if (v.startsWith("{")) {
		const o: Record<string, unknown> = {};
		for (const pair of splitTopLevel(v.slice(1, -1), ",")) {
			const eq = findTopLevel(pair, "=");
			const keys = splitKey(pair.slice(0, eq));
			descend(o, keys.slice(0, -1))[keys[keys.length - 1]] = parseValue(pair.slice(eq + 1).trim());
		}
		return o;
	}
	const n = Number(v.replace(/_/g, ""));
	if (!Number.isNaN(n)) return n;
	throw new Error(`TOML: unsupported value: ${v}`);
}
