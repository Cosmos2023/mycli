export const TRANSCRIPT_TEXT_MAX_CHARS = 8_000;

const OMITTED_MARKER = "\n... output omitted ...\n";
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 500;
const HIDDEN_HISTORY_TYPES = new Set([
	"capability",
	"command_result",
	"context_baseline_update",
	"contributed_tool",
	"skill_instructions",
	"tool_exposure",
	"turn_rollback",
]);
const SNAPSHOT_TYPES = new Map<string, TranscriptItemType>([
	["user_message", "user_message"],
	["assistant_message", "assistant_message"],
	["reasoning", "reasoning_summary"],
	["approval_request", "warning"],
	["approval_resolution", "status"],
	["clarification_response", "user_message"],
	["warning", "warning"],
	["compaction", "status"],
	["file_change", "file_change"],
	["plan_update", "plan_update"],
]);

export type TranscriptItemType =
	| "user_message"
	| "assistant_message"
	| "reasoning_summary"
	| "tool"
	| "warning"
	| "status"
	| "file_change"
	| "plan_update";

export interface TranscriptItem {
	readonly id: string;
	readonly type: TranscriptItemType;
	readonly text?: string;
	readonly created_at?: string;
	readonly tool_name?: string;
	readonly call_id?: string;
	readonly command?: string;
	readonly status?: string;
	readonly output?: string;
	readonly exit_code?: number;
	readonly duration_ms?: number;
	readonly truncated?: true;
	readonly omitted_chars?: number;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TranscriptProjectionOptions {
	readonly before?: number;
	readonly limit?: number;
}

export function projectTranscript(
	historyItems: readonly Readonly<Record<string, unknown>>[],
	turnRollouts: readonly Readonly<Record<string, unknown>>[],
	options: TranscriptProjectionOptions = {},
): readonly TranscriptItem[] {
	const approvalTurns = approvalResumeTurnIds(turnRollouts);
	const projected: TranscriptItem[] = [];
	const toolsByCallId = new Map<string, number>();

	for (const [index, rawItem] of historyItems.entries()) {
		const item = historyItem(rawItem, index);
		if (!item || suppressItem(item, approvalTurns)) continue;
		if (item.type === "tool_call") {
			const tool = toolCallItem(item);
			projected.push(tool);
			if (item.callId) toolsByCallId.set(item.callId, projected.length - 1);
			continue;
		}
		if (item.type === "tool_result") {
			const result = toolResultItem(item);
			const existingIndex = item.callId ? toolsByCallId.get(item.callId) : undefined;
			if (existingIndex === undefined) {
				projected.push(result);
				if (item.callId) toolsByCallId.set(item.callId, projected.length - 1);
			} else {
				projected[existingIndex] = mergeToolItems(projected[existingIndex]!, result);
			}
			continue;
		}
		if (item.type === "shell_session") {
			const shell = shellSessionItem(item);
			const existingIndex = item.callId ? toolsByCallId.get(item.callId) : undefined;
			if (existingIndex === undefined) {
				projected.push(shell);
				if (item.callId) toolsByCallId.set(item.callId, projected.length - 1);
			} else {
				projected[existingIndex] = mergeShellItem(projected[existingIndex]!, shell);
			}
			continue;
		}
		const visible = visibleItem(item);
		if (visible) projected.push(visible);
	}

	const before = boundedBefore(options.before, projected.length);
	const limit = boundedLimit(options.limit);
	return Object.freeze(projected.slice(Math.max(0, before - limit), before));
}

export function sanitizeTranscriptItem(value: unknown): TranscriptItem | undefined {
	const raw = recordValue(value);
	const id = boundedIdentity(raw.id, 512);
	if (!id || !isTranscriptItemType(raw.type)) return undefined;
	const text = boundedOptionalText(raw.text);
	const output = boundedOptionalText(raw.output);
	const command = boundedOptionalText(raw.command);
	const createdAt = boundedIdentity(raw.created_at, 100);
	const toolName = boundedIdentity(raw.tool_name, 256);
	const callId = boundedIdentity(raw.call_id, 512);
	const status = boundedIdentity(raw.status, 100);
	const exitCode = safeInteger(raw.exit_code);
	const durationMs = safeInteger(raw.duration_ms);
	const metadata = visibleMetadata(recordValue(raw.metadata));
	const omitted = Math.max(
		text?.omitted ?? 0,
		output?.omitted ?? 0,
		command?.omitted ?? 0,
		safeInteger(raw.omitted_chars) ?? 0,
	);
	return freezeItem({
		id,
		type: raw.type,
		...(text?.value ? { text: text.value } : {}),
		...(createdAt ? { created_at: createdAt } : {}),
		...(toolName ? { tool_name: toolName } : {}),
		...(callId ? { call_id: callId } : {}),
		...(command?.value ? { command: command.value } : {}),
		...(status ? { status } : {}),
		...(output?.value ? { output: output.value } : {}),
		...(exitCode === undefined ? {} : { exit_code: exitCode }),
		...(durationMs === undefined ? {} : { duration_ms: durationMs }),
		...(raw.truncated === true || omitted > 0
			? { truncated: true, ...(omitted > 0 ? { omitted_chars: omitted } : {}) }
			: {}),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	});
}

interface ParsedHistoryItem {
	readonly id: string;
	readonly turnId: string;
	readonly type: string;
	readonly text: string;
	readonly toolName?: string;
	readonly callId?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

function approvalResumeTurnIds(
	rollouts: readonly Readonly<Record<string, unknown>>[],
): ReadonlySet<string> {
	const turnIds = new Set<string>();
	for (const rollout of rollouts) {
		const turnId = stringValue(rollout.turn_id);
		if (!turnId || !Array.isArray(rollout.events)) continue;
		for (const rawEvent of rollout.events) {
			const event = recordValue(rawEvent);
			const payload = recordValue(event.payload);
			if (event.kind === "turn_item" && payload.type === "approval_resolution") {
				turnIds.add(turnId);
				break;
			}
		}
	}
	return turnIds;
}

function historyItem(
	raw: Readonly<Record<string, unknown>>,
	index: number,
): ParsedHistoryItem | undefined {
	const type = stringValue(raw.type);
	if (!type) return undefined;
	const turnId = stringValue(raw.turn_id) ?? "unknown-turn";
	const metadata = recordValue(raw.metadata);
	return {
		id: stringValue(raw.id) ?? `${turnId}:${type}:${index + 1}`,
		turnId,
		type,
		text: stringValue(raw.text) ?? "",
		...(stringValue(raw.tool_name) ? { toolName: stringValue(raw.tool_name) } : {}),
		...(stringValue(raw.call_id) ? { callId: stringValue(raw.call_id) } : {}),
		metadata,
	};
}

function suppressItem(item: ParsedHistoryItem, approvalTurns: ReadonlySet<string>): boolean {
	if (item.metadata.event_kind === "turn_aborted_marker") return true;
	return item.type === "user_message"
		&& approvalTurns.has(item.turnId)
		&& item.metadata.queued !== true
		&& item.metadata.model_role !== "developer";
}

function visibleItem(item: ParsedHistoryItem): TranscriptItem | undefined {
	if (HIDDEN_HISTORY_TYPES.has(item.type)) return undefined;
	const snapshotType = SNAPSHOT_TYPES.get(item.type) ?? (item.text ? "status" : undefined);
	if (!snapshotType) return undefined;
	const bounded = boundedHeadTail(item.text);
	const metadata = visibleMetadata(item.metadata);
	return freezeItem({
		id: item.id,
		type: snapshotType,
		...(bounded.value ? { text: bounded.value } : {}),
		...(stringValue(item.metadata.created_at)
			? { created_at: stringValue(item.metadata.created_at) }
			: {}),
		...(bounded.omitted > 0 ? { truncated: true, omitted_chars: bounded.omitted } : {}),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	});
}

function toolCallItem(item: ParsedHistoryItem): TranscriptItem {
	const metadata = visibleMetadata(item.metadata);
	const command = toolCommand(item.metadata);
	return freezeItem({
		id: item.id,
		type: "tool",
		...(item.text ? { text: boundedHeadTail(item.text).value } : {}),
		...(item.toolName ? { tool_name: item.toolName } : {}),
		...(item.callId ? { call_id: item.callId } : {}),
		...(command ? { command } : {}),
		status: stringValue(item.metadata.status) ?? "running",
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	});
}

function toolResultItem(item: ParsedHistoryItem): TranscriptItem {
	const rawOutput = stringValue(item.metadata.transcript_content)
		?? stringValue(item.metadata.output_preview)
		?? item.text;
	const bounded = boundedHeadTail(rawOutput);
	const metadata = visibleMetadata(item.metadata);
	const command = toolCommand(item.metadata);
	return freezeItem({
		id: item.id,
		type: "tool",
		...(item.toolName ? { tool_name: item.toolName } : {}),
		...(item.callId ? { call_id: item.callId } : {}),
		...(command ? { command } : {}),
		status: "completed",
		...(bounded.value ? { output: bounded.value } : {}),
		...(safeInteger(item.metadata.exit_code) !== undefined
			? { exit_code: safeInteger(item.metadata.exit_code) }
			: {}),
		...(safeInteger(item.metadata.duration_ms) !== undefined
			? { duration_ms: safeInteger(item.metadata.duration_ms) }
			: {}),
		...(bounded.omitted > 0 ? { truncated: true, omitted_chars: bounded.omitted } : {}),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	});
}

function shellSessionItem(item: ParsedHistoryItem): TranscriptItem {
	const terminalState = stringValue(item.metadata.terminal_state);
	const rawOutput = stringValue(item.metadata.output) ?? "";
	const bounded = boundedHeadTail(rawOutput);
	const historicalState = terminalState ? stringValue(item.metadata.process_state) : "stale";
	const metadata = visibleMetadata({
		...item.metadata,
		process_state: historicalState,
	});
	const omitted = bounded.omitted + (safeInteger(item.metadata.omitted_output_chars) ?? 0);
	return freezeItem({
		id: item.id,
		type: "tool",
		tool_name: item.toolName ?? "Shell",
		...(item.callId ? { call_id: item.callId } : {}),
		...(stringValue(item.metadata.command_preview)
			? { command: stringValue(item.metadata.command_preview) }
			: {}),
		status: terminalState ? "completed" : "stale",
		...(bounded.value ? { output: bounded.value } : {}),
		...(safeInteger(item.metadata.exit_code) === undefined
			? {}
			: { exit_code: safeInteger(item.metadata.exit_code) }),
		...(omitted > 0 ? { truncated: true, omitted_chars: omitted } : {}),
		metadata,
	});
}

function mergeToolItems(start: TranscriptItem, finish: TranscriptItem): TranscriptItem {
	const shellSnapshot = typeof start.metadata?.shell_id === "string";
	return freezeItem({
		...start,
		tool_name: start.tool_name ?? finish.tool_name,
		call_id: start.call_id ?? finish.call_id,
		command: start.command ?? finish.command,
		status: shellSnapshot ? start.status ?? "stale" : "completed",
		...((shellSnapshot ? start.output ?? finish.output : finish.output) === undefined
			? {}
			: { output: shellSnapshot ? start.output ?? finish.output : finish.output }),
		...(finish.exit_code === undefined ? {} : { exit_code: finish.exit_code }),
		...(finish.duration_ms === undefined ? {} : { duration_ms: finish.duration_ms }),
		...(finish.truncated ? {
			truncated: true,
			omitted_chars: finish.omitted_chars,
		} : {}),
		metadata: Object.freeze({ ...(start.metadata ?? {}), ...(finish.metadata ?? {}) }),
	});
}

function mergeShellItem(start: TranscriptItem, shell: TranscriptItem): TranscriptItem {
	return freezeItem({
		...start,
		tool_name: start.tool_name ?? shell.tool_name,
		call_id: start.call_id ?? shell.call_id,
		command: shell.command ?? start.command,
		status: shell.status,
		...(shell.output === undefined ? {} : { output: shell.output }),
		...(shell.exit_code === undefined ? {} : { exit_code: shell.exit_code }),
		...(shell.truncated ? {
			truncated: true,
			omitted_chars: shell.omitted_chars,
		} : {}),
		metadata: Object.freeze({ ...(start.metadata ?? {}), ...(shell.metadata ?? {}) }),
	});
}

function visibleMetadata(metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const visible: Record<string, unknown> = {};
	const path = boundedOptionalText(metadata.path)?.value;
	if (path) visible.path = path;
	const status = boundedIdentity(metadata.status, 100);
	if (status) visible.status = status;
	if (typeof metadata.success === "boolean") visible.success = metadata.success;
	if (typeof metadata.changes === "number" && Number.isSafeInteger(metadata.changes)) {
		visible.changes = metadata.changes;
	}
	if (Array.isArray(metadata.file_changes)) {
		const changes = metadata.file_changes
			.slice(0, 100)
			.map(projectFileChange)
			.filter((value): value is Readonly<Record<string, unknown>> => value !== undefined);
		if (changes.length > 0) visible.file_changes = Object.freeze(changes);
	}
	for (const key of [
		"shell_id",
		"process_state",
		"terminal_state",
		"transport",
		"cleanup_result",
		"shell_kind",
		"shell_edition",
	] as const) {
		const value = boundedIdentity(metadata[key], 256);
		if (value) visible[key] = value;
	}
	for (const key of ["background", "tty", "yielded"] as const) {
		if (typeof metadata[key] === "boolean") visible[key] = metadata[key];
	}
	return Object.freeze(visible);
}

function projectFileChange(value: unknown): Readonly<Record<string, unknown>> | undefined {
	const change = recordValue(value);
	const path = boundedIdentity(change.path, 1_024);
	if (!path) return undefined;
	const projected: Record<string, unknown> = { path };
	for (const key of ["kind", "status"] as const) {
		const item = boundedIdentity(change[key], 100);
		if (item) projected[key] = item;
	}
	const diff = stringValue(change.diff);
	if (diff) {
		const bounded = boundedHeadTail(diff);
		projected.diff = bounded.value;
		if (bounded.omitted > 0) {
			projected.truncated = true;
			projected.omitted_chars = bounded.omitted;
		}
	}
	for (const key of ["added_lines", "removed_lines"] as const) {
		const item = safeInteger(change[key]);
		if (item !== undefined) projected[key] = item;
	}
	return Object.freeze(projected);
}

function toolCommand(metadata: Readonly<Record<string, unknown>>): string | undefined {
	const direct = stringValue(metadata.command);
	if (direct) return boundedHeadTail(direct).value;
	const argumentsValue = recordValue(metadata.arguments);
	const command = stringValue(argumentsValue.command);
	if (command) return boundedHeadTail(command).value;
	const path = stringValue(argumentsValue.path) ?? stringValue(argumentsValue.file_path);
	return path ? boundedHeadTail(path).value : undefined;
}

function boundedHeadTail(value: string): { readonly value: string; readonly omitted: number } {
	if (value.length <= TRANSCRIPT_TEXT_MAX_CHARS) return { value, omitted: 0 };
	const retained = TRANSCRIPT_TEXT_MAX_CHARS - OMITTED_MARKER.length;
	const headChars = Math.floor(retained / 2);
	const tailChars = retained - headChars;
	return {
		value: `${value.slice(0, headChars)}${OMITTED_MARKER}${value.slice(-tailChars)}`,
		omitted: value.length - retained,
	};
}

function boundedOptionalText(
	value: unknown,
): { readonly value: string; readonly omitted: number } | undefined {
	return typeof value === "string" ? boundedHeadTail(value) : undefined;
}

function boundedIdentity(value: unknown, maxChars: number): string | undefined {
	return typeof value === "string" && value && value.length <= maxChars ? value : undefined;
}

function boundedBefore(value: number | undefined, length: number): number {
	return value === undefined || !Number.isSafeInteger(value)
		? length
		: Math.min(length, Math.max(0, value));
}

function boundedLimit(value: number | undefined): number {
	if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return DEFAULT_PAGE_LIMIT;
	return Math.min(value, MAX_PAGE_LIMIT);
}

function freezeItem(item: TranscriptItem): TranscriptItem {
	return Object.freeze(item);
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isTranscriptItemType(value: unknown): value is TranscriptItemType {
	if (typeof value !== "string") return false;
	switch (value) {
		case "user_message":
		case "assistant_message":
		case "reasoning_summary":
		case "tool":
		case "warning":
		case "status":
		case "file_change":
		case "plan_update":
			return true;
		default:
			return false;
	}
}

function safeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
