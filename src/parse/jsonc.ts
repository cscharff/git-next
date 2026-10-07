/** Parses JSON with comments and trailing commas (wrangler.jsonc, tsconfig-style files). */
export function parseJsonc(text: string): unknown {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const n = text[i + 1];
		if (inString) {
			out += c;
			if (c === "\\") out += text[++i] ?? "";
			else if (c === '"') inString = false;
		} else if (c === '"') {
			inString = true;
			out += c;
		} else if (c === "/" && n === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && n === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
		} else {
			out += c;
		}
	}
	// Trailing commas before } or ] (outside strings, which are now the only place commas could hide).
	out = out.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(out);
}
