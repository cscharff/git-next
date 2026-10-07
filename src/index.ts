import { env } from "cloudflare:workers";
import sampleContext from "../samples/context-agents-demo-full.json" with { type: "json" };
import sampleInsights from "../samples/insights-demo.json" with { type: "json" };
import { artifactsSource } from "./core/artifacts-source.ts";
import { RepoContext } from "./core/repo-context.ts";
import { withDemoLayers } from "./demo-layers.ts";
import { buildContext } from "./providers/context/index.ts";
import { gatewayLogsSource } from "./providers/cost/logs.ts";
import { createRegistry } from "./registry.ts";

// Read-only analysis over Artifacts repos. No caller authentication yet, so local dev only.

/** The AI Gateway git.next routes model calls through and reads cost logs from. */
const GATEWAY_ID = "git-next";

// Offline samples the dashboard falls back to when there is no live run.
const SAMPLES: Record<string, unknown> = { "insights-demo.json": sampleInsights, "context-agents-demo-full.json": sampleContext };

// Real AI Gateway logs when the account id and a read token are configured (.dev.vars / Worker secrets),
// otherwise the cost provider uses the bundled fixture.
const registry = createRegistry(
	env.CF_ACCOUNT_ID && env.AIG_LOGS_TOKEN ? gatewayLogsSource({ accountId: env.CF_ACCOUNT_ID, gatewayId: GATEWAY_ID, token: env.AIG_LOGS_TOKEN }) : undefined,
);

/** The only models the smoke route may call: small and cheap, capped at 50 output tokens. */
const SMOKE_MODELS = ["anthropic/claude-haiku-4.5", "@cf/zai-org/glm-5.3-flash"];
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isLocal = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

/** Repo reader for a request; `demo` (local dev only) overlays fixtures/demo-layers without touching the repo. */
function contextFor(url: URL, repo: string, demo: boolean): RepoContext {
	const factory = (name: string) => artifactsSource(env.ARTIFACTS, name);
	return new RepoContext(demo && isLocal(url) ? withDemoLayers(factory, repo) : factory);
}

export default {
	async fetch(request) {
		const url = new URL(request.url);

		// GET /insights?repo=&ref=&base=&providers=a,b -> run providers and return their insights.
		if (request.method === "GET" && url.pathname === "/insights") {
			const repo = url.searchParams.get("repo") ?? "";
			if (!REPO_NAME.test(repo)) return Response.json({ error: "repo is required" }, { status: 400 });
			const ref = url.searchParams.get("ref") || "HEAD";
			const base = url.searchParams.get("base") || undefined;
			const only = url.searchParams.get("providers")?.split(",").filter(Boolean);
			const files = contextFor(url, repo, url.searchParams.get("layers") === "demo");
			const started = Date.now();
			try {
				const result = await registry.run({ repo, ref, base, files }, only);
				return Response.json({ repo, ref, base: base ?? null, ms: Date.now() - started, ...result });
			} catch (err) {
				return Response.json({ error: String(err) }, { status: 500 });
			}
		}

		// POST /context {repo, ref, task, paths[], budgetTokens} -> rules for those paths + best sections within budget.
		if (request.method === "POST" && url.pathname === "/context") {
			const body = (await request.json().catch(() => null)) as Partial<{ repo: string; ref: string; task: string; paths: string[]; budgetTokens: number; layers: string }> | null;
			if (!body || !REPO_NAME.test(body.repo ?? "") || !body.task) return Response.json({ error: "repo and task are required" }, { status: 400 });
			const files = contextFor(url, body.repo!, body.layers === "demo");
			try {
				return Response.json(
					await buildContext(files, {
						repo: body.repo!,
						ref: body.ref || "HEAD",
						task: body.task,
						paths: Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === "string") : [],
						budgetTokens: Math.min(Math.max(Number(body.budgetTokens) || 4000, 500), 200_000),
					}),
				);
			} catch (err) {
				return Response.json({ error: String(err) }, { status: 500 });
			}
		}

		const sample = url.pathname.match(/^\/samples\/([a-z0-9.-]+\.json)$/);
		if (request.method === "GET" && sample && SAMPLES[sample[1]]) return Response.json(SAMPLES[sample[1]]);

		// POST /dev/gateway-smoke (localhost only) -> one tiny Claude call and one Workers AI call through the gateway.
		if (request.method === "POST" && url.pathname === "/dev/gateway-smoke" && isLocal(url)) {
			const metadata = { developer: "chris", repo: "agents-demo-full", fork: "main", agent: "smoke-test", task: "gateway-check" };
			const gateway = { id: GATEWAY_ID, metadata };
			const prompt = "Reply with one short sentence: what is a Git fork?";
			const call = async (model: string) => {
				try {
					const out = (await env.AI.run(model as any, { messages: [{ role: "user", content: prompt }], max_tokens: 50 } as any, { gateway })) as any;
					const text = out?.response ?? out?.choices?.[0]?.message?.content ?? out?.content?.[0]?.text ?? "";
					return { model, ok: true, text: String(text).slice(0, 200), usage: out?.usage ?? null };
				} catch (err) {
					return { model, ok: false, error: String(err).slice(0, 300) };
				}
			};
			const body = (await request.json().catch(() => ({}))) as { models?: string[] };
			const models = (body.models ?? SMOKE_MODELS).filter((m) => SMOKE_MODELS.includes(m));
			const results = [];
			for (const m of models) results.push(await call(m));
			return Response.json({ gateway: GATEWAY_ID, metadata, results });
		}

		if (request.method === "GET" && url.pathname === "/providers") {
			return Response.json(registry.list().map(({ id, title, needs }) => ({ id, title, needs })));
		}

		return Response.json({ message: "Use GET /insights?repo=&ref=&base=, POST /context or GET /providers." }, { status: 404 });
	},
} satisfies ExportedHandler;
