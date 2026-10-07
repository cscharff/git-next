import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/parse/jsonc.ts";
import { parseToml } from "../src/parse/toml.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseJsonc", () => {
	it("strips line and block comments and trailing commas", () => {
		expect(parseJsonc('{ "a": 1, // c\n /* b */ "b": [1, 2,], }')).toEqual({ a: 1, b: [1, 2] });
	});

	it("keeps comment-like text inside strings", () => {
		expect(parseJsonc('{ "u": "https://x//y", "s": "/* no */", "q": "a\\"//b" }')).toEqual({ u: "https://x//y", s: "/* no */", q: 'a"//b' });
	});

	it("parses the wrangler.jsonc fixture", () => {
		const cfg = parseJsonc(fixture("wrangler.jsonc")) as any;
		expect(cfg.name).toBe("jsonc-worker");
		expect(cfg.durable_objects.bindings[0].class_name).toBe("Chat");
		expect(cfg.vars.URL).toBe("https://example.com/a//b");
	});

	it("throws on invalid input", () => {
		expect(() => parseJsonc("{ a: 1 }")).toThrow();
	});
});

describe("parseToml", () => {
	it("parses tables, arrays of tables, dotted headers and inline values", () => {
		const cfg = parseToml(fixture("wrangler.toml")) as any;
		expect(cfg.name).toBe("toml-worker");
		expect(cfg.compatibility_flags).toEqual(["nodejs_compat"]);
		expect(cfg.ai).toEqual({ binding: "AI" });
		expect(cfg.durable_objects.bindings).toEqual([
			{ name: "ROOMS", class_name: "Room" },
			{ name: "REMOTE", class_name: "Counter", script_name: "other-worker" },
		]);
		expect(cfg.kv_namespaces).toEqual([{ binding: "CACHE", id: "kv-123" }]);
		expect(cfg.queues.producers).toEqual([{ binding: "JOBS", queue: "jobs" }]);
		expect(cfg.queues.consumers[0].max_batch_size).toBe(10);
		expect(cfg.vars.GREETING).toBe("hello # not a comment");
	});

	it("handles dotted keys and literal strings", () => {
		expect(parseToml("a.b = 'x'\n[t]\nc.d = 2")).toEqual({ a: { b: "x" }, t: { c: { d: 2 } } });
	});
});
