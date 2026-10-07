export type Severity = "info" | "warn" | "conflict";

export interface Evidence {
	repo: string;
	path: string;
	line?: number;
}

export interface Insight {
	provider: string;
	severity: Severity;
	scope: { repo: string; ref: string; path?: string; agent?: string };
	title: string;
	detail: string;
	evidence: Evidence[];
	metrics?: Record<string, unknown>;
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
