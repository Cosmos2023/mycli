import { skillInstructionArtifact, type SkillManagementService } from "@mycli/integrations";
import type { RuntimeSessionStore } from "@mycli/storage";
import type { TurnContextSources } from "@mycli/runtime";

/** Follow durable user input, including steering and recovery, within the captured run. */
export class SelectedSkillContext {
	#turnId?: string;
	#afterSequence = 0;
	readonly #instructions = new Map<string, { readonly skillId: string; readonly content: string }>();

	constructor(private readonly options: {
		readonly sessionId: string;
		readonly store: Pick<RuntimeSessionStore, "loadTurnEventWindow">;
		readonly service: () => Pick<SkillManagementService, "resolve"> | undefined;
	}) {}

	load(turnId: string): TurnContextSources["loadedSkillInstructions"] {
		if (this.#turnId !== turnId) {
			this.#turnId = turnId;
			this.#afterSequence = 0;
			this.#instructions.clear();
		}
		for (;;) {
			const page = this.options.store.loadTurnEventWindow(this.options.sessionId, turnId, {
				...(this.#afterSequence > 0 ? { afterSequence: this.#afterSequence } : {}), limit: 128,
			});
			for (const event of page.events) {
				if (event.eventType === "user_input") {
					for (const reference of event.payload.skillReferences ?? []) {
						const service = this.options.service();
						if (!service) throw new Error("Selected skills are unavailable. Reopen /skills and retry.");
						const skill = (() => {
							try { return service.resolve(reference); }
							catch { throw Object.assign(new Error("Selected skill is unavailable. Reopen /skills and retry."), { code: "config_error", retryable: false }); }
						})();
						this.#instructions.set(reference.id, {
							skillId: skill.name,
							content: skillInstructionArtifact(skill.name, skill.body, skill.sourceKind).text,
						});
					}
				}
				this.#afterSequence = event.sequenceNo;
			}
			if (!page.hasMore) return [...this.#instructions.values()];
		}
	}
}
