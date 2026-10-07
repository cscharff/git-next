import { memorySource, overlayFiles, type SourceFactory } from "./core/repo-context.ts";
import contract from "../fixtures/demo-layers/contract/AGENTS.md?raw";
import org from "../fixtures/demo-layers/org/AGENTS.md?raw";
import personal from "../fixtures/demo-layers/personal/AGENTS.md?raw";
import stack from "../fixtures/demo-layers/.gitnext/stack.json?raw";
import tool from "../fixtures/demo-layers/tool/AGENTS.md?raw";

export const DEMO_LAYERS_REPO = "git-next-demo-layers";
/**
 * Dev-only: serves fixtures/demo-layers as the git-next-demo-layers repo and adds its stack.json
 * to `repo`. Everything else is read from the wrapped factory unchanged.
 */
export function withDemoLayers(factory: SourceFactory, repo: string): SourceFactory {
	const layers = memorySource({ HEAD: { "org/AGENTS.md": org, "contract/AGENTS.md": contract, "tool/AGENTS.md": tool, "personal/AGENTS.md": personal } });
	return async (name) => (name === DEMO_LAYERS_REPO ? layers : name === repo ? overlayFiles(await factory(name), { ".gitnext/stack.json": stack }) : factory(name));
}
