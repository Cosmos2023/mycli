import type { ExtensionDefinition } from "@mycli/extensions";
import type { AgentRoleCatalog } from "@mycli/integrations";

export interface AgentRolesExtensionOptions {
	/** Read on every turn, so a role file edited mid-session applies to the next turn. */
	readonly roles: () => Promise<AgentRoleCatalog>;
}

/**
 * Declared subagent roles as an extension. The model can only choose a role it has been told about,
 * and `spawn_agent`'s `agent_type` names one of these, so the catalog has to reach the model.
 *
 * It contributes a context section rather than a tool-catalog entry: a role does not add a tool to
 * this turn, it changes what a child agent may do. The section reuses `conversation_context` because
 * the instruction-fragment kinds are a closed set that storage validates on read — a new kind would
 * need another format fence for a line of prompt text.
 */
export function createAgentRolesExtension(options: AgentRolesExtensionOptions): ExtensionDefinition {
	return {
		id: "agent-roles",
		context: {
			context: async () => {
				const catalog = await options.roles();
				if (catalog.roles.length === 0) return undefined;
				const lines = catalog.roles.map((role) => {
					const tools = role.tools === undefined ? "" : ` Tools: ${role.tools.join(", ")}.`;
					const model = role.model === undefined ? "" : ` Model: ${role.model}.`;
					return `- ${role.name}: ${role.description}${model}${tools}`;
				});
				return [{
					key: "agent-roles",
					kind: "conversation_context",
					title: "Agent roles",
					content: [
						"This workspace declares subagent roles. Pass one as agent_type to spawn_agent when it fits the task; omit it to inherit your own configuration. A role narrows the child's tools and may change its model; it never grants authority you do not have.",
						...lines,
					].join("\n"),
					source: "runtime:agent-roles",
					cacheClass: "dynamic",
					scope: "turn",
				}];
			},
		},
	};
}
