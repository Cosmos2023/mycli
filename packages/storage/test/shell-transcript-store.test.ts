import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	SQLiteSessionStore,
} from "../src/index.ts";

test("upserts one stable bounded shell history snapshot", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SQLiteSessionStore({
		dbPath: join(root, "sessions.db"),
		clock: () => "2026-08-05T00:00:00.000Z",
	});
	t.after(() => store.close());
	store.reserveTurn({
		sessionId: "session-a",
		clientTurnId: "client-a",
		clientUserMessageId: "client-a",
		turnId: "turn-a",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: root,
		threadId: "thread-a",
		userText: "run tests",
		startedAt: "2026-08-05T00:00:00.000Z",
	});

	store.upsertShellSnapshot({
		sessionId: "session-a",
		callId: "call-shell-1",
		shellId: "a1b2c3d4",
		payload: {
			command_preview: "npm test",
			process_state: "running_background",
			background: true,
			tty: false,
			yielded: true,
			output: "x".repeat(SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS + 100),
			provider_secret: "must-not-persist",
		},
	});
	store.upsertShellSnapshot({
		sessionId: "session-a",
		callId: "call-shell-1",
		shellId: "a1b2c3d4",
		payload: {
			command_preview: "npm test",
			process_state: "completed",
			terminal_state: "completed",
			exit_code: 0,
			background: true,
			tty: false,
			yielded: true,
			output: "done\n",
		},
	});

	const shellRows = store.loadHistoryItems("session-a")
		.filter((item) => item.type === "shell_session");
	assert.equal(shellRows.length, 1);
	assert.equal(shellRows[0]?.id, "shell:call-shell-1:a1b2c3d4");
	assert.equal(shellRows[0]?.call_id, "call-shell-1");
	assert.equal(shellRows[0]?.tool_name, "Shell");
	assert.deepEqual(shellRows[0]?.metadata, {
		background: true,
		command_preview: "npm test",
		exit_code: 0,
		output: "done\n",
		process_state: "completed",
		shell_id: "a1b2c3d4",
		terminal_state: "completed",
		tty: false,
		yielded: true,
	});
	assert.equal(JSON.stringify(shellRows).includes("must-not-persist"), false);
});

test("bounds retained shell output and records omitted characters", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db") });
	t.after(() => store.close());
	store.reserveTurn({
		sessionId: "session-a",
		clientTurnId: "client-a",
		clientUserMessageId: "client-a",
		turnId: "turn-a",
		requestFingerprint: `sha256:${"b".repeat(64)}`,
		workspaceRoot: root,
		threadId: "thread-a",
		userText: "run tests",
		startedAt: "2026-08-05T00:00:00.000Z",
	});
	const output = "x".repeat(SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS + 123);

	store.upsertShellSnapshot({
		sessionId: "session-a",
		callId: "call-shell-1",
		shellId: "a1b2c3d4",
		payload: {
			command_preview: "npm test",
			process_state: "running_background",
			background: true,
			tty: false,
			yielded: true,
			output,
		},
	});

	const row = store.loadHistoryItems("session-a")
		.find((item) => item.type === "shell_session");
	const metadata = row?.metadata as Readonly<Record<string, unknown>> | undefined;
	assert.equal(String(metadata?.output).length, SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS);
	assert.equal(metadata?.omitted_output_chars, 123);
});
