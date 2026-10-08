import { WorkflowEntrypoint, env, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { artifactsSource } from "./core/artifacts-source.ts";
import { RepoContext, type TreeFile } from "./core/repo-context.ts";
import type { PushEvent } from "./code.ts";
import { handleCodeRoute, type CodeDeps } from "./code-routes.ts";
import { handleWorkRoute, projectOf, type WorkRouteDeps } from "./work-routes.ts";
import { overlaps, workInFlight, type WorkItem } from "./work.ts";
import { DEMO_LAYERS_REPO, withDemoLayers } from "./demo-layers.ts";
import { handleDevRoute } from "./dev-routes.ts";
import { buildContext, dedupeSections, sectionsOf } from "./providers/context/index.ts";
import { Bm25Retriever } from "./providers/context/retrieve.ts";
import type { Section } from "./providers/context/sections.ts";
import { EMBED_MODEL, HybridRetriever, VectorizeRetriever, coverage, indexSections, type Manifest } from "./providers/context/vectorize.ts";
import { gatewayLogsSource, type CostSource } from "./providers/cost/logs.ts";
import { fixtureCostSource } from "./providers/cost/index.ts";
import { withMockedClouds } from "./providers/cost/mocked.ts";
import { accessToken, verifyAccess } from "./access.ts";
import { createRegistry } from "./registry.ts";
import { getIndex, getResult, kvExtractCache, parsePushEvent, putResult, type PushTrigger } from "./results.ts";
import { classifyChange, instanceIdFor, parseDecision, reviewKey, type ReviewRecord, type ReviewStatus } from "./review.ts";
import baselineCatalogJson from "../fixtures/org-baseline/catalog.json" with { type: "json" };
import { parseCatalog } from "./providers/catalog.ts";
import { llmExtractor, memoryCache, type ExtractCache } from "./providers/instruction-stack/llm-extract.ts";
import { keywordExtractor } from "./providers/instruction-stack/extract.ts";
import { DEFAULT_ORDER, validOrder, type LayerKind, type PrecedenceOverride, type RuleExtractor } from "./providers/instruction-stack/types.ts";

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
// ── embeddings ──
const embed = async (texts: string[]): Promise<number[][]> => {
	const out = (await env.AI.run(EMBED_MODEL as any, { text: texts } as any, { gateway: { id: GATEWAY_ID, metadata: { developer: "git-next", repo: "git-next", fork: "resolver", agent: "git-next-indexer", task: "embed#sections" } } })) as any;
	return out.data as number[][];
};
const manifest: Manifest = {
	get: async (repo) => (await env.RESULTS.get(`vindex/${repo}`, "json")) as string[] | null,
	put: async (repo, ids) => env.RESULTS.put(`vindex/${repo}`, JSON.stringify(ids)),
};
/** Hybrid (BM25 + vectors) once ≥90% of the repo's sections are indexed; BM25 until then, or when asked. */
const retrieverFor = (repo: string, forceBm25: boolean) => async (sections: Section[]) => {
	const bm25 = new Bm25Retriever(sections);
	if (forceBm25 || !env.SECTIONS) return bm25;
	return (await coverage(manifest, repo, sections)) >= 0.9 ? new HybridRetriever(bm25, new VectorizeRetriever(repo, sections, embed, env.SECTIONS)) : bm25;
};

// ── precedence overrides (KV, admin-only) ──
const adminEmails = () => String(env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
async function precedenceFor(repo: string): Promise<{ override: PrecedenceOverride | null; audit: unknown[] }> {
	if (!env.RESULTS) return { override: null, audit: [] };
	const [override, audit] = await Promise.all([env.RESULTS.get(`precedence/${repo}`, "json"), env.RESULTS.get(`precedence-audit/${repo}`, "json")]);
	return { override: (override as PrecedenceOverride | null) ?? null, audit: (audit as unknown[] | null) ?? [] };
}

/** `extractor: null` means the deterministic keyword extractor (undefined would pick the default). */
const registryFor = (enforce: boolean, cost: CostSource | undefined = costSource, extractor: RuleExtractor | null = modelExtractor ?? null) =>
	createRegistry(cost, { baseline: BASELINE_CATALOG, enforceBaseline: enforce, maxFiles: 300, configOnlyWithoutCatalog: true }, extractor ?? keywordExtractor, { precedence: precedenceFor });
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

/** Wiring for the Code view: the same repo readers the analysis uses (demo layers included where allowed). */
const codeDeps = (url: URL): CodeDeps => ({
	// Demo layers overlay the agents-demo-* repos only (as the dashboard's analysis does).
	context: (_repo, via) => contextFor(url, via, via.startsWith("agents-demo")),
	async listRepos() {
		const { repos } = await env.ARTIFACTS.list({ limit: 100 });
		const out = repos.map((r) => ({ name: r.name, description: r.description, defaultBranch: r.defaultBranch, lastPushAt: r.lastPushAt, source: r.source }));
		if (demoLayersFor(url, "agents-demo-full") && !out.some((r) => r.name === DEMO_LAYERS_REPO)) out.push({ name: DEMO_LAYERS_REPO, description: "Demo instruction layers (org, contract, tool, personal): fixtures overlaid at analysis time", defaultBranch: "HEAD", lastPushAt: null, source: null });
		return out;
	},
	events: async () => (await getIndex(env.RESULTS)).events as PushEvent[],
	treeCache: {
		get: async (key) => (await env.RESULTS.get(`codetree/${key}`, "json")) as TreeFile[] | null,
		put: (key, files) => env.RESULTS.put(`codetree/${key}`, JSON.stringify(files), { expirationTtl: 60 * 60 * 24 * 7 }),
	},
	latest: async (repo, ref) => (await getResult(env.RESULTS, repo, ref)) as Record<string, any> | null,
});

/** Fork sources, cached per isolate ("artifacts:default/agents-demo-full" → "agents-demo-full"). */
const sources = new Map<string, Promise<string | null>>();
const sourceOf = (repo: string) => {
	let s = sources.get(repo);
	if (!s) {
		s = (async () => {
			using handle = await env.ARTIFACTS.get(repo);
			const source = (await handle.info()).source ?? "";
			return source.match(/^artifacts:default\/(.+)$/)?.[1] ?? null;
		})().catch(() => null);
		sources.set(repo, s);
	}
	return s;
};

/** Wiring for work in flight, overlap and attempts: live index, fork sources, gateway records, org catalog. */
const workDeps = (url: URL | null): WorkRouteDeps => ({
	index: async () => (await getIndex(env.RESULTS)).index,
	sourceOf,
	files: (repo) => contextFor(url, repo, false),
	async forksOf(project) {
		const { repos } = await env.ARTIFACTS.list({ limit: 100 });
		return repos.filter((r) => r.source === `artifacts:default/${project}`).map((r) => r.name);
	},
	cache: {
		get: async (key) => (await env.RESULTS.get(`work/${key}`, "json")) as WorkItem | null,
		put: (key, item) => env.RESULTS.put(`work/${key}`, JSON.stringify(item), { expirationTtl: 60 * 60 * 24 * 14 }),
	},
	catalog: BASELINE_CATALOG,
	costs: async (project) => (costSource ? costSource.records({ repo: project }) : []),
});

export default {
	async fetch(request) {
		const url = new URL(request.url);

		// Deployed: only requests that passed Cloudflare Access (verified JWT for this app) get anything, assets included.
		let identity = { email: "local-admin", local: true };
		if (!isLocal(url)) {
			const configuredAud: string = env.ACCESS_AUD;
			const aud = configuredAud === "unset" ? "" : configuredAud;
			if (!aud) return new Response("git.next: Cloudflare Access is not configured for this deployment yet.", { status: 401 });
			const user = await verifyAccess(accessToken(request), { teamDomain: env.ACCESS_TEAM_DOMAIN, aud }).catch(() => null);
			if (!user) return new Response("Unauthorized", { status: 401 });
			identity = { email: user.email ?? user.sub ?? "unknown", local: false };
		}
		const isAdmin = identity.local || adminEmails().includes(identity.email.toLowerCase());

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
			const body = (await request.json().catch(() => null)) as Partial<{ repo: string; ref: string; task: string; paths: string[]; budgetTokens: number; layers: string; catalog: string; extractor: string; retriever: string }> | null;
			if (!body || !REPO_NAME.test(body.repo ?? "") || !body.task) return Response.json({ error: "repo and task are required" }, { status: 400 });
			const files = contextFor(url, body.repo!, body.layers === "demo");
			const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === "string") : [];
			// Who else is already changing these files (other forks and branches of the same project).
			const inFlight = (async () => {
				const deps = workDeps(url);
				const project = await projectOf(deps, body.repo!);
				return overlaps(await workInFlight(deps, project), paths, { repo: body.repo!, ...(body.ref && body.ref !== "HEAD" ? { ref: body.ref } : {}) });
			})().catch(() => []);
			try {
				const context = await buildContext(
						files,
						{
						repo: body.repo!,
						ref: body.ref || "HEAD",
						task: body.task,
						paths,
						budgetTokens: Math.min(Math.max(Number(body.budgetTokens) || 4000, 500), 200_000),
						...(body.catalog === "org" ? { catalog: BASELINE_CATALOG } : {}),
						},
						retrieverFor(body.repo!, body.retriever === "bm25"),
						body.extractor === "keyword" ? undefined : modelExtractor,
					);
				return Response.json({ ...context, inFlight: await inFlight });
			} catch (err) {
				return Response.json({ error: String(err) }, { status: 500 });
			}
		}

		const sample = url.pathname.match(/^\/samples\/((?:[a-z0-9-]+\/)?[a-z0-9.-]+\.json)$/);
		if (request.method === "GET" && sample && SAMPLES[sample[1]]) return Response.json(SAMPLES[sample[1]]);

		if (url.pathname.startsWith("/dev/") && url.pathname !== "/dev/gateway-smoke" && url.pathname !== "/dev/enqueue" && url.pathname !== "/dev/index") {
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

		if (request.method === "GET" && url.pathname === "/whoami") return Response.json({ email: identity.email, admin: isAdmin, local: identity.local });

		// Precedence: org › contract › project › tool › personal by default; admins may change it per repo (if org policy allows).
		if (url.pathname === "/precedence") {
			const repo = (request.method === "GET" ? url.searchParams.get("repo") : null) ?? "";
			if (request.method === "GET") {
				if (!REPO_NAME.test(repo)) return Response.json({ error: "repo is required" }, { status: 400 });
				return Response.json({ ...(await precedenceFor(repo)), policy: BASELINE_CATALOG.policy?.precedenceOverride ?? "never", admin: isAdmin });
			}
			if (request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { repo?: string; order?: unknown; reason?: string };
				if (!REPO_NAME.test(body.repo ?? "")) return Response.json({ error: "repo is required" }, { status: 400 });
				if ((BASELINE_CATALOG.policy?.precedenceOverride ?? "never") !== "admins") return Response.json({ error: "org policy does not allow precedence overrides" }, { status: 403 });
				if (!isAdmin) return Response.json({ error: "only admins can change precedence" }, { status: 403 });
				const reason = String(body.reason ?? "").trim().slice(0, 300);
				if (reason.length < 10) return Response.json({ error: "a reason (10+ characters) is required; it goes in the audit trail" }, { status: 400 });
				const reset = body.order === null;
				if (!reset && !validOrder(body.order)) return Response.json({ error: `order must list each of ${DEFAULT_ORDER.join(", ")} exactly once, or be null to reset` }, { status: 400 });
				const entry = { action: reset ? "reset" : "set", order: reset ? DEFAULT_ORDER : (body.order as LayerKind[]), by: identity.email, at: new Date().toISOString(), reason };
				const auditKey = `precedence-audit/${body.repo}`;
				const audit = ((await env.RESULTS.get(auditKey, "json")) as unknown[] | null) ?? [];
				await env.RESULTS.put(auditKey, JSON.stringify([entry, ...audit].slice(0, 100)));
				if (reset) await env.RESULTS.delete(`precedence/${body.repo}`);
				else await env.RESULTS.put(`precedence/${body.repo}`, JSON.stringify({ order: entry.order, by: entry.by, at: entry.at, reason }));
				// Re-analyse now so the dashboard shows the new winners (and the override) straight away.
				using handle = await env.ARTIFACTS.get(body.repo!);
				const [head] = await handle.log({ ref: "main", limit: 1 });
				const started = Date.now();
				const files = contextFor(null, body.repo!, true);
				const result = await registry.run({ repo: body.repo!, ref: head.hash, files });
				await putResult(env.RESULTS, body.repo!, "main", { repo: body.repo, ref: "main", commit: head.hash, base: null, ms: Date.now() - started, ...result }, null);
				return Response.json({ ok: true, entry });
			}
		}

		// Stored results written by the queue consumer on every push; the dashboard polls /results/index.
		if (request.method === "GET" && url.pathname === "/results/index") return Response.json(await getIndex(env.RESULTS));
		if (request.method === "GET" && url.pathname === "/results") {
			const repo = url.searchParams.get("repo") ?? "";
			const ref = url.searchParams.get("ref") || "main";
			if (!REPO_NAME.test(repo) || !/^[\w./-]{1,100}$/.test(ref)) return Response.json({ error: "repo and ref are required" }, { status: 400 });
			const stored = await getResult(env.RESULTS, repo, ref);
			return stored ? Response.json(stored) : Response.json({ error: "no stored result yet" }, { status: 404 });
		}

		// POST /dev/index {"repo","ref"} (localhost only): embed and index a repo's markdown sections now.
		if (request.method === "POST" && url.pathname === "/dev/index" && isLocal(url)) {
			const body = (await request.json().catch(() => ({}))) as { repo?: string; ref?: string };
			if (!REPO_NAME.test(body.repo ?? "")) return Response.json({ error: "repo is required" }, { status: 400 });
			const started = Date.now();
			const files = contextFor(url, body.repo!, false);
			const result = await indexSections({ embed, index: env.SECTIONS, manifest }, body.repo!, dedupeSections(await sectionsOf(files, body.repo!, body.ref || "main")).sections);
			return Response.json({ repo: body.repo, ...result, ms: Date.now() - started });
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

		// GET /reviews?repo= : recent push reviews (PushReview Workflow runs) with status, timeline and reasons.
		if (request.method === "GET" && url.pathname === "/reviews") {
			const repo = url.searchParams.get("repo");
			const list = await env.RESULTS.list<{ repo: string; updatedAt: string }>({ prefix: repo && REPO_NAME.test(repo) ? `review/${repo}/` : "review/" });
			const recent = list.keys.sort((a, b) => (b.metadata?.updatedAt ?? "").localeCompare(a.metadata?.updatedAt ?? "")).slice(0, 25);
			const records = (await Promise.all(recent.map((k) => env.RESULTS.get(k.name, "json")))).filter(Boolean);
			return Response.json({ reviews: records, admin: isAdmin });
		}
		// POST /reviews/decide {repo, ref, after, decision: approve|reject, reason} : admins only; resumes the Workflow.
		if (request.method === "POST" && url.pathname === "/reviews/decide") {
			if (!isAdmin) return Response.json({ error: "only admins can approve or reject a review" }, { status: 403 });
			const d = parseDecision(await request.json().catch(() => null));
			if (typeof d === "string") return Response.json({ error: d }, { status: 400 });
			const record = (await env.RESULTS.get(reviewKey(d.repo, d.ref, d.after), "json")) as ReviewRecord | null;
			if (!record) return Response.json({ error: "no review for that push" }, { status: 404 });
			if (record.status !== "needs-review") return Response.json({ error: `review is ${record.status}, not waiting for a decision` }, { status: 409 });
			const instance = await env.PUSH_REVIEW.get(record.instanceId);
			await instance.sendEvent({ type: "review", payload: { decision: d.decision, reason: d.reason, by: identity.email } });
			return Response.json({ ok: true, instanceId: record.instanceId, decision: d.decision });
		}

		// GET /work* : forks and branches in flight, overlap checks, attempt comparison.
		if (url.pathname === "/work" || url.pathname.startsWith("/work/")) {
			try {
				const res = await handleWorkRoute(request, url, workDeps(url));
				if (res) return res;
			} catch (err) {
				return Response.json({ error: String(err).slice(0, 500) }, { status: 500 });
			}
		}

		// GET /code/* : read-only file tree, files, history and diffs for the Code view.
		if (url.pathname.startsWith("/code/")) {
			try {
				const res = await handleCodeRoute(request, url, codeDeps(url));
				if (res) return res;
			} catch (err) {
				return Response.json({ error: String(err).slice(0, 500) }, { status: 500 });
			}
		}

		if (request.method === "GET" && url.pathname === "/providers") {
			return Response.json(registry.list().map(({ id, title, needs }) => ({ id, title, needs })));
		}

		if (!url.pathname.startsWith("/insights") && !url.pathname.startsWith("/context") && !url.pathname.startsWith("/dev/")) return env.ASSETS.fetch(request);
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
			// Each push becomes a PushReview Workflow instance (one per repo/ref/commit; a redelivered event finds it exists).
			try {
				await env.PUSH_REVIEW.create({ id: instanceIdFor(push.repo, push.ref, push.trigger.after), params: push });
				console.log(JSON.stringify({ event: "review-started", repo: push.repo, ref: push.ref, after: push.trigger.after.slice(0, 10) }));
				message.ack();
			} catch (err) {
				if (/already exists|duplicate/i.test(String(err))) message.ack();
				else {
					console.error(JSON.stringify({ event: "review-start-failed", repo: push.repo, error: String(err).slice(0, 300) }));
					message.retry({ delaySeconds: 30 });
				}
			}
		}
	},
} satisfies ExportedHandler<Env>;

// ── PushReview Workflow ───────────────────────────────────────────────────────

type PushParams = { repo: string; ref: string; trigger: PushTrigger };
type ReviewDecisionEvent = { decision: "approve" | "reject"; reason: string; by: string };
const STEP = { retries: { limit: 2, delay: "30 seconds" as const, backoff: "exponential" as const }, timeout: "15 minutes" as const };

/** Reads, changes and writes the push's review record (only this instance writes it, so no lost updates). */
async function updateReview(key: string, change: (r: ReviewRecord) => ReviewRecord) {
	const current = (await env.RESULTS.get(key, "json")) as ReviewRecord;
	const next = change(current);
	await env.RESULTS.put(key, JSON.stringify(next), { metadata: { repo: next.repo, ref: next.ref, after: next.after, status: next.status, updatedAt: next.updatedAt }, expirationTtl: 60 * 60 * 24 * 30 });
	return next;
}
const stepped = (r: ReviewRecord, name: string, started: number, detail?: string, status?: ReviewStatus): ReviewRecord => ({
	...r,
	...(status ? { status } : {}),
	updatedAt: new Date().toISOString(),
	steps: [...r.steps, { name, at: new Date(started).toISOString(), ms: Date.now() - started, ...(detail ? { detail } : {}) }],
});

/**
 * One push, end to end: analyse it (git.next's providers, stored for the dashboard), index its markdown for sliced
 * context, classify whether the change is sensitive, and if it is, wait for a person (an admin) to approve or reject
 * it before it may merge. Every step is recorded on the review record the dashboard shows.
 */
export class PushReview extends WorkflowEntrypoint<Env, PushParams> {
	async run(event: Readonly<WorkflowEvent<PushParams>>, step: WorkflowStep) {
		const { repo, ref, trigger } = event.payload;
		const key = reviewKey(repo, ref, trigger.after);

		await step.do("start", async () => {
			const now = new Date().toISOString();
			const record: ReviewRecord = { repo, ref, after: trigger.after, before: trigger.before, instanceId: event.instanceId, status: "running", startedAt: now, updatedAt: now, commit: trigger.commits[0] ? { message: trigger.commits[0].message, author: trigger.commits[0].author } : null, reasons: [], steps: [] };
			await env.RESULTS.put(key, JSON.stringify(record), { metadata: { repo, ref, after: trigger.after, status: record.status, updatedAt: now }, expirationTtl: 60 * 60 * 24 * 30 });
			return true;
		});

		const summary = await step.do("analyse", STEP, async () => {
			const started = Date.now();
			const files = contextFor(null, repo, true);
			const result = await registry.run({ repo, ref: trigger.after, base: trigger.before ?? undefined, files });
			const entry = await putResult(env.RESULTS, repo, ref, { repo, ref, commit: trigger.after, base: trigger.before, ms: Date.now() - started, ...result }, trigger);
			const s = { conflicts: entry.conflicts, catalogViolations: entry.catalogViolations, warnings: entry.warnings, insights: entry.insights };
			await updateReview(key, (r) => ({ ...stepped(r, "analyse", started, `${s.insights} insights, ${s.conflicts} conflicts, ${s.catalogViolations} catalog`), summary: s }));
			return s;
		});

		await step.do("index embeddings", STEP, async () => {
			const started = Date.now();
			let detail: string;
			try {
				const files = contextFor(null, repo, true);
				const indexed = await indexSections({ embed, index: env.SECTIONS, manifest }, repo, dedupeSections(await sectionsOf(files, repo, trigger.after)).sections);
				detail = `${indexed.embedded} new of ${indexed.total} sections`;
			} catch (err) {
				// Sliced context falls back to BM25; this never blocks a review.
				detail = `skipped: ${String(err).slice(0, 120)}`;
			}
			await updateReview(key, (r) => stepped(r, "index embeddings", started, detail));
			return detail;
		});

		const reasons = await step.do("classify", STEP, async () => {
			const started = Date.now();
			const files = contextFor(null, repo, false);
			// A new branch has no "before": measure it from the project's main.
			const base = trigger.before ?? (await files.log(repo, "main", 1))[0]?.hash ?? null;
			const changed = base ? await files.changedFiles(repo, base, trigger.after) : [];
			const text = async (path: string, side: "before" | "after") => {
				const b = await files.readBytes(repo, side === "before" ? base! : trigger.after, path).catch(() => null);
				return b ? new TextDecoder().decode(b) : null;
			};
			const found = await classifyChange(changed, text, BASELINE_CATALOG);
			await updateReview(key, (r) => ({ ...stepped(r, "classify", started, found.length ? `${found.length} sensitive change(s) in ${changed.length} file(s)` : `nothing sensitive in ${changed.length} file(s)`), reasons: found }));
			return found;
		});

		if (!reasons.length) {
			await step.do("auto-approve", async () => {
				await updateReview(key, (r) => stepped(r, "auto-approve", Date.now(), "no sensitive changes: merge allowed", "auto-approved"));
				return true;
			});
			return { status: "auto-approved", summary };
		}

		await step.do("request human review", async () => {
			await updateReview(key, (r) => stepped(r, "request human review", Date.now(), [...new Set(reasons.map((x) => x.why.replace(/^(adds|modifies|removes) a file that /, "")))].slice(0, 3).join("; "), "needs-review"));
			return true;
		});
		let decision: ReviewDecisionEvent | null = null;
		try {
			decision = (await step.waitForEvent<ReviewDecisionEvent>("human review", { type: "review", timeout: "7 days" })).payload;
		} catch {
			decision = null;
		}
		const final: ReviewStatus = !decision ? "expired" : decision.decision === "approve" ? "approved" : "rejected";
		await step.do("record decision", async () => {
			await updateReview(key, (r) => ({
				...stepped(r, "record decision", Date.now(), decision ? `${decision.decision}d by ${decision.by}: ${decision.reason}` : "no decision within 7 days", final),
				...(decision ? { decision: { by: decision.by, at: new Date().toISOString(), decision: decision.decision, reason: decision.reason } } : {}),
			}));
			return true;
		});
		return { status: final, summary };
	}
}
