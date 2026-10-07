import { memorySource, overlayFiles, type SourceFactory } from "./core/repo-context.ts";
import contract from "../fixtures/demo-layers/contract/AGENTS.md?raw";
import org from "../fixtures/demo-layers/org/AGENTS.md?raw";
import personal from "../fixtures/demo-layers/personal/AGENTS.md?raw";
import privateLayer from "../fixtures/demo-layers/private/AGENTS.md?raw";
import stack from "../fixtures/demo-layers/.gitnext/stack.json?raw";
import tool from "../fixtures/demo-layers/tool/AGENTS.md?raw";
import envStack from "../fixtures/demo-environments/stack.json?raw";
import environments from "../fixtures/demo-environments/environments.json?raw";

export const DEMO_LAYERS_REPO = "git-next-demo-layers";
/**
 * Dev-only: serves fixtures/demo-layers as the git-next-demo-layers repo and adds its stack.json
 * to `repo`. With `envs`, also adds the MOCKED multi-cloud environments (fixtures/demo-environments) and the
 * stack that includes the private-cloud layer. Everything else is read from the wrapped factory unchanged.
 */
export function withDemoLayers(factory: SourceFactory, repo: string, opts: { envs?: boolean } = {}): SourceFactory {
	const layers = memorySource({ HEAD: { "org/AGENTS.md": org, "contract/AGENTS.md": contract, "tool/AGENTS.md": tool, "personal/AGENTS.md": personal, "private/AGENTS.md": privateLayer } });
	const overlay: Record<string, string> = opts.envs ? { ".gitnext/stack.json": envStack, ".gitnext/environments.json": environments } : { ".gitnext/stack.json": stack };
	return async (name) => (name === DEMO_LAYERS_REPO ? layers : name === repo ? overlayFiles(await factory(name), overlay) : factory(name));
}
