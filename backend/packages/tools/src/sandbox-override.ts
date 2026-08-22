import type { CanonicalToolCall } from "@mycli/core";
import { mutationCallRequestsSandboxOverride } from "./file-sandbox-permissions.ts";
import { shellCallRequestsSandboxOverride } from "./shell-sandbox-permissions.ts";

export function toolCallRequestsSandboxOverride(call: CanonicalToolCall): boolean {
	return shellCallRequestsSandboxOverride(call)
		|| mutationCallRequestsSandboxOverride(call);
}
