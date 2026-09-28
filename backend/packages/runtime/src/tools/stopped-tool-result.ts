import type { CanonicalToolCall } from "@mycli/core";
import type { ToolExecutionResult } from "@mycli/tools";

export function stoppedToolResult(call: CanonicalToolCall, reason: string): ToolExecutionResult {
	return { callId: call.callId, toolName: call.name, success: false, errorKind: "interrupted",
		modelOutput: `Tool was not executed. ${reason}`, summary: "Tool skipped: goal stopped", metadata: {} };
}
