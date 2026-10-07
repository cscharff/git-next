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
		};
	});
}

/** Where cost records come from. Fixture today; the AI Gateway logs API later. */
export interface CostSource {
	id: string;
	records(filter: { repo?: string }): Promise<CostRecord[]>;
}

export function staticCostSource(id: string, records: CostRecord[]): CostSource {
	return { id, records: async ({ repo }) => records.filter((r) => !repo || r.repo === repo) };
}

// TODO(cost): real source. Page through
//   GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs?meta_info=true&per_page=50&page=N&start_date=&end_date=
// (also `cf ai-gateway logs list`) with an API token from a Worker secret, filter on metadata.repo,
// and map each record through parseGatewayLogs. Needs: account id, gateway id, token scope "AI Gateway Read".
