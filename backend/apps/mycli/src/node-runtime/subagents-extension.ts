import type { ExtensionDefinition } from "@mycli/extensions";
import type { RuntimeIntegrationComposition } from "./integration-composition.ts";

export interface SubagentsExtensionOptions {
	readonly composition: RuntimeIntegrationComposition;
}

/**
 * Subagents as an extension, for the part of them the session catalog holds: the coordination tools
 * (spawn, send, wait) that are registered as subagent tool registrations.
 *
 * The subagent controller, mailbox, and residency policy stay where they are — they are runtime
 * services, not catalog entries.
 */
export function createSubagentsExtension(options: SubagentsExtensionOptions): ExtensionDefinition {
	const { composition } = options;
	return {
		id: "subagent",
		tools: {
			toolRegistrations: () => composition.registrations
				.filter((registration) => registration.source === "subagent")
				// Coordination tools are auto-approved: the subagent's own policy governs its work.
				.map((registration) => registration.approvalPolicy === undefined
					? Object.freeze({ ...registration, approvalPolicy: "auto_allow" as const })
					: registration),
		},
	};
}
