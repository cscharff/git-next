/**
 * A tiny YAML subset for agent definition files (agent.yaml): `key: value`, inline lists `key: [a, b]`, block lists
 * (`- item`) and one level of nested maps. Anything else is ignored rather than guessed at; values are data only.
 */
export function parseYamlSubset(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let open: string | null = null; // top-level key whose value is an indented block

	const scalar = (v: string): unknown => {
		const t = v.trim().replace(/\s+#.*$/, "");
		if (/^\[.*\]$/.test(t))
			return t
				.slice(1, -1)
				.split(",")
				.map((x) => scalar(x))
				.filter((x) => x !== "");
		if (/^(['"]).*\1$/.test(t)) return t.slice(1, -1);
		if (t === "true" || t === "false") return t === "true";
		return t;
	};

	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim() || raw.trim().startsWith("#")) continue;
		const indented = /^\s/.test(raw);
		const line = raw.trim();
		if (indented && open) {
			const current = out[open];
			if (line.startsWith("- ")) {
				if (Array.isArray(current)) current.push(scalar(line.slice(2)));
				else if (current === undefined) out[open] = [scalar(line.slice(2))];
				continue;
			}
			const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
			if (m) {
				const map = (current && !Array.isArray(current) && typeof current === "object" ? current : {}) as Record<string, unknown>;
				map[m[1]] = scalar(m[2]);
				out[open] = map;
			}
			continue;
		}
		const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
		if (!m) continue;
		open = null;
		if (m[2] === "") open = m[1];
		else out[m[1]] = scalar(m[2]);
	}
	return out;
}
