import type { CanonicalToolCall } from "@mycli/core";

export type ShellSandboxPermissions = "use_default" | "require_escalated";

export const SHELL_JUSTIFICATION_MAX_CHARS = 512;

export function isValidShellJustification(value: unknown): value is string {
	return typeof value === "string"
		&& value.trim().length > 0
		&& Array.from(value).length <= SHELL_JUSTIFICATION_MAX_CHARS;
}

export function parseShellSandboxPermissions(
	value: unknown,
): ShellSandboxPermissions | undefined {
	if (value === undefined || value === "use_default") return "use_default";
	return value === "require_escalated" ? value : undefined;
}

export function shellCallRequestsSandboxOverride(call: CanonicalToolCall): boolean {
	if (call.name !== "Shell") return false;
	try {
		const parsed = JSON.parse(call.argumentsJson) as unknown;
		return typeof parsed === "object"
			&& parsed !== null
			&& !Array.isArray(parsed)
			&& Reflect.get(parsed, "sandbox_permissions") === "require_escalated";
	} catch {
		return false;
	}
}
