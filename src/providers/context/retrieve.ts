import type { Section } from "./sections.ts";

export interface Scored {
	section: Section;
	score: number;
}

/** Ranks indexed sections for a query. BM25 today; an embedding-backed retriever can drop in later. */
export interface Retriever {
	id: string;
	search(query: string, k: number): Promise<Scored[]>;
}

/** Turns texts into vectors (Workers AI EmbeddingGemma later). */
export interface Embedder {
	id: string;
	embed(texts: string[]): Promise<number[][]>;
}

const STOPWORDS = new Set(
	"a an and are as at be by for from has have how i if in into is it its of on or that the this to was we what when where which will with you your use using should can do not".split(" "),
);

export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
		.filter((t) => t.length > 1 && !STOPWORDS.has(t))
		.map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/** Text indexed for a section: headings and path count extra so "where is X documented" queries land. */
const indexText = (s: Section) => `${s.headings.join(" ")} ${s.headings.join(" ")} ${s.path.replace(/[/._-]/g, " ")} ${s.text}`;

/** Okapi BM25 over section text. Deterministic, no model calls. */
export class Bm25Retriever implements Retriever {
	readonly id = "bm25";
	private docs: { section: Section; tf: Map<string, number>; len: number }[];
	private df = new Map<string, number>();
	private avgLen: number;
	private k1: number;
	private b: number;

	constructor(sections: Section[], k1 = 1.2, b = 0.75) {
		this.k1 = k1;
		this.b = b;
		this.docs = sections.map((section) => {
			const tf = new Map<string, number>();
			const tokens = tokenize(indexText(section));
			for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
			for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
			return { section, tf, len: tokens.length };
		});
		this.avgLen = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(1, this.docs.length);
	}

	async search(query: string, k: number): Promise<Scored[]> {
		const terms = [...new Set(tokenize(query))];
		const n = this.docs.length;
		const scored: Scored[] = [];
		for (const d of this.docs) {
			let score = 0;
			for (const t of terms) {
				const f = d.tf.get(t);
				if (!f) continue;
				const df = this.df.get(t)!;
				const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
				score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
			}
			if (score > 0) scored.push({ section: d.section, score });
		}
		return scored.sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id)).slice(0, k);
	}
}

/** Cosine-similarity retriever over any Embedder. In-memory now; Vectorize can back it later. */
export class VectorRetriever implements Retriever {
	readonly id: string;
	private vectors: Promise<number[][]>;
	private sections: Section[];
	private embedder: Embedder;

	constructor(sections: Section[], embedder: Embedder) {
		this.sections = sections;
		this.embedder = embedder;
		this.id = `vector:${embedder.id}`;
		this.vectors = embedder.embed(sections.map(indexText));
	}

	async search(query: string, k: number): Promise<Scored[]> {
		const [q] = await this.embedder.embed([query]);
		const vectors = await this.vectors;
		return this.sections
			.map((section, i) => ({ section, score: cosine(q, vectors[i]) }))
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
