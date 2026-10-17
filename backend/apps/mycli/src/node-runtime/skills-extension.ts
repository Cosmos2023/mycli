import type { ExtensionDefinition } from "@mycli/extensions";
import type { RuntimeIntegrationComposition } from "./integration-composition.ts";
import type { SelectedSkillContext } from "./selected-skill-context.ts";

export interface SkillsExtensionOptions {
	readonly composition: RuntimeIntegrationComposition;
	readonly selected: SelectedSkillContext;
}

/**
 * Skills as an extension. It owns the three things skills put into a turn: the model-visible skill
 * catalog, the tool registrations that invoke a skill, and the instructions for the skills the user
 * selected on this turn.
 *
 * The catalog is read on every call and only rendered when the session actually exposes skill
 * tools, which is what the app used to check by looking at the registration sources itself.
 */
export function createSkillsExtension(options: SkillsExtensionOptions): ExtensionDefinition {
	const { composition, selected } = options;
	const skillRegistrations = () => composition.registrations
		.filter((registration) => registration.source === "skill")
		// A skill the user selected runs without an approval prompt. The feature owns that default,
		// so the app no longer has to know which sources are auto-approved.
		.map((registration) => registration.approvalPolicy === undefined
			? Object.freeze({ ...registration, approvalPolicy: "auto_allow" as const })
			: registration);
	return {
		id: "skills",
		tools: { toolRegistrations: skillRegistrations },
		skills: {
			skillCatalog: () => skillRegistrations().length > 0 ? composition.skillCatalog : "",
			selectedInstructions: ({ turnId }) => selected.load(turnId),
		},
	};
}
