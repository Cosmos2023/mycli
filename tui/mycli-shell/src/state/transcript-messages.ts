import {
	GATEWAY_TOOL_PREVIEW_MAX_CHARS,
	errorDefinition,
	errorPublicDetails,
	errorSummary,
	readErrorContext,
	TURN_INTERRUPTED_NOTICE,
	turnInterruptionNotice,
	isTurnInterruptionReason,
	diagnosticRecoveryAction,
	isDiagnosticCategory,
	isDiagnosticRecoveryActionId,
	isRuntimeErrorCode,
	runtimeErrorCategory,
	runtimeErrorRecoveryActions,
	runtimeErrorRecoveryHint,
	sanitizeRuntimeErrorDetail,
	turnFailedNoticeId,
	turnFailureNotice,
	turnInterruptedNoticeId,
	type DiagnosticRecoveryActionId,
} from "@mycli/contracts";
import type { MycliShellNoticeDiagnostic, MycliShellWebSearch } from "../model.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { booleanValue, nextId, numberValue, recordValue, stringValue, textValue } from "./payload-values.ts";
import type { RuntimeShellState, RuntimeTranscriptItem } from "./runtime-state-model.ts";
import { findLastIndex, findToolIndex } from "./transcript-records.ts";

export function appendInterruptedNotice(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
): RuntimeTranscriptItem[] {
	const turnId = stringValue(params.turn_id) ?? stringValue(params.client_turn_id);
	const currentTurnStart = items.findLastIndex((item) => item.type === "user");
	const currentTurnItems = items.slice(currentTurnStart + 1);
	if (
		turnId ? items.some((item) => item.id === turnInterruptedNoticeId(turnId)) : currentTurnItems.some(
			(item) => item.type === "warning" && item.text === TURN_INTERRUPTED_NOTICE,
		)
	) {
		return items;
	}
	return [
		...items,
		{
			id: turnId ? turnInterruptedNoticeId(turnId) : nextId("turn-interrupted"),
			...(turnId ? { turn_id: turnId } : {}),
			type: "warning",
			text: turnInterruptionNotice(isTurnInterruptionReason(params.interruption_reason) ? params.interruption_reason : undefined),
			folded: false,
			metadata: {
				...errorNoticeMetadata(params),
				event_kind: "turn_interrupted",
				...(turnId ? { interrupted_turn_id: turnId } : {}),
				status: "interrupted",
			},
		},
	];
}

export function appendTurnFailureNotice(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
): RuntimeTranscriptItem[] {
	const code = stringValue(params.code) ?? stringValue(params.error_code) ?? "provider_error";
	const message = turnFailureNotice(code, stringValue(params.message) ?? undefined, readErrorContext(params.error_context));
	const turnId = stringValue(params.turn_id) ?? stringValue(params.client_turn_id);
	return appendErrorNotice(items, {
		...params,
		code,
		event_kind: "turn_failed",
		status: "failed",
		source: "runtime",
	}, message, turnId ? turnFailedNoticeId(turnId) : undefined);
}

export function appendErrorNotice(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
	message: string,
	id?: string,
): RuntimeTranscriptItem[] {
	if (id && items.some((item) => item.id === id)) return items;
	const context = readErrorContext(params.error_context);
	return [
		...items,
		{
			id: id ?? nextId("error"),
			type: "error",
			text: context ? errorSummary(context) : message,
			folded: false,
			metadata: errorNoticeMetadata(params),
		},
	];
}

function errorNoticeMetadata(params: Record<string, unknown>): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	const context = readErrorContext(params.error_context);
	if (context) metadata.error_context = context;
	if (params.error_context_invalid === true || (params.error_context !== undefined && !context)) metadata.error_context_invalid = true;
	for (const key of [
		"source",
		"method",
		"code",
		"event_kind",
		"status",
		"category",
		"occurrence_id",
	] as const) {
		const value = stringValue(params[key]);
		if (value) metadata[key] = value;
	}
	const recoveryActions = recoveryActionIds(params.recovery_actions);
	if (Array.isArray(params.recovery_actions)) metadata.recovery_actions = recoveryActions;
	for (const key of ["turn_id", "client_turn_id"] as const) {
		const value = stringValue(params[key]);
		if (value) metadata[key] = value;
	}
	const additionalDetails = sanitizeRuntimeErrorDetail(params.additional_details);
	if (additionalDetails) {
		metadata.additional_details = additionalDetails;
	}
	return metadata;
}

export function turnFailureMessage(params: Record<string, unknown>): string {
	return turnFailureNotice(
		stringValue(params.code) ?? stringValue(params.error_code) ?? "provider_error",
		stringValue(params.message) ?? undefined,
		readErrorContext(params.error_context),
	);
}

export function finalizeInterruptedTools(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	let changed = false;
	const finalized = items.map((item) => {
		if (item.type !== "tool_summary" && item.type !== "tool_detail") return item;
		const metadata = recordValue(item.metadata);
		const record = item.tool_record;
		if ((record ? record.status !== "running" : stringValue(metadata.status) !== "running")
			|| (record ? record.shell?.background === true : booleanValue(metadata.background) === true)) {
			return item;
		}
		changed = true;
		return {
			...item,
			...(record ? { tool_record: { ...record, status: "error" as const, error_preview: "tool_interrupted" } } : {}),
			metadata: {
				...metadata,
				status: "failed",
				success: false,
				error_kind: "tool_interrupted",
				error: "tool_interrupted",
				summary: stringValue(metadata.summary) ?? `${stringValue(metadata.tool_name) ?? "Tool"} interrupted`,
			},
		};
	});
	return changed ? finalized : items;
}

export function finalizeFailedTools(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
): RuntimeTranscriptItem[] {
	const message = turnFailureMessage(params);
	let changed = false;
	const finalized = items.map((item) => {
		if (item.type !== "tool_summary" && item.type !== "tool_detail") return item;
		const metadata = recordValue(item.metadata);
		const record = item.tool_record;
		if ((record ? record.status !== "running" : stringValue(metadata.status) !== "running")
			|| (record ? record.shell?.background === true : booleanValue(metadata.background) === true)) {
			return item;
		}
		changed = true;
		return {
			...item,
			...(record ? { tool_record: { ...record, status: "error" as const, error_preview: message.slice(0, GATEWAY_TOOL_PREVIEW_MAX_CHARS) } } : {}),
			metadata: {
				...metadata,
				status: "failed",
				success: false,
				error_kind: "turn_failed",
				error: message,
				summary: stringValue(metadata.summary) ?? `${stringValue(metadata.tool_name) ?? "Tool"} failed`,
			},
		};
	});
	return changed ? finalized : items;
}

export function noticeDiagnostic(
	value: Record<string, unknown> | undefined,
): { diagnostic?: MycliShellNoticeDiagnostic } {
	const metadata = recordValue(value);
	const source = stringValue(metadata.source);
	const method = stringValue(metadata.method);
	const code = stringValue(metadata.code);
	const context = readErrorContext(metadata.error_context);
	const invalidContext = metadata.error_context_invalid === true || (metadata.error_context !== undefined && !context);
	const details = context ? errorPublicDetails(context) ?? sanitizeRuntimeErrorDetail(metadata.additional_details)
		: sanitizeRuntimeErrorDetail(metadata.additional_details);
	const runtimeCode = code && isRuntimeErrorCode(code) ? code : undefined;
	const hint = runtimeCode && !context && !invalidContext ? runtimeErrorRecoveryHint(runtimeCode) : undefined;
	const category = context ? errorDefinition(context.reason).category : runtimeCode
		? runtimeErrorCategory(runtimeCode)
		: isDiagnosticCategory(metadata.category) ? metadata.category : undefined;
	const recoveryActions = invalidContext ? [] : context || Array.isArray(metadata.recovery_actions)
		? recoveryActionIds(metadata.recovery_actions).map(diagnosticRecoveryAction)
		: runtimeCode ? runtimeErrorRecoveryActions(runtimeCode) : [];
	const occurrenceId = stringValue(metadata.occurrence_id);
	return context || hint || source || method || code || details || category || recoveryActions.length > 0
		? {
			diagnostic: {
				...(context ? { errorContext: context } : {}),
				...(hint ? { hint } : {}),
				...(source ? { source } : {}),
				...(method ? { method } : {}),
				...(code ? { code } : {}),
				...(details ? { details } : {}),
				...(category ? { category } : {}),
				...(recoveryActions.length > 0 ? { recoveryActions } : {}),
				...(occurrenceId ? { occurrenceId } : {}),
			},
		}
		: {};
}

function recoveryActionIds(value: unknown): DiagnosticRecoveryActionId[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 4).flatMap((item) => {
		const id = recoveryActionId(item);
		return id ? [id] : [];
	});
}

function recoveryActionId(value: unknown): DiagnosticRecoveryActionId | undefined {
	return isDiagnosticRecoveryActionId(value) ? value : undefined;
}

export function rollbackOutputFreeUserTurn(
	items: RuntimeTranscriptItem[],
): RuntimeTranscriptItem[] {
	const userIndex = items.findLastIndex((item) => item.type === "user");
	return userIndex < 0 ? items : items.slice(0, userIndex);
}

export function webSearchFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellWebSearch | null {
	const metadata = recordValue(item.metadata);
	const callId = stringValue(item.call_id) ?? stringValue(metadata.call_id);
	if (!callId) return null;
	const rawStatus = stringValue(item.status) ?? stringValue(metadata.status);
	const rawAction = stringValue(metadata.action_type);
	const action: MycliShellWebSearch["action"] = rawAction === "search"
		|| rawAction === "open_page"
		|| rawAction === "find_in_page"
		? rawAction
		: "other";
	return {
		id: item.id,
		callId,
		status: rawStatus === "running" ? "running" : "completed",
		action,
		...(item.text.trim() ? { detail: item.text.trim() } : {}),
	};
}

export function webSearchActionMetadata(value: unknown): Record<string, unknown> {
	const action = recordValue(value);
	const type = stringValue(action.type);
	if (type === "search") {
		const query = textValue(action.query);
		const queries = Array.isArray(action.queries)
			? action.queries
				.filter((item): item is string => typeof item === "string" && item.length > 0)
				.slice(0, 16)
			: [];
		return {
			action_type: type,
			...(query ? { query } : {}),
			...(queries.length > 0 ? { queries } : {}),
		};
	}
	if (type === "open_page") {
		const url = textValue(action.url);
		return { action_type: type, ...(url ? { url } : {}) };
	}
	if (type === "find_in_page") {
		const url = textValue(action.url);
		const pattern = textValue(action.pattern);
		return {
			action_type: type,
			...(url ? { url } : {}),
			...(pattern ? { pattern } : {}),
		};
	}
	return { action_type: "other" };
}

export function webSearchDetail(metadata: Readonly<Record<string, unknown>>): string {
	const type = stringValue(metadata.action_type);
	if (type === "search") {
		const query = textValue(metadata.query);
		if (query) return query;
		const queries = Array.isArray(metadata.queries)
			? metadata.queries.filter((item): item is string => typeof item === "string" && item.length > 0)
			: [];
		return queries.length > 1 ? `${queries[0]} ...` : queries[0] ?? "";
	}
	if (type === "open_page") return textValue(metadata.url) ?? "";
	if (type === "find_in_page") {
		const url = textValue(metadata.url);
		const pattern = textValue(metadata.pattern);
		return pattern && url ? `'${pattern}' in ${url}` : pattern ? `'${pattern}'` : url ?? "";
	}
	return "";
}

export function applyAssistantDelta(items: RuntimeTranscriptItem[], assistantId: string, text: string): RuntimeTranscriptItem[] {
	const lastIndex = items.length - 1;
	const last = items[lastIndex];
	if (last?.id === assistantId && last.type === "assistant_stream") {
		return items.with(lastIndex, { ...last, text: `${last.text}${text}` });
	}
	if (last?.id === assistantId && last.type === "assistant_final") {
		return items.with(lastIndex, {
			...last,
			type: "assistant_stream",
			text: `${last.text}${text}`,
		});
	}
	const streamIndex = items.findIndex(
		(item) => item.id === assistantId && item.type === "assistant_stream",
	);
	if (streamIndex >= 0) {
		const item = items[streamIndex]!;
		return items.with(streamIndex, { ...item, text: `${item.text}${text}` });
	}
	const finalIndex = items.findIndex(
		(item) => item.id === assistantId && item.type === "assistant_final",
	);
	if (finalIndex >= 0) {
		const item = items[finalIndex]!;
		return items.with(finalIndex, {
			...item,
			type: "assistant_stream",
			text: `${item.text}${text}`,
		});
	}
	return [...items, { id: assistantId, type: "assistant_stream", text, folded: false, metadata: {} }];
}

export function rollbackActiveAssistantAttempt(state: RuntimeShellState): RuntimeShellState {
	const activeId = state.activeAssistantItemId;
	let start = activeId === null ? -1 : state.transcript.findIndex((item) => item.id === activeId);
	let end = start;
	if (start >= 0) {
		while (start > 0 && state.transcript[start - 1]?.type === "reasoning") start -= 1;
		while (end + 1 < state.transcript.length && state.transcript[end + 1]?.type === "reasoning") end += 1;
	} else {
		end = state.transcript.length - 1;
		start = end;
		while (start >= 0 && state.transcript[start]?.type === "reasoning") start -= 1;
		start += 1;
	}
	const transcript = (start >= 0 && end >= start
		? [...state.transcript.slice(0, start), ...state.transcript.slice(end + 1)]
		: state.transcript).filter((item) => !(
		item.type === "web_search"
		&& booleanValue(recordValue(item.metadata).transient) === true
	));
	return {
		...state,
		activeAssistantItemId: nextId("assistant"),
		liveReasoning: null,
		transcript,
	};
}

export function commitCompletedWebSearchItems(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	let changed = false;
	const committed = items.map((item) => {
		const metadata = recordValue(item.metadata);
		if (item.type !== "web_search"
			|| (stringValue(item.status) ?? stringValue(metadata.status)) !== "completed"
			|| booleanValue(metadata.transient) !== true) return item;
		changed = true;
		return { ...item, metadata: { ...metadata, transient: false } };
	});
	return changed ? committed : items;
}

export function finalizeTransientWebSearchItems(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	let changed = false;
	const finalized: RuntimeTranscriptItem[] = [];
	for (const item of items) {
		const metadata = recordValue(item.metadata);
		if (item.type !== "web_search" || booleanValue(metadata.transient) !== true) {
			finalized.push(item);
			continue;
		}
		changed = true;
		if ((stringValue(item.status) ?? stringValue(metadata.status)) !== "completed") continue;
		finalized.push({ ...item, metadata: { ...metadata, transient: false } });
	}
	return changed ? finalized : items;
}

export function reconcileFinalAnswer(items: RuntimeTranscriptItem[], assistantId: string | null, answer: string): RuntimeTranscriptItem[] {
	const streamIndex =
		assistantId !== null
			? items.findIndex((item) => item.id === assistantId && item.type === "assistant_stream")
			: findLastIndex(items, (item) => item.type === "assistant_stream");
	if (!answer.trim()) {
		return streamIndex >= 0 ? [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)] : items;
	}
	const fallbackId = assistantId ?? nextId("assistant");
	const finalIndex = items.findIndex((item) => item.id === fallbackId && item.type === "assistant_final");
	const finalText = finalAnswerSuffix(items, streamIndex >= 0 ? streamIndex : finalIndex, answer);
	if (!finalText.trim()) {
		if (streamIndex >= 0) {
			return [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)];
		}
		return items;
	}
	const finalItem = {
		id: streamIndex >= 0 ? items[streamIndex]!.id : fallbackId,
		type: "assistant_final",
		text: finalText,
		folded: false,
		metadata: {},
	};
	if (finalIndex >= 0) {
		return [...items.slice(0, finalIndex), finalItem, ...items.slice(finalIndex + 1)];
	}
	return streamIndex >= 0 ? [...items.slice(0, streamIndex), finalItem, ...items.slice(streamIndex + 1)] : [...items, finalItem];
}

export function sealAssistantStream(items: RuntimeTranscriptItem[], assistantId: string): RuntimeTranscriptItem[] {
	const streamIndex = items.findIndex((item) => item.id === assistantId && item.type === "assistant_stream");
	if (streamIndex < 0) {
		return items;
	}
	const item = items[streamIndex]!;
	if (!item.text.trim()) {
		return [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)];
	}
	return [
		...items.slice(0, streamIndex),
		{ ...item, type: "assistant_final", folded: false },
		...items.slice(streamIndex + 1),
	];
}

export function sealActiveAssistantStream(items: RuntimeTranscriptItem[], assistantId: string | null): RuntimeTranscriptItem[] {
	return assistantId === null ? items : sealAssistantStream(items, assistantId);
}

export function applyProposedPlan(items: RuntimeTranscriptItem[], params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const text = String(params.text ?? "").trim();
	if (!text) return items;
	const clientTurnId = stringValue(params.client_turn_id) ?? "turn";
	const id = `plan:${clientTurnId}`;
	const item = {
		id,
		type: "proposed_plan",
		text,
		folded: false,
		metadata: { ...params, status: stringValue(params.status) ?? "proposed" },
	};
	const existingIndex = items.findIndex((candidate) => candidate.id === id || candidate.type === "proposed_plan");
	if (existingIndex >= 0) {
		return [...items.slice(0, existingIndex), item, ...items.slice(existingIndex + 1)];
	}
	return [...items, item];
}

function finalAnswerSuffix(items: RuntimeTranscriptItem[], replaceIndex: number, answer: string): string {
	const turnStart = findLastIndex(items, (item) => item.type === "user");
	const end = replaceIndex >= 0 ? replaceIndex : items.length;
	const visiblePrefix = items
		.slice(turnStart + 1, end)
		.filter((item) => item.type === "assistant_stream" || item.type === "assistant_final")
		.map((item) => item.text)
		.join("");
	if (!visiblePrefix || !answer.startsWith(visiblePrefix)) {
		return answer;
	}
	return answer.slice(visiblePrefix.length);
}

export function applyReasoning(items: RuntimeTranscriptItem[], text: string, metadata: Record<string, unknown>): RuntimeTranscriptItem[] {
	const last = items.at(-1);
	const item = {
		id: last?.type === "reasoning" ? last.id : nextId("reasoning"),
		type: "reasoning",
		text,
		folded: true,
		metadata,
	};
	return last?.type === "reasoning" ? items.with(-1, item) : [...items, item];
}

export function applyCompactionLifecycle(items: RuntimeTranscriptItem[], method: string, params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const id = stringValue(params.checkpoint_id) ?? legacyCompactionId(items, method, params);
	const existing = items.find((item) => recordValue(item.metadata).call_id === id);
	if (method === "compaction.started" && existing) return items;
	const metadata = {
		...params,
		tool_id: id,
		call_id: id,
		tool_name: "Compact",
		name: "Compact",
		status:
			method === "compaction.started"
				? "running"
				: stringValue(params.status) === "interrupted"
					? "interrupted"
					: stringValue(params.status) === "failed"
					? "failed"
					: "done",
		summary: compactionSummary(method, params),
		context: params.source === "user_requested" ? "Manual" : params.source === "pre_turn" ? "Before turn" : "During turn",
	};
	const matchIndex = findToolIndex(items, metadata);
	const item = {
		id: matchIndex >= 0 ? items[matchIndex]!.id : nextId("compaction"),
		type: "tool_summary",
		text: compactionSummary(method, params),
		folded: true,
		metadata: matchIndex >= 0 ? { ...recordValue(items[matchIndex]!.metadata), ...metadata } : metadata,
	};
	return matchIndex >= 0 ? [...items.slice(0, matchIndex), item, ...items.slice(matchIndex + 1)] : [...items, item];
}

function legacyCompactionId(items: RuntimeTranscriptItem[], method: string, params: Record<string, unknown>): string {
	const prefix = [
		"compaction",
		stringValue(params.client_turn_id) ?? "turn",
		stringValue(params.source) ?? "context",
	].join(":");
	if (method === "compaction.completed") {
		const active = items.findLast((item) => {
			const metadata = recordValue(item.metadata);
			return stringValue(metadata.call_id)?.startsWith(`${prefix}:`) && metadata.status === "running";
		});
		if (active) return String(recordValue(active.metadata).call_id);
	}
	return `${prefix}:${nextId("operation")}`;
}

function compactionSummary(method: string, params: Record<string, unknown>): string {
	const before = numberValue(params.before_tokens);
	const after = numberValue(params.after_tokens);
	const duration = numberValue(params.duration_s);
	if (method === "compaction.started") {
		return before === null ? "Compressing context" : `Compressing context ${uiGlyphs().separator} ${formatTokens(before)} tokens`;
	}
	const durationText = duration === null ? "" : ` for ${formatSeconds(duration)}`;
	if (params.status === "interrupted" || recordValue(params.failure).code === "interrupted") {
		return `Context compaction cancelled${durationText}`;
	}
	if (stringValue(params.status) === "failed") {
		const failure = recordValue(params.failure);
		const context = readErrorContext(failure.errorContext);
		const message = context ? errorSummary(context) : sanitizeRuntimeErrorDetail(failure.message);
		const details = sanitizeRuntimeErrorDetail(failure.additionalDetails)
			?? (context ? errorPublicDetails(context) : undefined);
		return [`Context compression failed${durationText}${message ? `: ${message}` : ""}`, details]
			.filter(Boolean).join("\n");
	}
	if (stringValue(params.status) === "skipped") {
		return `Context compression skipped${durationText}`;
	}
	if (before !== null && after !== null) {
		return `Context compressed${durationText} ${uiGlyphs().separator} ${formatTokens(before)} -> ${formatTokens(after)} tokens`;
	}
	return `Context compressed${durationText}`;
}

function formatTokens(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatSeconds(value: number): string {
	const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
	return `${rounded} s`;
}

export function reasoningText(params: Record<string, unknown>): string {
	const format = stringValue(params.format) ?? stringValue(params.encoding);
	if (format && ["encrypted", "opaque", "binary"].includes(format.toLowerCase())) {
		const bytes = typeof params.bytes === "number" ? ` ${uiGlyphs().separator} ${params.bytes} bytes` : "";
		return `reasoning ${uiGlyphs().separator} ${format.toLowerCase()}${bytes}`;
	}
	return String(params.text ?? `reasoning ${uiGlyphs().separator} opaque`);
}
