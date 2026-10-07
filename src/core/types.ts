export type Severity = "info" | "warn" | "conflict";

export interface Evidence {
	repo: string;
	path: string;
	line?: number;
}

/** Where an insight's subject runs. Only Cloudflare is read live; the others come from declared (mocked) environments. */
export const CLOUDS = ["cloudflare", "gcp", "aws", "private"] as const;
export type Cloud = (typeof CLOUDS)[number];
export const isCloud = (v: unknown): v is Cloud => typeof v === "string" && (CLOUDS as readonly string[]).includes(v);

/** Normalized resource kinds, so R2, GCS, S3 and MinIO can be compared as "object-store". */
export const RESOURCE_KINDS = ["object-store", "sql-db", "kv-cache", "queue", "compute", "ai", "vector", "secrets"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const isResourceKind = (v: unknown): v is ResourceKind => typeof v === "string" && (RESOURCE_KINDS as readonly string[]).includes(v);

export interface EnvScope {
	cloud: Cloud;
	/** Environment name from .gitnext/environments.json (e.g. prod-aws, staging-cf, onprem). */
	name?: string;
	/** Account, project or subscription id. */
	account?: string;
	region?: string;
	/** True when the environment is declared, not read from a real provider. */
	mocked?: boolean;
}

export interface Insight {
	provider: string;
	severity: Severity;
	/** `env` absent means Cloudflare (every provider read Cloudflare config before environments existed). */
	scope: { repo: string; ref: string; path?: string; agent?: string; env?: EnvScope };
	title: string;
	detail: string;
	evidence: Evidence[];
	metrics?: Record<string, unknown>;
}

/**
 * Clouds an insight is about: its scope env; or, for cross-cutting insights, metrics.clouds; instruction-stack
 * findings without an env apply to every cloud (rules are cloud-agnostic unless scoped); everything else is Cloudflare.
 */
export function insightClouds(i: Insight): Cloud[] {
	if (i.scope.env) return [i.scope.env.cloud];
	const listed = i.metrics?.clouds;
	if (Array.isArray(listed) && listed.every(isCloud)) return listed;
	return i.provider === "instruction-stack" ? [...CLOUDS] : ["cloudflare"];
}

/** What a provider reads, so the host can skip providers whose inputs are absent. */
export type ProviderNeed = "tree" | "files" | "log" | "base";

export interface AnalyzeContext {
	repo: string;
	ref: string;
	/** Optional comparison ref (e.g. main when analysing a fork branch). */
	base?: string;
	files: import("./repo-context.ts").RepoContext;
}

export interface InsightProvider {
	id: string;
	title: string;
	needs: ProviderNeed[];
	analyze(ctx: AnalyzeContext): Promise<Insight[]>;
}
