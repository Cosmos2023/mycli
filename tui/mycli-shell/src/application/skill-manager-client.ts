import type { GatewayMethod, GatewayParams, GatewayResult } from "@mycli/contracts";
import type { MycliShellSkillManager } from "../model.ts";

export function createSkillManagerClient(options: {
	readonly request: <M extends GatewayMethod>(method: M, params: GatewayParams<M>) => Promise<GatewayResult<M>>;
	readonly context: () => GatewayParams<"skills.list">;
}): MycliShellSkillManager {
	return {
		load: async (signal) => {
			signal.throwIfAborted();
			const result = await options.request("skills.list", options.context());
			signal.throwIfAborted();
			return result;
		},
		setEnabled: async (skill, enabled, revision, signal) => {
			signal.throwIfAborted();
			const result = await options.request("skills.config.write", { ...options.context(),
				id: skill.id, skill_revision: skill.revision, revision, enabled,
			});
			signal.throwIfAborted();
			return result;
		},
	};
}
