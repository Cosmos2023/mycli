import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelInputSha256 } from "@mycli/core";
import type { CanonicalConversationItem, InstructionSnapshot, ToolDefinition } from "@mycli/core";
import { openRuntimeSessionStore, StorageFailure } from "@mycli/storage";
import { commitRuntimeProviderStep } from "../../src/context/model-input-pipeline.ts";
import { exportSessionTrainingData } from "../../src/sessions/training/export.ts";
import type { SessionTrainingExportOptions, TrainingExportStore } from "../../src/sessions/training/export.ts";
import type { SessionTrainingConversation } from "../../src/sessions/training/types.ts";

const TOOL: ToolDefinition = { id: "Read", name: "Read", description: "Read input.", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } };
const INSTRUCTIONS: InstructionSnapshot = { snapshotId: "instructions", version: "1", source: "test", content: "Original system prompt.", contentSha256: modelInputSha256("Original system prompt."), createdAt: "2026-09-15T00:00:00.000Z" };

test("one conversation preserves each message once across provider steps and compaction", async (t) => {
	const { store, begin, commit, finish, now } = await fixture(t);
	begin("turn"); commit("turn", 1);
	const thought = "Stored thought.\n".repeat(1500);
	const images = [{ mediaType: "image/png" as const, data: "aW1hZ2U=", detail: "original" as const }];
	store.appendAssistantToolCalls({ sessionId: "session", clientTurnId: "turn", assistantText: "Inspect.",
		calls: [{ callId: "image", name: "Read", argumentsJson: '{"file_path":"x","api_key":"secret-value"}' }],
		providerState: { provider: "deepseek", value: { thinkingBlocks: [{ thinking: thought, thinkingSignature: "opaque-secret" }] } },
	});
	store.appendToolResult({ sessionId: "session", clientTurnId: "turn", summary: "Display preview", result: { callId: "image", toolName: "Read", success: false, output: "Partial result.", images } });
	for (let index = 0; index < 2010; index++) store.appendDisplayActivity({ sessionId: "session", turnId: "turn", eventId: `display-${index}`, activityType: "status", text: "Telemetry", createdAt: now() });
	commit("turn", 2, { permissionContext: "Updated permission rules." }); finish("turn");
	store.appendEvent({ schemaVersion: 1, sessionId: "session", eventId: "compaction", turnId: "manual-compaction", eventType: "compaction", modelVisible: false, createdAt: now(),
		payload: { windowId: "window", sourceProviderIndex: 2, summary: "Summary", replacement: store.loadConversationItems("session") } });
	begin("next"); commit("next", 1, { history: [{ type: "user", text: "Stored compacted summary." }, { type: "user", text: "inspect" }] }); finish("next");
	let reconstructions = 0;
	const view: TrainingExportStore = { loadEventWindow: store.loadEventWindow.bind(store), modelInputLedger: {
		listProviderRequestReferences: store.modelInputLedger.listProviderRequestReferences.bind(store.modelInputLedger),
		loadProviderRequestManifest: store.modelInputLedger.loadProviderRequestManifest.bind(store.modelInputLedger),
		loadToolSetSnapshot: store.modelInputLedger.loadToolSetSnapshot.bind(store.modelInputLedger),
		loadModelContextEvents: store.modelInputLedger.loadModelContextEvents.bind(store.modelInputLedger),
		reconstructProviderStep: (id) => { reconstructions++; return store.modelInputLedger.reconstructProviderStep(id); },
	} };
	const { conversation, raw, report } = await collect(view, { secrets: ["aW1hZ2U="] });
	assert.equal(raw.trimEnd().split("\n").length, 1);
	assert.equal(reconstructions, 1);
	assert.deepEqual(Object.keys(conversation), ["schema_version", "source", "messages", "tools"]);
	assert.equal(conversation.messages.filter((message) => message.role === "system").length, 1);
	assert.equal(conversation.tools.length, 1);
	assert.equal(report.turns, 2);
	assert.equal(report.tool_calls, 1); assert.equal(report.tool_results, 1); assert.equal(report.images, 1); assert.equal(report.reasoning_blocks, 1);
	assert.equal(conversation.messages.filter((message) => message.content === "inspect").length, 2, "actual repeated user messages survive");
	assert.equal(conversation.messages.filter((message) => message.content === "Final response.").length, 2);
	const assistant = conversation.messages.find((message) => message.role === "assistant" && message.tool_calls);
	assert.ok(assistant?.role === "assistant");
	assert.equal(assistant.reasoning?.[0]?.text, thought);
	const result = conversation.messages.find((message) => message.role === "tool");
	assert.ok(result?.role === "tool" && result.is_error);
	assert.deepEqual(result.images, images); assert.equal(result.tool_call_id, assistant.tool_calls?.[0]?.id);
	assert.doesNotMatch(raw, /Telemetry|Display preview|opaque-secret|secret-value|Stored compacted summary/);
	assert.ok(conversation.messages.some((message) => message.content.includes("Updated permission rules.")));
	assert.ok(Buffer.byteLength(raw) < 100_000);
});

test("interrupted, rolled-back and legacy messages survive without matching request/response samples", async (t) => {
	const { store, begin, commit, finish, now } = await fixture(t);
	begin("done"); commit("done", 1); finish("done");
	store.appendEvent({ schemaVersion: 1, sessionId: "session", eventId: "rollback", eventType: "rollback", modelVisible: false, createdAt: now(), payload: { removedTurnIds: ["done"], reason: "user_requested" } });
	begin("stopped");
	store.appendAssistantToolCalls({ sessionId: "session", clientTurnId: "stopped", assistantText: "Starting.", calls: [{ callId: "incomplete", name: "Unknown", argumentsJson: '{"started":true}' }] });
	store.turnTerminalizations.terminalize({ kind: "failed", sessionId: "session", clientTurnId: "stopped", code: "interrupted", message: "Stopped", completedAt: now() });
	const result = await collect(store);
	assert.equal(result.report.turns, 2);
	assert.ok(result.conversation.messages.some((message) => message.content === "Final response."));
	assert.ok(result.conversation.messages.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.function.name === "Unknown"));
	assert.equal(result.report.tool_calls, 1);
});

test("an inherited fork prefix is emitted once and subsequent local history is appended once", async (t) => {
	const { store, begin, commit, finish } = await fixture(t);
	begin("fork");
	commit("fork", 1, { history: [{ type: "user", text: "Inherited question" }, { type: "assistant", text: "Inherited answer" }, { type: "user", text: "inspect" }] }); finish("fork");
	const { conversation } = await collect(store);
	for (const text of ["Inherited question", "Inherited answer", "inspect", "Final response."]) assert.equal(conversation.messages.filter((message) => message.content === text).length, 1);
});

test("empty or missing-ledger sessions export valid conversation rows without inventing prompts", async (t) => {
	const { store, begin } = await fixture(t);
	assert.deepEqual((await collect(store)).conversation, { schema_version: 3, source: { session_id: "session" }, messages: [], tools: [] });
	begin("legacy");
	const result = await collect(store);
	assert.deepEqual(result.conversation.messages, [{ role: "user", content: "inspect" }]);
	assert.deepEqual(result.report.warnings, ["initial_context_unavailable"]);
	const ledger = store.modelInputLedger;
	const view: TrainingExportStore = { loadEventWindow: store.loadEventWindow.bind(store), modelInputLedger: {
		listProviderRequestReferences: () => [{ requestId: "missing", turnId: "legacy", providerStep: 1 }],
		loadModelContextEvents: ledger.loadModelContextEvents.bind(ledger), loadProviderRequestManifest: ledger.loadProviderRequestManifest.bind(ledger), loadToolSetSnapshot: ledger.loadToolSetSnapshot.bind(ledger),
		reconstructProviderStep: () => { throw new StorageFailure("private database detail"); },
	} };
	const broken = await collect(view);
	assert.deepEqual(broken.conversation.messages, result.conversation.messages);
	assert.doesNotMatch(JSON.stringify(broken), /private database detail/);
});

test("single-row streaming respects the initial transcript boundary and cancellation", async (t) => {
	const { store, begin, commit, finish, now } = await fixture(t);
	begin("turn"); commit("turn", 1); finish("turn");
	let raw = "", inserted = false;
	await exportSessionTrainingData(store, { sessionId: "session", signal: new AbortController().signal }, async (chunk) => {
		raw += chunk;
		if (!inserted) { inserted = true; store.appendEvent({ schemaVersion: 1, sessionId: "session", eventId: "late", turnId: "turn", eventType: "assistant_output", modelVisible: true, payload: { text: "Late output" }, createdAt: now() }); }
	});
	assert.doesNotMatch(raw, /Late output/);
	const controller = new AbortController(); let written = 0;
	await assert.rejects(exportSessionTrainingData(store, { sessionId: "session", signal: controller.signal }, async () => { written++; controller.abort(); }), { name: "AbortError" });
	assert.equal(written, 1);
});

test("reasoning display copies are deduplicated within their turn without dropping another turn's thought", async (t) => {
	const { store, begin, finish, now } = await fixture(t);
	begin("first");
	store.appendDisplayActivity({ sessionId: "session", turnId: "first", eventId: "first-thought", activityType: "reasoning", text: "Check the file.", createdAt: now() });
	finish("first");
	begin("second");
	store.appendDisplayActivity({ sessionId: "session", turnId: "second", eventId: "second-thought", activityType: "reasoning", text: "Check the file.", createdAt: now() });
	store.appendEvent({ schemaVersion: 1, sessionId: "session", turnId: "second", eventId: "second-answer", eventType: "assistant_output", modelVisible: true, createdAt: now(),
		payload: { text: "Checked.", providerState: { provider: "deepseek", value: { reasoningContent: "Check the file." } } } });
	finish("second");
	const { report, conversation } = await collect(store);
	assert.equal(report.reasoning_blocks, 2);
	assert.equal(conversation.messages.filter((message) => message.role === "assistant" && message.reasoning?.[0]?.text === "Check the file.").length, 2);
});

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "mycli-training-conversation-"));
	let tick = 0; const now = (): string => new Date(Date.parse("2026-09-15T00:00:00.000Z") + tick++).toISOString();
	const store = openRuntimeSessionStore({ dbPath: join(root, "sessions.db"), reconcileRuntimeState: false, clock: now });
	t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
	const begin = (turnId: string): void => { store.reserveTurn({ sessionId: "session", turnId, clientTurnId: turnId, clientUserMessageId: `${turnId}:user`, requestFingerprint: `sha256:${"a".repeat(64)}`, userText: "inspect", workspaceRoot: root, threadId: "session", startedAt: now() }); };
	const commit = (turnId: string, providerStep: number, options: { readonly history?: readonly CanonicalConversationItem[]; readonly permissionContext?: string } = {}) => commitRuntimeProviderStep({
		sessionId: "session", turnId, providerStep, requestConfig: { provider: "openai", protocol: "responses", model: "test-model" }, instructionSnapshot: INSTRUCTIONS,
		tools: [TOOL], history: options.history ?? store.loadConversationItems("session"), currentUserRequest: "inspect", sources: { permissionContext: options.permissionContext ?? "Original permission rules." },
		ledger: store.modelInputLedger, maxPromptTokens: 100_000, clock: now,
	});
	const finish = (turnId: string): void => { store.turnTerminalizations.terminalize({ kind: "completed", sessionId: "session", clientTurnId: turnId, assistantText: "Final response.", usage: {}, completedAt: now() }); };
	return { store, begin, commit, finish, now };
}

async function collect(store: TrainingExportStore, options: Partial<SessionTrainingExportOptions> = {}) {
	let raw = "";
	const report = await exportSessionTrainingData(store, { sessionId: "session", signal: new AbortController().signal, ...options }, async (chunk) => { raw += chunk; });
	assert.equal(report.bytes_written, Buffer.byteLength(raw));
	const conversation = JSON.parse(raw) as SessionTrainingConversation;
	assert.equal(conversation.messages.length, report.messages);
	return { conversation, raw, report };
}
