import {
	GATEWAY_TOOL_PREVIEW_MAX_CHARS,
	projectGatewayToolRecord,
	type GatewayToolRecord,
} from "@mycli/contracts";
import { booleanValue, nextId, numberValue, recordValue, stringValue, textValue } from "./payload-values.ts";
import type {
	RuntimeLiveStatus,
	RuntimeShellProcess,
	RuntimeShellState,
	RuntimeTranscriptItem,
} from "./runtime-state-model.ts";
import { findToolIndex, toolRecordFromTranscriptItem } from "./transcript-records.ts";

const SHELL_OUTPUT_PREVIEW_BUDGET = GATEWAY_TOOL_PREVIEW_MAX_CHARS;

export function applyShellBootstrap(state: RuntimeShellState, value: unknown): RuntimeShellState {
	if (!Array.isArray(value)) return state;
	let nextState = state;
	for (const rawRow of value) {
		const row = recordValue(rawRow);
		const shellId = stringValue(row.shell_id);
		if (!shellId || nextState.shellEventSequences[shellId] !== undefined) continue;
		nextState = applyShellLifecycle(nextState, "shell.started", {
			...row,
			shell_id: shellId,
			sequence: 0,
			background: true,
			process_state: stringValue(row.process_state) ?? "running_background",
			output_delta: textValue(row.output) ?? "",
		});
	}
	return {
		...nextState,
		backgroundShellCount: Object.keys(nextState.backgroundShells).length,
	};
}

export function applyShellLifecycle(
	state: RuntimeShellState,
	method: string,
	params: Record<string, unknown>,
): RuntimeShellState {
	const shellId = stringValue(params.shell_id);
	const sequence = numberValue(params.sequence);
	if (!shellId || sequence === null || !Number.isInteger(sequence)) return state;
	const callId = stringValue(params.call_id) ?? undefined;
	const transcriptIndex = findShellTranscriptIndex(state.transcript, shellId, callId);
	const existingItem = transcriptIndex >= 0 ? state.transcript[transcriptIndex] : undefined;
	const existingRecord = existingItem ? toolRecordFromTranscriptItem(existingItem) : undefined;
	const existingShell = existingRecord?.shell;
	const previousSequence = Math.max(state.shellEventSequences[shellId] ?? -1, existingShell?.sequence ?? -1);
	if (sequence <= previousSequence) return state;

	const shellEventSequences = { ...state.shellEventSequences, [shellId]: sequence };
	let lifecycleState = { ...state, shellEventSequences };
	let activeBackgroundCount: number | null = null;
	if (method === "shell.list.updated") {
		activeBackgroundCount = numberValue(params.active_background_count);
		lifecycleState = {
			...lifecycleState,
			backgroundShellCount:
				activeBackgroundCount !== null && Number.isInteger(activeBackgroundCount) && activeBackgroundCount >= 0
					? activeBackgroundCount
					: state.backgroundShellCount,
		};
		const updatesProcess = ["background", "process_state", "transport", "tty", "yielded"]
			.some((key) => Object.prototype.hasOwnProperty.call(params, key));
		if (!updatesProcess) return lifecycleState;
	}
	if (method === "shell.removed") {
		const backgroundShells = { ...lifecycleState.backgroundShells };
		delete backgroundShells[shellId];
		return { ...lifecycleState, backgroundShells };
	}

	const existingMetadata = recordValue(existingItem?.metadata);
	const existingTerminalState = existingShell?.terminal_state;
	const incomingTerminalState = stringValue(params.terminal_state) ?? undefined;
	if (existingTerminalState && !incomingTerminalState) {
		return lifecycleState;
	}

	const existingProcess = lifecycleState.backgroundShells[shellId];
	const commandPreview =
		stringValue(params.command_preview) ??
		existingProcess?.commandPreview ??
		existingShell?.command_preview ??
		existingRecord?.target ??
		"command";
	const description =
		stringValue(params.description)?.trim() ??
		existingProcess?.description ??
		existingShell?.description ??
		undefined;
	const background = booleanValue(params.background) ?? existingProcess?.background ?? existingShell?.background ?? false;
	const processState =
		stringValue(params.process_state) ??
		existingProcess?.processState ??
		(incomingTerminalState ? incomingTerminalState : background ? "running_background" : "running_foreground");
	const shellKind = stringValue(params.shell_kind) ?? existingProcess?.shellKind ?? existingShell?.shell_kind;
	const shellEdition = stringValue(params.shell_edition) ?? existingProcess?.shellEdition ?? existingShell?.shell_edition;
	const transport = stringValue(params.transport) ?? existingProcess?.transport ?? existingShell?.transport;
	const tty = booleanValue(params.tty) ?? existingProcess?.tty ?? existingShell?.tty;
	const yielded = booleanValue(params.yielded) ?? existingProcess?.yielded ?? existingShell?.yielded;
	const existingOutput =
		existingProcess?.outputPreview ??
		(existingRecord ? shellRecordOutput(existingRecord) : "");
	const previousCursor = existingProcess?.nextCursor ?? numberValue(existingMetadata.next_cursor) ?? 0;
	const nextCursor = numberValue(params.next_cursor);
	const delta = textValue(params.output_delta) ?? "";
	const deltaStart = nextCursor === null ? previousCursor : nextCursor - delta.length;
	const overlap = Math.max(0, Math.min(delta.length, previousCursor - deltaStart));
	const previousOmitted = existingProcess?.omittedOutputChars ?? existingShell?.omitted_output_chars ?? 0;
	const omittedOutputChars = Math.max(
		numberValue(params.omitted_output_chars) ?? 0,
		previousOmitted + (delta ? Math.max(0, deltaStart - previousCursor) : 0),
	);
	const outputPreview = delta.length > overlap
		? boundedShellOutput(existingOutput, delta.slice(overlap), omittedOutputChars)
		: existingOutput;
	const process: RuntimeShellProcess = {
		shellId,
		callId: callId ?? existingProcess?.callId ?? existingRecord?.call_id,
		commandPreview,
		...(description ? { description } : {}),
		background,
		processState,
		...(transport ? { transport } : {}),
		...(tty !== undefined ? { tty } : {}),
		...(yielded !== undefined ? { yielded } : {}),
		...(incomingTerminalState ? { terminalState: incomingTerminalState } : {}),
		...(numberValue(params.exit_code) !== null ? { exitCode: numberValue(params.exit_code)! } : {}),
		sequence,
		startedAt: stringValue(params.started_at) ?? existingProcess?.startedAt ?? existingShell?.started_at,
		...(stringValue(params.completed_at) ? { completedAt: stringValue(params.completed_at)! } : {}),
		outputPreview,
		nextCursor: Math.max(previousCursor, nextCursor ?? 0),
		outputChars: numberValue(params.output_chars) ?? existingProcess?.outputChars ?? existingShell?.output_chars ?? outputPreview.length,
		omittedOutputChars,
		...(stringValue(params.cleanup_result) ? { cleanupResult: stringValue(params.cleanup_result)! } : {}),
		...(shellKind ? { shellKind } : {}),
		...(shellEdition ? { shellEdition } : {}),
	};

	const backgroundShells = { ...lifecycleState.backgroundShells };
	if (background && !incomingTerminalState) {
		backgroundShells[shellId] = process;
	} else {
		delete backgroundShells[shellId];
	}
	const successful = incomingTerminalState === "completed" && (process.exitCode === undefined || process.exitCode === 0);
	const metadata: Record<string, unknown> = {
		...existingMetadata,
		...params,
		tool_name: existingRecord?.name ?? (shellKind ? "Shell" : "Bash"),
		call_id: process.callId,
		shell_id: shellId,
		command_preview: commandPreview,
		command: commandPreview,
		description,
		background,
		process_state: processState,
		transport: process.transport,
		tty: process.tty,
		yielded: process.yielded,
		terminal_state: incomingTerminalState,
		exit_code: process.exitCode,
		shell_sequence: sequence,
		started_at: process.startedAt,
		completed_at: process.completedAt,
		output_chars: process.outputChars,
		omitted_output_chars: process.omittedOutputChars,
		cleanup_result: process.cleanupResult,
		shell_kind: process.shellKind,
		shell_edition: process.shellEdition,
		output_preview: outputPreview,
		summary: outputPreview || undefined,
		status: incomingTerminalState ? (successful ? "done" : "failed") : "running",
		success: incomingTerminalState ? successful : undefined,
	};
	metadata.display = shellDisplayEnvelope({
		metadata: existingItem?.tool_record ? {} : metadata,
		shellId,
		commandPreview,
		outputPreview,
		terminalState: incomingTerminalState,
		exitCode: process.exitCode,
	});
	const item: RuntimeTranscriptItem = {
		id: existingItem?.id ?? nextId("shell"),
		type: "tool_summary",
		text: `${stringValue(metadata.tool_name) ?? "Shell"} ${commandPreview}`,
		folded: existingItem?.folded ?? true,
		metadata,
		tool_record: {
			...existingRecord,
			...projectGatewayToolRecord({ text: `${stringValue(metadata.tool_name) ?? "Shell"} ${commandPreview}`, metadata }),
			mutating: existingRecord?.mutating ?? false,
			duration_ms: existingRecord?.duration_ms,
		},
	};
	const transcript =
		transcriptIndex >= 0
			? [...lifecycleState.transcript.slice(0, transcriptIndex), item, ...lifecycleState.transcript.slice(transcriptIndex + 1)]
			: [...lifecycleState.transcript, item];
	return {
		...lifecycleState,
		transcript,
		backgroundShells,
		backgroundShellCount:
			activeBackgroundCount !== null && Number.isInteger(activeBackgroundCount) && activeBackgroundCount >= 0
				? activeBackgroundCount
				: Object.keys(backgroundShells).length,
		shellEventSequences,
	};
}

export function findShellTranscriptIndex(
	items: RuntimeTranscriptItem[],
	shellId: string,
	callId: string | undefined,
): number {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.type !== "tool_summary" && item?.type !== "tool_detail") continue;
		if (item.tool_record) {
			if (callId && item.tool_record.call_id === callId) return index;
			if (item.tool_record.shell?.shell_id === shellId) return index;
			continue;
		}
		const metadata = recordValue(item.metadata);
		const rawPayload = recordValue(metadata.raw_payload);
		if (callId && stringValue(metadata.call_id) === callId) return index;
		if (stringValue(metadata.shell_id) === shellId || stringValue(rawPayload.shell_id) === shellId) return index;
	}
	return -1;
}

function boundedShellOutput(existing: string, delta: string, omittedChars: number): string {
	const combined = `${existing}${delta}`;
	if (combined.length <= SHELL_OUTPUT_PREVIEW_BUDGET && omittedChars <= 0) return combined;
	const initiallyOmitted = Math.max(0, omittedChars);
	const marker = (count: number) => `\n... ${count} chars omitted ...\n`;
	let totalOmitted = initiallyOmitted;
	let markerText = marker(totalOmitted);
	let available = Math.max(0, SHELL_OUTPUT_PREVIEW_BUDGET - markerText.length);
	if (combined.length > available) totalOmitted += combined.length - available;
	markerText = marker(totalOmitted);
	available = Math.max(0, SHELL_OUTPUT_PREVIEW_BUDGET - markerText.length);
	if (combined.length <= available) return `${markerText}${combined}`;
	const headLength = Math.floor(available / 2);
	const tailLength = available - headLength;
	return `${combined.slice(0, headLength)}${markerText}${combined.slice(-tailLength)}`;
}

export function isShellOutputLifecycle(params: Record<string, unknown>): boolean {
	const name = stringValue(params.name) ?? stringValue(params.tool_name) ?? "";
	const normalized = name.trim().toLowerCase().replace(/[_-]/g, "");
	return normalized === "shelloutput" || normalized === "bashoutput" || normalized === "writestdin";
}

export function isEmptyWriteStdinPoll(params: Record<string, unknown>): boolean {
	const name = stringValue(params.name) ?? stringValue(params.tool_name) ?? "";
	return name.trim().toLowerCase().replace(/[_-]/g, "") === "writestdin" && params.empty_poll === true;
}

export function activeTerminalWait(items: RuntimeTranscriptItem[]): RuntimeLiveStatus | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index]!;
		if (item.type === "user" || item.type === "turn_completed") break;
		if (item.type !== "tool_summary" && item.type !== "tool_detail") continue;
		const record = toolRecordFromTranscriptItem(item);
		if (record.status !== "running" || record.terminal_interaction?.kind !== "poll") continue;
		return {
			state: "running", kind: "waiting_background_terminal", text: "Waiting for background terminal",
			...(record.call_id ? { callId: record.call_id } : {}),
			...(record.terminal_interaction.command_preview ? { message: record.terminal_interaction.command_preview } : {}),
		};
	}
	return undefined;
}

export function removeToolLifecycleItem(items: RuntimeTranscriptItem[], params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const index = findToolIndex(items, params);
	return index < 0 ? items : [...items.slice(0, index), ...items.slice(index + 1)];
}

export function mergeShellOutputIntoExecution(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
): RuntimeTranscriptItem[] | null {
	const rawPayload = recordValue(params.raw_payload);
	const incomingDisplay = recordValue(params.display);
	const incomingMetrics = recordValue(incomingDisplay.metrics);
	const shellId =
		stringValue(rawPayload.shell_id) ??
		stringValue(rawPayload.session_id) ??
		stringValue(rawPayload.bash_id) ??
		stringValue(params.shell_id) ??
		stringValue(params.session_id) ??
		stringValue(params.bash_id) ??
		stringValue(incomingMetrics.shell_id) ??
		stringValue(incomingMetrics.session_id);
	if (!shellId) return null;

	const index = findShellTranscriptIndex(items, shellId, undefined);
	if (index < 0) return null;
	const existing = items[index]!;
	const metadata = recordValue(existing.metadata);
	const existingRecord = toolRecordFromTranscriptItem(existing);
	const existingShell = existingRecord.shell;
	const existingDisplay = existing.tool_record ? {} : recordValue(metadata.display);
	const existingOutput = shellRecordOutput(existingRecord);
	const incomingOutput =
		textValue(incomingDisplay.detail) ??
		textValue(rawPayload.output) ??
		textValue(rawPayload.stdout) ??
		"";
	const outputPreview = boundedShellOutput(mergeShellOutputText(existingOutput, incomingOutput), "", 0);
	const terminalState =
		stringValue(rawPayload.terminal_state) ??
		stringValue(params.terminal_state) ??
		undefined;
	const exitCode = numberValue(rawPayload.exit_code) ?? numberValue(params.exit_code) ?? undefined;
	const effectiveTerminalState = existingShell?.terminal_state ?? terminalState;
	const effectiveExitCode = existingShell?.terminal_state ? existingShell.exit_code : exitCode ?? existingShell?.exit_code;
	const commandPreview =
		existingShell?.command_preview ??
		existingRecord.target ??
		"command";
	const nextMetadata: Record<string, unknown> = {
		...metadata,
		tool_name: existingRecord.name,
		call_id: existingRecord.call_id,
		shell_id: shellId,
		command_preview: commandPreview,
		command: commandPreview,
		transport:
			stringValue(rawPayload.transport) ??
			stringValue(params.transport) ??
			stringValue(incomingMetrics.transport) ??
			existingShell?.transport,
		tty:
			booleanValue(rawPayload.tty) ??
			booleanValue(params.tty) ??
			booleanValue(incomingMetrics.tty) ??
			existingShell?.tty,
		background:
			booleanValue(rawPayload.background) ??
			booleanValue(params.background) ??
			existingShell?.background,
		process_state:
			stringValue(rawPayload.process_state) ??
			stringValue(params.process_state) ??
			existingShell?.process_state,
		yielded:
			booleanValue(rawPayload.yielded) ??
			booleanValue(params.yielded) ??
			booleanValue(incomingMetrics.yielded) ??
			existingShell?.yielded,
		terminal_state: effectiveTerminalState,
		exit_code: effectiveExitCode,
		output_chars:
			numberValue(rawPayload.output_chars) ??
			numberValue(params.output_chars) ??
			existingShell?.output_chars ??
			undefined,
		omitted_output_chars:
			numberValue(rawPayload.omitted_output_chars) ??
			numberValue(params.omitted_output_chars) ??
			existingShell?.omitted_output_chars ??
			0,
		output_preview: outputPreview || undefined,
		status: effectiveTerminalState
			? (effectiveTerminalState === "completed" && (effectiveExitCode === undefined || effectiveExitCode === 0)
				? "done"
				: "failed")
			: "running",
		success: effectiveTerminalState
			? effectiveTerminalState === "completed" && (effectiveExitCode === undefined || effectiveExitCode === 0)
			: undefined,
	};
	nextMetadata.display = shellDisplayEnvelope({
		metadata: { ...nextMetadata, display: { ...existingDisplay, ...incomingDisplay, target: existingDisplay.target } },
		shellId,
		commandPreview,
		outputPreview,
		terminalState: effectiveTerminalState,
		exitCode: effectiveExitCode,
	});
	const projected = projectGatewayToolRecord({ text: existing.text, metadata: nextMetadata });
	const merged: RuntimeTranscriptItem = {
		...existing,
		metadata: nextMetadata,
		tool_record: {
			...existingRecord,
			...projected,
			mutating: existingRecord.mutating,
			duration_ms: existingRecord.duration_ms,
			shell: { ...existingShell, ...projected.shell },
		},
	};
	return [...items.slice(0, index), merged, ...items.slice(index + 1)];
}

function shellRecordOutput(record: GatewayToolRecord): string {
	return record.detail_preview ?? (record.output_preview !== record.summary_preview ? record.output_preview : undefined) ?? "";
}

function mergeShellOutputText(existing: string, incoming: string): string {
	if (!incoming) return existing;
	if (!existing) return incoming;
	if (existing.includes(incoming)) return existing;
	if (incoming.includes(existing)) return incoming;
	return `${existing}${incoming}`;
}

function shellDisplayEnvelope(options: {
	metadata: Record<string, unknown>;
	shellId: string;
	commandPreview: string;
	outputPreview: string;
	terminalState?: string;
	exitCode?: number;
}): Record<string, unknown> {
	const existing = recordValue(options.metadata.display);
	const metrics = recordValue(existing.metrics);
	const successful =
		options.terminalState === "completed" &&
		(options.exitCode === undefined || options.exitCode === 0);
	const status = options.terminalState ? (successful ? "success" : "error") : "running";
	const summary = options.terminalState
		? options.exitCode === undefined
			? options.terminalState
			: `Exit ${options.exitCode}`
		: "Running";
	return {
		...existing,
		target: options.commandPreview,
		status,
		summary,
		...(options.outputPreview ? { detail: options.outputPreview } : {}),
		presentation: "shell",
		metrics: {
			...metrics,
			shell_id: options.shellId,
			...(options.exitCode === undefined ? {} : { exit_code: options.exitCode }),
		},
	};
}
