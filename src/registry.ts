import { ProviderRegistry } from "./core/registry.ts";
import { costProvider } from "./providers/cost/index.ts";
import type { CostSource } from "./providers/cost/logs.ts";
import { instructionStackProvider } from "./providers/instruction-stack/index.ts";
import { resourceMapProvider } from "./providers/resource-map.ts";

/** Default providers. Kept free of Workers-only imports so offline scripts and tests can use it. */
export const createRegistry = (cost?: CostSource) => new ProviderRegistry().register(resourceMapProvider).register(instructionStackProvider()).register(costProvider(cost));
