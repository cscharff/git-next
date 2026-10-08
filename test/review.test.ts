import { describe, expect, it } from "vitest";
import { parseCatalog } from "../src/providers/catalog.ts";
import { classifyChange, instanceIdFor, mergeAllowed, parseDecision } from "../src/review.ts";

const catalog = parseCatalog(JSON.stringify({ version: "1", gateway: { id: "git-next" }, models: [{ id: "@cf/zai-org/glm-5.3-flash" }], bindings: [{ type: "r2_buckets", shared: [{ binding: "UPLOADS", name: "acme-shared-uploads" }] }, { type: "ai" }] }));

const before: Record<string, string> = {
	"examples/a/wrangler.jsonc": '{ "name": "a", "r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "acme-shared-uploads" }] }',
	"package.json": JSON.stringify({ dependencies: { hono: "4" } }),
	"src/index.ts": "export default {};\n",
};
const after: Record<string, string> = {
	"examples/a/wrangler.jsonc": '{ "name": "a", "r2_buckets": [{ "binding": "UPLOADS", "bucket_name": "acme-shared-uploads" }], "kv_namespaces": [{ "binding": "CACHE", "id": "x" }] }',
	"package.json": JSON.stringify({ dependencies: { hono: "4", "left-pad": "1" } }),
	"src/index.ts": 'export default { fetch: (r, env) => env.AI.run("@cf/meta/llama-3-8b-instruct", {}) };\n',
	"AGENTS.md": "- Always use npm.\n",
	".github/workflows/ci.yml": "on: push\n",
	".dev.vars.example": "TOKEN=\n",
	".env": "TOKEN=x\n",
};
const read = async (path: string, side: "before" | "after") => (side === "before" ? before : after)[path] ?? null;

describe("classifyChange", () => {
	it("flags instructions, CI, secrets files, new bindings, new dependencies and catalog findings", async () => {
		const changed = [
			{ path: "AGENTS.md", status: "added" as const },
			{ path: ".github/workflows/ci.yml", status: "added" as const },
			{ path: ".dev.vars.example", status: "added" as const },
			{ path: ".env", status: "added" as const },
			{ path: "examples/a/wrangler.jsonc", status: "modified" as const },
			{ path: "package.json", status: "modified" as const },
			{ path: "src/index.ts", status: "modified" as const },
		];
		const reasons = await classifyChange(changed, read, catalog);
		expect(reasons.map((r) => `${r.kind}:${r.path}:${r.why}`)).toEqual([
			"instructions:AGENTS.md:adds a file that changes instructions agents follow",
			"ci-hooks-plugins:.github/workflows/ci.yml:adds a file that changes CI, git hooks, plugins or MCP servers",
			"secrets:.env:adds a file that touches a secrets file",
			"infrastructure:examples/a/wrangler.jsonc:adds binding kv_namespaces:CACHE→x",
			"dependencies:package.json:adds dependency left-pad",
			"catalog:examples/a/wrangler.jsonc:Unapproved binding: kv_namespaces CACHE → x",
			"catalog:src/index.ts:Unapproved model: @cf/meta/llama-3-8b-instruct (line 1)",
			"catalog:src/index.ts:Model call bypasses the org gateway (line 1)",
		]);
	});

	it("passes an ordinary change", async () => {
		const files: Record<string, string> = { "docs/a.md": "# Hi\n" };
		expect(await classifyChange([{ path: "docs/a.md", status: "added" }], async (p) => files[p] ?? null, catalog)).toEqual([]);
	});
});

describe("review helpers", () => {
	it("builds workflow-safe instance ids", () => {
		expect(instanceIdFor("agents-demo-full", "attempt/haiku", "1990365f50f3731f0e204d64a3cff82ccc8f3ff0")).toBe("agents-demo-full-attempt-haiku-1990365f50f3");
	});

	it("only lets approved or auto-approved changes merge", () => {
		expect(["approved", "auto-approved", "needs-review", "rejected", "expired", "running"].map((status) => mergeAllowed({ status: status as any }))).toEqual([true, true, false, false, false, false]);
		expect(mergeAllowed(null)).toBe(false);
	});

	it("validates a reviewer's decision", () => {
		const ok = { repo: "agents-demo-full", ref: "attempt/haiku", after: "1990365f50f3731f0e204d64a3cff82ccc8f3ff0", decision: "approve", reason: "Bucket and model match the catalog." };
		expect(parseDecision(ok)).toEqual(ok);
		expect(parseDecision({ ...ok, reason: "ok" })).toBe("reason must be at least 10 characters");
		expect(parseDecision({ ...ok, decision: "merge" })).toBe("decision must be approve or reject");
		expect(parseDecision({ ...ok, after: "HEAD" })).toBe("after must be a commit hash");
		expect(parseDecision(null)).toBe("body must be JSON");
	});
});
