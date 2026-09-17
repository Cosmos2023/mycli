import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { isProviderRouteId } from "@mycli/core";
import { readErrorContext, RUNTIME_RETRY_AFTER_MAX_SECONDS, sanitizeRuntimeErrorDetail } from "@mycli/contracts";
import type { RuntimeDiagnosticEvent } from "@mycli/runtime";
import type { RuntimeSessionStore } from "@mycli/storage";

const NODE_TRACE_MAX_BYTES = 5 * 1024 * 1024;

type NodeTraceKind =
	| "runtime_error"
	| "turn_interrupt_requested"
	| "turn_interrupted"
	| "model_stream_diagnostics"
	| "turn_completion_diagnostics"
	| "tool_execution"
	| "compaction"
	| "subagent_lifecycle";

export function nodeTraceRows(
	store: RuntimeSessionStore,
	homeDir: string,
	sessionId: string,
): readonly Readonly<Record<string, unknown>>[] {
	const diagnostics = loadNodeTrace(homeDir, sessionId);
	const turns = store.loadTurnRollouts(sessionId).slice(-50).map((rollout) => {
		const continuation = objectValue(rollout.continuation_state);
		const usage = objectValue(continuation.usage);
		return Object.freeze({
			kind: "turn",
			...(boundedTraceString(rollout.turn_id, 256) ? {
				turn_id: boundedTraceString(rollout.turn_id, 256),
			} : {}),
			...(boundedTraceString(rollout.status, 32) ? {
				status: boundedTraceString(rollout.status, 32),
			} : {}),
			...(boundedTraceString(rollout.stop_reason, 64) ? {
				stop_reason: boundedTraceString(rollout.stop_reason, 64),
			} : {}),
			...(boundedTraceString(rollout.started_at, 64) ? {
				started_at: boundedTraceString(rollout.started_at, 64),
			} : {}),
			...(boundedTraceString(rollout.completed_at, 64) ? {
				completed_at: boundedTraceString(rollout.completed_at, 64),
			} : {}),
			...traceUsage(usage),
		});
	});
	return Object.freeze([...turns, ...diagnostics].slice(-50));
}

export function appendNodeTrace(
	homeDir: string,
	sessionId: string,
	event: Readonly<Record<string, unknown>>,
): void {
	const identity = traceSessionId(sessionId);
	const kind = nodeTraceKind(event.kind);
	const turnId = boundedTraceString(event.turn_id, 256);
	if (!kind || !turnId) return;
	const payload = nodeTracePayload(kind, objectValue(event.payload));
	const tracesRoot = join(homeDir, ".mycli", "traces");
	const logsRoot = join(homeDir, ".mycli", "logs");
	mkdirSync(tracesRoot, { recursive: true, mode: 0o700 });
	mkdirSync(logsRoot, { recursive: true, mode: 0o700 });
	const tracePath = join(tracesRoot, `${identity}-trace.jsonl`);
	const traceLine = `${JSON.stringify({ kind, turn_id: turnId, payload })}\n`;
	rotateNodeTraceIfNeeded(tracePath, Buffer.byteLength(traceLine, "utf8"));
	appendFileSync(tracePath, traceLine, { encoding: "utf8", mode: 0o600 });
	appendFileSync(
		join(logsRoot, "agent.log"),
		`event=${kind} session_id=${identity} turn_id=${turnId}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

export function runtimeDiagnosticTraceEvent(
	event: RuntimeDiagnosticEvent,
): Readonly<Record<string, unknown>> {
	if (event.kind === "runtime_error") return Object.freeze({
		kind: event.kind, turn_id: event.errorContext?.scope.id ?? "unavailable",
		payload: { operation: event.operation, ...(event.errorContext ? { error_context: event.errorContext } : {}) },
	});
	if (event.kind === "model_stream_diagnostics") {
		return Object.freeze({
			kind: event.kind,
			turn_id: event.turnId,
			payload: {
				provider: event.provider,
				protocol: event.protocol,
				model: event.model,
				attempt: event.attempt,
				elapsed_ms: event.elapsedMs,
				...(event.ttfbMs === undefined ? {} : { ttfb_ms: event.ttfbMs }),
				...(event.ttftMs === undefined ? {} : { ttft_ms: event.ttftMs }),
				...(event.tbtMs === undefined ? {} : { tbt_ms: event.tbtMs }),
				...(event.maxTbtMs === undefined ? {} : { max_tbt_ms: event.maxTbtMs }),
				...(event.lastTextDeltaMs === undefined ? {} : { last_text_delta_ms: event.lastTextDeltaMs }),
				...(event.responseTerminalMs === undefined ? {} : { response_terminal_ms: event.responseTerminalMs }),
				...(event.sdkTerminalMs === undefined ? {} : { sdk_terminal_ms: event.sdkTerminalMs }),
				...(event.completedEventMs === undefined ? {} : { completed_event_ms: event.completedEventMs }),
				...(event.streamSettledMs === undefined ? {} : { stream_settled_ms: event.streamSettledMs }),
				...(event.terminalPersistMs === undefined ? {} : { terminal_persist_ms: event.terminalPersistMs }),
				...(event.textTailMs === undefined ? {} : { text_tail_ms: event.textTailMs }),
				text_delta_interval_count: event.textDeltaIntervalCount,
				provider_event_count: event.providerEventCount,
				reasoning_event_count: event.reasoningEventCount,
				text_event_count: event.textEventCount,
				provider_state_event_count: event.providerStateEventCount,
				tool_call_event_count: event.toolCallEventCount,
				usage_event_count: event.usageEventCount,
				completed_event_count: event.completedEventCount,
				reasoning_bytes: event.reasoningBytes,
				text_bytes: event.textBytes,
				success: event.success,
				...(event.failureKind ? { failure_kind: event.failureKind } : {}),
				...(event.failure ? modelFailureTracePayload({
					error_context: event.failure.errorContext,
					retryable: event.failure.retryable,
					retry_after_seconds: event.failure.retryAfterSeconds,
					additional_details: event.failure.additionalDetails,
					status: event.failure.diagnostics?.status,
					request_id: event.failure.diagnostics?.request_id,
					provider_error_code: event.failure.diagnostics?.provider_error_code,
					provider_error_type: event.failure.diagnostics?.provider_error_type,
					transport_error_code: event.failure.diagnostics?.transport_error_code,
					transport_error_name: event.failure.diagnostics?.transport_error_name,
					error_source: event.failure.diagnostics?.error_source,
				}) : {}),
			},
		});
	}
	if (event.kind === "turn_completion_diagnostics") {
		return Object.freeze({
			kind: event.kind,
			turn_id: event.turnId,
			payload: {
				commit_ms: event.commitMs,
				continuation_ms: event.continuationMs,
				snapshot_ms: event.snapshotMs,
				publish_ms: event.publishMs,
				elapsed_ms: event.elapsedMs,
				snapshot_written: event.snapshotWritten,
			},
		});
	}
	if (event.kind === "tool_execution") {
		return Object.freeze({
			kind: event.kind,
			turn_id: event.turnId,
			payload: {
				call_id: event.callId,
				tool_name: event.toolName,
				duration_ms: event.durationMs,
				success: event.success,
				output_chars: event.outputChars,
				output_truncated: event.outputTruncated,
				...(event.failureKind ? { failure_kind: event.failureKind } : {}),
			},
		});
	}
	return Object.freeze({
		kind: event.kind,
		turn_id: event.turnId,
		payload: {
			source: event.source,
			status: event.status,
			before_tokens: event.beforeTokens,
			after_tokens: event.afterTokens,
			max_tokens: event.maxTokens,
			duration_ms: event.durationMs,
			...(event.failure ? {
				failure_kind: event.failure.code,
				...modelFailureTracePayload({ error_context: event.failure.errorContext,
					retryable: event.failure.retryable, additional_details: event.failure.additionalDetails,
					...event.failure.diagnostics }),
			} : {}),
			...(event.usage ? traceUsage(event.usage) : {}),
		},
	});
}

export function tryAppendNodeTrace(
	homeDir: string,
	sessionId: string,
	event: Readonly<Record<string, unknown>>,
): void {
	try {
		appendNodeTrace(homeDir, sessionId, event);
	} catch {
		// Observability is best-effort and never participates in turn success.
	}
}

export function elapsedIsoMs(startedAt: string, finishedAt: string): number {
	const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
	return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

export function elapsedMonotonicMs(startedAt: number, finishedAt: number): number {
	const elapsed = finishedAt - startedAt;
	return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

export function nodeLogRows(homeDir: string): readonly string[] {
	const logsRoot = join(homeDir, ".mycli", "logs");
	const rows = ["agent.log", "errors.log", "model-events.jsonl"].map((name) => {
		const path = join(logsRoot, name);
		return existsSync(path)
			? `${name} present bytes=${statSync(path).size}`
			: `${name} absent`;
	});
	return Object.freeze(rows);
}

function rotateNodeTraceIfNeeded(path: string, incomingBytes: number): void {
	if (!existsSync(path) || statSync(path).size + incomingBytes <= NODE_TRACE_MAX_BYTES) return;
	const backup = `${path}.1`;
	rmSync(backup, { force: true });
	renameSync(path, backup);
}

function loadNodeTrace(
	homeDir: string,
	sessionId: string,
): readonly Readonly<Record<string, unknown>>[] {
	const identity = traceSessionId(sessionId);
	const path = join(homeDir, ".mycli", "traces", `${identity}-trace.jsonl`);
	if (!existsSync(path)) return Object.freeze([]);
	const rows: Readonly<Record<string, unknown>>[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
			const event = parsed as Readonly<Record<string, unknown>>;
			const kind = nodeTraceKind(event.kind);
			const turnId = boundedTraceString(event.turn_id, 256);
			if (!kind || !turnId) continue;
			rows.push(Object.freeze({
				kind,
				turn_id: turnId,
				payload: nodeTracePayload(kind, objectValue(event.payload)),
			}));
		} catch {
			// Corrupt diagnostics are skipped without affecting the runtime.
		}
	}
	return Object.freeze(rows.slice(-50));
}

function traceSessionId(value: string): string {
	if (!value || value.startsWith("<") || value.endsWith(">")
		|| value.includes("/") || value.includes("\\") || value.includes("..")) {
		throw new Error("invalid trace session id");
	}
	return value.slice(0, 256);
}

function nodeTraceKind(value: unknown): NodeTraceKind | undefined {
	return [
		"runtime_error",
		"turn_interrupt_requested",
		"turn_interrupted",
		"model_stream_diagnostics",
		"turn_completion_diagnostics",
		"tool_execution",
		"compaction",
		"subagent_lifecycle",
	].includes(value as NodeTraceKind)
		? value as NodeTraceKind
		: undefined;
}

function nodeTracePayload(
	kind: NodeTraceKind,
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	if (kind === "runtime_error") return {
		...(value.operation === "terminal_commit" || value.operation === "terminal_projection" ? { operation: value.operation } : {}),
		...(readErrorContext(value.error_context) ? { error_context: readErrorContext(value.error_context) } : {}),
	};
	if (kind === "model_stream_diagnostics") return modelStreamTracePayload(value);
	if (kind === "turn_completion_diagnostics") return compactTracePayload({
		commit_ms: boundedTraceNumber(value.commit_ms),
		continuation_ms: boundedTraceNumber(value.continuation_ms),
		snapshot_ms: boundedTraceNumber(value.snapshot_ms),
		publish_ms: boundedTraceNumber(value.publish_ms),
		elapsed_ms: boundedTraceNumber(value.elapsed_ms),
		snapshot_written: typeof value.snapshot_written === "boolean" ? value.snapshot_written : undefined,
	});
	if (kind === "tool_execution") return toolExecutionTracePayload(value);
	if (kind === "compaction") return compactionTracePayload(value);
	if (kind === "subagent_lifecycle") return subagentLifecycleTracePayload(value);
	const clientTurnId = boundedTraceString(value.client_turn_id, 256);
	return Object.freeze({
		...(clientTurnId ? { client_turn_id: clientTurnId } : {}),
		...(typeof value.requested === "boolean" ? { requested: value.requested } : {}),
		...(typeof value.input_rolled_back === "boolean"
			? { input_rolled_back: value.input_rolled_back }
			: {}),
		...(value.status === "interrupted" ? { status: "interrupted" } : {}),
	});
}

function modelStreamTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return compactTracePayload({
		provider: isProviderRouteId(value.provider) ? value.provider : undefined,
		protocol: traceEnum(value.protocol, ["responses", "chat_completions", "anthropic_messages"]),
		model: boundedTraceToken(value.model, 256),
		attempt: boundedTraceCount(value.attempt),
		elapsed_ms: boundedTraceNumber(value.elapsed_ms),
		ttfb_ms: boundedTraceNumber(value.ttfb_ms),
		ttft_ms: boundedTraceNumber(value.ttft_ms),
		tbt_ms: boundedTraceNumber(value.tbt_ms),
		max_tbt_ms: boundedTraceNumber(value.max_tbt_ms),
		last_text_delta_ms: boundedTraceNumber(value.last_text_delta_ms),
		response_terminal_ms: boundedTraceNumber(value.response_terminal_ms),
		sdk_terminal_ms: boundedTraceNumber(value.sdk_terminal_ms),
		completed_event_ms: boundedTraceNumber(value.completed_event_ms),
		stream_settled_ms: boundedTraceNumber(value.stream_settled_ms),
		terminal_persist_ms: boundedTraceNumber(value.terminal_persist_ms),
		text_tail_ms: boundedTraceNumber(value.text_tail_ms),
		text_delta_interval_count: boundedTraceCount(value.text_delta_interval_count),
		provider_event_count: boundedTraceCount(value.provider_event_count),
		reasoning_event_count: boundedTraceCount(value.reasoning_event_count),
		text_event_count: boundedTraceCount(value.text_event_count),
		provider_state_event_count: boundedTraceCount(value.provider_state_event_count),
		tool_call_event_count: boundedTraceCount(value.tool_call_event_count),
		usage_event_count: boundedTraceCount(value.usage_event_count),
		completed_event_count: boundedTraceCount(value.completed_event_count),
		reasoning_bytes: boundedTraceCount(value.reasoning_bytes),
		text_bytes: boundedTraceCount(value.text_bytes),
		success: typeof value.success === "boolean" ? value.success : undefined,
		failure_kind: boundedTraceToken(value.failure_kind, 64),
		...modelFailureTracePayload(value),
	});
}

function modelFailureTracePayload(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const errorContext = readErrorContext(value.error_context);
	return compactTracePayload({
		...(errorContext ? { error_context: errorContext } : {}),
		retryable: typeof value.retryable === "boolean" ? value.retryable : undefined,
		retry_after_seconds: typeof value.retry_after_seconds === "number"
			&& Number.isFinite(value.retry_after_seconds) && value.retry_after_seconds >= 0
			&& value.retry_after_seconds <= RUNTIME_RETRY_AFTER_MAX_SECONDS ? value.retry_after_seconds : undefined,
		additional_details: sanitizeRuntimeErrorDetail(value.additional_details),
		status: Number.isInteger(value.status) && (value.status as number) >= 100
			&& (value.status as number) <= 599 ? value.status : undefined,
		request_id: boundedTraceToken(value.request_id, 128),
		provider_error_code: boundedTraceToken(value.provider_error_code, 128),
		provider_error_type: boundedTraceToken(value.provider_error_type, 128),
		transport_error_code: boundedTraceToken(value.transport_error_code, 128),
		transport_error_name: boundedTraceToken(value.transport_error_name, 128),
		error_source: traceEnum(value.error_source, ["http", "response_stream", "transport"]),
	});
}

function toolExecutionTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return compactTracePayload({
		call_id: boundedTraceToken(value.call_id, 256),
		tool_name: boundedTraceToken(value.tool_name, 128),
		duration_ms: boundedTraceNumber(value.duration_ms),
		success: typeof value.success === "boolean" ? value.success : undefined,
		output_chars: boundedTraceCount(value.output_chars),
		output_truncated: typeof value.output_truncated === "boolean"
			? value.output_truncated
			: undefined,
		failure_kind: boundedTraceToken(value.failure_kind, 128),
	});
}

function compactionTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return compactTracePayload({
		source: traceEnum(value.source, ["pre_turn", "mid_turn", "context_overflow", "user_requested"]),
		status: traceEnum(value.status, ["not_needed", "compressed", "skipped", "failed", "interrupted"]),
		before_tokens: boundedTraceCount(value.before_tokens),
		after_tokens: boundedTraceCount(value.after_tokens),
		max_tokens: boundedTraceCount(value.max_tokens),
		duration_ms: boundedTraceNumber(value.duration_ms),
		failure_kind: boundedTraceToken(value.failure_kind, 64),
		...modelFailureTracePayload(value),
		...traceUsage(value),
	});
}

function subagentLifecycleTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return compactTracePayload({
		thread_id: boundedTraceToken(value.thread_id, 256),
		status: traceEnum(value.status, ["started", "completed", "failed", "interrupted"]),
		duration_ms: boundedTraceNumber(value.duration_ms),
	});
}

function boundedTraceNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		&& value <= 24 * 60 * 60 * 1_000
		? value
		: undefined;
}

function boundedTraceCount(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0
		&& (value as number) <= 1_099_511_627_776
		? value as number
		: undefined;
}

function boundedTraceToken(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= limit
		&& /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
		? value
		: undefined;
}

function traceEnum<const Value extends string>(
	value: unknown,
	allowed: readonly Value[],
): Value | undefined {
	return typeof value === "string" && allowed.includes(value as Value)
		? value as Value
		: undefined;
}

function compactTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return Object.freeze(Object.fromEntries(
		Object.entries(value).filter((entry) => entry[1] !== undefined),
	));
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

function boundedTraceString(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value ? value.slice(0, limit) : undefined;
}

function traceUsage(value: Readonly<Record<string, unknown>>): Readonly<Record<string, number>> {
	const result: Record<string, number> = {};
	for (const key of ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "reasoning_tokens",
		"cached_tokens", "cache_write_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
		const count = value[key];
		if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) result[key] = count;
	}
	return Object.freeze(result);
}
