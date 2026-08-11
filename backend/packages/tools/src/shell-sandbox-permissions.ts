import type { CanonicalToolCall } from "@mycli/core";

export type ShellSandboxPermissions = "use_default" | "require_escalated";

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
