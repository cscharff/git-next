import { describe, expect, it } from "vitest";
import { annotateLog, commitTrailers, diffTrees, fileView, lineDiff, taskCosts } from "../src/code.ts";
import { handleCodeRoute, type CodeDeps } from "../src/code-routes.ts";
import { RepoContext, memorySource, type RepoSource } from "../src/core/repo-context.ts";

describe("fileView", () => {
	it("shows text, flags binaries and truncates large files", () => {
		expect(fileView("a.md", new TextEncoder().encode("# hi\n"))).toEqual({ path: "a.md", size: 5, binary: false, truncated: false, text: "# hi\n" });
		expect(fileView("logo.png", new Uint8Array([137, 80, 78, 71, 0, 1]))).toMatchObject({ binary: true, text: null });
		const big = fileView("big.txt", new Uint8Array(1024 * 1024 + 10).fill(97));
		expect(big.truncated).toBe(true);
		expect(big.text!.length).toBe(1024 * 1024);
	});
});

describe("diffTrees", () => {
	it("lists added, removed and modified files by path", () => {
		const base = [{ path: "a", hash: "1" }, { path: "b", hash: "2" }, { path: "c", hash: "3" }];
		const head = [{ path: "a", hash: "1" }, { path: "b", hash: "9" }, { path: "d", hash: "4" }];
		expect(diffTrees(base, head)).toEqual([{ path: "b", status: "modified" }, { path: "c", status: "removed" }, { path: "d", status: "added" }]);
	});
});

describe("lineDiff", () => {
	it("returns hunks with context and line numbers on both sides", () => {
		const before = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join("\n");
		const after = ["one", "two", "three", "four", "FIVE", "six", "seven", "eight", "nine", "ten", "eleven"].join("\n");
		const hunks = lineDiff(before, after, 1)!;
		expect(hunks).toHaveLength(2);
		expect(hunks[0]).toEqual([
			{ op: " ", a: 4, b: 4, text: "four" },
			{ op: "-", a: 5, text: "five" },
			{ op: "+", b: 5, text: "FIVE" },
			{ op: " ", a: 6, b: 6, text: "six" },
		]);
		expect(hunks[1]).toEqual([
			{ op: " ", a: 10, b: 10, text: "ten" },
			{ op: "+", b: 11, text: "eleven" },
		]);
	});

	it("handles added and removed files and identical content", () => {
		expect(lineDiff("", "a\nb")).toEqual([[{ op: "+", b: 1, text: "a" }, { op: "+", b: 2, text: "b" }]]);
		expect(lineDiff("a", "")).toEqual([[{ op: "-", a: 1, text: "a" }]]);
		expect(lineDiff("same\n", "same\n")).toEqual([]);
	});

	it("gives up on huge rewrites instead of building a huge table", () => {
		const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n");
		const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n");
		expect(lineDiff(a, b)).toBeNull();
	});
});

describe("commit annotations", () => {
	const rollup = [
		{ level: "project", key: "p", cost: 1, requests: 3, children: [
			{ level: "developer", key: "chris", cost: 1, requests: 3, children: [
				{ level: "fork", key: "agents-demo-r2", cost: 0.2, requests: 2, children: [{ level: "agent", key: "r2-agent", cost: 0.2, requests: 2, children: [{ level: "task", key: "r2#uploads", cost: 0.2, requests: 2 }] }] },
				{ level: "fork", key: "agents-demo-docs", cost: 0.8, requests: 1, children: [{ level: "agent", key: "docs-agent", cost: 0.8, requests: 1, children: [{ level: "task", key: "docs#x", cost: 0.8, requests: 1 }] }] },
			] },
		] },
	];

	it("reads Agent and Agent-Task trailers", () => {
		expect(commitTrailers("SOW-1042: Add uploads\n\nAgent: r2-agent (claude) via git.next\nAgent-Task: r2#uploads\n")).toEqual({ agent: "r2-agent", agentTask: "r2#uploads" });
		expect(commitTrailers("plain commit")).toEqual({ agent: null, agentTask: null });
	});

	it("sums task spend for one fork only", () => {
		expect([...taskCosts(rollup, "agents-demo-r2")]).toEqual([["r2#uploads", { cost: 0.2, requests: 2 }]]);
		expect(taskCosts(undefined, "x").size).toBe(0);
	});

	it("joins push results by commit and cost by task", () => {
		const commits = [
			{ hash: "c3", message: "SOW-1042: Add uploads\n\nAgent-Task: r2#uploads", author: "r2-agent", committedAt: 3, parents: ["c2"] },
			{ hash: "c2", message: "SOW-1042: Earlier", author: "r2-agent", committedAt: 2, parents: ["c1"] },
			{ hash: "c1", message: "upstream", author: "someone", committedAt: 1 },
		];
		const events = [
			{ repo: "agents-demo-r2", after: "c2", receivedAt: "2026-10-07T23:00:00Z", conflicts: 2, catalogViolations: 1 },
			{ repo: "agents-demo-docs", after: "c1", receivedAt: "2026-10-07T22:00:00Z", conflicts: 9, catalogViolations: 9 },
		];
		const latest = {
			commit: "c3",
			updatedAt: "2026-10-08T00:34:12Z",
			insights: [
				{ provider: "instruction-stack", severity: "conflict" },
				{ provider: "instruction-stack", severity: "warn" },
				{ provider: "cost", severity: "info", metrics: { rollup } },
			],
		};
		const rows = annotateLog(commits, "agents-demo-r2", events, latest);
		expect(rows.map((r) => [r.hash, r.push?.conflicts ?? null, r.push?.catalogViolations ?? null, r.cost?.cost ?? null])).toEqual([
			["c3", 1, 0, 0.2],
			["c2", 2, 1, null],
			["c1", null, null, null],
		]);
		expect(rows[0]).toMatchObject({ agentTask: "r2#uploads", parents: ["c2"], push: { warnings: 1, insights: 3, receivedAt: "2026-10-08T00:34:12Z" } });
		expect(rows[2].parents).toEqual([]);
		expect(rows[0].cost).toEqual({ cost: 0.2, requests: 2, commits: 1 });
	});

	it("marks spend shared by several commits with the same task", () => {
		const commits = ["a", "b"].map((hash) => ({ hash, message: "x\n\nAgent-Task: r2#uploads", author: "r2-agent", committedAt: 1 }));
		const latest = { commit: "zzz", insights: [{ provider: "cost", severity: "info", metrics: { rollup } }] };
		expect(annotateLog(commits, "agents-demo-r2", [], latest).map((r) => r.cost)).toEqual([{ cost: 0.2, requests: 2, commits: 2 }, { cost: 0.2, requests: 2, commits: 2 }]);
	});
});

describe("/code routes", () => {
	const refs = {
		main: { "README.md": "# Demo\nline two\n", "src/index.ts": "export default 1;\n", "img.bin": "x" },
		c1: { "README.md": "# Demo\n", "old.txt": "gone\n" },
	};
	const mem = memorySource(refs);
	const source: RepoSource = {
		...mem,
		log: async (ref) => (ref === "main" ? [{ hash: "main", message: "SOW-1: second\n\nAgent-Task: t1", author: "a", committedAt: 2, parents: ["c1"] }] : []),
		// Direct reads by path, as Artifacts serves them; img.bin is binary.
		readPath: async (ref, path) => {
			const text = (refs as Record<string, Record<string, string>>)[ref]?.[path];
			return text === undefined ? null : path === "img.bin" ? new Uint8Array([0, 1, 2]) : new TextEncoder().encode(text);
		},
	};
	const deps: CodeDeps = {
		context: () => new RepoContext(async () => source),
		listRepos: async () => [{ name: "demo", description: null, defaultBranch: "main", lastPushAt: null, source: null }],
		events: async () => [],
		latest: async () => null,
	};
	const get = async (path: string) => {
		const res = await handleCodeRoute(new Request(`http://x${path}`), new URL(`http://x${path}`), deps);
		return { status: res!.status, body: (await res!.json()) as any };
	};

	it("lists repos and the files at a ref with the head commit", async () => {
		expect((await get("/code/repos")).body.repos[0].name).toBe("demo");
		const tree = await get("/code/tree?repo=demo&ref=main");
		expect(tree.body.files.map((f: { path: string }) => f.path)).toEqual(["README.md", "img.bin", "src/index.ts"]);
		expect(tree.body.head.hash).toBe("main");
	});

	it("reuses a cached listing for the same commit", async () => {
		const store = new Map<string, unknown>();
		const cached: CodeDeps = { ...deps, treeCache: { get: async (k) => (store.get(k) as never) ?? null, put: async (k, f) => void store.set(k, f) } };
		const call = () => handleCodeRoute(new Request("http://x/code/tree?repo=demo&ref=main"), new URL("http://x/code/tree?repo=demo&ref=main"), cached).then((r) => r!.json() as Promise<any>);
		await call();
		expect([...store.keys()]).toEqual(["demo/main/demo"]);
		store.set("demo/main/demo", [{ path: "from-cache.md", hash: "h" }]);
		expect((await call()).files).toEqual([{ path: "from-cache.md", hash: "h" }]);
	});

	it("reads overlay files ahead of the source's direct path reads", async () => {
		const { overlayFiles } = await import("../src/core/repo-context.ts");
		const files = new RepoContext(async () => overlayFiles(source, { "README.md": "overlaid" }));
		expect(new TextDecoder().decode((await files.readBytes("demo", "main", "README.md"))!)).toBe("overlaid");
		expect(new TextDecoder().decode((await files.readBytes("demo", "main", "src/index.ts"))!)).toBe("export default 1;\n");
		expect(await new RepoContext(async () => mem).readBytes("demo", "main", "nope")).toBeNull();
	});

	it("serves text files, marks binaries and 404s unknown paths", async () => {
		expect((await get("/code/file?repo=demo&ref=main&path=README.md")).body).toMatchObject({ text: "# Demo\nline two\n", binary: false });
		expect((await get("/code/file?repo=demo&ref=main&path=img.bin")).body).toMatchObject({ binary: true, text: null });
		expect((await get("/code/file?repo=demo&ref=main&path=nope.md")).status).toBe(404);
	});

	it("diffs against the first parent by default", async () => {
		expect((await get("/code/diff?repo=demo&ref=main")).body).toMatchObject({
			base: "c1",
			changed: [
				{ path: "README.md", status: "modified" },
				{ path: "img.bin", status: "added" },
				{ path: "old.txt", status: "removed" },
				{ path: "src/index.ts", status: "added" },
			],
		});
		const one = (await get("/code/diff?repo=demo&ref=main&path=README.md")).body;
		expect(one.status).toBe("modified");
		expect(one.hunks[0].filter((l: { op: string }) => l.op === "+").map((l: { text: string }) => l.text)).toEqual(["line two"]);
	});

	it("returns the annotated log and rejects bad input", async () => {
		expect((await get("/code/log?repo=demo&ref=main")).body.commits[0]).toMatchObject({ hash: "main", agentTask: "t1", push: null, cost: null });
		expect((await get("/code/tree?repo=../etc&ref=main")).status).toBe(400);
		expect((await get("/code/diff?repo=demo&ref=main&base=$(x)")).status).toBe(400);
		expect(await handleCodeRoute(new Request("http://x/code/tree", { method: "POST" }), new URL("http://x/code/tree"), deps)).toBeNull();
	});
});

describe("artifactsSource.changedFiles", () => {
	it("skips unchanged subtrees and expands added/removed/retyped ones", async () => {
		const { artifactsSource } = await import("../src/core/artifacts-source.ts");
		const trees: Record<string, { name: string; type: string; hash: string; mode: string }[]> = {
			rootA: [{ name: "same", type: "tree", hash: "S", mode: "40000" }, { name: "src", type: "tree", hash: "srcA", mode: "40000" }, { name: "gone", type: "tree", hash: "G", mode: "40000" }, { name: "x", type: "blob", hash: "x1", mode: "100644" }],
			rootB: [{ name: "same", type: "tree", hash: "S", mode: "40000" }, { name: "src", type: "tree", hash: "srcB", mode: "40000" }, { name: "x", type: "tree", hash: "X", mode: "40000" }, { name: "new.md", type: "blob", hash: "n", mode: "100644" }],
			srcA: [{ name: "a.ts", type: "blob", hash: "a1", mode: "100644" }, { name: "b.ts", type: "blob", hash: "b1", mode: "100644" }],
			srcB: [{ name: "a.ts", type: "blob", hash: "a2", mode: "100644" }, { name: "b.ts", type: "blob", hash: "b1", mode: "100644" }],
			G: [{ name: "old.txt", type: "blob", hash: "o", mode: "100644" }],
			X: [{ name: "inner.ts", type: "blob", hash: "i", mode: "100644" }],
		};
		const read: string[] = [];
		const repo = {
			log: async ({ ref }: { ref: string }) => [{ hash: ref, treeHash: ref === "base" ? "rootA" : "rootB" }],
			readTree: async (hash: string) => (read.push(hash), trees[hash] ?? null),
		};
		const source = await artifactsSource({ get: async () => repo } as unknown as Artifacts, "demo");
		expect(await source.changedFiles!("base", "head")).toEqual([
			{ path: "gone/old.txt", status: "removed" },
			{ path: "new.md", status: "added" },
			{ path: "src/a.ts", status: "modified" },
			{ path: "x", status: "removed" },
			{ path: "x/inner.ts", status: "added" },
		]);
		expect(read).not.toContain("S");
	});
});
