import type { MycliShellBackgroundTerminals, MycliShellCommandResult } from "../model.ts";
import { commandResultFromGateway } from "./command-results.ts";
import {
	boundedCatalogText,
	collaborationModeValue,
	nextId,
	recordValue,
	stringValue,
} from "./payload-values.ts";
import type { RuntimeShellState, RuntimeTranscriptItem } from "./runtime-state-model.ts";
import { backgroundProcessesFromUnknown, upsertTranscriptItem } from "./transcript-records.ts";

const STARTUP_UPDATE_NOTICE_ID = "startup-update-notice";

export function runtimeStateWithCommandResult(
	state: RuntimeShellState,
	command: string,
	result: Record<string, unknown>,
): RuntimeShellState {
	const projected = projectRuntimeStateWithCommandResult(state, command, result);
	return stringValue(result.dismissed_update_version)
		? withoutStartupUpdateNotice(projected)
		: projected;
}

function projectRuntimeStateWithCommandResult(state: RuntimeShellState, command: string, result: Record<string, unknown>): RuntimeShellState {
	const lines = Array.isArray(result.lines) ? result.lines.map((line) => String(line)) : [String(result.message ?? "Done")];
	const collaborationMode = collaborationModeValue(result.collaboration_mode);
	if (result.presentation === "overlay" || result.presentation === "none") {
		return {
			...state,
			collaborationMode: collaborationMode ?? state.collaborationMode,
		};
	}
	if (result.command_kind === "background_shells") {
		const backgroundTerminals: Omit<MycliShellBackgroundTerminals, "id"> = {
			processes: backgroundProcessesFromUnknown(result.processes),
		};
		const id = stringValue(result.result_id) ?? nextId("command");
		return {
			...state,
			collaborationMode: collaborationMode ?? state.collaborationMode,
			transcript: upsertTranscriptItem(
				state.transcript,
				{
					id,
					type: "background_terminals",
					text: "Background terminals",
					folded: false,
					metadata: commandResultMetadata(state, { command, backgroundTerminals }),
				},
			),
		};
	}
	const commandResult = commandResultFromGateway(result);
	if (commandResult) {
		return {
			...state,
			collaborationMode: collaborationMode ?? state.collaborationMode,
			transcript: upsertTranscriptItem(
				state.transcript,
				commandResultTranscriptItem(commandResult, state.turnRunning),
			),
		};
	}
	const fallbackId = stringValue(result.result_id) ?? nextId("command");
	const item = {
		id: fallbackId,
		type: "command_output",
		text: lines.join("\n"),
		folded: false,
		metadata: commandResultMetadata(state, { command }),
	};
	return {
		...state,
		collaborationMode: collaborationMode ?? state.collaborationMode,
		transcript: upsertTranscriptItem(state.transcript, item),
	};
}

export function runtimeStateWithStartupUpdate(
	state: RuntimeShellState,
	value: unknown,
): RuntimeShellState {
	const update = recordValue(value);
	const install = recordValue(update.install);
	const availability = boundedCatalogText(update.availability, 32);
	const latestVersion = boundedCatalogText(update.latest_version, 64);
	const installCommand = boundedCatalogText(install.command, 512);
	const withoutNotice = withoutStartupUpdateNotice(state);
	if (update.schema_version !== 1
		|| availability !== "available"
		|| !latestVersion
		|| !installCommand) {
		return withoutNotice;
	}
	const fallback = install.fallback === true;
	const text = [
		`mycli ${latestVersion} is available.`,
		`${fallback ? "Manual fallback" : "Install"}: ${installCommand}`,
		`Dismiss this version: /update dismiss ${latestVersion}`,
	].join("\n");
	return {
		...withoutNotice,
		transcript: upsertTranscriptItem(withoutNotice.transcript, {
			id: STARTUP_UPDATE_NOTICE_ID,
			type: "system_notice",
			text,
			folded: false,
			metadata: {
				transient: true,
				update_notice: true,
				latest_version: latestVersion,
			},
		}),
	};
}

function withoutStartupUpdateNotice(state: RuntimeShellState): RuntimeShellState {
	const transcript = state.transcript.filter((item) => item.id !== STARTUP_UPDATE_NOTICE_ID);
	return transcript.length === state.transcript.length ? state : { ...state, transcript };
}

function commandResultTranscriptItem(
	commandResult: MycliShellCommandResult,
	deferUntilTurnComplete: boolean,
): RuntimeTranscriptItem {
	return {
		id: commandResult.id,
		type: "command_result",
		text: commandResult.fallbackLines.join("\n"),
		folded: commandResult.folded,
		metadata: {
			command: commandResult.display.command,
			display: commandResultDisplayPayload(commandResult),
			fallback_lines: commandResult.fallbackLines,
			model_visible: false,
			...(deferUntilTurnComplete ? { deferred_until_turn_complete: true } : {}),
		},
	};
}

function commandResultMetadata(
	state: RuntimeShellState,
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	return state.turnRunning
		? { ...metadata, deferred_until_turn_complete: true }
		: metadata;
}

function commandResultDisplayPayload(commandResult: MycliShellCommandResult): Record<string, unknown> {
	const display = commandResult.display;
	return {
		version: display.version,
		kind: display.kind,
		command: display.command,
		title: display.title,
		severity: display.severity,
		...(display.summary !== undefined ? { summary: display.summary } : {}),
		...(display.fields.length > 0 ? { fields: display.fields } : {}),
		...(display.rows.length > 0 ? { rows: display.rows } : {}),
		...(display.sections.length > 0 ? { sections: display.sections } : {}),
		...(display.usage !== undefined ? { usage: display.usage } : {}),
		...(display.suggestions.length > 0 ? { suggestions: display.suggestions } : {}),
		...(display.preformatted !== undefined ? { preformatted: display.preformatted } : {}),
		...(display.totalRows !== undefined ? { total_rows: display.totalRows } : {}),
		...(display.omittedRows > 0 ? { omitted_rows: display.omittedRows } : {}),
		...(display.omittedChars > 0 ? { omitted_chars: display.omittedChars } : {}),
	};
}
