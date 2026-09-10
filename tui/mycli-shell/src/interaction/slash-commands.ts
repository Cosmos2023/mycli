import { slashCommandArguments } from "@mycli/contracts";
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
	const categories: readonly MycliShellCommandSpec["category"][] = [
		"diagnostics", "interface", "model", "safety", "session", "tools",
	];
	const category = categories.includes(record.category as MycliShellCommandSpec["category"])
		? record.category as MycliShellCommandSpec["category"]
		: "tools";
	const aliases = Array.isArray(record.aliases)
		? [...new Set(record.aliases.flatMap((alias) => {
			if (typeof alias !== "string") return [];
			const normalized = alias.trim();
			return normalized.startsWith("/") ? [normalized] : [];
		}))]
		: [];
	const unavailableReason = typeof record.unavailable_reason === "string" && record.unavailable_reason.trim()
		? record.unavailable_reason.trim().slice(0, 256)
		: undefined;
	return {
		id,
		name,
		description,
		...(argumentHint ? { argumentHint } : {}),
		argumentPolicy: argumentPolicy as MycliShellCommandSpec["argumentPolicy"],
		availableDuringTurn: record.available_during_turn,
		aliases,
		category,
		searchOnly: record.search_only === true,
		available: record.available !== false,
		...(unavailableReason ? { unavailableReason } : {}),
	};
}

export function slashCommandsFromResult(result: Record<string, unknown>): MycliShellCommandSpec[] {
	if (!Array.isArray(result.commands)) return [];
	return result.commands
		.map(commandFromUnknown)
		.filter((command): command is MycliShellCommandSpec => command !== null);
}

export function slashCommandNamesFromResult(result: Record<string, unknown>): string[] {
	if (!Array.isArray(result.routing_names)) return [];
	return [...new Set(result.routing_names.flatMap((value) => {
		if (typeof value !== "string") return [];
		const name = value.trim();
		return name.startsWith("/") ? [name] : [];
	}))];
}

export function isSlashCommandSubmission(text: string, commandNames: readonly string[]): boolean {
	return commandNames.some((name) => slashCommandArguments(text, name) !== null);
}

export function commandRoutingNames(commands: readonly MycliShellCommandSpec[]): string[] {
	return [...new Set(commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]))];
}

export function clientActionFromResult(result: Record<string, unknown>): MycliShellClientAction | null {
	if (result.execution !== "tui") return null;
	const action = typeof result.client_action === "string" ? result.client_action.trim() : "";
	const args = typeof result.args === "string" ? result.args : null;
	const commandId = typeof result.command_id === "string" ? result.command_id.trim() : "";
	if (!action || args === null || !commandId) return null;
	return { action, args, commandId };
}
