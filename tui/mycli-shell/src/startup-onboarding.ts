export const STARTUP_ONBOARDING_STAGES = [
	"welcome",
	"credential",
	"model",
	"connectivity",
	"trust",
	"permission",
	"ready",
] as const;

export type StartupOnboardingStage = typeof STARTUP_ONBOARDING_STAGES[number];

export interface StartupOnboardingInput {
	readonly authenticationRequired: boolean;
	readonly trustRequired: boolean;
	readonly modelSelectionAvailable: boolean;
}

export function startupOnboardingStages(
	input: StartupOnboardingInput,
): readonly StartupOnboardingStage[] {
	if (!input.authenticationRequired) {
		return input.trustRequired ? Object.freeze(["trust"]) : Object.freeze([]);
	}
	return Object.freeze([
		"welcome",
		"credential",
		...(input.modelSelectionAvailable ? ["model" as const] : []),
		"connectivity",
		...(input.trustRequired ? ["trust" as const] : []),
		"permission",
		"ready",
	]);
}

export class StartupOnboardingCoordinator {
	readonly #stages: readonly StartupOnboardingStage[];
	#index = 0;

	constructor(input: StartupOnboardingInput) {
		this.#stages = startupOnboardingStages(input);
	}

	current(): StartupOnboardingStage | undefined {
		return this.#stages[this.#index];
	}

	advance(completedStage: StartupOnboardingStage): StartupOnboardingStage | undefined {
		if (this.current() !== completedStage) {
			throw new Error("startup_onboarding_stage_mismatch");
		}
		this.#index += 1;
		return this.current();
	}

	stages(): readonly StartupOnboardingStage[] {
		return this.#stages;
	}
}
