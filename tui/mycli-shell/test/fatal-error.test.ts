import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendFatalTuiDiagnostic } from "../src/fatal-error.ts";

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
	assert.equal(file.mode & 0o777, 0o600);
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
	assert.deepEqual(Object.keys(record).sort(), ["message", "name", "stack", "timestamp"]);
});
