import { env } from "cloudflare:workers";
import { artifactsSource } from "./core/artifacts-source.ts";
import { ProviderRegistry } from "./core/registry.ts";
import { RepoContext } from "./core/repo-context.ts";
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

		if (request.method === "GET" && url.pathname === "/providers") {
			return Response.json(registry.list().map(({ id, title, needs }) => ({ id, title, needs })));
		}

		return Response.json({ message: "Use GET /insights?repo=&ref=&base= or GET /providers." }, { status: 404 });
	},
} satisfies ExportedHandler;
