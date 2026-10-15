import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Account-specific values come from .dev.vars (DEPLOY_*; `npm run dev` and `npm run deploy` load it, and deploy keeps
// them out of the Worker's secrets). Without them, Access stays "unset" (fail closed) and RESULTS has no namespace.
declare const process: { env: Record<string, string | undefined> }; // the config runs in Node; the Worker's tsconfig has no Node types
const deploy = (name: string, fallback: string) => process.env[`DEPLOY_${name}`] || fallback;

export default defineConfig({
	worker: {
		name: "git-next",
		compatibilityDate: "2026-10-06",
		entrypoint,
		// public/index.html is the dashboard. Every request goes to the Worker first so the Access check covers static
		// files too; the Worker serves assets through the ASSETS binding after the check.
		assets: { notFoundHandling: "none", runWorkerFirst: true },
		env: {
			ASSETS: bindings.assets(),
			// Cloudflare Access: the team domain and this application's audience tag (public values, not secrets), from
			// DEPLOY_ACCESS_TEAM_DOMAIN / DEPLOY_ACCESS_AUD (README, "Deploy behind Cloudflare Access"); "unset" refuses every
			// non-local request (fail closed) until the Access application exists.
			ACCESS_TEAM_DOMAIN: bindings.text(deploy("ACCESS_TEAM_DOMAIN", "unset")),
			ACCESS_AUD: bindings.text(deploy("ACCESS_AUD", "unset")),
			// Read-only use: providers read trees, blobs and commits from repos in this namespace.
			// `remote: true` makes local dev read the real Artifacts repos.
			ARTIFACTS: bindings.artifacts({ namespace: "default", dev: { remote: true } }),
			// Workers AI, routed through the git-next AI Gateway (logs + cost per request metadata).
			AI: bindings.ai({ dev: { remote: true } }),
			// Embeddings of markdown sections (EmbeddingGemma-300m, 768-dim, cosine), filtered by repo.
			SECTIONS: bindings.vectorize({ name: "git-next-sections", dev: { remote: true } }),
			// Stored results (latest insights per repo/ref, index, recent pushes) and the rule-extraction cache.
			// Your namespace id in DEPLOY_RESULTS_KV_ID (`npx cf kv namespaces create`, README step 3).
			RESULTS: bindings.kv({ id: deploy("RESULTS_KV_ID", "unset") }),
			// Push events from Artifacts (event subscriptions → this queue); the producer is used by /dev/enqueue locally.
			PUSHES: bindings.queue({ name: "git-next-pushes" }),
			// Every push runs through this Workflow: analyse → index → classify → human review when sensitive → decision.
			PUSH_REVIEW: bindings.workflow({ name: "git-next-push-review", worker: "git-next", exportName: "PushReview" }),
			// "on": overlay fixtures/demo-layers for agents-demo-* repos (the demo's org/contract/tool/personal layers).
			DEMO_LAYERS: bindings.text("on"),
			// For the cost provider's AI Gateway logs reads. Set in .dev.vars locally (gitignored) and as Worker secrets.
			CF_ACCOUNT_ID: bindings.secret(),
			AIG_LOGS_TOKEN: bindings.secret(),
			// Comma-separated emails (Access identities) allowed to override layer precedence. Unset: nobody (fail closed).
			ADMIN_EMAILS: bindings.secret(),
		},
		exports: {
			PushReview: exports.workflow({ name: "git-next-push-review" }),
		},
		// One push per invocation: a first analysis plus embedding can take several minutes, so batching would risk
		// the invocation time limit; up to 3 pushes are analysed in parallel.
		triggers: [triggers.queue({ name: "git-next-pushes", deadLetterQueue: "git-next-pushes-dlq", maxBatchSize: 1, maxRetries: 3, maxConcurrency: 3 })],
	},
});
