import { stableModelInputJson, toolDiscovery, type ToolDefinition, type ToolDiscovery } from "@mycli/core";

const DIRECT_TOOL_THRESHOLD = 100;
const DIRECT_SCHEMA_BUDGET_BYTES = 128 * 1024;
const RETAINED_TOOL_LIMIT = 64;

export interface ExtensionToolExposure {
	readonly direct: readonly ToolDefinition[];
	readonly deferred: readonly ToolDefinition[];
}

/** Generic function-calling exposure; native discovery requires its own provider protocol. */
export function planExtensionToolExposure(
	definitions: readonly ToolDefinition[],
	discoveries: readonly ToolDiscovery[],
): ExtensionToolExposure {
	const ordered = [...definitions].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
	const size = (definition: ToolDefinition): number => Buffer.byteLength(stableModelInputJson(definition), "utf8");
	if (ordered.length < DIRECT_TOOL_THRESHOLD && ordered.reduce((bytes, definition) => bytes + size(definition), 0) <= DIRECT_SCHEMA_BUDGET_BYTES) {
		return Object.freeze({ direct: Object.freeze(ordered), deferred: Object.freeze([]) });
	}
	const current = new Map(ordered.map((definition) => [definition.id, definition]));
	const selected = new Set<string>();
	const direct: ToolDefinition[] = [];
	let bytes = 0;
	for (const discovery of discoveries) {
		const definition = current.get(discovery.id);
		if (!definition || definition.name !== discovery.name || selected.has(definition.id)
			|| toolDiscovery(definition).definitionSha256 !== discovery.definitionSha256) continue;
		const nextBytes = bytes + size(definition);
		if (direct.length >= RETAINED_TOOL_LIMIT || nextBytes > DIRECT_SCHEMA_BUDGET_BYTES) continue;
		direct.push(definition);
		selected.add(definition.id);
		bytes = nextBytes;
	}
	return Object.freeze({ direct: Object.freeze(direct.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
		deferred: Object.freeze(ordered.filter((definition) => !selected.has(definition.id))) });
}
