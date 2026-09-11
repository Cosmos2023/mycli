import { createErrorContext, failureScope, legacyToolReason, readErrorContext } from "@mycli/contracts";
import type { ErrorContext, ErrorContextInput, ErrorReasonDetails } from "@mycli/contracts";
import type { CanonicalToolCall } from "@mycli/core";
import type { ToolAdapterResult, ToolExecutionOptions } from "../types.ts";

export function toolErrorContext(
	call: CanonicalToolCall,
	result: ToolAdapterResult,
	options: Pick<ToolExecutionOptions, "errorContextVersion" | "mutating">,
	dispatched = true,
): ErrorContext | undefined {
	if (options.errorContextVersion !== 1 || result.success) return undefined;
	const scope = failureScope("tool_call", call.callId);
	const existing = readErrorContext(result.errorContext ?? result.metadata.error_context);
	if (existing?.scope.kind === scope.kind && existing.scope.id === scope.id) return existing;
	const reason = legacyToolReason(result.errorKind);
	const details = reason.startsWith("tool.")
		? { tool: call.name, ...(result.errorKind ? { legacy_kind: result.errorKind } : {}),
			...(typeof result.metadata.exit_code === "number" ? { exit_code: result.metadata.exit_code } : {}),
			...(typeof result.metadata.timeout_ms === "number" ? { timeout_ms: result.metadata.timeout_ms } : {}),
		}
		: reason.startsWith("policy.") ? { tool: call.name } : undefined;
	return createErrorContext({
		reason, ...(details ? { details } as Pick<ErrorReasonDetails, "details"> : {}),
		source: reason.startsWith("policy.") ? "policy" : reason.startsWith("integration.") ? "integration" : "tool",
		scope,
		outcome: !dispatched || reason.startsWith("policy.") || reason === "tool.invalid_arguments" || reason === "tool.process_start_failed"
			? { state: "not_started", effects: "none" }
			: reason === "runtime.effect_outcome_unknown" || reason === "tool.timed_out" ? { state: "unknown", effects: options.mutating === false ? "none" : "possible" }
				: { state: "failed", effects: options.mutating === false ? "none" : "possible" },
	} as ErrorContextInput);
}

export function imageInputUnsupportedResult(options: {
	readonly callId: string;
	readonly model?: string;
	readonly errorContextVersion?: 1;
}): ToolAdapterResult {
	const errorContext = options.errorContextVersion === 1 ? createErrorContext({
		reason: "capability.image_input_unsupported", source: "tool",
		scope: failureScope("tool_call", options.callId), outcome: { state: "not_started", effects: "none" },
		details: { input_origin: "tool", ...(options.model ? { model: options.model } : {}) },
	}) : undefined;
	return { success: false, errorKind: "unsupported_capability", summary: "Image unavailable",
		modelOutput: "view_image failed\nThe selected model cannot read images. Select a model with image-input support.",
		...(errorContext ? { errorContext } : {}), metadata: errorContext ? { error_context: errorContext } : {},
	};
}
