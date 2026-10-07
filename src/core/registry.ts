import type { AnalyzeContext, Insight, InsightProvider } from "./types.ts";

export class ProviderRegistry {
	private providers = new Map<string, InsightProvider>();

	register(provider: InsightProvider): this {
		this.providers.set(provider.id, provider);
		return this;
	}

	list(): InsightProvider[] {
		return [...this.providers.values()];
	}

	/** Runs every provider; one provider failing yields an error entry instead of failing the run. */
	async run(ctx: AnalyzeContext, only?: string[]) {
		const selected = this.list().filter((p) => !only || only.includes(p.id));
		const results = await Promise.all(
			selected.map(async (p) => {
				const started = Date.now();
				try {
					const insights = await p.analyze(ctx);
					return { id: p.id, ok: true as const, ms: Date.now() - started, insights };
				} catch (err) {
					return { id: p.id, ok: false as const, ms: Date.now() - started, error: String(err), insights: [] as Insight[] };
				}
			}),
		);
		return {
			providers: results.map(({ insights, ...r }) => ({ ...r, count: insights.length })),
			insights: results.flatMap((r) => r.insights),
		};
	}
}
