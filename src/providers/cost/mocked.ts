import bedrock from "../../../fixtures/mocked-clouds/bedrock-logs.json" with { type: "json" };
import vertex from "../../../fixtures/mocked-clouds/vertex-logs.json" with { type: "json" };
import vllm from "../../../fixtures/mocked-clouds/vllm-logs.json" with { type: "json" };
import { combinedCostSource, mockedCostSource, parseGatewayLogs, type CostSource } from "./logs.ts";

// MOCKED cost sources for the multi-cloud demo: Bedrock (aws), Vertex AI (gcp) and a self-hosted vLLM (private).
// Fixture files only: no cloud API is called and every record is flagged mocked. The AI Gateway stays the only live source.

export const mockedCloudSources = (): CostSource[] => [
	mockedCostSource("bedrock", parseGatewayLogs(bedrock)),
	mockedCostSource("vertex-ai", parseGatewayLogs(vertex)),
	mockedCostSource("vllm", parseGatewayLogs(vllm)),
];

/** The live (or fixture) source plus the mocked clouds. */
export const withMockedClouds = (source: CostSource): CostSource => combinedCostSource(source, ...mockedCloudSources());
