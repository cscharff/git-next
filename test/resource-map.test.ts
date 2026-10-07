import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RepoContext, memorySource } from "../src/core/repo-context.ts";
import { diffBindings, parseWranglerConfig, resourceMapProvider } from "../src/providers/resource-map.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseWranglerConfig", () => {
	it("extracts every supported binding type from TOML", () => {
		const w = parseWranglerConfig("wrangler.toml", fixture("wrangler.toml"));
		expect(w.worker).toBe("toml-worker");
		const types = new Set(w.bindings.map((b) => b.type));
		expect([...types].sort()).toEqual(
			["ai", "artifacts", "browser", "containers", "d1_databases", "durable_objects", "hyperdrive", "kv_namespaces", "queues", "r2_buckets", "services", "vectorize", "workflows"].sort(),
		);
		expect(w.bindings).toContainEqual({ type: "durable_objects", name: "REMOTE", resource: "other-worker:Counter" });
		expect(w.bindings).toContainEqual({ type: "services", name: "AUTH", resource: "auth-worker#AuthRPC" });
		expect(w.bindings).toContainEqual({ type: "queues", name: "consumer:jobs", resource: "jobs" });
	});

	it("parses JSONC configs", () => {
		const w = parseWranglerConfig("apps/chat/wrangler.jsonc", fixture("wrangler.jsonc"));
		expect(w).toEqual({
			path: "apps/chat/wrangler.jsonc",
			worker: "jsonc-worker",
			bindings: [
				{ type: "durable_objects", name: "Chat", resource: "Chat" },
				{ type: "ai", name: "AI" },
			],
		});
	});

	it("extracts worker loaders, images, assets and analytics engine datasets", () => {
		const w = parseWranglerConfig(
			"wrangler.jsonc",
			`{ "name": "cms", "worker_loaders": [{ "binding": "LOADER" }], "images": { "binding": "IMAGES" }, "assets": { "directory": "./dist" },
			"analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "ops" }] }`,
		);
		expect(w.bindings).toEqual([
			{ type: "worker_loaders", name: "LOADER" },
			{ type: "images", name: "IMAGES" },
			{ type: "assets", name: "(assets)", resource: "./dist" },
			{ type: "analytics_engine_datasets", name: "METRICS", resource: "ops" },
		]);
	});

	it("reports parse errors instead of throwing", () => {
		const w = parseWranglerConfig("wrangler.json", "{ nope");
		expect(w.worker).toBe("(unparseable)");
		expect(w.error).toBeTruthy();
	});
});

describe("diffBindings", () => {
	it("classifies added, removed and unchanged bindings", () => {
		const kv = { type: "kv_namespaces" as const, name: "CACHE", resource: "1" };
		const r2 = { type: "r2_buckets" as const, name: "B", resource: "b" };
		const ai = { type: "ai" as const, name: "AI" };
		expect(diffBindings([kv, r2], [kv, ai])).toEqual({ added: [ai], removed: [r2], unchanged: [kv] });
	});
});

describe("resourceMapProvider", () => {
	const repo = "demo";
	const main = {
		"wrangler.jsonc": fixture("wrangler.jsonc"),
		"old/wrangler.toml": 'name = "old"\n[ai]\nbinding = "AI"\n',
		"README.md": "# hi",
	};
	const fork = {
		"wrangler.jsonc": fixture("wrangler.jsonc").replace('"ai": { "binding": "AI" },', '"r2_buckets": [{ "binding": "FILES", "bucket_name": "files" }],'),
		"new/wrangler.toml": fixture("wrangler.toml"),
	};
	const files = new RepoContext(async () => memorySource({ main, fork }));

	it("lists Workers and bindings at a ref", async () => {
		const out = await resourceMapProvider.analyze({ repo, ref: "main", files });
		expect(out.map((i) => i.title).sort()).toEqual(["jsonc-worker: 2 bindings", "old: 1 binding"]);
		expect(out.every((i) => i.severity === "info")).toBe(true);
	});

	it("calls out queue consumers in the title and detail", async () => {
		const q = new RepoContext(async () =>
			memorySource({ main: { "wrangler.toml": 'name = "q"\n[[queues.producers]]\nbinding = "JOBS"\nqueue = "jobs"\n[[queues.consumers]]\nqueue = "jobs"\n' } }),
		);
		const [i] = await resourceMapProvider.analyze({ repo, ref: "main", files: q });
		expect(i.title).toBe("q: 2 bindings (incl. 1 queue consumer)");
		expect(i.detail).toBe("queues: JOBS → jobs, jobs (consumer)");
	});

	it("diffs a fork against its base", async () => {
		const out = await resourceMapProvider.analyze({ repo, ref: "fork", base: "main", files });
		const byPath = Object.fromEntries(out.map((i) => [i.scope.path, i]));
		const changed = byPath["wrangler.jsonc"].metrics!.diff as any;
		expect(changed.added).toEqual([{ type: "r2_buckets", name: "FILES", resource: "files" }]);
		expect(changed.removed).toEqual([{ type: "ai", name: "AI" }]);
		expect(changed.unchanged).toHaveLength(1);
		expect(byPath["new/wrangler.toml"].metrics!.newConfig).toBe(true);
		expect(byPath["old/wrangler.toml"].title).toBe("old: config removed vs main");
	});
});
