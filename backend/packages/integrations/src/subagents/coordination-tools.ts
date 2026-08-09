import type { ToolDefinition } from "@mycli/core";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import type { AgentCoordinationControlContract } from "./controller.ts";
import { boundText, failure, success } from "./tool-result.ts";

export interface AgentCoordinationToolOptions {
	readonly control: AgentCoordinationControlContract;
}

export const SPAWN_AGENT_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "subagent:spawn_agent",
	name: "spawn_agent",
	description: "Spawn a durable child agent with an independent thread and canonical path.",
	inputSchema: {
		type: "object",
		properties: {
			task_name: {
				type: "string",
				pattern: "^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$",
			},
				message: { type: "string", minLength: 1, maxLength: 65_536 },
				fork_turns: { type: "string", pattern: "^(?:none|all|[1-9][0-9]*)$" },
		},
		required: ["task_name", "message"],
		additionalProperties: false,
	},
});

export const SEND_AGENT_MESSAGE_TOOL_DEFINITION: ToolDefinition = messageDefinition(
	"send_message",
	"Queue a durable message for an agent without starting a new turn.",
);

export const FOLLOWUP_TASK_TOOL_DEFINITION: ToolDefinition = messageDefinition(
	"followup_task",
	"Queue a durable message and trigger the target agent when it is eligible to run.",
);

export const INTERRUPT_AGENT_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "subagent:interrupt_agent",
	name: "interrupt_agent",
	description: "Interrupt a running agent in the caller's root tree.",
	inputSchema: {
		type: "object",
		properties: {
			target: { type: "string", minLength: 1, maxLength: 512 },
			reason: { type: "string", minLength: 1, maxLength: 4_096 },
		},
		required: ["target"],
		additionalProperties: false,
	},
});

export const LIST_AGENTS_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "subagent:list_agents",
	name: "list_agents",
	description: "List durable loaded and unloaded agents in the caller's root tree.",
	inputSchema: {
		type: "object",
		properties: {
			path_prefix: { type: "string", pattern: "^/root(?:/[a-z0-9][a-z0-9_-]{0,63})*$" },
		},
		required: [],
		additionalProperties: false,
	},
});

export class SpawnAgentTool implements ToolAdapter {
	readonly definition = SPAWN_AGENT_TOOL_DEFINITION;
	readonly #control: AgentCoordinationControlContract;

	constructor(options: AgentCoordinationToolOptions) {
		this.#control = options.control;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		try {
			const forkTurns = optionalString(argumentsValue.fork_turns);
			const result = await this.#control.spawnAgent({
				ownerSessionId: options.ownerSessionId,
				...(options.ownerTurnId ? { ownerTurnId: options.ownerTurnId } : {}),
				taskName: stringValue(argumentsValue.task_name),
				message: stringValue(argumentsValue.message),
				...(forkTurns ? { forkTurns } : {}),
			});
			const output = boundText(JSON.stringify({
				status: result.status,
				thread_id: result.childSessionId,
				task_name: result.taskName,
				agent_path: result.agentPath,
				...(result.report === undefined ? {} : { report: result.report }),
				...(result.error === undefined ? {} : { error: result.error }),
			}));
			return result.status === "running" || result.status === "completed"
				? success(output, `Agent ${result.status}: ${result.agentPath}`)
				: failure(output, `Agent ${result.status}: ${result.agentPath}`, `agent_${result.status}`);
		} catch (error) {
			return coordinationFailure("spawn_agent", error);
		}
	}
}

export class SendAgentMessageTool implements ToolAdapter {
	readonly definition: ToolDefinition;
	readonly #control: AgentCoordinationControlContract;
	readonly #triggerMode: "queue_only" | "follow_up";

	constructor(options: AgentCoordinationToolOptions & Readonly<{
		definition: ToolDefinition;
		triggerMode: "queue_only" | "follow_up";
	}>) {
		this.#control = options.control;
		this.definition = options.definition;
		this.#triggerMode = options.triggerMode;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		try {
			const result = await this.#control.sendAgent({
				ownerSessionId: options.ownerSessionId,
				target: stringValue(argumentsValue.target),
				message: stringValue(argumentsValue.message),
				triggerMode: this.#triggerMode,
				callId: options.callId,
			});
			return success(JSON.stringify({
				status: result.status,
				message_id: result.messageId,
				receiver_thread_id: result.receiverThreadId,
				receiver_path: result.receiverPath,
				receiver_sequence: result.receiverSequence,
				trigger_mode: result.triggerMode,
				projected: result.projected,
			}), `Agent message ${result.status}: ${result.receiverPath}`);
		} catch (error) {
			return coordinationFailure(this.definition.name, error);
		}
	}
}

export class InterruptAgentTool implements ToolAdapter {
	readonly definition = INTERRUPT_AGENT_TOOL_DEFINITION;
	readonly #control: AgentCoordinationControlContract;

	constructor(options: AgentCoordinationToolOptions) {
		this.#control = options.control;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		try {
			const reason = optionalString(argumentsValue.reason);
			const result = await this.#control.interruptAgent({
				ownerSessionId: options.ownerSessionId,
				target: stringValue(argumentsValue.target),
				...(reason ? { reason } : {}),
			});
			const output = JSON.stringify({
				interrupted: result.interrupted,
				thread_id: result.threadId,
				agent_path: result.path,
			});
			return result.interrupted
				? success(output, `Agent interrupted: ${result.path}`)
				: failure(output, `Agent not interruptible: ${result.path}`, "agent_interrupt_unavailable");
		} catch (error) {
			return coordinationFailure("interrupt_agent", error);
		}
	}
}

export class ListAgentsTool implements ToolAdapter {
	readonly definition = LIST_AGENTS_TOOL_DEFINITION;
	readonly #control: AgentCoordinationControlContract;

	constructor(options: AgentCoordinationToolOptions) {
		this.#control = options.control;
	}

	execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		try {
			const pathPrefix = optionalString(argumentsValue.path_prefix);
			const agents = this.#control.listAgents({
				ownerSessionId: options.ownerSessionId,
				...(pathPrefix ? { pathPrefix } : {}),
			});
			return Promise.resolve(success(JSON.stringify({
				agents: agents.map((agent) => ({
					thread_id: agent.threadId,
					agent_path: agent.path,
					task_name: agent.taskName,
					...(agent.nickname === undefined ? {} : { nickname: agent.nickname }),
					status: agent.status,
					resident: agent.resident,
				})),
			}), `Listed ${agents.length} agents`));
		} catch (error) {
			return Promise.resolve(coordinationFailure("list_agents", error));
		}
	}
}

function messageDefinition(name: "send_message" | "followup_task", description: string): ToolDefinition {
	return deepFreeze({
		id: `subagent:${name}`,
		name,
		description,
		inputSchema: {
			type: "object",
			properties: {
				target: { type: "string", minLength: 1, maxLength: 512 },
				message: { type: "string", minLength: 1, maxLength: 65_536 },
			},
			required: ["target", "message"],
			additionalProperties: false,
		},
	});
}

function coordinationFailure(tool: string, error: unknown): ToolAdapterResult {
	const code = errorCode(error);
	return failure(
		`${tool} failed\nError kind: ${code}`,
		`${tool} failed`,
		code,
	);
}

function errorCode(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { readonly code?: unknown }).code;
		if (typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code)) return code;
	}
	if (error instanceof Error && error.message === "agent_coordination_unavailable") {
		return "agent_coordination_unavailable";
	}
	return "agent_coordination_failed";
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
	const result = stringValue(value);
	return result || undefined;
}

function assertNotAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("interrupted");
	error.name = "AbortError";
	throw error;
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
