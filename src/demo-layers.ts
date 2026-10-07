import type { RepoSource, SourceFactory } from "./core/repo-context.ts";
import { memorySource } from "./core/repo-context.ts";
import contract from "../fixtures/demo-layers/contract/AGENTS.md?raw";
import org from "../fixtures/demo-layers/org/AGENTS.md?raw";
import personal from "../fixtures/demo-layers/personal/AGENTS.md?raw";
import stack from "../fixtures/demo-layers/.gitnext/stack.json?raw";
import tool from "../fixtures/demo-layers/tool/AGENTS.md?raw";

export const DEMO_LAYERS_REPO = "git-next-demo-layers";
const STACK_PATH = ".gitnext/stack.json";
const STACK_HASH = "demo0000000000000000000000000000stackjson";

/** Overlays the demo .gitnext/stack.json onto a source so nothing has to be pushed to the analysed repo. */
function withDemoStack(source: RepoSource): RepoSource {
	return {
		...source,
		async listFiles(ref) {
			return [...(await source.listFiles(ref)).filter((f) => f.path !== STACK_PATH), { path: STACK_PATH, hash: STACK_HASH }];
		},
		async readBlob(hash) {
			return hash === STACK_HASH ? stack : source.readBlob(hash);
		},
	};
}

/**
 * Dev-only: serves fixtures/demo-layers as the git-next-demo-layers repo and adds its stack.json
 * to `repo`. Everything else is read from the wrapped factory unchanged.
 */
export function withDemoLayers(factory: SourceFactory, repo: string): SourceFactory {
	const layers = memorySource({ HEAD: { "org/AGENTS.md": org, "contract/AGENTS.md": contract, "tool/AGENTS.md": tool, "personal/AGENTS.md": personal } });
	return async (name) => (name === DEMO_LAYERS_REPO ? layers : name === repo ? withDemoStack(await factory(name)) : factory(name));
}
