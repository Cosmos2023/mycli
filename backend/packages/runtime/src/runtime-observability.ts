import type { ErrorContext, RuntimeErrorCode, RuntimeFailure } from "@mycli/contracts";
import type { ProtocolId, ProviderRouteId } from "@mycli/core";

export interface ProviderStreamDiagnostics {
	readonly attempt: number;
	readonly elapsedMs: number;
	readonly ttfbMs?: number;
	readonly ttftMs?: number;
	readonly tbtMs?: number;
	readonly maxTbtMs?: number;
	readonly lastTextDeltaMs?: number;
	readonly responseTerminalMs?: number;
	readonly sdkTerminalMs?: number;
	readonly completedEventMs?: number;
	readonly streamSettledMs?: number;
	readonly terminalPersistMs?: number;
	readonly textTailMs?: number;
	readonly textDeltaIntervalCount: number;
	readonly providerEventCount: number;
	readonly reasoningEventCount: number;
	readonly textEventCount: number;
	readonly providerStateEventCount: number;
	readonly toolCallEventCount: number;
	readonly usageEventCount: number;
	readonly completedEventCount: number;
	readonly reasoningBytes: number;
	readonly textBytes: number;
	readonly success: boolean;
	readonly failureKind?: RuntimeErrorCode;
	readonly failure?: RuntimeFailure;
}

export type RuntimeDiagnosticEvent =
	| { readonly kind: "runtime_error"; readonly operation: "terminal_commit" | "terminal_projection"; readonly errorContext?: ErrorContext }
	| (ProviderStreamDiagnostics & {
		readonly kind: "model_stream_diagnostics";
		readonly turnId: string;
		readonly provider: ProviderRouteId;
		readonly protocol: ProtocolId;
		readonly model: string;
	})
	| {
		readonly kind: "turn_completion_diagnostics";
		readonly turnId: string;
		readonly commitMs: number;
		readonly continuationMs: number;
		readonly snapshotMs: number;
		readonly publishMs: number;
		readonly elapsedMs: number;
		readonly snapshotWritten: boolean;
	}
	| {
		readonly kind: "tool_execution";
		readonly turnId: string;
		readonly callId: string;
		readonly toolName: string;
		readonly durationMs: number;
		readonly success: boolean;
		readonly outputChars: number;
		readonly outputTruncated: boolean;
		readonly failureKind?: string;
	}
	| {
		readonly kind: "compaction";
		readonly turnId: string;
		readonly source: "pre_turn" | "mid_turn" | "context_overflow" | "user_requested";
		readonly status: "not_needed" | "compressed" | "skipped" | "failed" | "interrupted";
		readonly beforeTokens: number;
		readonly afterTokens: number;
		readonly maxTokens: number;
		readonly durationMs: number;
	};

export function publishRuntimeDiagnostic(
	sink: ((event: RuntimeDiagnosticEvent) => void) | undefined,
	event: RuntimeDiagnosticEvent,
): void {
	try {
		sink?.(Object.freeze(event));
	} catch {
		// Diagnostics are best-effort and must never alter runtime behavior.
	}
}

export function publishProviderStreamDiagnostics(
	sink: ((diagnostic: ProviderStreamDiagnostics) => void) | undefined,
	diagnostic: ProviderStreamDiagnostics,
): void {
	try {
		sink?.(Object.freeze(diagnostic));
	} catch {
		// Diagnostics are best-effort and must never alter provider execution.
	}
}
