import type {
	BuiltInToolManifest,
	CombinedToolManifest,
	ExtensionToolManifestEntry,
	ManifestToolRegistration,
} from "./types.ts";
import {
	EXTENSION_ORIGIN_MAX_ENTRIES,
	EXTENSION_ORIGIN_MAX_KEY_LENGTH,
	EXTENSION_ORIGIN_MAX_VALUE_LENGTH,
} from "./types.ts";

const MAX_EXTENSION_ID_LENGTH = 128;

export function combinedToolManifest(
	builtin: BuiltInToolManifest,
	registrations: readonly ManifestToolRegistration[],
): CombinedToolManifest {
	const ids = new Set<string>();
	const routes = new Set<string>();
	for (const tool of builtin.tools) addUnique(tool.id, tool.name, ids, routes);

	const extensionTools = registrations.map((registration) => {
		validateRegistration(registration);
		addUnique(registration.id, registration.definition.name, ids, routes);
		return extensionEntry(registration);
	});
	const tools = [
		...builtin.tools.map((tool) => deepFreezeCopy(tool)),
		...extensionTools,
	];
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(tool.toolset, (counts.get(tool.toolset) ?? 0) + 1);

	return deepFreezeCopy({
		schema_version: 1 as const,
		source: "combined" as const,
		toolsets: [...counts.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([id, tool_count]) => ({ id, tool_count })),
		tools,
	});
}

function extensionEntry(registration: ManifestToolRegistration): ExtensionToolManifestEntry {
	return deepFreezeCopy({
		...registration.definition,
		id: registration.id,
		source: registration.source,
		toolset: "external" as const,
		availability: { status: "available" as const },
		origin_metadata: { ...registration.originMetadata },
	});
}

function validateRegistration(registration: ManifestToolRegistration): void {
	if (!registration.id || registration.id.length > MAX_EXTENSION_ID_LENGTH) {
		throw new Error("invalid_tool_id");
	}
	if (registration.definition.id !== registration.id) {
		throw new Error("tool_definition_id_mismatch");
	}
	const originEntries = Object.entries(registration.originMetadata);
	if (originEntries.length > EXTENSION_ORIGIN_MAX_ENTRIES) throw new Error("tool_origin_too_large");
	for (const [key, value] of originEntries) {
		if (!key || key.length > EXTENSION_ORIGIN_MAX_KEY_LENGTH
			|| !value || value.length > EXTENSION_ORIGIN_MAX_VALUE_LENGTH) {
			throw new Error("invalid_tool_origin");
		}
	}
}

function addUnique(
	id: string,
	route: string,
	ids: Set<string>,
	routes: Set<string>,
): void {
	if (ids.has(id)) throw new Error("duplicate_tool_id");
	if (routes.has(route)) throw new Error("duplicate_tool_route");
	ids.add(id);
	routes.add(route);
}

function deepFreezeCopy<Value>(value: Value): Value {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => deepFreezeCopy(item))) as Value;
	}
	if (typeof value !== "object" || value === null) return value;
	return Object.freeze(Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, deepFreezeCopy(item)]),
	)) as Value;
}
