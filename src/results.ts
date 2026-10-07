import type { ExtractCache } from "./providers/instruction-stack/llm-extract.ts";
import type { Rule } from "./providers/instruction-stack/types.ts";

// Stored results in KV: the latest insights per repo/ref (written by the queue consumer on every push), an index the
// dashboard polls for live updates, a short log of recent pushes, and the rule-extraction cache.

export interface PushTrigger {
	after: string;
	before: string | null;
	commits: { id: string; message: string; author: string }[];
	totalCommitsCount: number;
	receivedAt: string;
}

export interface IndexEntry {
	repo: string;
	ref: string;
	updatedAt: string;
	after: string | null;
	conflicts: number;
	warnings: number;
	catalogViolations: number;
	insights: number;
	ms: number;
}

const INDEX_KEY = "index";
const EVENTS_KEY = "events";
const MAX_EVENTS = 50;

export const resultKey = (repo: string, ref: string) => `insights/${repo}/${ref}`;

export async function putResult(kv: KVNamespace, repo: string, ref: string, result: Record<string, any>, trigger: PushTrigger | null): Promise<IndexEntry> {
	const updatedAt = new Date().toISOString();
	const insights: { provider: string; severity: string }[] = result.insights ?? [];
	await kv.put(resultKey(repo, ref), JSON.stringify({ ...result, updatedAt, trigger }));
	const entry: IndexEntry = {
		repo,
		ref,
		updatedAt,
		after: trigger?.after ?? null,
		conflicts: insights.filter((i) => i.provider === "instruction-stack" && i.severity === "conflict").length,
		warnings: insights.filter((i) => i.severity === "warn").length,
		catalogViolations: insights.filter((i) => i.provider === "catalog" && i.severity === "conflict").length,
		insights: insights.length,
		ms: result.ms ?? 0,
	};
	// Read-modify-write; a lost update under concurrent pushes only delays an index entry until the next push.
	const index = ((await kv.get(INDEX_KEY, "json")) as IndexEntry[] | null) ?? [];
	await kv.put(INDEX_KEY, JSON.stringify([entry, ...index.filter((e) => !(e.repo === repo && e.ref === ref))].slice(0, 200)));
	if (trigger) {
		const events = ((await kv.get(EVENTS_KEY, "json")) as unknown[] | null) ?? [];
		await kv.put(EVENTS_KEY, JSON.stringify([{ repo, ref, ...trigger, conflicts: entry.conflicts, catalogViolations: entry.catalogViolations }, ...events].slice(0, MAX_EVENTS)));
	}
	return entry;
}

export const getResult = (kv: KVNamespace, repo: string, ref: string) => kv.get(resultKey(repo, ref), "json");
export async function getIndex(kv: KVNamespace) {
	const [index, events] = await Promise.all([kv.get(INDEX_KEY, "json"), kv.get(EVENTS_KEY, "json")]);
	return { index: (index as IndexEntry[] | null) ?? [], events: (events as unknown[] | null) ?? [] };
}

/** Rule-extraction cache in KV, keyed by content hash (rules are stored without their layer, which is rebound). */
export function kvExtractCache(kv: KVNamespace, memory: ExtractCache): ExtractCache {
	return {
		async get(key) {
			const hit = await memory.get(key);
			if (hit) return hit;
			const stored = (await kv.get(`cache/${key}`, "json")) as Rule[] | null;
			if (stored) await memory.put(key, stored);
			return stored;
		},
		async put(key, rules) {
			await memory.put(key, rules);
			await kv.put(`cache/${key}`, JSON.stringify(rules.map(({ layer, ...r }) => ({ ...r, layer: { path: layer.path } }))), { expirationTtl: 60 * 60 * 24 * 30 });
		},
	};
}

const ZERO = /^0{40}$/;

/** Parses a cf.artifacts.repo.pushed event; returns null for anything that isn't a branch push we should analyse. */
export function parsePushEvent(body: unknown, namespace: string): { repo: string; ref: string; trigger: PushTrigger } | null {
	const e = body as any;
	if (e?.type !== "cf.artifacts.repo.pushed" || e?.source?.type !== "artifacts.repo" || e.source.namespace !== namespace) return null;
	const repo = String(e.source.repoName ?? e.source.repo_name ?? "");
	const fullRef = String(e.payload?.ref ?? "");
	const after = String(e.payload?.after ?? "");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) || !fullRef.startsWith("refs/heads/") || !/^[0-9a-f]{40}$/.test(after) || ZERO.test(after)) return null;
	const before = String(e.payload?.before ?? "");
	const commits = Array.isArray(e.payload?.commits) ? e.payload.commits : [];
	return {
		repo,
		ref: fullRef.slice("refs/heads/".length),
		trigger: {
			after,
			before: /^[0-9a-f]{40}$/.test(before) && !ZERO.test(before) ? before : null,
			commits: commits.slice(0, 20).map((c: any) => ({ id: String(c?.id ?? "").slice(0, 40), message: String(c?.message ?? "").split("\n")[0].slice(0, 200), author: String(c?.author?.name ?? "").slice(0, 80) })),
			totalCommitsCount: Number(e.payload?.totalCommitsCount) || commits.length,
			receivedAt: new Date().toISOString(),
		},
	};
}
