// Helpers for offline runs: load a local checkout (and the demo layers) as in-memory RepoSources.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { localSource } from "../src/cli/git-source.ts";
import { RepoContext, memorySource, overlayFiles, type RepoSource } from "../src/core/repo-context.ts";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".next", "coverage"]);

/** Reads files under `dir` whose repo-relative path matches `wanted` (text only). */
export function readCheckout(dir: string, wanted: RegExp): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			if (SKIP.has(name)) continue;
			const p = join(d, name);
			const rel = relative(dir, p);
			if (statSync(p).isDirectory()) walk(p);
			else if (wanted.test(rel)) files[rel] = /\.(yaml|lockb)$/.test(name) ? "" : readFileSync(p, "utf8");
		}
	};
	walk(dir);
	return files;
}

export const DEMO_LAYERS_REPO = "git-next-demo-layers";
export const demoLayers = (): Record<string, string> => readCheckout(new URL("../fixtures/demo-layers", import.meta.url).pathname, /\.(md|json)$/);

/** A RepoContext where `repo@main` is the checkout and the demo-layers repo serves the fixture layers at HEAD. */
export function localContext(repo: string, files: Record<string, string>): RepoContext {
	return new RepoContext(async (name) => memorySource(name === DEMO_LAYERS_REPO ? { HEAD: demoLayers() } : name === repo ? { main: files } : {}));
}

/**
 * A checkout's committed files (git objects at HEAD, so symlinks arrive as link blobs, as in Artifacts) served as
 * `main`, every file readable on demand. `extra` overlays files such as a demo stack.json.
 */
export function gitCheckoutSource(dir: string, extra: Record<string, string> = {}): RepoSource {
	const src = localSource(dir);
	const atHead: RepoSource = { ...src, listFiles: (ref) => src.listFiles(ref === "main" ? "HEAD" : ref) };
	return Object.keys(extra).length ? overlayFiles(atHead, extra) : atHead;
}
