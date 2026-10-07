import { ProviderRegistry } from "./core/registry.ts";
import { catalogProvider, type CatalogOptions } from "./providers/catalog.ts";
import { costProvider } from "./providers/cost/index.ts";
import { environmentsProvider } from "./providers/environments.ts";
import type { CostSource } from "./providers/cost/logs.ts";
import type { RuleExtractor } from "./providers/instruction-stack/types.ts";
import type { StackProviderOptions } from "./providers/instruction-stack/index.ts";
import { instructionStackProvider } from "./providers/instruction-stack/index.ts";
import { ownersProvider } from "./providers/owners.ts";
import { resourceMapProvider } from "./providers/resource-map.ts";

/** Default providers. Kept free of Workers-only imports so offline scripts and tests can use it. */
export const createRegistry = (cost?: CostSource, catalog?: CatalogOptions, extractor?: RuleExtractor, stack?: StackProviderOptions) =>
	new ProviderRegistry()
		.register(resourceMapProvider)
		.register(instructionStackProvider(extractor, stack))
		.register(costProvider(cost, { catalog: catalog?.baseline }))
		.register(ownersProvider)
		.register(catalogProvider(catalog))
		.register(environmentsProvider({ baseline: catalog?.baseline }));
