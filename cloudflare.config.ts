import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "git-next",
		compatibilityDate: "2026-10-06",
		entrypoint,
		env: {
			// Read-only use: providers read trees, blobs and commits from repos in this namespace.
			// `remote: true` makes local dev read the real Artifacts repos.
			ARTIFACTS: bindings.artifacts({ namespace: "default", dev: { remote: true } }),
		},
	},
});
