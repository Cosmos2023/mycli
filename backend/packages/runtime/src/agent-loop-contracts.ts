import type {
	CanonicalConversationItem,
	CanonicalToolCall,
	InstructionSnapshot,
	ToolSetSnapshot,
} from "@mycli/core";
import type { ToolExecutionResult } from "@mycli/tools";

export const AGENT_EXECUTION_ADAPTER_ENV = "MYCLI_AGENT_EXECUTION_ADAPTER";
export const ROOT_AGENT_EXECUTION_ADAPTER_ENV = "MYCLI_ROOT_AGENT_EXECUTION_ADAPTER";
export const SUBAGENT_EXECUTION_ADAPTER_ENV = "MYCLI_SUBAGENT_EXECUTION_ADAPTER";
export const DEFAULT_AGENT_EXECUTION_ADAPTER = "worker" as const;

export type AgentExecutionAdapterKind = "in_process" | "worker";

export interface AgentExecutionAdapterSelection {
	readonly root: AgentExecutionAdapterKind;
	readonly subagent: AgentExecutionAdapterKind;
}

export type AgentLoopPriority = "interactive" | "background";

export interface AgentTimelinePosition {
	readonly windowId: string;
	readonly version: number;
}

export interface AgentContextBootstrap {
	readonly jobId: string;
	readonly position: AgentTimelinePosition;
	readonly instructionSnapshot: InstructionSnapshot;
	readonly toolSetSnapshot: ToolSetSnapshot;
	readonly conversation: readonly CanonicalConversationItem[];
	readonly logicalInputSha256: string;
}

export type AgentContextDelta =
	| {
		readonly kind: "append";
		readonly jobId: string;
		readonly base: AgentTimelinePosition;
		readonly next: AgentTimelinePosition;
		readonly items: readonly CanonicalConversationItem[];
		readonly logicalInputSha256: string;
	}
	| {
		readonly kind: "replace";
		readonly jobId: string;
		readonly base: AgentTimelinePosition;
		readonly bootstrap: AgentContextBootstrap;
	};

export interface AgentToolAttempt {
	readonly attemptId: string;
	readonly jobId: string;
	readonly turnId: string;
	readonly base: AgentTimelinePosition;
	readonly call: CanonicalToolCall;
	readonly mutating: boolean;
}

export interface AgentToolAttemptResult {
	readonly attemptId: string;
	readonly position: AgentTimelinePosition;
	readonly result: ToolExecutionResult;
}

export function parseAgentExecutionAdapter(
	value: string | undefined,
	environmentKey = AGENT_EXECUTION_ADAPTER_ENV,
): AgentExecutionAdapterKind {
	if (value === undefined || value.trim() === "") return DEFAULT_AGENT_EXECUTION_ADAPTER;
	if (value === "in_process" || value === "worker") return value;
	throw new TypeError(`invalid agent execution adapter: ${environmentKey}`);
}

export function resolveAgentExecutionAdapters(
	environment: Readonly<Record<string, string | undefined>>,
): AgentExecutionAdapterSelection {
	const base = parseAgentExecutionAdapter(
		environment[AGENT_EXECUTION_ADAPTER_ENV],
		AGENT_EXECUTION_ADAPTER_ENV,
	);
	return Object.freeze({
		root: parseAgentExecutionAdapterOverride(
			environment[ROOT_AGENT_EXECUTION_ADAPTER_ENV],
			ROOT_AGENT_EXECUTION_ADAPTER_ENV,
			base,
		),
		subagent: parseAgentExecutionAdapterOverride(
			environment[SUBAGENT_EXECUTION_ADAPTER_ENV],
			SUBAGENT_EXECUTION_ADAPTER_ENV,
			base,
		),
	});
}

function parseAgentExecutionAdapterOverride(
	value: string | undefined,
	environmentKey: string,
	fallback: AgentExecutionAdapterKind,
): AgentExecutionAdapterKind {
	if (value === undefined || value.trim() === "") return fallback;
	return parseAgentExecutionAdapter(value, environmentKey);
}
