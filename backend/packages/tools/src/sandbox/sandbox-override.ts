import type { CanonicalToolCall } from "@mycli/core";
import { mutationCallRequestsSandboxOverride } from "../files/file-sandbox-permissions.ts";
import { shellCallRequestsSandboxOverride } from "../shell/shell-sandbox-permissions.ts";

export function toolCallRequestsSandboxOverride(call: CanonicalToolCall): boolean {
	return shellCallRequestsSandboxOverride(call)
		|| mutationCallRequestsSandboxOverride(call);
}
