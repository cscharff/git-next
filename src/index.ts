import { env } from "cloudflare:workers";
import { artifactsSource } from "./core/artifacts-source.ts";
import { ProviderRegistry } from "./core/registry.ts";
import { RepoContext } from "./core/repo-context.ts";
import { buildContext } from "./providers/context/index.ts";
import { instructionStackProvider } from "./providers/instruction-stack/index.ts";
import { resourceMapProvider } from "./providers/resource-map.ts";

// Read-only analysis over Artifacts repos. No caller authentication yet, so local dev only.
export const registry = new ProviderRegistry().register(resourceMapProvider).register(instructionStackProvider());

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
			const files = new RepoContext((name) => artifactsSource(env.ARTIFACTS, name));
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
			const body = (await request.json().catch(() => null)) as Partial<{ repo: string; ref: string; task: string; paths: string[]; budgetTokens: number }> | null;
			if (!body || !REPO_NAME.test(body.repo ?? "") || !body.task) return Response.json({ error: "repo and task are required" }, { status: 400 });
			const files = new RepoContext((name) => artifactsSource(env.ARTIFACTS, name));
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

		if (request.method === "GET" && url.pathname === "/providers") {
			return Response.json(registry.list().map(({ id, title, needs }) => ({ id, title, needs })));
		}

		return Response.json({ message: "Use GET /insights?repo=&ref=&base=, POST /context or GET /providers." }, { status: 404 });
	},
} satisfies ExportedHandler;
