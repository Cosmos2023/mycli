import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectTerminalInteraction } from "@mycli/contracts";
import { projectTranscript, SQLiteSessionStore, SQLiteTranscriptEventRepository } from "../../src/index.ts";

for (const Store of [SQLiteSessionStore, SQLiteTranscriptEventRepository]) {
	test(`${Store.name} preserves only explicit safe terminal previews across restart`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "mycli-terminal-history-"));
		const options = { dbPath: join(root, "sessions.db"), clock: (): string => "2026-09-09T00:00:00Z" };
		let store = new Store(options);
		t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
		store.reserveTurn({ sessionId: "session-1", clientTurnId: "client-1", clientUserMessageId: "user-1",
			turnId: "turn-1", requestFingerprint: `sha256:${"a".repeat(64)}`, workspaceRoot: root,
			threadId: "thread-1", userText: "Interact with the terminal.", startedAt: options.clock() });
		const interaction = { shell_id: "shell-1", kind: "input", input_preview: '"token=private-input"',
			command_preview: "node wait.cjs", interaction_succeeded: true, process_running: true,
			private_field: "private-detail" };
		const calls = ["explicit", "legacy", "malformed"].map((callId) => ({ callId, name: "WriteStdin",
			argumentsJson: JSON.stringify({ session_id: "shell-1", chars: "legacy-private-input\n" }) }));
		store.appendAssistantToolCalls({ sessionId: "session-1", clientTurnId: "client-1", assistantText: "", calls });
		for (const call of calls) {
			store.appendToolResult({ sessionId: "session-1", clientTurnId: "client-1",
				result: { callId: call.callId, toolName: call.name, output: "Shell is running", success: true },
				summary: "Shell is running",
				metadata: { raw_input: "private-detail", ...(call.callId === "explicit" ? { terminal_interaction: interaction }
					: call.callId === "malformed" ? { terminal_interaction: { ...interaction, kind: "unknown" } } : {}) } });
		}
		store.close();
		store = new Store(options);
		const readable = "loadReadableTranscript" in store ? store.loadReadableTranscript("session-1")
			: projectTranscript(store.loadHistoryItems("session-1"), store.loadTurnRollouts("session-1"));
		assert.deepEqual(readable.find((item) => item.call_id === "explicit")?.metadata?.terminal_interaction,
			projectTerminalInteraction(interaction));
		assert.equal(readable.find((item) => item.call_id === "legacy")?.metadata?.terminal_interaction, undefined);
		assert.equal(readable.find((item) => item.call_id === "malformed")?.metadata?.terminal_interaction, undefined);
		assert.doesNotMatch(JSON.stringify(readable), /private-input|private-detail|private_field|raw_input/u);
	});
}
