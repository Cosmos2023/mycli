import type { ToolDefinition } from "@mycli/core";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import { failure, success } from "./tool-result.ts";

export const WAIT_AGENT_DEFAULT_TIMEOUT_MS = 30_000;
export const WAIT_AGENT_MIN_TIMEOUT_MS = 100;
export const WAIT_AGENT_MAX_TIMEOUT_MS = 60_000;

export type WaitAgentActivity =
	| "steering"
	| "task_notification"
	| "agent_message"
	| "lifecycle"
	| "completion"
	| "mixed";

export type WaitAgentActivityResult =
	| {
		readonly kind: "activity";
		readonly activity: WaitAgentActivity;
		readonly pendingCount: number;
	}
	| { readonly kind: "timeout" }
	| { readonly kind: "unavailable" };

export interface WaitAgentActivityInput {
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}

export interface WaitAgentActivityContract {
	wait(input: WaitAgentActivityInput): Promise<WaitAgentActivityResult>;
}

export interface WaitAgentToolOptions {
	readonly activity: WaitAgentActivityContract;
}

export const WAIT_AGENT_TOOL_DEFINITION: ToolDefinition = deepFreeze({
	id: "subagent:wait_agent",
	name: "wait_agent",
	description: (
		"Wait for background subagent activity or user steering when no independent work remains. "
		+ "A terminal report is delivered automatically through the caller's mailbox and becomes available to the next model step; no output-fetch tool is needed. "
		+ "A timeout is not completion, so wait again while relevant children remain outstanding. "
		+ "Do not poll task output, create sleeping shell commands, or give the final answer before relevant reports are integrated unless the user explicitly requested detached background work."
	),
	inputSchema: {
		type: "object",
		properties: {
			timeout_ms: {
				type: "integer",
				minimum: WAIT_AGENT_MIN_TIMEOUT_MS,
				maximum: WAIT_AGENT_MAX_TIMEOUT_MS,
				description: "Maximum time to wait for relevant agent activity or user steering. Defaults to 30000 ms; valid range is 100-60000 ms.",
			},
		},
		required: [],
		additionalProperties: false,
	},
});

export class WaitAgentTool implements ToolAdapter {
	readonly definition = WAIT_AGENT_TOOL_DEFINITION;
	readonly #activity: WaitAgentActivityContract;

	constructor(options: WaitAgentToolOptions) {
		this.#activity = options.activity;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		if (!options.ownerTurnId) {
			return failure(
				"Agent activity wait is unavailable outside an active turn.",
				"Agent wait unavailable",
				"agent_wait_unavailable",
			);
		}
		const timeoutMs = timeoutValue(argumentsValue.timeout_ms);
		const result = await this.#activity.wait({
			parentSessionId: options.ownerSessionId,
			parentTurnId: options.ownerTurnId,
			timeoutMs,
			signal: options.signal,
		});
		if (result.kind === "unavailable") {
			return failure(
				"Agent activity wait is unavailable for this session.",
				"Agent wait unavailable",
				"agent_wait_unavailable",
			);
		}
		if (result.kind === "timeout") {
			return success("No agent activity arrived before the timeout.", "Agent wait timed out");
		}
		return success(
			`Agent activity available: ${result.activity} (${result.pendingCount} pending).`,
			"Agent activity available",
		);
	}
}

function timeoutValue(value: unknown): number {
	if (value === undefined) return WAIT_AGENT_DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(value)
		|| (value as number) < WAIT_AGENT_MIN_TIMEOUT_MS
		|| (value as number) > WAIT_AGENT_MAX_TIMEOUT_MS) {
		throw new TypeError("timeout_ms is outside the supported range");
	}
	return value as number;
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
