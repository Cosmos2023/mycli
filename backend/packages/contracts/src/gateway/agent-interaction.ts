import type { GatewayAgentInteraction } from "../generated/gateway-tool-record.ts";
import { sanitizePublicTextPreview } from "./runtime-errors.ts";

export function agentInteractionFromArguments(
	toolName: string,
	argumentsValue: unknown,
	includeMessage = true,
): GatewayAgentInteraction | undefined {
	const kind = agentInteractionKind(toolName);
	if (!kind) return undefined;
	let args = argumentsValue;
	if (typeof args === "string") {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (!isRecord(args)) return undefined;
	return projectAgentInteraction({
		kind,
		target: kind === "spawn" ? args.task_name : args.target,
		...(includeMessage ? { message_preview: kind === "interrupt" ? args.reason : args.message } : {}),
	});
}

export function agentInteractionKind(toolName: string): GatewayAgentInteraction["kind"] | undefined {
	switch (toolName.trim().toLowerCase()) {
		case "spawn_agent": return "spawn";
		case "send_message": return "message";
		case "followup_task": return "followup";
		case "interrupt_agent": return "interrupt";
		default: return undefined;
	}
}

export function projectAgentInteraction(value: unknown): GatewayAgentInteraction | undefined {
	if (!isRecord(value) || typeof value.target !== "string" || !value.target.trim()
		|| value.target.length > 512 || /[\p{Cc}\p{Cf}]/u.test(value.target)
		|| (value.kind !== "spawn" && value.kind !== "message"
			&& value.kind !== "followup" && value.kind !== "interrupt")) return undefined;
	const target = sanitizePublicTextPreview(value.target);
	if (!target || target.length > 512) return undefined;
	const message = sanitizePublicTextPreview(typeof value.message_preview === "string"
		? value.message_preview.replace(/[\p{Cf}\u0080-\u009f]/gu, "") : undefined);
	return Object.freeze({ kind: value.kind, target,
		...(message ? { message_preview: message } : {}),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
