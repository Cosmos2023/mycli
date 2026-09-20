import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readErrorContext } from "@mycli/contracts";
import { appendFatalTuiDiagnostic, fatalTuiErrorContext } from "../../src/platform/fatal-error.ts";

test("fatal TUI diagnostics are private, bounded, and redacted", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-fatal-"));
	t.after(async () => rm(homeDir, { recursive: true, force: true }));
	const secret = "sk-abcdefghijklmnop";
	const transcriptText = "private transcript content must not be copied";
	const error = new Error(`render failed apiKey=${secret} Authorization: Bearer private-bearer`);
	error.stack = [
		`Error: render failed apiKey=${secret}`,
		"    at render (/workspace/tui.ts:10:2)",
	].join("\n");

	const logPath = appendFatalTuiDiagnostic(error, {
		homeDir,
		now: () => new Date("2026-08-24T00:00:00.000Z"),
	});

	assert.equal(logPath, join(homeDir, ".mycli", "logs", "tui-errors.log"));
	const file = await stat(logPath!);
	if (process.platform !== "win32") assert.equal(file.mode & 0o777, 0o600);
	const content = await readFile(logPath!, "utf8");
	assert.doesNotMatch(content, new RegExp(secret, "u"));
	assert.doesNotMatch(content, /private-bearer/u);
	assert.doesNotMatch(content, new RegExp(transcriptText, "u"));
	assert.match(content, /\[REDACTED\]/u);
	assert.match(content, /2026-08-24T00:00:00\.000Z/u);
});

test("fatal TUI diagnostics do not serialize unrelated transcript state", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-fatal-"));
	t.after(async () => rm(homeDir, { recursive: true, force: true }));
	const transcriptText = "private transcript content must not be copied";

	const logPath = appendFatalTuiDiagnostic(new Error("render failed"), { homeDir });
	const content = await readFile(logPath!, "utf8");

	assert.doesNotMatch(content, new RegExp(transcriptText, "u"));
	const record = JSON.parse(content) as Readonly<Record<string, unknown>>;
	assert.deepEqual(Object.keys(record).sort(), ["error_context", "message", "name", "stack", "timestamp"]);
	assert.equal(readErrorContext(record.error_context)?.reason, "tui.render_failed");
});

test("gateway close diagnostics retain the session, backend code, and original client error", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-gateway-close-"));
	t.after(async () => rm(homeDir, { recursive: true, force: true }));
	const path = appendFatalTuiDiagnostic(new Error("Gateway input closed."), {
		homeDir, sessionId: "session-1", diagnosticCode: "gateway_overloaded",
	});
	assert.ok(path);
	const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	assert.equal(record.session_id, "session-1");
	assert.equal(record.diagnostic_code, "gateway_overloaded");
	assert.equal(record.message, "Gateway input closed.");
	assert.equal(readErrorContext(record.error_context)?.reason, "gateway.output_capacity_exceeded");
});

test("fatal classification preserves known connection causes and keeps unknown disconnects conservative", () => {
	for (const [code, reason] of [
		["gateway_output_stalled", "transport.output_stalled"],
		["node_backend_worker_failed", "runtime.worker_exited"],
		["future_disconnect", "transport.gateway_disconnected"],
	] as const) {
		const context = fatalTuiErrorContext("connection", code);
		assert.equal(context.reason, reason);
		assert.deepEqual(context.outcome, { state: "unknown", effects: "possible" });
	}
});
