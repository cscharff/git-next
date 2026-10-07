import { env } from "cloudflare:workers";
import { artifactsSource } from "./core/artifacts-source.ts";
import { RepoContext } from "./core/repo-context.ts";
import { withDemoLayers } from "./demo-layers.ts";
import { handleDevRoute } from "./dev-routes.ts";
import { buildContext } from "./providers/context/index.ts";
import { gatewayLogsSource, type CostSource } from "./providers/cost/logs.ts";
import { fixtureCostSource } from "./providers/cost/index.ts";
import { withMockedClouds } from "./providers/cost/mocked.ts";
import { createRegistry } from "./registry.ts";
import { getIndex, getResult, kvExtractCache, parsePushEvent, putResult } from "./results.ts";
import baselineCatalogJson from "../fixtures/org-baseline/catalog.json" with { type: "json" };
import { parseCatalog } from "./providers/catalog.ts";
import { llmExtractor, memoryCache, type ExtractCache } from "./providers/instruction-stack/llm-extract.ts";
import { keywordExtractor } from "./providers/instruction-stack/extract.ts";
import type { RuleExtractor } from "./providers/instruction-stack/types.ts";

// Read-only analysis over Artifacts repos. No caller authentication yet, so local dev only.

/** The AI Gateway git.next routes model calls through and reads cost logs from. */
const GATEWAY_ID = "git-next";

// Samples the dashboard falls back to when there is no live run (every samples/**/*.json, keyed by relative path).
const ALL_SAMPLES = Object.fromEntries(
	Object.entries(import.meta.glob<unknown>("../samples/**/*.json", { eager: true, import: "default" })).map(([path, json]) => [path.replace(/^\.\.\/samples\//, ""), json]),
);
const SAMPLES: Record<string, unknown> = ALL_SAMPLES;

/** The org's current catalog (org-baseline). Validated at startup so a bad catalog fails loudly. */
const BASELINE_CATALOG = parseCatalog(JSON.stringify(baselineCatalogJson));

// Real AI Gateway logs when the account id and a read token are configured (.dev.vars / Worker secrets),
// otherwise the cost provider uses the bundled fixture.
const costSource = env.CF_ACCOUNT_ID && env.AIG_LOGS_TOKEN ? gatewayLogsSource({ accountId: env.CF_ACCOUNT_ID, gatewayId: GATEWAY_ID, token: env.AIG_LOGS_TOKEN }) : undefined;
/** Rule extraction runs on Workers AI through the org gateway, cached by content hash (in-memory per isolate). */
const EXTRACT_MODEL = "@cf/zai-org/glm-5.3-flash";
const extractCache: ExtractCache = env.RESULTS ? kvExtractCache(env.RESULTS, memoryCache()) : memoryCache();
const modelExtractor: RuleExtractor | undefined = env.AI
	? llmExtractor({
			model: EXTRACT_MODEL,
			cache: extractCache,
			call: async (system, user) => {
				const out = (await env.AI.run(EXTRACT_MODEL as any, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 8000 } as any, { gateway: { id: GATEWAY_ID, metadata: { developer: "git-next", repo: "git-next", fork: "resolver", agent: "git-next-resolver", task: "extract#rules" } } })) as any;
				return String(out?.response ?? out?.choices?.[0]?.message?.content ?? "");
			},
		})
	: undefined;

/** `enforce` checks repos without their own catalog against the org baseline (?catalog=org). */
/** `extractor: null` means the deterministic keyword extractor (undefined would pick the default). */
const registryFor = (enforce: boolean, cost: CostSource | undefined = costSource, extractor: RuleExtractor | null = modelExtractor ?? null) =>
	createRegistry(cost, { baseline: BASELINE_CATALOG, enforceBaseline: enforce, maxFiles: 300, configOnlyWithoutCatalog: true }, extractor ?? keywordExtractor);
const registry = registryFor(false);

/** The only models the smoke route may call: small and cheap, capped at 50 output tokens. */
const SMOKE_MODELS = ["anthropic/claude-haiku-4.5", "@cf/zai-org/glm-5.3-flash"];
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isLocal = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
/** Demo layers are allowed locally, and when deployed with DEMO_LAYERS=on (for agents-demo-* repos only). */
const demoLayersFor = (url: URL | null, repo: string) => (url ? isLocal(url) : false) || (env.DEMO_LAYERS === "on" && repo.startsWith("agents-demo"));

/** Repo reader for a request; `demo` overlays fixtures/demo-layers (and `envs` the mocked environments) without touching the repo. */
function contextFor(url: URL | null, repo: string, demo: boolean, envs = false): RepoContext {
	const factory = (name: string) => artifactsSource(env.ARTIFACTS, name);
	return new RepoContext((demo || envs) && demoLayersFor(url, repo) ? withDemoLayers(factory, repo, { envs }) : factory);
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
			// ?envs=demo adds the MOCKED multi-cloud environments and the Bedrock/Vertex/vLLM cost fixtures (demo layers only).
			const envs = url.searchParams.get("envs") === "demo" && demoLayersFor(url, repo);
			const files = contextFor(url, repo, url.searchParams.get("layers") === "demo", envs);
			const started = Date.now();
			try {
				// ?cost=fixture uses the bundled team sample instead of live gateway logs (for the team-overspend view).
				const enforce = url.searchParams.get("catalog") === "org";
				const fixture = url.searchParams.get("cost") === "fixture";
				// ?extractor=keyword skips the model and uses the deterministic extractor.
				const keyword = url.searchParams.get("extractor") === "keyword";
				const cost = fixture ? fixtureCostSource() : costSource;
				const reg = enforce || fixture || keyword || envs ? registryFor(enforce, envs ? withMockedClouds(cost ?? fixtureCostSource()) : cost, keyword ? null : (modelExtractor ?? null)) : registry;
				const result = await reg.run({ repo, ref, base, files }, only);
				return Response.json({ repo, ref, base: base ?? null, ms: Date.now() - started, ...result });
			} catch (err) {
				return Response.json({ error: String(err) }, { status: 500 });
			}
		}

		// POST /context {repo, ref, task, paths[], budgetTokens} -> rules for those paths + best sections within budget.
		if (request.method === "POST" && url.pathname === "/context") {
			const body = (await request.json().catch(() => null)) as Partial<{ repo: string; ref: string; task: string; paths: string[]; budgetTokens: number; layers: string; catalog: string; extractor: string }> | null;
			if (!body || !REPO_NAME.test(body.repo ?? "") || !body.task) return Response.json({ error: "repo and task are required" }, { status: 400 });
			const files = contextFor(url, body.repo!, body.layers === "demo");
			try {
				return Response.json(
					await buildContext(
						files,
						{
						repo: body.repo!,
						ref: body.ref || "HEAD",
						task: body.task,
						paths: Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === "string") : [],
						budgetTokens: Math.min(Math.max(Number(body.budgetTokens) || 4000, 500), 200_000),
						...(body.catalog === "org" ? { catalog: BASELINE_CATALOG } : {}),
						},
						undefined,
						body.extractor === "keyword" ? undefined : modelExtractor,
					),
				);
			} catch (err) {
				return Response.json({ error: String(err) }, { status: 500 });
			}
		}

		const sample = url.pathname.match(/^\/samples\/((?:[a-z0-9-]+\/)?[a-z0-9.-]+\.json)$/);
		if (request.method === "GET" && sample && SAMPLES[sample[1]]) return Response.json(SAMPLES[sample[1]]);

		if (url.pathname.startsWith("/dev/") && url.pathname !== "/dev/gateway-smoke" && url.pathname !== "/dev/enqueue") {
			if (!isLocal(url)) return Response.json({ error: "not found" }, { status: 404 });
			try {
				const res = await handleDevRoute(request, url, env, GATEWAY_ID);
				if (res) return res;
			} catch (err) {
				return Response.json({ error: String(err).slice(0, 500) }, { status: 500 });
			}
		}

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

		if (request.method === "GET" && url.pathname === "/catalog") return Response.json(BASELINE_CATALOG);

		// Stored results written by the queue consumer on every push; the dashboard polls /results/index.
		if (request.method === "GET" && url.pathname === "/results/index") return Response.json(await getIndex(env.RESULTS));
		if (request.method === "GET" && url.pathname === "/results") {
			const repo = url.searchParams.get("repo") ?? "";
			const ref = url.searchParams.get("ref") || "main";
			if (!REPO_NAME.test(repo) || !/^[\w./-]{1,100}$/.test(ref)) return Response.json({ error: "repo and ref are required" }, { status: 400 });
			const stored = await getResult(env.RESULTS, repo, ref);
			return stored ? Response.json(stored) : Response.json({ error: "no stored result yet" }, { status: 404 });
		}

		// POST /dev/enqueue {"repo","ref"} (localhost only): simulate an Artifacts push event for local testing.
		if (request.method === "POST" && url.pathname === "/dev/enqueue" && isLocal(url)) {
			const body = (await request.json().catch(() => ({}))) as { repo?: string; ref?: string };
			if (!REPO_NAME.test(body.repo ?? "")) return Response.json({ error: "repo is required" }, { status: 400 });
			using handle = await env.ARTIFACTS.get(body.repo!);
			const [head, prev] = await handle.log({ ref: body.ref || "main", limit: 2 });
			const event = {
				type: "cf.artifacts.repo.pushed",
				source: { type: "artifacts.repo", namespace: "default", repoName: body.repo },
				payload: { ref: `refs/heads/${body.ref || "main"}`, before: prev?.hash ?? "0".repeat(40), after: head.hash, commits: [{ id: head.hash, message: head.message, author: { name: head.author.name } }], totalCommitsCount: 1 },
				metadata: { simulated: true, eventTimestamp: new Date().toISOString() },
			};
			await env.PUSHES.send(event);
			return Response.json({ enqueued: true, repo: body.repo, after: head.hash });
		}

		if (request.method === "GET" && url.pathname === "/providers") {
			return Response.json(registry.list().map(({ id, title, needs }) => ({ id, title, needs })));
		}

		return Response.json({ message: "Use GET /insights?repo=&ref=&base=, POST /context or GET /providers." }, { status: 404 });
	},

	/** Artifacts push events (via event subscriptions): analyse the pushed commit and store the results. */
	async queue(batch) {
		for (const message of batch.messages) {
			const push = parsePushEvent(message.body, "default");
			if (!push) {
				message.ack();
				continue;
			}
			const started = Date.now();
			try {
				const files = contextFor(null, push.repo, true);
				const result = await registry.run({ repo: push.repo, ref: push.trigger.after, base: push.trigger.before ?? undefined, files });
				const entry = await putResult(env.RESULTS, push.repo, push.ref, { repo: push.repo, ref: push.ref, commit: push.trigger.after, base: push.trigger.before, ms: Date.now() - started, ...result }, push.trigger);
				console.log(JSON.stringify({ event: "analysed", repo: push.repo, ref: push.ref, after: push.trigger.after.slice(0, 10), ms: entry.ms, conflicts: entry.conflicts, catalogViolations: entry.catalogViolations }));
				message.ack();
			} catch (err) {
				console.error(JSON.stringify({ event: "analysis-failed", repo: push.repo, ref: push.ref, error: String(err).slice(0, 300) }));
				message.retry({ delaySeconds: 30 });
			}
		}
	},
} satisfies ExportedHandler<Env>;
