import { readErrorContext } from "@mycli/contracts";
import type { CanonicalToolCall } from "@mycli/core";
import { normalizeCanonicalImages } from "@mycli/core";
import type { AppendToolResultInput } from "../sessions/session-store.ts";
import type { AgentEffectAttempt } from "./agent-effect-ledger.ts";

type RecoveredToolResult = Readonly<{
	result: AppendToolResultInput["result"];
	summary: string;
	errorKind?: string;
	metadata?: Readonly<Record<string, unknown>>;
}>;

export function interruptedToolResult(
	call: CanonicalToolCall,
	attempt: AgentEffectAttempt | undefined,
	interruptedOutput: string,
): RecoveredToolResult {
	const completed = completedAttemptToolResult(call, attempt);
	if (completed) return completed;
	const toolName = call.name.slice(0, 128) || "Tool";
	const errorKind = attempt?.state === "effect_outcome_unknown"
		? "effect_outcome_unknown"
		: attempt?.state === "failed" || attempt?.state === "unknown"
			? attempt.state
			: "tool_interrupted";
	return Object.freeze({
		result: Object.freeze({
			callId: call.callId,
			toolName: call.name,
			output: errorKind === "effect_outcome_unknown"
				? "Tool outcome is unknown because interruption occurred after the effect started."
				: errorKind === "tool_interrupted"
					? attempt
						? "Tool execution was interrupted before a result was persisted."
						: interruptedOutput
					: "Tool result was not available after interruption.",
			success: false,
		}),
		summary: errorKind === "effect_outcome_unknown"
			? `${toolName} outcome unknown`
			: errorKind === "tool_interrupted"
				? `${toolName} interrupted`
				: `${toolName} result unavailable`,
		errorKind,
		metadata: Object.freeze({ synthetic: true, append_only: true }),
	});
}

function completedAttemptToolResult(
	call: CanonicalToolCall,
	attempt: AgentEffectAttempt | undefined,
): RecoveredToolResult | undefined {
	if (attempt?.state !== "completed" || !attempt.result) return undefined;
	const result = attempt.result;
	if (result.callId !== call.callId
		|| result.toolName !== call.name
		|| typeof result.success !== "boolean"
		|| typeof result.modelOutput !== "string"
		|| typeof result.summary !== "string"
		|| typeof result.metadata !== "object"
		|| result.metadata === null
		|| Array.isArray(result.metadata)) {
		return undefined;
	}
	const metadata = { ...result.metadata as Readonly<Record<string, unknown>> };
	const errorContext = result.success ? undefined : readErrorContext(result.errorContext ?? metadata.error_context);
	delete metadata.error_context;
	if (errorContext) metadata.error_context = errorContext;
	return Object.freeze({
		result: Object.freeze({
			callId: call.callId,
			toolName: call.name,
			output: result.modelOutput,
			...(result.images === undefined ? {} : { images: normalizeCanonicalImages(result.images) }),
			success: result.success,
		}),
		summary: result.summary,
		...(typeof result.errorKind === "string" ? { errorKind: result.errorKind } : {}),
		metadata: Object.freeze(metadata),
	});
}
