import { modelInputSha256, type AgentSpawnConfigSnapshot } from "@mycli/core";
import type { IntegrationRegistration } from "@mycli/integrations";
import type { RunExecutionSnapshot } from "@mycli/runtime";
import type { RuntimeIntegrationComposition } from "./integration-composition.ts";

type IntegrationAuthority = NonNullable<AgentSpawnConfigSnapshot["integrationAuthority"]>;

export function integrationToolFingerprint(registration: IntegrationRegistration, skillCatalog: string): string {
	return modelInputSha256({ definition: registration.definition, approvalScope: registration.approvalScope ?? null,
		...(registration.source === "skill" ? { skillCatalog } : {}) });
}

export function captureChildIntegrationAuthority(
	composition: RuntimeIntegrationComposition | undefined,
	snapshot: RunExecutionSnapshot | undefined,
	tools: readonly string[],
): IntegrationAuthority | undefined {
	if (!composition?.configuration || !snapshot) return undefined;
	const allowed = new Set(tools);
	const definitions = new Map([...snapshot.toolCatalog.directTools, ...snapshot.toolCatalog.deferredTools]
		.map((definition) => [definition.name, modelInputSha256(definition)]));
	return Object.freeze({
		configurationFingerprint: composition.configuration.fingerprint,
		toolFingerprints: Object.freeze(Object.fromEntries(composition.registrations.filter((registration) =>
			allowed.has(registration.definition.name)
			&& definitions.get(registration.definition.name) === modelInputSha256(registration.definition),
		).map((registration) => [registration.definition.name, integrationToolFingerprint(registration, composition.skillCatalog)]))),
	});
}

export function inheritedIntegrationRegistrations(
	composition: RuntimeIntegrationComposition,
	authority: IntegrationAuthority | undefined,
): readonly IntegrationRegistration[] {
	return composition.registrations.filter((registration) => registration.source === "subagent"
		|| (authority?.configurationFingerprint === composition.configuration?.fingerprint
			&& authority?.toolFingerprints[registration.definition.name] === integrationToolFingerprint(registration, composition.skillCatalog)));
}
