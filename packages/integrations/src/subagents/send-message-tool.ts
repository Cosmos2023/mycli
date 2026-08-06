import type { ToolDefinition } from "@mycli/core";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import type { SubagentControlContract } from "./controller.ts";
import { failure, success } from "./task-tool.ts";

export interface SendMessageToolOptions {
	readonly control: SubagentControlContract;
}

export const SEND_MESSAGE_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "subagent:SendMessage",
	name: "SendMessage",
	description: "Send an additional instruction to a running child session.",
	inputSchema: {
		type: "object",
		properties: {
			child_session_id: { type: "string", minLength: 1 },
			message: { type: "string", minLength: 1 },
		},
		required: ["child_session_id", "message"],
		additionalProperties: false,
	},
});

export class SendMessageTool implements ToolAdapter {
	readonly definition = SEND_MESSAGE_TOOL_DEFINITION;
	readonly #control: SubagentControlContract;

	constructor(options: SendMessageToolOptions) {
		this.#control = options.control;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		const childSessionId = stringValue(argumentsValue.child_session_id);
		const result = await this.#control.send(
			childSessionId,
			stringValue(argumentsValue.message),
			options.ownerSessionId,
		);
		if (!result.accepted) {
			return failure(
				`Message unavailable for child session ${result.childSessionId}`,
				"Subagent message unavailable",
				"subagent_message_unavailable",
			);
		}
		return success(
			`Message accepted by child session ${result.childSessionId}`,
			"Subagent message accepted",
		);
	}
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
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
