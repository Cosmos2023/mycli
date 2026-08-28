import type { RuntimeErrorCode } from "@mycli/contracts";

export function runtimeErrorStopReason(code: RuntimeErrorCode | null | undefined): string {
	if (code === null || code === undefined) return "runtime_error";
	switch (code) {
		case "config_error": return "config_error";
		case "auth_error": return "auth_failed";
		case "permission_denied": return "permission_denied";
		case "invalid_request": return "invalid_request";
		case "provider_error": return "model_error";
		case "connection_error": return "connection_error";
		case "response_stream_error": return "response_stream_error";
		case "server_overloaded": return "server_overloaded";
		case "rate_limited": return "rate_limited";
		case "quota_exceeded": return "quota_exceeded";
		case "context_window_exceeded": return "context_window_exceeded";
		case "retry_exhausted": return "retry_exhausted";
		case "persistence_error": return "persistence_error";
		case "interrupted": return "interrupted";
		case "unsupported_capability": return "unsupported_capability";
		case "tool_budget_exceeded": return "tool_budget_exceeded";
		case "tool_protocol_error": return "tool_protocol_error";
	}
	const exhaustive: never = code;
	return exhaustive;
}
