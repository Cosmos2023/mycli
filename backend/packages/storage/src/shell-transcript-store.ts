export const SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS = 8_000;

const MAX_IDENTITY_CHARS = 256;
const MAX_COMMAND_PREVIEW_CHARS = 512;
const MAX_STATE_CHARS = 128;

export interface UpsertShellSnapshotInput {
	readonly sessionId: string;
	readonly callId: string;
	readonly shellId: string;
	readonly payload: Readonly<Record<string, unknown>>;
}

export interface ShellTranscriptStore {
	upsertShellSnapshot(input: UpsertShellSnapshotInput): void;
}

export function shellHistoryItem(
	input: UpsertShellSnapshotInput,
	threadId: string,
): Readonly<Record<string, unknown>> {
	const sessionId = boundedIdentity(input.sessionId, "sessionId");
	const callId = boundedIdentity(input.callId, "callId");
	const shellId = boundedIdentity(input.shellId, "shellId");
	return Object.freeze({
		id: `shell:${callId}:${shellId}`,
		thread_id: boundedIdentity(threadId, "threadId"),
		turn_id: callId,
		type: "shell_session",
		text: "",
		tool_name: "Shell",
		call_id: callId,
		metadata: sanitizeShellSnapshotPayload(input.payload, shellId),
		session_id: sessionId,
	});
}

export function sanitizeShellSnapshotPayload(
	payload: Readonly<Record<string, unknown>>,
	shellId: string,
): Readonly<Record<string, unknown>> {
	const visible: Record<string, unknown> = {
		shell_id: boundedIdentity(shellId, "shellId"),
	};
	copyString(payload, visible, "command_preview", MAX_COMMAND_PREVIEW_CHARS, true);
	copyString(payload, visible, "process_state", MAX_STATE_CHARS);
	copyString(payload, visible, "terminal_state", MAX_STATE_CHARS);
	copyString(payload, visible, "transport", MAX_STATE_CHARS);
	copyString(payload, visible, "cleanup_result", MAX_STATE_CHARS);
	copyString(payload, visible, "started_at", 64);
	copyString(payload, visible, "completed_at", 64);
	copyString(payload, visible, "shell_kind", 64);
	copyString(payload, visible, "shell_edition", 64);
	for (const key of ["background", "tty", "yielded"] as const) {
		if (typeof payload[key] === "boolean") visible[key] = payload[key];
	}
	for (const key of ["exit_code", "next_cursor", "output_chars"] as const) {
		const value = safeInteger(payload[key]);
		if (value !== undefined) visible[key] = value;
	}
	const rawOutput = typeof payload.output === "string" ? payload.output : "";
	const localOmitted = Math.max(0, rawOutput.length - SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS);
	const output = localOmitted > 0 ? rawOutput.slice(-SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS) : rawOutput;
	if (output) visible.output = output;
	const upstreamOmitted = nonNegativeInteger(payload.omitted_output_chars) ?? 0;
	if (upstreamOmitted + localOmitted > 0) {
		visible.omitted_output_chars = upstreamOmitted + localOmitted;
	}
	return Object.freeze(visible);
}

function copyString(
	source: Readonly<Record<string, unknown>>,
	target: Record<string, unknown>,
	key: string,
	maxChars: number,
	redactSensitive = false,
): void {
	const value = source[key];
	if (typeof value !== "string" || !value) return;
	const bounded = value.slice(0, maxChars);
	target[key] = redactSensitive && containsSensitiveValue(bounded)
		? "[redacted command]"
		: bounded;
}

function containsSensitiveValue(value: string): boolean {
	return /(?:api[_-]?key|authorization|bearer|password|secret|token)\s*(?:=|:|\s)\s*\S+/iu.test(value)
		|| /\bsk-[A-Za-z0-9_-]{12,}\b/u.test(value);
}

function boundedIdentity(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > MAX_IDENTITY_CHARS) {
		throw new RangeError(`${name} must contain between 1 and ${MAX_IDENTITY_CHARS} characters`);
	}
	return normalized;
}

function safeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}
