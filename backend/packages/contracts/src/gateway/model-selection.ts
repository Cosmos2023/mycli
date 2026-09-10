import { gatewayContractCatalog } from "../catalog.ts";
import type { GatewayContractCatalog } from "../generated/catalog.ts";

export type ModelSelectionScope = GatewayContractCatalog["modelSelectionScopes"][number];

export const MODEL_SELECTION_SCOPES: readonly ModelSelectionScope[] = Object.freeze(
	[...gatewayContractCatalog.modelSelectionScopes],
);

const MODEL_SELECTION_SCOPE_SET = new Set<string>(MODEL_SELECTION_SCOPES);

export function isModelSelectionScope(value: unknown): value is ModelSelectionScope {
	return typeof value === "string" && MODEL_SELECTION_SCOPE_SET.has(value);
}
