export type McpFailureCategory =
	| "timeout"
	| "server_startup"
	| "transport_error"
	| "schema_error"
	| "execution_error";

export function classifyMcpFailure(error: unknown): McpFailureCategory {
	if (error instanceof Error && error.name === "TimeoutError") return "timeout";
	const text = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
	if (text.includes("timeout") || text.includes("timed out")) return "timeout";
	if (text.includes("not found") || text.includes("enoent") || text.includes("permission")) {
		return "server_startup";
	}
	if (text.includes("transport") || text.includes("connection") || text.includes("fetch")) {
		return "transport_error";
	}
	if (text.includes("schema") || text.includes("inputschema")) return "schema_error";
	return "execution_error";
}

export function mcpFailureErrorKind(category: McpFailureCategory): string {
	return category === "timeout" ? "mcp_timeout" : `mcp_${category}`;
}

export function isMcpAbort(error: unknown): error is Error {
	return error instanceof Error && error.name === "AbortError";
}
