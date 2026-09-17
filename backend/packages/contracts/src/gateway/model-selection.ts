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

/** A confirmed model selection, shared by the picker and inline command. */
export function modelSelectionNotice(provider: string, model: string, effort: string | undefined, scope: ModelSelectionScope): string {
	const reasoning = effort && effort !== "none" ? ` (${effort} reasoning)` : "";
	const scopeText = scope === "session" ? "for this conversation" : "as the user default";
	return `Model changed to ${provider ? `${provider}/` : ""}${model}${reasoning} ${scopeText}.`;
}
