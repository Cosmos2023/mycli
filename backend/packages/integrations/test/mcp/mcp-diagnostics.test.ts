import assert from "node:assert/strict";
import test from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { errorPublicDetails, parseErrorContext } from "@mycli/contracts";
import { describeMcpFailure, McpHttpError, McpRequestError, mcpFailureContext, mcpFailureText } from "../../src/mcp/diagnostics.ts";

test("MCP diagnostics retain structured HTTP and RPC evidence without upstream text or data", () => {
	for (const [error, expected] of [
		[new StreamableHTTPError(403, "https://private/credential Bearer secret"), { http_status: 403 }],
		[new McpError(-32602, "private arguments", { token: "secret" }), { rpc_code: -32602 }],
		[new TypeError("private fetch failure", { cause: Object.assign(new Error("secret"), { code: "ECONNRESET" }) }), { transport_code: "ECONNRESET" }],
		[Object.assign(new Error("private process"), { code: "ENOENT", path: "/private/secret" }), { transport_code: "ENOENT" }],
	] as const) {
		const failure = describeMcpFailure(error, { operation: "tools/call" });
		assert.deepEqual(failure.details, { operation: "tools/call", phase: "request", ...expected });
		const context = mcpFailureContext(failure, "call:1", "train");
		assert.deepEqual(parseErrorContext(JSON.parse(JSON.stringify(context))), context);
		assert.equal(context.source, "integration");
		assert.equal(context.scope.id, "call:1");
		assert.doesNotMatch(`${JSON.stringify(context)} ${mcpFailureText(failure)} ${errorPublicDetails(context)}`, /private|secret|Bearer/u);
	}
});

test("timeouts, invalid replies, explicit rejections and unknown outcomes remain distinct", () => {
	for (const [error, category, state] of [
		[new McpError(ErrorCode.RequestTimeout, "private timeout"), "timeout", "unknown"],
		[new McpError(ErrorCode.ConnectionClosed, "private connection"), "transport_error", "unknown"],
		[new McpError(ErrorCode.InvalidParams, "private params"), "execution_error", "not_started"],
		[new McpError(-32050, "private server exception"), "execution_error", "failed"],
		[new StreamableHTTPError(-1, "private content-type"), "schema_error", "unknown"],
		[new SyntaxError("private invalid JSON"), "schema_error", "unknown"],
		[new Error("invalid_mcp_http_response"), "schema_error", "unknown"],
		[new McpHttpError(404, true), "transport_error", "not_started"],
		[new McpHttpError(503, true), "transport_error", "unknown"],
	] as const) {
		const failure = describeMcpFailure(error, { operation: "tools/call", timeoutMs: 1_000 });
		assert.equal(failure.category, category);
		assert.equal(failure.outcome.state, state);
		assert.equal(failure.outcome.effects, state === "not_started" ? "none" : "possible");
	}
	const initialize = describeMcpFailure(new McpHttpError(503), { operation: "initialize", phase: "reconnect", recoveryAttempts: 1 });
	assert.deepEqual(initialize.outcome, { state: "not_started", effects: "none" });
	const resource = describeMcpFailure(new McpHttpError(503), { operation: "resources/read" });
	assert.deepEqual(resource.outcome, { state: "unknown", effects: "none" });
});

test("MCP code allowlists reject arbitrary code strings and bound circular causes", () => {
	const error = Object.assign(new Error("private failure"), { code: "https://private/secret", status: 404, rpc_code: -32602, cause: undefined as unknown });
	error.cause = error;
	const wrapped = new McpRequestError(error, { operation: "tools/call" });
	assert.deepEqual(wrapped.failure.details, { operation: "tools/call", phase: "request" });
	assert.equal(wrapped.cause, undefined);
	assert.doesNotMatch(wrapped.message + JSON.stringify(wrapped), /private|secret|404|32602/u);
	assert.equal(describeMcpFailure(wrapped, { operation: "tools/call" }), wrapped.failure);
});
