// Local-dev-only routes used by scripts/demo-agents.ts. They mint credentials and spend model credits,
// so the caller must check isLocal() before dispatching here, and they must never be deployed as-is.

/** Models the demo agents may call through the gateway, with a hard output cap. */
export const AGENT_MODELS = [
	"anthropic/claude-fable-5.1",
	"anthropic/claude-opus-5.5",
	"anthropic/claude-opus-4.8",
	"anthropic/claude-sonnet-5.5",
	"anthropic/claude-sonnet-5",
	"anthropic/claude-haiku-4.5",
	"@cf/zai-org/glm-5.3-flash",
];
const MAX_OUTPUT_TOKENS = 4000;
const SOURCE_REPO = "agents-demo-full";
const FORK_NAME = /^agents-demo-[a-z0-9-]{1,40}$/;

const bad = (error: string, status = 400) => Response.json({ error }, { status });
const errCode = (err: unknown) => (err as { code?: string })?.code;

export async function handleDevRoute(request: Request, url: URL, env: Env, gatewayId: string): Promise<Response | null> {
	if (request.method !== "POST") return null;
	const body = (await request.json().catch(() => ({}))) as Record<string, any>;

	// POST /dev/fork {"name"} -> fork agents-demo-full (default branch only); reuses an existing fork.
	if (url.pathname === "/dev/fork") {
		const name = String(body.name ?? "");
		if (!FORK_NAME.test(name)) return bad("name must look like agents-demo-<slug>");
		try {
			using existing = await env.ARTIFACTS.get(name);
			const info = await existing.info();
			return Response.json({ name: info.name, remote: info.remote, defaultBranch: info.defaultBranch, source: info.source, created: false });
		} catch (err) {
			if (errCode(err) !== "NOT_FOUND" && !String(err).includes("not found")) return bad(`get(): ${String(err)} [code ${errCode(err) ?? "?"}]`, 502);
		}
		using source = await env.ARTIFACTS.get(SOURCE_REPO);
		let forked;
		try {
			forked = await source.fork(name, { description: `git.next demo fork of ${SOURCE_REPO}`, defaultBranchOnly: true });
		} catch (err) {
			return bad(`fork(): ${String(err)} [code ${errCode(err) ?? "?"}]`, 502);
		}
		return Response.json({ name: forked.name, remote: forked.remote, defaultBranch: forked.defaultBranch, created: true });
	}

	// POST /dev/token {"repo","scope","ttl"} -> short-lived token for a demo repo (returned to the local caller only).
	if (url.pathname === "/dev/token") {
		const repo = String(body.repo ?? "");
		if (repo !== SOURCE_REPO && !FORK_NAME.test(repo)) return bad("repo must be agents-demo-full or a demo fork");
		const scope = body.scope === "write" ? "write" : "read";
		const ttl = Math.min(Math.max(Number(body.ttl) || 600, 60), 1800);
		using handle = await env.ARTIFACTS.get(repo);
		const info = await handle.info();
		const token = await handle.createToken(scope, ttl);
		return Response.json({ repo: info.name, remote: info.remote, scope, expiresAt: token.expiresAt, token: token.plaintext });
	}

	// POST /dev/llm {"model","system","prompt","maxTokens","metadata"} -> one model call through the gateway.
	if (url.pathname === "/dev/llm") {
		const model = String(body.model ?? "");
		if (!AGENT_MODELS.includes(model)) return bad(`model must be one of ${AGENT_MODELS.join(", ")}`);
		const metadata = Object.fromEntries(Object.entries(body.metadata ?? {}).filter(([k, v]) => /^[a-z]+$/.test(k) && typeof v === "string").map(([k, v]) => [k, String(v).slice(0, 120)]));
		const max_tokens = Math.min(Math.max(Number(body.maxTokens) || 1000, 16), MAX_OUTPUT_TOKENS);
		// Anthropic models take the system prompt as a top-level field; Workers AI models as a system message.
		const user = { role: "user", content: String(body.prompt ?? "") };
		const input = model.startsWith("anthropic/")
			? { ...(body.system ? { system: String(body.system) } : {}), messages: [user], max_tokens }
			: { messages: [...(body.system ? [{ role: "system", content: String(body.system) }] : []), user], max_tokens };
		try {
			const out = (await env.AI.run(model as any, input as any, { gateway: { id: gatewayId, metadata } })) as any;
			const text = out?.response ?? out?.choices?.[0]?.message?.content ?? out?.content?.map?.((c: any) => c.text ?? "").join("") ?? "";
			return Response.json({ model, text: String(text), usage: out?.usage ?? null, stopReason: out?.stop_reason ?? out?.choices?.[0]?.finish_reason ?? null });
		} catch (err) {
			return bad(String(err).slice(0, 500), 502);
		}
	}
	return null;
}
