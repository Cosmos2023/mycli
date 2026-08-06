import type { ManagementCommand, ManagementResponse } from "./types.ts";

export function renderManagementResponse(
	command: ManagementCommand,
	response: ManagementResponse,
): string {
	if (command.json) return `${JSON.stringify(response)}\n`;
	const lines = [response.message ?? `mycli ${command.kind} ${response.ok ? "complete" : "failed"}`];
	for (const row of responseRows(command, response)) lines.push(row);
	for (const issue of response.issues ?? []) lines.push(`issue=${issue}`);
	return `${lines.join("\n")}\n`;
}

function responseRows(
	command: ManagementCommand,
	response: ManagementResponse,
): readonly string[] {
	if (command.kind === "hooks") {
		return rows(response, "hooks").map((row) => fields("hook", row, [
			"identity", "hookPoint", "enabled", "allowlistStatus", "allowlistReason",
		]));
	}
	if (command.kind === "plugins") {
		const result = record(Reflect.get(response, "commandResult"));
		return [
			...rows(response, "plugins").map((row) => fields("plugin", row, [
				"pluginId", "source", "enabled", "status", "tools", "hooks", "commands",
			])),
			...(result ? [fields("command", result, ["ok", "summary", "error"])] : []),
		];
	}
	if (command.kind === "mcp") {
		return rows(response, "servers").map((row) => fields("mcp", row, [
			"serverId", "transport", "enabled", "status", "toolCount", "timeoutMs",
		]));
	}
	if (command.kind === "subagents") {
		return rows(response, "profiles").map((row) => fields("subagent", row, [
			"id", "description", "model", "allowedTools", "deniedTools",
		]));
	}
	return [];
}

function rows(response: ManagementResponse, key: string): readonly Readonly<Record<string, unknown>>[] {
	const value = Reflect.get(response, key);
	return Array.isArray(value) ? value.flatMap((row) => record(row) ? [record(row)!] : []) : [];
}

function fields(
	prefix: string,
	row: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): string {
	const values = keys.flatMap((key) => row[key] === undefined ? [] : [`${key}=${scalar(row[key])}`]);
	return `${prefix} ${values.join(" ")}`.trimEnd();
}

function scalar(value: unknown): string {
	if (Array.isArray(value)) return value.map((item) => String(item)).join(",") || "none";
	return String(value).replace(/[\r\n]+/gu, " ").slice(0, 512);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: undefined;
}
