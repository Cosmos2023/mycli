import { createHash } from "node:crypto";
import type { ToolAdapter } from "@mycli/tools";
import type { IntegrationRegistration } from "./registration.ts";
import { PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH } from "./ids.ts";

/** Keep protocol identity intact while resolving model alias collisions across extensions. */
export function normalizeIntegrationToolNames(
	registrations: readonly IntegrationRegistration[],
	reservedNames: readonly string[] = [],
): readonly IntegrationRegistration[] {
	const ids = new Set<string>();
	const counts = new Map<string, number>();
	for (const registration of registrations) {
		if (ids.has(registration.id)) throw new Error("duplicate_integration_tool");
		ids.add(registration.id);
		const name = registration.definition.name;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const reserved = new Set(reservedNames);
	const colliding = registrations.filter(({ definition }) => counts.get(definition.name)! > 1 || reserved.has(definition.name));
	const names = new Map<string, string>();
	const occupied = new Set([...reservedNames, ...registrations.map(({ definition }) => definition.name)]);
	for (const registration of [...colliding].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
		for (let attempt = 0; ; attempt += 1) {
			const suffix = createHash("sha256").update(JSON.stringify([registration.id, attempt])).digest("hex").slice(0, 12);
			const prefix = registration.definition.name.slice(0, PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH - suffix.length - 1);
			const name = `${prefix}_${suffix}`;
			if (occupied.has(name)) continue;
			occupied.add(name);
			names.set(registration.id, name);
			break;
		}
	}
	return Object.freeze(registrations.map((registration) => {
		const name = names.get(registration.id);
		if (!name) return registration;
		const definition = Object.freeze({ ...registration.definition, name });
		const original = registration.adapter;
		const adapter: ToolAdapter = Object.freeze({
			definition,
			supportsParallelToolCalls: registration.supportsParallelToolCalls,
			...(original.legacyInputSchemas ? { legacyInputSchemas: original.legacyInputSchemas } : {}),
			...(original.beginTurn ? { beginTurn: original.beginTurn.bind(original) } : {}),
			...(original.finishTurn ? { finishTurn: original.finishTurn.bind(original) } : {}),
			...(original.prepare ? { prepare: original.prepare.bind(original) } : {}),
			...(original.preview ? { preview: original.preview.bind(original) } : {}),
			execute: original.execute.bind(original),
		});
		return Object.freeze({ ...registration, definition, adapter });
	}));
}
