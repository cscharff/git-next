import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "git-next",
		compatibilityDate: "2026-10-06",
		entrypoint,
		// public/index.html is the dashboard; API routes go to the Worker first.
		assets: { notFoundHandling: "none", runWorkerFirst: ["/insights", "/context", "/providers", "/samples/*", "/dev/*", "/catalog", "/results", "/results/*"] },
		env: {
			// Read-only use: providers read trees, blobs and commits from repos in this namespace.
			// `remote: true` makes local dev read the real Artifacts repos.
			ARTIFACTS: bindings.artifacts({ namespace: "default", dev: { remote: true } }),
			// Workers AI, routed through the git-next AI Gateway (logs + cost per request metadata).
			AI: bindings.ai({ dev: { remote: true } }),
			// Stored results (latest insights per repo/ref, index, recent pushes) and the rule-extraction cache.
			RESULTS: bindings.kv({ id: "add53cfdb613401cbc50c632dfb058f9" }),
			// Push events from Artifacts (event subscriptions → this queue); the producer is used by /dev/enqueue locally.
			PUSHES: bindings.queue({ name: "git-next-pushes" }),
			// "on": overlay fixtures/demo-layers for agents-demo-* repos (the demo's org/contract/tool/personal layers).
			DEMO_LAYERS: bindings.text("on"),
			// For the cost provider's AI Gateway logs reads. Set in .dev.vars locally (gitignored) and as Worker secrets.
			CF_ACCOUNT_ID: bindings.secret(),
			AIG_LOGS_TOKEN: bindings.secret(),
		},
		triggers: [triggers.queue({ name: "git-next-pushes", deadLetterQueue: "git-next-pushes-dlq", maxBatchSize: 5, maxRetries: 3, maxConcurrency: 2 })],
	},
});
