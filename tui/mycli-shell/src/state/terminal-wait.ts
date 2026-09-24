import {
	gatewayToolLifecycleRecord,
	projectTerminalInteraction,
	type GatewayTerminalInteraction,
} from "@mycli/contracts";
import { nextId, recordValue, stringValue } from "./payload-values.ts";
import type {
	RuntimeShellState,
	RuntimeTerminalWait,
	RuntimeTranscriptItem,
} from "./runtime-state-model.ts";
import { toolRecordFromTranscriptItem } from "./transcript-records.ts";
import { findShellTranscriptIndex } from "./transcript-shell.ts";

/**
 * Where an incoming event sits relative to an active background-terminal wait.
 *
 * Codex keeps one status line while polls repeat and inserts a single "Waited for background
 * terminal" cell when the wait ends, so a wait never owns one transcript row per poll.
 */
export type TerminalWaitFlushTiming = "before" | "after";

const TERMINAL_TURN_STATES = new Set(["completed", "failed", "interrupted", "rejected"]);

export function terminalWaitFlushTiming(
	state: RuntimeShellState,
	method: string,
	params: Record<string, unknown>,
): TerminalWaitFlushTiming | null {
	const wait = state.terminalWaitStreak;
	if (!wait) return null;
	if (
		method === "message.delta"
		|| method === "message.complete"
		|| method === "plan.proposed"
		|| method === "plan.updated"
	) {
		return "before";
	}
	const interaction = projectTerminalInteraction(
		params.terminal_interaction ?? recordValue(params.tool_record).terminal_interaction,
	);
	if (interaction?.kind === "input" && interaction.shell_id === wait.shellId) return "before";
	if (method.startsWith("shell.")) {
		if (stringValue(params.shell_id) !== wait.shellId) return null;
		return method === "shell.removed"
			|| method === "shell.completed"
			|| method === "shell.failed"
			|| stringValue(params.terminal_state)
			? "after"
			: null;
	}
	if (method === "turn.completed" || method === "turn.failed") return "after";
	if (method === "turn.interrupted" && params.requested !== true) return "after";
	if (method === "status.changed" && params.turn_running === false) return "after";
	if (
		(method === "turn.status" || method === "status.update")
		&& (params.terminal === true || TERMINAL_TURN_STATES.has(stringValue(params.state) ?? ""))
	) {
		return "after";
	}
	return null;
}

export function extendTerminalWait(
	state: RuntimeShellState,
	wait: RuntimeTerminalWait,
): RuntimeShellState {
	const previous = state.terminalWaitStreak;
	const base = previous && previous.shellId !== wait.shellId ? flushTerminalWait(state) : state;
	return {
		...base,
		terminalWaitStreak: previous && previous.shellId === wait.shellId
			? mergeTerminalWait(previous, wait)
			: wait,
		liveStatus: {
			state: "running",
			kind: "waiting_background_terminal",
			text: "Waiting for background terminal",
			...(wait.callId ? { callId: wait.callId } : {}),
			...(wait.interaction.command_preview ? { message: wait.interaction.command_preview } : {}),
		},
	};
}

export function flushTerminalWait(state: RuntimeShellState): RuntimeShellState {
	const wait = state.terminalWaitStreak;
	if (!wait) return state;
	return {
		...state,
		terminalWaitStreak: null,
		liveStatus: state.liveStatus?.kind === "waiting_background_terminal"
			? { state: "running", kind: "running", text: "Running" }
			: state.liveStatus,
		transcript: [...state.transcript, terminalWaitItem(wait)],
	};
}

/**
 * Resolves the shell row a poll belongs to: the command it was started with and whether the
 * process already reached a terminal state. Codex ignores polls for finished processes.
 */
export function shellWaitTarget(
	items: RuntimeTranscriptItem[],
	shellId: string,
): { commandPreview?: string; finished: boolean } {
	const index = findShellTranscriptIndex(items, shellId, undefined);
	if (index < 0) return { finished: false };
	const record = toolRecordFromTranscriptItem(items[index]!);
	return {
		commandPreview: record.shell?.command_preview ?? record.target,
		finished: record.shell?.terminal_state !== undefined || record.status !== "running",
	};
}

function mergeTerminalWait(
	previous: RuntimeTerminalWait,
	next: RuntimeTerminalWait,
): RuntimeTerminalWait {
	const interaction: GatewayTerminalInteraction = {
		...previous.interaction,
		...next.interaction,
		command_preview: next.interaction.command_preview ?? previous.interaction.command_preview,
		kind: "poll",
		shell_id: next.shellId,
	};
	return {
		shellId: next.shellId,
		...(next.callId ?? previous.callId ? { callId: next.callId ?? previous.callId } : {}),
		interaction,
	};
}

function terminalWaitItem(wait: RuntimeTerminalWait): RuntimeTranscriptItem {
	const failed = wait.interaction.interaction_succeeded === false;
	const params: Record<string, unknown> = {
		name: "WriteStdin",
		call_id: wait.callId,
		success: !failed,
		terminal_interaction: wait.interaction,
	};
	return {
		id: nextId("terminal-wait"),
		type: "tool_summary",
		text: "WriteStdin",
		folded: true,
		metadata: params,
		tool_record: gatewayToolLifecycleRecord(failed ? "tool.failed" : "tool.complete", params),
	};
}
