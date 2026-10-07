import { isCloud, type Cloud } from "../../core/types.ts";

/** One AI Gateway request, normalized from a log record. */
export interface CostRecord {
	id: string;
	at: string;
	model: string;
	provider: string;
	tokensIn: number;
	tokensOut: number;
	cost: number;
	cached: boolean;
	success: boolean;
	developer: string;
	repo: string;
	fork: string;
	agent: string;
	task: string;
	/** Task type parsed from the task id, e.g. "format" from "format#412". */
	taskLabel: string;
	/** Where the model ran: metadata.cloud, default cloudflare (the AI Gateway). */
	cloud: Cloud;
	/** True for records from mocked sources (Bedrock, Vertex AI, vLLM fixtures), never real spend. */
	mocked: boolean;
}

export const UNATTRIBUTED = "(unattributed)";
export const METADATA_KEYS = ["developer", "repo", "fork", "agent", "task"] as const;

type RawLog = Record<string, unknown> & { metadata?: unknown };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown, fallback = UNATTRIBUTED) => (typeof v === "string" && v.trim() ? v.trim() : fallback);

/** Task label = leading word of the task id ("changelog#412", "triage: issue 9" -> "changelog", "triage"). */
export const taskLabelOf = (task: string) => (task === UNATTRIBUTED ? UNATTRIBUTED : (task.toLowerCase().match(/^[a-z][a-z0-9-]*/)?.[0] ?? "other"));

/**
 * Parses AI Gateway log records: a bare array, or the API envelope `{ result: [...] }`.
 * Metadata may arrive as an object or a JSON string (as custom metadata headers are stored).
 */
export function parseGatewayLogs(input: unknown): CostRecord[] {
	const rows = (Array.isArray(input) ? input : ((input as { result?: unknown })?.result ?? [])) as RawLog[];
	if (!Array.isArray(rows)) throw new Error("expected an array of log records or { result: [...] }");
	return rows.map((r, i) => {
		let meta: Record<string, unknown> = {};
		if (typeof r.metadata === "string") {
			try {
				meta = JSON.parse(r.metadata);
			} catch {
				meta = {};
			}
		} else if (r.metadata && typeof r.metadata === "object") meta = r.metadata as Record<string, unknown>;
		const task = str(meta.task);
		return {
			id: str(r.id, `row-${i}`),
			at: str(r.created_at, ""),
			model: str(r.model, "unknown"),
			provider: str(r.provider, "unknown"),
			tokensIn: num(r.tokens_in),
			tokensOut: num(r.tokens_out),
			cost: num(r.cost),
			cached: r.cached === true,
			success: r.success !== false,
			developer: str(meta.developer),
			repo: str(meta.repo),
			fork: str(meta.fork),
			agent: str(meta.agent),
			task,
			taskLabel: taskLabelOf(task),
			cloud: isCloud(meta.cloud) ? meta.cloud : isCloud(r.cloud) ? r.cloud : "cloudflare",
			mocked: r.mocked === true || meta.mocked === true,
		};
	});
}

/** Where cost records come from. Fixture today; the AI Gateway logs API later. */
export interface CostSource {
	id: string;
	records(filter: { repo?: string }): Promise<CostRecord[]>;
}

/** A repo matches its own records and, for a fork, the records tagged with that fork name. */
export const matchesRepo = (r: CostRecord, repo?: string) => !repo || r.repo === repo || r.fork === repo;

export function staticCostSource(id: string, records: CostRecord[]): CostSource {
	return { id, records: async ({ repo }) => records.filter((r) => matchesRepo(r, repo)) };
}

/** A source whose records are all flagged mocked, whatever the file says. */
export const mockedCostSource = (id: string, records: CostRecord[]): CostSource => staticCostSource(`mocked:${id}`, records.map((r) => ({ ...r, mocked: true })));

/** Several sources read as one (e.g. the live gateway plus mocked clouds). */
export function combinedCostSource(...sources: CostSource[]): CostSource {
	return { id: sources.map((s) => s.id).join("+"), records: async (f) => (await Promise.all(sources.map((s) => s.records(f)))).flat() };
}

export interface GatewayLogsConfig {
	accountId: string;
	gatewayId: string;
	/** Cloudflare API token with AI Gateway Read on the account. Never logged or returned. */
	token: string;
	/** Safety cap on pages fetched per call (50 records per page). */
	maxPages?: number;
	fetcher?: typeof fetch;
}

/**
 * Reads AI Gateway logs: GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs, newest first.
 * Narrows server-side with the free-text metadata search on the repo name, then filters exactly on
 * metadata.repo (or metadata.fork, when the repo is a fork).
 */
export function gatewayLogsSource(cfg: GatewayLogsConfig): CostSource {
	const fetcher = cfg.fetcher ?? fetch;
	return {
		id: `ai-gateway:${cfg.gatewayId}`,
		async records({ repo }) {
			const out: CostRecord[] = [];
			const maxPages = cfg.maxPages ?? 20;
			for (let page = 1; page <= maxPages; page++) {
				const qs = new URLSearchParams({ per_page: "50", page: String(page), order_by: "created_at", order_by_direction: "desc", ...(repo ? { search: repo } : {}) });
				const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/ai-gateway/gateways/${encodeURIComponent(cfg.gatewayId)}/logs?${qs}`, {
					headers: { authorization: `Bearer ${cfg.token}` },
				});
				const body = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown[]; errors?: { message?: string }[]; result_info?: { total_count?: number } } | null;
				if (!res.ok || !body?.success) throw new Error(`AI Gateway logs: HTTP ${res.status} ${body?.errors?.map((e) => e.message).join("; ") ?? ""}`.trim());
				const rows = body.result ?? [];
				out.push(...parseGatewayLogs(rows).filter((r) => matchesRepo(r, repo)));
				if (rows.length < 50) break;
			}
			return out;
		},
	};
}
