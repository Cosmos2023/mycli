import { IntegrationEnablementStore, integrationEnabled } from "../foundation/enablement-store.ts";
import { skillIdentity, skillRevision, type SkillRegistry } from "./registry.ts";
import type { SkillDefinition, SkillSourceKind } from "./types.ts";

export interface SkillManagementRow {
	readonly id: string;
	readonly revision: string;
	readonly name: string;
	readonly description: string;
	readonly source: SkillSourceKind;
	readonly path: string;
	readonly enabled: boolean;
}

export interface SkillManagementSnapshot {
	readonly revision: string;
	readonly skills: readonly SkillManagementRow[];
}

export class SkillSelectionError extends Error {
	constructor(readonly code: "skill_not_found" | "skill_changed" | "skill_disabled") {
		super(code);
		this.name = "SkillSelectionError";
	}
}

export class SkillManagementService {
	readonly #registry: () => SkillRegistry;
	readonly #store: IntegrationEnablementStore;
	readonly #catalog: () => Promise<SkillRegistry>;

	constructor(options: { readonly registry: () => SkillRegistry; readonly homeDir: string; readonly catalog?: () => Promise<SkillRegistry> }) {
		this.#registry = options.registry;
		this.#catalog = options.catalog ?? (async () => options.registry());
		this.#store = new IntegrationEnablementStore(options);
	}

	async list(): Promise<SkillManagementSnapshot> {
		const settings = await this.#store.load();
		const registry = await this.#catalog();
		return Object.freeze({ revision: settings.revision,
			skills: Object.freeze(registry.listAll().map((skill) => {
				const id = skillIdentity(skill);
				return Object.freeze({ id, revision: skillRevision(skill), name: skill.name,
					description: skill.description, source: skill.sourceKind, path: skill.sourcePath,
					enabled: integrationEnabled(settings, "skill", id),
				});
			})),
		});
	}

	async setEnabled(input: {
		readonly id: string;
		readonly revision: string;
		readonly skillRevision: string;
		readonly enabled: boolean;
	}, signal: AbortSignal): Promise<SkillManagementSnapshot> {
		const skill = (await this.#catalog()).listAll().find((item) => skillIdentity(item) === input.id);
		if (!skill) throw new SkillSelectionError("skill_not_found");
		if (skillRevision(skill) !== input.skillRevision) throw new SkillSelectionError("skill_changed");
		await this.#store.setEnabled({ kind: "skill", id: input.id, enabled: input.enabled, revision: input.revision }, signal);
		return this.list();
	}

	resolve(reference: { readonly id: string; readonly name: string; readonly revision: string }): SkillDefinition {
		const skill = this.#registry().listAll().find((item) => skillIdentity(item) === reference.id);
		if (!skill) throw new SkillSelectionError("skill_not_found");
		if (!skill.enabled) throw new SkillSelectionError("skill_disabled");
		if (skill.name !== reference.name || skillRevision(skill) !== reference.revision) throw new SkillSelectionError("skill_changed");
		return skill;
	}
}
