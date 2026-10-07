import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "git-next",
		compatibilityDate: "2026-10-06",
		entrypoint,
		// public/index.html is the dashboard; API routes go to the Worker first.
		assets: { notFoundHandling: "none", runWorkerFirst: ["/insights", "/context", "/providers", "/samples/*", "/dev/*", "/catalog"] },
		env: {
			// Read-only use: providers read trees, blobs and commits from repos in this namespace.
			// `remote: true` makes local dev read the real Artifacts repos.
			ARTIFACTS: bindings.artifacts({ namespace: "default", dev: { remote: true } }),
			// Workers AI, routed through the git-next AI Gateway (logs + cost per request metadata).
			AI: bindings.ai({ dev: { remote: true } }),
			// For the cost provider's AI Gateway logs reads. Set in .dev.vars locally (gitignored); never in source.
			CF_ACCOUNT_ID: bindings.secret(),
			AIG_LOGS_TOKEN: bindings.secret(),
		},
	},
});
