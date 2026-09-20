import { removeFixtureDirectoryAfterTests } from "../fixtures/directory-cleanup.ts";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	SQLiteSessionStore,
} from "../../src/index.ts";

test("upserts one stable bounded shell history snapshot", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-history-"));
	removeFixtureDirectoryAfterTests(t, root);
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
	removeFixtureDirectoryAfterTests(t, root);
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

test("stores full shell output as append-only pages outside bounded history", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-output-pages-"));
	removeFixtureDirectoryAfterTests(t, root);
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db") });
	t.after(() => store.close());
	store.reserveTurn({
		sessionId: "session-a",
		clientTurnId: "client-a",
		clientUserMessageId: "client-a",
		turnId: "turn-a",
		requestFingerprint: `sha256:${"c".repeat(64)}`,
		workspaceRoot: root,
		threadId: "thread-a",
		userText: "print output",
		startedAt: "2026-08-11T00:00:00.000Z",
	});

	for (const [sequence, cursorStart, output, omittedBefore] of [
		[2, 0, "first\n", 0],
		[3, 6, "second\n", 0],
		[4, 20, "tail\n", 7],
	] as const) {
		store.upsertShellSnapshot({
			sessionId: "session-a",
			callId: "call-shell-1",
			shellId: "shell-a",
			payload: { command_preview: "printf", output, process_state: "running" },
			outputChunk: {
				sequence,
				cursorStart,
				cursorEnd: cursorStart + output.length,
				omittedBefore,
				output,
			},
		});
	}

	const first = store.loadShellOutputPage({
		sessionId: "session-a",
		shellId: "shell-a",
		callId: "call-shell-1",
		limitChars: 8,
	});
	assert.equal(first.available, true);
	assert.equal(first.complete, false);
	assert.equal(first.omittedChars, 7);
	assert.equal(first.outputChars, 25);
	assert.equal(first.chunks.map((chunk) => chunk.output).join(""), "first\n");
	assert.equal(first.nextAfterSequence, 2);

	const second = store.loadShellOutputPage({
		sessionId: "session-a",
		shellId: "shell-a",
		afterSequence: first.nextAfterSequence ?? 0,
		limitChars: 64,
	});
	assert.equal(second.nextAfterSequence, null);
	assert.deepEqual(second.chunks.map((chunk) => [chunk.sequence, chunk.omittedBefore, chunk.output]), [
		[3, 0, "second\n"],
		[4, 7, "tail\n"],
	]);

	const history = JSON.stringify(store.loadHistoryItems("session-a"));
	assert.equal(history.includes("first\\nsecond"), false);
	assert.equal(store.loadShellOutputPage({
		sessionId: "session-a",
		shellId: "missing",
	}).available, false);
});

test("rejects duplicate shell chunk sequences instead of overwriting output", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-output-append-only-"));
	removeFixtureDirectoryAfterTests(t, root);
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db") });
	t.after(() => store.close());
	store.reserveTurn({
		sessionId: "session-a",
		clientTurnId: "client-a",
		clientUserMessageId: "client-a",
		turnId: "turn-a",
		requestFingerprint: `sha256:${"d".repeat(64)}`,
		workspaceRoot: root,
		threadId: "thread-a",
		userText: "print output",
		startedAt: "2026-08-11T00:00:00.000Z",
	});
	const write = (output: string) => store.upsertShellSnapshot({
		sessionId: "session-a",
		callId: "call-shell-1",
		shellId: "shell-a",
		payload: { output },
		outputChunk: {
			sequence: 2,
			cursorStart: 0,
			cursorEnd: output.length,
			omittedBefore: 0,
			output,
		},
	});

	write("original");
	assert.throws(() => write("changed"), /persistence_error/u);
	assert.equal(store.loadShellOutputPage({
		sessionId: "session-a",
		shellId: "shell-a",
	}).chunks[0]?.output, "original");
});
