import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProcessSandboxError } from "@mycli/tools";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpOAuthError } from "./oauth-store.ts";
import { createErrorContext, failureScope, type ErrorContext, type FailureOutcome, type IntegrationErrorDetails } from "@mycli/contracts";

export type McpFailureCategory =
	| "timeout"
	| "server_startup"
	| "transport_error"
	| "schema_error"
	| "execution_error";

export type McpOperation = NonNullable<IntegrationErrorDetails["operation"]>;

export interface McpFailure {
	readonly category: McpFailureCategory;
	readonly details: Readonly<IntegrationErrorDetails>;
	readonly outcome: Readonly<FailureOutcome>;
}

interface McpFailureOptions {
	readonly operation: McpOperation;
	readonly phase?: IntegrationErrorDetails["phase"];
	readonly timeoutMs?: number;
	readonly recoveryAttempts?: 0 | 1;
}

const TRANSPORT_CODES = new Set([
	"ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
	"ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "ENOENT", "EACCES", "EPERM",
]);
const SCHEMA_CODES = new Set([
	"invalid_mcp_resource_pagination", "invalid_mcp_tool_pagination", "invalid_mcp_tool_schema", "invalid_mcp_http_response", "mcp_http_response_too_large",
]);
const LOCAL_CODES = new Set([
	"mcp_oauth_required", "mcp_oauth_failed", "mcp_oauth_store_failed", "mcp_oauth_unsupported",
	...SCHEMA_CODES, "mcp_client_closed", "mcp_manager_closed", "mcp_server_unavailable",
	"unknown_mcp_server", "mcp_http_transport_closed", "network_access_denied", "mcp_http_redirect_denied",
]);

// Expiry comes from the HTTP status or a supported machine code, never free-form server text.
export class McpHttpError extends Error {
	readonly sessionExpired: boolean;

	constructor(readonly status: number, sessionExpired = false) {
		super(`MCP HTTP ${status}`);
		this.name = "McpHttpError";
		this.sessionExpired = (status === 404 || status === 401) && sessionExpired;
	}
}

export class McpRequestError extends Error {
	readonly failure: McpFailure;

	constructor(error: unknown, options: McpFailureOptions) {
		const failure = describeMcpFailure(error, options);
		super(`MCP ${failure.category}${failure.details.transport_code ? `: ${failure.details.transport_code}` : ""}`);
		this.name = "McpRequestError";
		this.failure = failure;
	}
}

export function describeMcpFailure(error: unknown, options: McpFailureOptions): McpFailure {
	if (error instanceof McpRequestError) return error.failure;
	const category = classifyMcpFailure(error);
	const phase = options.phase ?? "request";
	const httpStatus = error instanceof McpHttpError ? error.status
		: error instanceof StreamableHTTPError && typeof error.code === "number" && error.code >= 100 && error.code <= 599 ? error.code : undefined;
	const rpcCode = error instanceof McpError && Number.isInteger(error.code)
		&& error.code >= -2_147_483_648 && error.code <= 2_147_483_647 ? error.code : undefined;
	const transportCode = error instanceof ProcessSandboxError ? error.kind
		: error instanceof McpHttpError && error.sessionExpired ? "mcp_session_expired"
		: knownTransportCode(error) ?? (error instanceof Error && LOCAL_CODES.has(error.message) ? error.message : undefined);
	const notStarted = phase !== "request" || (error instanceof McpHttpError && error.sessionExpired)
		|| (rpcCode !== undefined && [ErrorCode.ParseError, ErrorCode.InvalidRequest, ErrorCode.MethodNotFound, ErrorCode.InvalidParams].includes(rpcCode))
		|| transportCode === "unknown_mcp_server" || transportCode === "mcp_server_unavailable" || transportCode === "mcp_client_closed"
		|| transportCode === "network_access_denied" || error instanceof ProcessSandboxError || error instanceof McpOAuthError;
	return Object.freeze({
		category,
		details: Object.freeze({ operation: options.operation, phase,
			...(httpStatus === undefined ? {} : { http_status: httpStatus }),
			...(rpcCode === undefined ? {} : { rpc_code: rpcCode }),
			...(transportCode ? { transport_code: transportCode } : {}),
			...(category === "timeout" && options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
			...(options.recoveryAttempts ? { recovery_attempts: options.recoveryAttempts } : {}),
		}),
		outcome: Object.freeze(notStarted ? { state: "not_started", effects: "none" }
			: { state: rpcCode !== undefined && category === "execution_error" ? "failed" : "unknown",
				effects: options.operation === "tools/call" ? "possible" : "none" }),
	});
}

export function mcpFailureContext(failure: McpFailure, callId: string, server?: string): ErrorContext {
	const policy = failure.details.transport_code;
	if (policy === "network_access_denied" || policy === "sandbox_unavailable" || policy === "network_proxy_unavailable") {
		return createErrorContext({ reason: policy === "network_access_denied" ? "policy.access_denied" : "policy.sandbox_unavailable",
			source: "policy", scope: failureScope("tool_call", callId), outcome: failure.outcome, details: { policy } });
	}
	return createErrorContext({
		reason: failure.category === "schema_error" ? "integration.protocol_invalid"
			: failure.category === "execution_error" ? "integration.failure_unclassified" : "integration.unavailable",
		source: "integration", scope: failureScope("tool_call", callId), outcome: failure.outcome,
		details: { ...failure.details, ...(server ? { integration: server } : {}), legacy_kind: mcpFailureErrorKind(failure.category) },
	});
}

export function mcpFailureText(failure: McpFailure): string {
	const details = failure.details;
	return [
		`Error kind: ${failure.category}`,
		`Operation: ${details.operation}. Phase: ${details.phase}.`,
		...(details.http_status === undefined ? [] : [`HTTP status: ${details.http_status}.`]),
		...(details.rpc_code === undefined ? [] : [`RPC code: ${details.rpc_code}.`]),
		...(details.transport_code ? [`Transport code: ${details.transport_code}.`] : []),
		...(details.transport_code === "mcp_oauth_required" || details.http_status === 401
			? ["Authentication is required. Run mycli mcp login <server-id>, then refresh the session."] : []),
		...(details.recovery_attempts ? [`Session recovery attempts: ${details.recovery_attempts}.`] : []),
		...(failure.outcome.state === "unknown" && failure.outcome.effects === "possible"
			? ["Execution outcome is unknown; check the remote state before retrying this operation."] : []),
	].join("\n");
}

export function classifyMcpFailure(error: unknown): McpFailureCategory {
	if (error instanceof McpOAuthError) return "transport_error";
	if (error instanceof McpRequestError) return error.failure.category;
	if (error instanceof ProcessSandboxError) return "server_startup";
	if (error instanceof Error && (error.message === "network_access_denied" || error.message === "mcp_http_redirect_denied")) return "transport_error";
	if (error instanceof McpHttpError) return "transport_error";
	if (error instanceof StreamableHTTPError) return error.code === -1 ? "schema_error" : "transport_error";
	if (error instanceof McpError) {
		if (error.code === ErrorCode.RequestTimeout) return "timeout";
		if (error.code === ErrorCode.ConnectionClosed) return "transport_error";
		return "execution_error";
	}
	const code = knownTransportCode(error);
	if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return "server_startup";
	if (code) return code.includes("TIMEOUT") || code === "ETIMEDOUT" ? "timeout" : "transport_error";
	if (error instanceof Error && error.name === "TimeoutError") return "timeout";
	if (error instanceof Error && (error.name === "ZodError" || error instanceof SyntaxError
		|| SCHEMA_CODES.has(error.message))) return "schema_error";
	if (error instanceof Error && ["unknown_mcp_server", "mcp_server_unavailable", "mcp_client_closed", "mcp_manager_closed"].includes(error.message)) return "server_startup";
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

function knownTransportCode(error: unknown): string | undefined {
	const seen = new Set<unknown>();
	let current = error;
	while (current instanceof Error && seen.size < 4 && !seen.has(current)) {
		seen.add(current);
		const code: unknown = "code" in current ? current.code : undefined;
		if (typeof code === "string" && TRANSPORT_CODES.has(code)) return code;
		current = current.cause;
	}
	return undefined;
}
