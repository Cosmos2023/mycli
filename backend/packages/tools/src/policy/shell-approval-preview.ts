import type { ApprovalPreviewDetails, CanonicalToolCall } from "@mycli/core";
import {
	isValidShellJustification,
	SHELL_JUSTIFICATION_MAX_CHARS,
} from "../shell/shell-sandbox-permissions.ts";

const MAX_COMMAND_PREVIEW_CHARS = 12_000;
const SECRET_NAME = "(?:[\\w-]*[_-])?(?:api[_-]?key|access[_-]?key|authorization|password|passwd|secret|token|credential|cookie)";
const SECRET_VALUE = `(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|'[^']*'|[^\\s"'\x60,;|&<>]+)`;
const SECRET_ASSIGNMENT = new RegExp(`(\\b${SECRET_NAME}["']?\\s*[:=]\\s*)(?:(?:Bearer|Basic)\\s+)?${SECRET_VALUE}`, "giu");
const SECRET_OPTION = new RegExp(`(--?${SECRET_NAME}(?:=|[ \\t]+))${SECRET_VALUE}`, "giu");

/** Display-only projection of the canonical call; never used as execution input. */
export function shellApprovalPreview(call: CanonicalToolCall): ApprovalPreviewDetails {
	if (call.name !== "Shell" && call.name !== "Bash") return Object.freeze({});
	let value: unknown;
	try {
		value = JSON.parse(call.argumentsJson) as unknown;
	} catch {
		return Object.freeze({});
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)
		|| !("command" in value) || typeof value.command !== "string" || !value.command.trim()) {
		return Object.freeze({});
	}
	const command = approvalDisplayText(value.command);
	const justification = call.name === "Shell" && "justification" in value
		? approvalJustification(value.justification) : undefined;
	return Object.freeze({
		commandPreview: command.slice(0, MAX_COMMAND_PREVIEW_CHARS),
		commandTruncated: command.length > MAX_COMMAND_PREVIEW_CHARS,
		...(justification ? { justification } : {}),
	});
}

function approvalJustification(value: unknown): string | undefined {
	if (!isValidShellJustification(value)) return undefined;
	const characters = Array.from(approvalDisplayText(value.trim()));
	return characters.length <= SHELL_JUSTIFICATION_MAX_CHARS
		? characters.join("")
		: `${characters.slice(0, SHELL_JUSTIFICATION_MAX_CHARS - 3).join("")}...`;
}

function approvalDisplayText(value: string): string {
	return value
		.replace(/(["'])((?:proxy-)?authorization|cookie|set-cookie)(\s*:\s*)(?:\\[\s\S]|(?!\1)[^\\])*\1/giu, "$1$2$3[REDACTED]$1")
		.replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
		.replace(SECRET_OPTION, "$1[REDACTED]")
		.replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/giu, "[REDACTED]")
		.replace(/([?&](?:api[_-]?key|key|token|secret|password)=)[^&#\s"']+/giu, "$1[REDACTED]")
		.replace(/(:\/\/[^\s/:]+:)[^\s/@]+(@)/gu, "$1[REDACTED]$2")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gu, "[REDACTED]")
		.replace(/[\p{Cc}\p{Cf}]/gu, (character) => /[\t\n\r]/u.test(character)
			? character : `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}
