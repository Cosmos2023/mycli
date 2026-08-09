import type { ManagementCommand, ManagementResponse } from "./types.ts";
import { redactDoctorText } from "./doctor/redaction.ts";

export function renderManagementResponse(
	command: ManagementCommand,
	response: ManagementResponse,
): string {
	if (command.json) return `${JSON.stringify(response)}\n`;
	if (command.kind === "doctor") return renderDoctor(response);
	const lines = [response.message ?? `mycli ${command.kind} ${response.ok ? "complete" : "failed"}`];
	for (const row of responseRows(command, response)) lines.push(row);
	for (const issue of response.issues ?? []) lines.push(`issue=${issue}`);
	return `${lines.join("\n")}\n`;
}

function renderDoctor(response: ManagementResponse): string {
	const checks = Array.isArray(Reflect.get(response, "checks"))
		? (Reflect.get(response, "checks") as readonly unknown[]).flatMap((value) => {
			const row = record(value);
			if (!row) return [];
			const name = typeof row.name === "string" ? row.name : "diagnostic";
			const status: "ok" | "warning" | "failed" = row.status === "ok"
				|| row.status === "warning"
				|| row.status === "failed"
				? row.status
				: "failed";
			const message = typeof row.message === "string" ? row.message : "diagnostic failed";
			const detail = typeof row.detail === "string" ? row.detail : undefined;
			return [{ name, status, message, ...(detail ? { detail } : {}) }];
		})
		: [];
	const marker = { ok: "[OK]", warning: "[WARN]", failed: "[FAIL]" } as const;
	if (checks.length === 0 && response.message && response.message !== "mycli doctor") {
		return `${redactDoctorText(response.message)}\n`;
	}
	const lines = ["mycli doctor"];
	for (const check of checks) {
		const detail = check.detail ? ` (${redactDoctorText(check.detail)})` : "";
		lines.push(
			`${marker[check.status]} ${redactDoctorText(check.name)}: ${redactDoctorText(check.message)}${detail}`,
		);
	}
	lines.push(
		`Summary: ${countValue(response, "okCount")} ok, `
		+ `${countValue(response, "warningCount")} warning, `
		+ `${countValue(response, "failedCount")} failed`,
	);
	return `${lines.join("\n")}\n`;
}

function countValue(response: ManagementResponse, key: string): number {
	const value = Reflect.get(response, key);
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
