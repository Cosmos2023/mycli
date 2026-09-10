import type { GatewayTerminalInteraction } from "../generated/gateway-tool-record.ts";
import { sanitizeRuntimeErrorDetail } from "./runtime-errors.ts";

export function terminalInteractionFromArguments(
	toolName: string,
	argumentsValue: unknown,
): GatewayTerminalInteraction | undefined {
	if (toolName.toLowerCase().replace(/[_-]/gu, "") !== "writestdin") return undefined;
	let args = argumentsValue;
	if (typeof args === "string") {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (!isRecord(args)) return undefined;
	const shellId = args.session_id ?? args.shell_id ?? args.bash_id;
	const chars = args.chars ?? "";
	if (typeof chars !== "string") return undefined;
	// Quoting makes whitespace and control input visible without executing terminal escapes.
	const inputPreview = chars ? JSON.stringify(chars.slice(0, 16_384))
		.replace(/\\u0003/gu, "^C").replace(/\\u0004/gu, "^D")
		.replace(/[\u007f-\u009f]/gu, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`) : undefined;
	return projectTerminalInteraction({
		shell_id: shellId, kind: chars ? "input" : "poll",
		...(inputPreview ? { input_preview: inputPreview } : {}),
	});
}

export function projectTerminalInteraction(value: unknown): GatewayTerminalInteraction | undefined {
	if (!isRecord(value) || typeof value.shell_id !== "string"
		|| !value.shell_id.trim() || value.shell_id.length > 512
		|| [...value.shell_id].some((character) => character.charCodeAt(0) < 32
			|| (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159))
		|| (value.kind !== "input" && value.kind !== "poll")) return undefined;
	const inputPreview = value.kind === "input" ? sanitizeRuntimeErrorDetail(value.input_preview) : undefined;
	const commandPreview = sanitizeRuntimeErrorDetail(value.command_preview);
	return Object.freeze({
		shell_id: value.shell_id.trim(), kind: value.kind,
		...(inputPreview ? { input_preview: inputPreview } : {}),
		...(commandPreview ? { command_preview: commandPreview } : {}),
		...(typeof value.interaction_succeeded === "boolean" ? { interaction_succeeded: value.interaction_succeeded } : {}),
		...(typeof value.process_running === "boolean" ? { process_running: value.process_running } : {}),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
