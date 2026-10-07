import type { Retriever, Scored } from "./retrieve.ts";
import type { Section } from "./sections.ts";

// Embedding-backed retrieval: markdown sections are embedded with Workers AI (EmbeddingGemma-300m, 768 dimensions) and
// stored in Vectorize, filtered by repo. Indexing happens at push time (queue consumer); requests only embed the query.
// A KV manifest records which section ids are indexed so a request can tell whether vectors cover the repo yet.

export const EMBED_MODEL = "@cf/google/embeddinggemma-300m";
const EMBED_BATCH = 50;
const UPSERT_BATCH = 500;

/** Embeds texts; returns one vector per text, in order. */
export type Embed = (texts: string[]) => Promise<number[][]>;

export interface VectorIndex {
	upsert(vectors: { id: string; values: number[]; metadata?: Record<string, string> }[]): Promise<unknown>;
	query(vector: number[], options: { topK: number; filter?: Record<string, string>; returnMetadata?: "none" | "indexed" | "all" }): Promise<{ matches: { id: string; score: number }[] }>;
}

export interface Manifest {
	get(repo: string): Promise<string[] | null>;
	put(repo: string, ids: string[]): Promise<void>;
}

/** Text that gets embedded: heading trail and path give short sections their context. */
const embedText = (s: Section) => `${s.headings.join(" › ")}\n${s.path}\n${s.text}`.slice(0, 6000);

/** Stable id per repo + section content (Vectorize ids are at most 64 bytes). */
export async function sectionVectorId(repo: string, s: Section): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${repo}\0${s.path}\0${s.text}`)));
	return [...bytes.slice(0, 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Embeds and upserts sections not yet indexed for this repo; returns counts. Safe to re-run (idempotent ids). */
export async function indexSections(deps: { embed: Embed; index: VectorIndex; manifest: Manifest }, repo: string, sections: Section[]) {
	const ids = await Promise.all(sections.map((s) => sectionVectorId(repo, s)));
	const known = new Set((await deps.manifest.get(repo)) ?? []);
	const missing = sections.map((s, i) => ({ s, id: ids[i] })).filter(({ id }) => !known.has(id));
	const vectors: { id: string; values: number[]; metadata: Record<string, string> }[] = [];
	for (let i = 0; i < missing.length; i += EMBED_BATCH) {
		const batch = missing.slice(i, i + EMBED_BATCH);
		const embedded = await deps.embed(batch.map(({ s }) => embedText(s)));
		batch.forEach(({ s, id }, j) => vectors.push({ id, values: embedded[j], metadata: { repo, path: s.path } }));
	}
	for (let i = 0; i < vectors.length; i += UPSERT_BATCH) await deps.index.upsert(vectors.slice(i, i + UPSERT_BATCH));
	// The manifest lists the current sections' ids (old ones age out of the manifest; their vectors are harmless).
	await deps.manifest.put(repo, ids);
	return { total: sections.length, embedded: missing.length };
}

/** Share of the given sections that are indexed for this repo (0..1). */
export async function coverage(manifest: Manifest, repo: string, sections: Section[]): Promise<number> {
	const known = new Set((await manifest.get(repo)) ?? []);
	if (!known.size || !sections.length) return 0;
	const ids = await Promise.all(sections.map((s) => sectionVectorId(repo, s)));
	return ids.filter((id) => known.has(id)).length / ids.length;
}

/** Vector search over the repo's indexed sections (Vectorize returns at most 100 matches). */
export class VectorizeRetriever implements Retriever {
	readonly id = `vectorize:${EMBED_MODEL}`;
	private byId: Promise<Map<string, Section>>;
	private repo: string;
	private embed: Embed;
	private index: VectorIndex;

	constructor(repo: string, sections: Section[], embed: Embed, index: VectorIndex) {
		this.repo = repo;
		this.embed = embed;
		this.index = index;
		this.byId = Promise.all(sections.map(async (s) => [await sectionVectorId(repo, s), s] as const)).then((pairs) => new Map(pairs));
	}

	async search(query: string, k: number): Promise<Scored[]> {
		const [vector] = await this.embed([query]);
		const [res, byId] = await Promise.all([this.index.query(vector, { topK: Math.min(k, 100), filter: { repo: this.repo }, returnMetadata: "none" }), this.byId]);
		return res.matches.flatMap((m) => {
			const section = byId.get(m.id);
			return section ? [{ section, score: m.score }] : [];
		});
	}
}

/**
 * Weighted reciprocal rank fusion of two rankings (k = 60): sections both retrievers like rise to the top; either one
 * alone still contributes. On cloudflare/agents, vectors at half weight helped natural-language questions without
 * pulling unrelated design docs above exact matches. Scores are rescaled so the best result is 10, comparable in size to BM25 scores downstream.
 */
export class HybridRetriever implements Retriever {
	readonly id: string;
	private a: Retriever;
	private b: Retriever;
	private weights: [number, number];

	/** `weights` scale each ranking's contribution (BM25 first): exact terms from task and paths stay the stronger signal. */
	constructor(a: Retriever, b: Retriever, weights: [number, number] = [1, 0.5]) {
		this.a = a;
		this.b = b;
		this.weights = weights;
		this.id = `hybrid(${a.id}+${b.id})`;
	}

	async search(query: string, k: number): Promise<Scored[]> {
		const [ra, rb] = await Promise.all([this.a.search(query, k), this.b.search(query, k).catch(() => [] as Scored[])]);
		const fused = new Map<string, { section: Section; score: number }>();
		for (const [w, list] of [[this.weights[0], ra], [this.weights[1], rb]] as const)
			list.forEach((r, rank) => {
				const cur = fused.get(r.section.id) ?? { section: r.section, score: 0 };
				cur.score += w / (60 + rank);
				fused.set(r.section.id, cur);
			});
		const out = [...fused.values()].sort((x, y) => y.score - x.score).slice(0, k);
		const top = out[0]?.score || 1;
		return out.map((r) => ({ section: r.section, score: (r.score / top) * 10 }));
	}
}
