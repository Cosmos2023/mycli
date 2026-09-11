import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	ContractValidationError, ERROR_REASONS, RUNTIME_ERROR_CODES, LEGACY_RUNTIME_ERRORS,
	createErrorContext, errorContextSchema, errorDefinition, errorOccurrence, errorPublicDetails,
	errorSummary, isDiagnosticCategory, isDiagnosticRecoveryActionId, legacyGatewayReason,
	legacyRuntimeReason, parseErrorContext, readErrorContext, runtimeErrorRecoveryActions,
} from "../src/index.ts";
import type { ErrorContextIssue, ErrorReason, RuntimeErrorCode } from "../src/index.ts";

const fixtureBytes = readFileSync(new URL("../../../../tests/fixtures/error-system/failures.json", import.meta.url));
const fixtures = JSON.parse(fixtureBytes.toString("utf8")) as readonly {
	readonly name: string;
	readonly code: string;
	readonly context: unknown;
	readonly summary: string;
	readonly recovery: readonly string[];
}[];

test("the error reason catalog matches its canonical schema and has complete definitions", () => {
	const schema = errorContextSchema as { $defs: { reason_details: { oneOf: { properties: { reason: { enum: ErrorReason[] } } }[] } } };
	const reasons = schema.$defs.reason_details.oneOf.flatMap((branch) => branch.properties.reason.enum);
	assert.equal(new Set(reasons).size, reasons.length);
	assert.deepEqual([...reasons].sort(), [...ERROR_REASONS].sort());
	assert.equal(reasons.length, 66);
	for (const reason of reasons) {
		const definition = errorDefinition(reason);
		assert.equal(isDiagnosticCategory(definition.category), true);
		assert.ok(definition.summary.endsWith("."));
		assert.ok(definition.scopes.length > 0);
		for (const action of definition.recovery) assert.equal(isDiagnosticRecoveryActionId(action), true);
		assert.equal(createErrorContext({ reason, source: "runtime", scope: { kind: definition.scopes[0]!, id: "operation:test" } }).reason, reason);
	}
});

test("legacy runtime coverage does not guess concrete capability or cancellation causes", () => {
	assert.deepEqual(Object.keys(LEGACY_RUNTIME_ERRORS), RUNTIME_ERROR_CODES);
	for (const code of RUNTIME_ERROR_CODES) assert.ok(errorDefinition(legacyRuntimeReason(code)));
	assert.equal(legacyRuntimeReason("unsupported_capability"), "capability.unspecified");
	assert.equal(legacyRuntimeReason("interrupted"), "runtime.interruption_unspecified");
	assert.deepEqual(runtimeErrorRecoveryActions("unsupported_capability"), []);
	assert.equal(legacyGatewayReason("gateway_overloaded", false), "gateway.admission_rejected");
	assert.equal(legacyGatewayReason("gateway_overloaded", true), "gateway.output_capacity_exceeded");
	assert.equal(legacyGatewayReason("gateway_overloaded"), "gateway.failure_unclassified");
});

test("shared public error fixtures retain their recorded digest", () => {
	const digest = readFileSync(new URL("../../../../tests/fixtures/error-system/failures.sha256", import.meta.url), "utf8").trim();
	assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"), digest);
});

for (const fixture of fixtures) test(`shared error fixture: ${fixture.name}`, () => {
	const context = parseErrorContext(fixture.context);
	assert.equal(errorSummary(context), fixture.summary);
	assert.deepEqual(errorDefinition(context.reason).recovery, fixture.recovery);
	assert.deepEqual(parseErrorContext(JSON.parse(JSON.stringify(context))), context);
	assert.equal(Object.isFrozen(context), true);
	assert.equal(Object.isFrozen(context.outcome), true);
	if (fixture.code in LEGACY_RUNTIME_ERRORS) assert.ok(legacyRuntimeReason(fixture.code as RuntimeErrorCode));
});

test("invalid optional error context is quarantined with a bounded issue", () => {
	const context = parseErrorContext(fixtures[0]!.context);
	const issues: ErrorContextIssue[] = [];
	assert.equal(readErrorContext(undefined, (issue) => issues.push(issue)), undefined);
	for (const patch of [
		{ version: 2 }, { reason: "future.reason" }, { private: "raw" },
		{ outcome: { state: "not_started", effects: "confirmed" } },
		{ details: { model: "x", raw_body: "secret" } },
		{ details: { model: "x".repeat(9000) } },
		{ scope: { kind: "tool_call", id: "file:///private/example" } },
		{ causes: [errorOccurrence(context)] },
	]) {
		assert.throws(() => parseErrorContext({ ...context, ...patch }), ContractValidationError);
		assert.equal(readErrorContext({ ...context, ...patch }, (issue) => issues.push(issue)), undefined);
	}
	assert.deepEqual(issues.slice(0, 2), ["unsupported_version", "unknown_reason"]);
	assert.equal(issues.length, 8);
});

test("constructors omit unsafe details without losing reason or execution evidence", () => {
	for (const model of ["sk-testsecret12345678", "Bearer secret", "file:///Users/private/secret", "\u001b[31mred", "data:image/png;base64,secret", "x".repeat(257)]) {
		const context = createErrorContext({
			reason: "capability.image_input_unsupported", source: "provider",
			scope: { kind: "provider_attempt", id: "attempt:1" },
			outcome: { state: "not_started", effects: "none" },
			details: { model, input_origin: "history" },
		});
		assert.deepEqual(context.details, { input_origin: "history" });
		assert.equal(context.reason, "capability.image_input_unsupported");
		assert.doesNotMatch(errorPublicDetails(context) ?? "", /secret|private|base64/u);
	}
	const input = { reason: "tool.path_not_found", details: { http_status: 401 } };
	assert.throws(() => parseErrorContext({
		...createErrorContext({ reason: "tool.path_not_found", source: "tool", scope: { kind: "tool_call", id: "call:1" } }),
		...input,
	}));
});

test("integration diagnostics validate HTTP, RPC and phase evidence and render it publicly", () => {
	const context = createErrorContext({ reason: "integration.unavailable", source: "integration", scope: { kind: "tool_call", id: "mcp:call" },
		outcome: { state: "not_started", effects: "none" }, details: { integration: "remote", operation: "tools/call", phase: "request",
			http_status: 404, rpc_code: -32602, transport_code: "mcp_session_expired", recovery_attempts: 1 } });
	assert.deepEqual(parseErrorContext(JSON.parse(JSON.stringify(context))), context);
	const text = errorPublicDetails(context);
	assert.match(text ?? "", /HTTP 404.*Operation: tools\/call.*Phase: request.*RPC -32602.*mcp_session_expired/u);
	for (const details of [
		{ http_status: 600 }, { rpc_code: 2 ** 32 }, { phase: "private phase" }, { operation: "https://private/path" },
		{ transport_code: "Bearer secret" }, { recovery_attempts: 2 }, { raw_body: "private" },
	]) assert.throws(() => parseErrorContext({ ...context, details }), ContractValidationError);
});

test("aggregate failures preserve immediate and root causes without mutation", () => {
	const causes = Array.from({ length: 6 }, (_, index) => createErrorContext({
		reason: "transport.timed_out", source: "provider", scope: { kind: "provider_attempt", id: `attempt:${index}` },
		outcome: { state: "unknown", effects: "none" }, details: { transport_code: "ETIMEDOUT" },
	}));
	const context = createErrorContext({
		reason: "runtime.retry_exhausted", source: "runtime", scope: { kind: "turn", id: "turn:test" },
		causes: causes.map(errorOccurrence),
	});
	assert.deepEqual(context.causes?.map((cause) => cause.id), [causes[0]!.id, causes[1]!.id, causes[5]!.id]);
	assert.deepEqual(context.details, { omitted_causes: 3 });
	assert.deepEqual(causes[0]!.details, { transport_code: "ETIMEDOUT" });
});
