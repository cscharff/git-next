import { describe, expect, it } from "vitest";
import { Bm25Retriever } from "../src/providers/context/retrieve.ts";
import { splitSections } from "../src/providers/context/sections.ts";
import { HybridRetriever, VectorizeRetriever, coverage, indexSections, sectionVectorId, type Embed, type Manifest, type VectorIndex } from "../src/providers/context/vectorize.ts";

const sections = [
	...splitSections("docs/mcp.md", "# MCP client\nThe MCP client reconnects when the transport drops.\n# OAuth\nOAuth flows for MCP servers."),
	...splitSections("docs/email.md", "# Email\nRoute inbound email to agents."),
	...splitSections("docs/upload.md", "# Storing files\nPut objects in a bucket."),
];
// A toy embedding: one dimension per vocabulary word.
const vocab = ["mcp", "reconnect", "oauth", "email", "bucket", "files", "storing", "upload"];
const embed: Embed = async (texts) => texts.map((t) => vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)));

function memoryIndex(): VectorIndex & { size: () => number } {
	const store = new Map<string, { values: number[]; metadata?: Record<string, string> }>();
	const cos = (a: number[], b: number[]) => {
		const dot = a.reduce((n, x, i) => n + x * b[i], 0);
		const na = Math.hypot(...a);
		const nb = Math.hypot(...b);
		return na && nb ? dot / (na * nb) : 0;
	};
	return {
		size: () => store.size,
		async upsert(vs) {
			for (const v of vs) store.set(v.id, v);
		},
		async query(vector, { topK, filter }) {
			const matches = [...store.entries()].filter(([, v]) => !filter || Object.entries(filter).every(([k, x]) => v.metadata?.[k] === x)).map(([id, v]) => ({ id, score: cos(vector, v.values) })).sort((a, b) => b.score - a.score).slice(0, topK);
			return { matches };
		},
	};
}
const memoryManifest = (): Manifest => {
	const m = new Map<string, string[]>();
	return { get: async (r) => m.get(r) ?? null, put: async (r, ids) => void m.set(r, ids) };
};

describe("vector indexing and retrieval", () => {
	it("indexes only new sections and reports coverage", async () => {
		const index = memoryIndex();
		const manifest = memoryManifest();
		let calls = 0;
		const counting: Embed = async (t) => {
			calls++;
			return embed(t);
		};
		expect(await coverage(manifest, "r", sections)).toBe(0);
		expect(await indexSections({ embed: counting, index, manifest }, "r", sections)).toEqual({ total: 4, embedded: 4 });
		expect(await indexSections({ embed: counting, index, manifest }, "r", sections)).toEqual({ total: 4, embedded: 0 });
		expect(calls).toBe(1);
		expect(await coverage(manifest, "r", sections)).toBe(1);
		expect(await sectionVectorId("r", sections[0])).toMatch(/^[0-9a-f]{40}$/);
		expect(await sectionVectorId("other", sections[0])).not.toBe(await sectionVectorId("r", sections[0]));
	});

	it("searches by meaning within one repo", async () => {
		const index = memoryIndex();
		const manifest = memoryManifest();
		await indexSections({ embed, index, manifest }, "r", sections);
		await indexSections({ embed, index, manifest }, "other", sections.slice(0, 1));
		const out = await new VectorizeRetriever("r", sections, embed, index).search("where do uploaded files go? a bucket", 2);
		expect(out[0].section.path).toBe("docs/upload.md");
		expect(index.size()).toBe(5);
	});

	it("fuses BM25 and vector rankings", async () => {
		const index = memoryIndex();
		const manifest = memoryManifest();
		await indexSections({ embed, index, manifest }, "r", sections);
		const hybrid = new HybridRetriever(new Bm25Retriever(sections), new VectorizeRetriever("r", sections, embed, index));
		const out = await hybrid.search("fix MCP reconnect", 3);
		expect(out[0].section.id).toBe("docs/mcp.md#mcp-client");
		expect(out[0].score).toBe(10);
		expect(hybrid.id).toContain("hybrid(bm25+vectorize:");
	});

	it("still answers with BM25 if the vector side fails", async () => {
		const broken: VectorIndex = { upsert: async () => {}, query: async () => Promise.reject(new Error("vectorize down")) };
		const out = await new HybridRetriever(new Bm25Retriever(sections), new VectorizeRetriever("r", sections, embed, broken)).search("email routing", 2);
		expect(out[0].section.path).toBe("docs/email.md");
	});
});
