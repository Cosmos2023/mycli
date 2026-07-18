import type { MycliShellClientAction, MycliShellCommandSpec } from "../model.ts";

function recordValue(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function commandFromUnknown(value: unknown): MycliShellCommandSpec | null {
	const record = recordValue(value);
	if (!record) return null;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	const name = typeof record.name === "string" ? record.name.trim() : "";
	const description = typeof record.description === "string" ? record.description.trim() : "";
	const argumentPolicy = record.argument_policy;
	if (
		!id ||
		!name.startsWith("/") ||
		!description ||
		!(["none", "optional", "required"] as unknown[]).includes(argumentPolicy) ||
		typeof record.available_during_turn !== "boolean"
	) {
		return null;
	}
	const argumentHint = typeof record.argument_hint === "string" && record.argument_hint.trim()
		? record.argument_hint.trim()
		: undefined;
	return {
		id,
		name,
		description,
		...(argumentHint ? { argumentHint } : {}),
		argumentPolicy: argumentPolicy as MycliShellCommandSpec["argumentPolicy"],
		availableDuringTurn: record.available_during_turn,
	};
}

export function slashCommandsFromResult(result: Record<string, unknown>): MycliShellCommandSpec[] {
	if (!Array.isArray(result.commands)) return [];
	return result.commands
		.map(commandFromUnknown)
		.filter((command): command is MycliShellCommandSpec => command !== null);
}

export function clientActionFromResult(result: Record<string, unknown>): MycliShellClientAction | null {
	if (result.execution !== "tui") return null;
	const action = typeof result.client_action === "string" ? result.client_action.trim() : "";
	const args = typeof result.args === "string" ? result.args : null;
	const commandId = typeof result.command_id === "string" ? result.command_id.trim() : "";
	if (!action || args === null || !commandId) return null;
	return { action, args, commandId };
}
