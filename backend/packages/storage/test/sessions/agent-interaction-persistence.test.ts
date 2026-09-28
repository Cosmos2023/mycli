import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectAgentInteraction, projectGatewayToolRecord } from "@mycli/contracts";
import { projectTranscript, SQLiteSessionStore, SQLiteTranscriptEventRepository } from "../../src/index.ts";
import { sanitizeTranscriptItem } from "../../src/projections/transcript-projector.ts";

for (const Store of [SQLiteSessionStore, SQLiteTranscriptEventRepository]) {
	test(`${Store.name} restores agent targets and explicit previews without exposing legacy messages`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "mycli-agent-history-"));
		const options = { dbPath: join(root, "sessions.db"), clock: (): string => "2026-09-28T00:00:00Z" };
		let store = new Store(options);
		t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
		store.reserveTurn({ sessionId: "session", clientTurnId: "client", clientUserMessageId: "user",
			turnId: "turn", requestFingerprint: `sha256:${"a".repeat(64)}`, workspaceRoot: root,
			threadId: "thread", userText: "Review permissions", startedAt: options.clock() });
		const interaction = { kind: "message", target: "/root/review", message_preview: "Look at permissions token=private-token",
			private_field: "private-field" };
		const calls = ["explicit", "legacy", "malformed", "pending"].map((callId) => ({ callId, name: "send_message",
			argumentsJson: JSON.stringify({ target: "review", message: "legacy-private-message" }) }));
		store.appendAssistantToolCalls({ sessionId: "session", clientTurnId: "client", assistantText: "", calls });
		for (const call of calls.filter((item) => item.callId !== "pending")) {
			store.appendToolResult({ sessionId: "session", clientTurnId: "client",
				result: { callId: call.callId, toolName: call.name, output: "Message queued", success: true }, summary: "Message queued",
				metadata: { raw_input: "private-field", ...(call.callId === "explicit" ? { agent_interaction: interaction }
					: call.callId === "malformed" ? { agent_interaction: { ...interaction, kind: "unknown" } } : {}) } });
		}
		store.close();
		store = new Store(options);
		const readable = "loadReadableTranscript" in store ? store.loadReadableTranscript("session")
			: projectTranscript(store.loadHistoryItems("session"), store.loadTurnRollouts("session"));
		for (const call of calls) {
			const item = readable.find((entry) => entry.call_id === call.callId);
			const expected = call.callId === "explicit" ? projectAgentInteraction(interaction) : { kind: "message", target: "review" };
			assert.deepEqual(item?.metadata?.agent_interaction, expected);
			const restored = sanitizeTranscriptItem(item);
			assert.deepEqual(restored?.metadata?.agent_interaction, expected);
			assert.deepEqual(projectGatewayToolRecord({ text: restored?.text ?? "", metadata: {
				...restored?.metadata, tool_name: restored?.tool_name,
			} }).agent_interaction, expected);
		}
		assert.doesNotMatch(JSON.stringify(readable), /private-token|private-field|legacy-private-message|raw_input/u);
	});
}
