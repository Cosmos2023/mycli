import type { SubagentProfileRegistry } from "./profile-registry.ts";
import type {
	SubagentBudget,
	SubagentProfile,
	SubagentProfileSourceDirectory,
	SubagentProfileSourceKind,
} from "./types.ts";

export interface SubagentManagementServiceOptions {
	readonly registry: SubagentProfileRegistry;
}

export interface SubagentManagementRow {
	readonly id: string;
	readonly description: string;
	readonly model?: string;
	readonly allowedTools: readonly string[];
	readonly deniedTools: readonly string[];
	readonly budget: SubagentBudget;
	readonly sourceKind: SubagentProfileSourceKind;
	readonly sourceDirectory: SubagentProfileSourceDirectory;
	readonly fileLabel: string;
}

export interface SubagentManagementListResponse {
	readonly ok: true;
	readonly action: "list";
	readonly profiles: readonly SubagentManagementRow[];
}

export type SubagentManagementInspectResponse =
	| {
		readonly ok: true;
		readonly action: "inspect";
		readonly profiles: readonly SubagentManagementRow[];
		readonly profile: SubagentManagementRow;
	}
	| {
		readonly ok: false;
		readonly action: "inspect";
		readonly profiles: readonly SubagentProfile[];
		readonly message: string;
	};

export type SubagentManagementResponse =
	| SubagentManagementListResponse
	| SubagentManagementInspectResponse;

export class SubagentManagementService {
	readonly #registry: SubagentProfileRegistry;

	constructor(options: SubagentManagementServiceOptions) {
		this.#registry = options.registry;
	}

	list(): SubagentManagementListResponse {
		return Object.freeze({
			ok: true,
			action: "list",
			profiles: Object.freeze(this.#registry.list().map(managementRow)),
		});
	}

	inspect(profileId: string): SubagentManagementInspectResponse {
		const profile = this.#registry.get(profileId);
		if (!profile) {
			return Object.freeze({
				ok: false,
				action: "inspect",
				profiles: Object.freeze([]),
				message: "subagent profile not found",
			});
		}
		const row = managementRow(profile);
		return Object.freeze({
			ok: true,
			action: "inspect",
			profiles: Object.freeze([row]),
			profile: row,
		});
	}
}

function managementRow(profile: SubagentProfile): SubagentManagementRow {
	return Object.freeze({
		id: profile.id,
		description: profile.description,
		...(profile.model ? { model: profile.model } : {}),
		allowedTools: Object.freeze([...profile.allowedTools]),
		deniedTools: Object.freeze([...profile.deniedTools]),
		budget: Object.freeze({ ...profile.budget }),
		sourceKind: profile.sourceKind,
		sourceDirectory: profile.sourceDirectory,
		fileLabel: profile.fileLabel,
	});
}
