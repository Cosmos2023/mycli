import {
	defineIntegrationRegistration,
	FOLLOWUP_TASK_TOOL_DEFINITION,
	INTERRUPT_AGENT_TOOL_DEFINITION,
	InterruptAgentTool,
	LIST_AGENTS_TOOL_DEFINITION,
	ListAgentsTool,
	SEND_AGENT_MESSAGE_TOOL_DEFINITION,
	SendAgentMessageTool,
	SubagentController,
	SPAWN_AGENT_TOOL_DEFINITION,
	SpawnAgentTool,
	WAIT_AGENT_TOOL_DEFINITION,
	WaitAgentTool,
	type IntegrationRegistration,
	type WaitAgentActivityContract,
} from "@mycli/integrations";
import type { ToolAdapter } from "@mycli/tools";

type Projection = Readonly<Record<string, unknown>>;

export interface RuntimeSubagentServices {
	readonly controller: SubagentController;
	readonly registrations: readonly IntegrationRegistration[];
	subscribe(listener: (value: Projection) => void): () => void;
	publish(value: Projection): void;
	close(): Promise<void>;
}

/** One backend-owned supervisor; session integration content never disposes it. */
export function createRuntimeSubagentServices(
	options: ConstructorParameters<typeof SubagentController>[0] & {
		readonly agentActivity?: WaitAgentActivityContract;
	},
): RuntimeSubagentServices {
	const controller = new SubagentController(options);
	controller.recoverAbandoned("parent runtime restarted");
	const listeners = new Set<(value: Projection) => void>();
	let closing: Promise<void> | undefined;
	return Object.freeze({
		controller,
		registrations: subagentRegistrations(controller, options.agentActivity ?? UNAVAILABLE_AGENT_ACTIVITY),
		subscribe: (listener: (value: Projection) => void) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		publish: (value: Projection) => {
			for (const listener of listeners) {
				try { listener(value); } catch { /* Projection cannot affect execution. */ }
			}
		},
		close: () => closing ??= controller.close().finally(() => { listeners.clear(); }),
	});
}

function subagentRegistrations(
	controller: SubagentController,
	agentActivity: WaitAgentActivityContract,
): readonly IntegrationRegistration[] {
	return Object.freeze([
		subagentRegistration(
			SPAWN_AGENT_TOOL_DEFINITION,
			new SpawnAgentTool({ control: controller }),
		),
		subagentRegistration(
			SEND_AGENT_MESSAGE_TOOL_DEFINITION,
			new SendAgentMessageTool({
				control: controller,
				definition: SEND_AGENT_MESSAGE_TOOL_DEFINITION,
				triggerMode: "queue_only",
			}),
		),
		subagentRegistration(
			FOLLOWUP_TASK_TOOL_DEFINITION,
			new SendAgentMessageTool({
				control: controller,
				definition: FOLLOWUP_TASK_TOOL_DEFINITION,
				triggerMode: "follow_up",
			}),
		),
		subagentRegistration(
			INTERRUPT_AGENT_TOOL_DEFINITION,
			new InterruptAgentTool({ control: controller }),
		),
		subagentRegistration(
			LIST_AGENTS_TOOL_DEFINITION,
			new ListAgentsTool({ control: controller }),
		),
		subagentRegistration(
			WAIT_AGENT_TOOL_DEFINITION,
			new WaitAgentTool({ activity: agentActivity }),
		),
	]);
}

function subagentRegistration(
	definition: IntegrationRegistration["definition"],
	adapter: ToolAdapter,
	modelVisible = true,
): IntegrationRegistration {
	return defineIntegrationRegistration({
		id: definition.id,
		source: "subagent",
		definition,
		adapter,
		originMetadata: { controller: "local" },
		modelVisible,
	});
}

const UNAVAILABLE_AGENT_ACTIVITY: WaitAgentActivityContract = Object.freeze({
	wait: async () => Object.freeze({ kind: "unavailable" as const }),
});
