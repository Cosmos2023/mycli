import type { SubagentProfileRegistry } from "./profile-registry.ts";
import type { SubagentProfile } from "./types.ts";

export interface SubagentManagementServiceOptions {
	readonly registry: SubagentProfileRegistry;
}

export interface SubagentManagementListResponse {
	readonly ok: true;
	readonly action: "list";
	readonly profiles: readonly SubagentProfile[];
}

export type SubagentManagementInspectResponse =
	| {
		readonly ok: true;
		readonly action: "inspect";
		readonly profiles: readonly SubagentProfile[];
		readonly profile: SubagentProfile;
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
			profiles: this.#registry.list(),
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
		return Object.freeze({
			ok: true,
			action: "inspect",
			profiles: Object.freeze([profile]),
			profile,
		});
	}
}
