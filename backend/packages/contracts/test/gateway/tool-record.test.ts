import assert from "node:assert/strict";
import test from "node:test";
import {
	ContractValidationError, GatewayRpcValidationError, gatewayToolLifecycleRecord,
	parseGatewayEvent, parseGatewayResult, parseGatewayToolRecord, projectGatewayToolRecord,
	type GatewayToolRecord,
} from "../../src/index.ts";

test("Read summaries describe validated actual ranges and preserve explicit display summaries", () => {
	const base = { tool_name: "Read", success: true, path: "src/app.ts", actualStartLine: 10, actualEndLine: 29, shownLines: 20, totalLines: 120 };
	for (const [metadata, expected] of [
		[base, "Lines 10-29 of 120"],
		[{ ...base, dedup: true }, "Lines 10-29 of 120 (unchanged)"],
		[{ ...base, rows: 120 }, "Rows 10-29 of 120"],
		[{ ...base, shownLines: 0, totalLines: 0 }, "Empty file"],
		[{ ...base, shownLines: 0 }, "0 lines read (120 total)"],
		[{ ...base, actualEndLine: -1 }, undefined],
		[{ ...base, actualStartLine: 0 }, undefined],
		[{ ...base, shownLines: 21 }, undefined],
		[{ ...base, totalLines: Infinity }, undefined],
		[{ ...base, success: false }, undefined],
		[{ ...base, tool_name: "other" }, undefined],
		[{ ...base, display: { status: "success", summary: "Custom summary" } }, "Custom summary"],
	] as const) {
		const record = projectGatewayToolRecord({ text: "Read src/app.ts", metadata });
		assert.equal(record.summary_preview, expected);
		assert.equal(parseGatewayToolRecord(record), record);
	}
});

test("tool records normalize legacy targets without copying argument objects or private rationale", () => {
	const projected = projectGatewayToolRecord({ text: "Skill", metadata: {
		tool_name: "Skill", call_id: "call", skill_name: "review", status: "completed",
		arguments: { name: "fallback", private: "argument-secret" }, rationale: "private-rationale",
		raw_payload: { private: "payload-secret" }, duration_s: 0.25,
	} });
	assert.equal(parseGatewayToolRecord(projected), projected);
	assert.equal(projected.target, "review");
	assert.equal(projected.status, "success");
	assert.equal(projected.duration_ms, 250);
	assert.deepEqual(projected, JSON.parse(JSON.stringify(projected)));
	assert.doesNotMatch(JSON.stringify(projected), /argument-secret|payload-secret|private-rationale|arguments|raw_payload/);
});

test("display records preserve whitespace, cancellation, mutation content, and explicit shell metrics", () => {
	const shell = projectGatewayToolRecord({ text: "Shell", metadata: {
		tool_name: "Shell", status: "done", exit_code: 7, shell_sequence: 3,
		display: { status: "cancelled", summary: "", detail: " leading\n", presentation: "shell", metrics: { shell_id: "sh", exit_code: 0, duration_ms: 50 } },
	} });
	assert.equal(shell.status, "cancelled");
	assert.equal(shell.detail_preview, " leading\n");
	assert.equal(shell.shell?.exit_code, 7);
	assert.equal(shell.shell?.shell_id, "sh");
	assert.equal(shell.shell?.sequence, 3);
	parseGatewayToolRecord(shell);
	assert.deepEqual(shell, JSON.parse(JSON.stringify(shell)));
	const write = projectGatewayToolRecord({ text: "Write", metadata: {
		tool_name: "Write", display: { status: "success", summary: "saved", detail: "  x\n", presentation: "mutation" },
	} });
	assert.equal(write.content_preview, "  x\n");
	assert.equal(write.content_line_count, 1);
	assert.equal(write.detail_preview, undefined);
	parseGatewayToolRecord(write);
});

test("normalized records bound every preview and reject nonfinite or invalid counts", () => {
	const projected = projectGatewayToolRecord({ text: "Shell", metadata: {
		tool_name: "Shell", call_id: "x".repeat(600), command_preview: "x".repeat(20_000),
		description: "x".repeat(20_000), shell_sequence: -1, exit_code: Infinity,
		duration_ms: NaN, output_chars: 0.5, display: {
			status: "success", summary: "x".repeat(20_000), detail: "x".repeat(20_000),
			error: "x".repeat(20_000), target: "x".repeat(20_000), omitted_chars: -1,
		},
	} });
	parseGatewayToolRecord(projected);
	assert.equal(projected.call_id?.length, 512);
	assert.equal(projected.target?.length, 8192);
	assert.equal(projected.detail_preview?.length, 8192);
	assert.equal(projected.shell?.command_preview?.length, 8192);
	assert.equal(projected.shell?.sequence, undefined);
	assert.equal(projected.shell?.exit_code, undefined);
	assert.equal(projected.shell?.output_chars, undefined);
	assert.equal(projected.duration_ms, undefined);
});

test("closed tool contracts reject unknown fields, wrong variants, bad numbers and oversized previews", () => {
	const valid: GatewayToolRecord = { version: 1, kind: "tool_execution", name: "Read", status: "success", mutating: false };
	for (const invalid of [
		{ ...valid, version: 2 }, { ...valid, status: "done" }, { ...valid, arguments: {} },
		{ ...valid, output_preview: "x".repeat(8193) }, { ...valid, duration_ms: -1 },
		{ ...valid, shell: { sequence: 0.5 } }, { ...valid, shell: { env: {} } },
	]) assert.throws(() => parseGatewayToolRecord(invalid), ContractValidationError);
	// @ts-expect-error Legacy status strings must be normalized before entering the contract.
	const invalidStatus: GatewayToolRecord = { ...valid, status: "done" };
	assert.equal(invalidStatus.status, "done");
});

test("a shell invocation return does not complete a process that is still running", () => {
	for (const process_state of ["running", "running_foreground", "running_background"]) {
		const record = gatewayToolLifecycleRecord("tool.complete", { name: "Shell", call_id: "call", process_state });
		assert.equal(record.status, "running");
		assert.equal(record.shell?.process_state, process_state);
	}
});

test("live direct and mirrored events validate tool identity and reject malformed typed records", () => {
	const params = { client_turn_id: "client", tool_id: "call", call_id: "call", name: "Read", context: "reading" };
	const tool_record = gatewayToolLifecycleRecord("tool.start", params);
	const direct = { jsonrpc: "2.0", method: "tool.start", params: { ...params, tool_record } };
	parseGatewayEvent(direct);
	for (const record of [{ ...tool_record, status: "bad" }, { ...tool_record, call_id: "other" }]) {
		assert.throws(() => parseGatewayEvent({ ...direct, params: { ...params, tool_record: record } }), ContractValidationError);
		assert.throws(() => parseGatewayEvent({ jsonrpc: "2.0", method: "runtime.event", params: {
			version: 1, sequence: 1, timestamp: 0, type: "tool.start", payload: { ...params, tool_record: record },
		} }), ContractValidationError);
	}
});

test("transcript RPC validates optional typed records while retaining version 1 legacy items", () => {
	const legacy = { id: "tool", type: "tool_summary", text: "Read", folded: false, metadata: {} };
	const result = { session_id: "session", items: [legacy], next_before: null };
	parseGatewayResult("transcript.load", result);
	parseGatewayResult("transcript.load", { ...result, items: [{ ...legacy, tool_record: projectGatewayToolRecord(legacy) }] });
	assert.throws(() => parseGatewayResult("transcript.load", { ...result, items: [{ ...legacy, tool_record: {} }] }), GatewayRpcValidationError);
});
