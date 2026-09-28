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

test("fresh and continued nested forks export original ancestry once within each fork boundary", async (t) => {
	const { store, begin, commit, finish, now } = await fixture(t);
	const addTool = (sessionId: string): void => {
		store.appendAssistantToolCalls({ sessionId, clientTurnId: "same", assistantText: "Inspect.",
			calls: [{ callId: "same-call", name: "Read", argumentsJson: "{}" }] });
		store.appendToolResult({ sessionId, clientTurnId: "same", summary: "Read", result: {
			callId: "same-call", toolName: "Read", success: true, output: `${sessionId} result`,
		} });
	};
	begin("same"); commit("same", 1); addTool("session"); finish("same");
	for (let index = 0; index < 600; index++) store.appendDisplayActivity({ sessionId: "session", turnId: "same",
		eventId: `display-${index}`, activityType: "status", text: "Telemetry", createdAt: now() });
	store.appendEvent({ schemaVersion: 1, sessionId: "session", eventId: "compact", eventType: "compaction", modelVisible: false,
		createdAt: now(), payload: { windowId: "window", sourceProviderIndex: 4, summary: "Compressed ancestor",
			replacement: [{ type: "user", text: "Compressed ancestor" }] } });
	store.forkSession({ sourceSessionId: "session", targetSessionId: "child" });
	const fresh = await collect(store, { sessionId: "child" });
	assert.equal(fresh.report.turns, 1);
	assert.equal(fresh.report.tool_calls, 1);
	assert.equal(fresh.conversation.messages.filter((message) => message.content === "inspect").length, 1);
	assert.ok(fresh.conversation.messages.some((message) => message.content === "Final response."));
	assert.doesNotMatch(fresh.raw, /Compressed ancestor|Telemetry/);
	begin("excluded"); commit("excluded", 1, { permissionContext: "Excluded late root context" }); finish("excluded");
	begin("same", "child"); commit("same", 1, { sessionId: "child" }); addTool("child"); finish("same", "child");
	store.forkSession({ sourceSessionId: "child", targetSessionId: "grandchild" });
	begin("excluded-child", "child"); commit("excluded-child", 1, { sessionId: "child", permissionContext: "Excluded late child context" }); finish("excluded-child", "child");
	const nested = await collect(store, { sessionId: "grandchild" });
	assert.equal(nested.report.turns, 2, "reused turn ids belong to different sessions");
	assert.equal(nested.conversation.messages.filter((message) => message.content === "inspect").length, 2);
	assert.equal(nested.conversation.messages.filter((message) => message.content === "Final response.").length, 2);
	assert.equal(nested.conversation.messages.filter((message) => message.role === "system").length, 1);
	assert.equal(nested.conversation.tools.length, 1);
	const calls = nested.conversation.messages.flatMap((message) => message.role === "assistant" ? message.tool_calls ?? [] : []);
	const results = nested.conversation.messages.filter((message) => message.role === "tool");
	assert.equal(calls.length, 2);
	assert.notEqual(calls[0]!.id, calls[1]!.id);
	assert.deepEqual(results.map((message) => message.tool_call_id), calls.map((call) => call.id));
	assert.doesNotMatch(nested.raw, /Excluded late|Compressed ancestor|Telemetry/);
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

test("a fork of legacy history introduces known child instructions only at the child boundary", async (t) => {
	const { store, begin, commit, finish } = await fixture(t);
	begin("legacy"); finish("legacy");
	store.forkSession({ sourceSessionId: "session", targetSessionId: "child" });
	const fresh = await collect(store, { sessionId: "child" });
	assert.deepEqual(fresh.conversation.messages, [{ role: "user", content: "inspect" }, { role: "assistant", content: "Final response." }]);
	assert.deepEqual(fresh.report.warnings, ["initial_context_unavailable"]);
	begin("child-turn", "child"); commit("child-turn", 1, { sessionId: "child" }); finish("child-turn", "child");
	const continued = await collect(store, { sessionId: "child" });
	assert.deepEqual(continued.conversation.messages.slice(0, 2), fresh.conversation.messages);
	assert.deepEqual(continued.conversation.messages[2], { role: "system", content: INSTRUCTIONS.content });
	assert.equal(continued.conversation.messages.filter((message) => message.content === "inspect").length, 2);
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
	const begin = (turnId: string, sessionId = "session"): void => { store.reserveTurn({ sessionId, turnId, clientTurnId: turnId, clientUserMessageId: `${turnId}:user`, requestFingerprint: `sha256:${"a".repeat(64)}`, userText: "inspect", workspaceRoot: root, threadId: sessionId, startedAt: now() }); };
	const commit = (turnId: string, providerStep: number, options: { readonly history?: readonly CanonicalConversationItem[]; readonly permissionContext?: string; readonly sessionId?: string } = {}) => commitRuntimeProviderStep({
		sessionId: options.sessionId ?? "session", turnId, providerStep, requestConfig: { provider: "openai", protocol: "responses", model: "test-model" },
		instructionSnapshot: { ...INSTRUCTIONS, snapshotId: `${options.sessionId ?? "session"}:instructions` },
		tools: [TOOL], history: options.history ?? store.loadConversationItems(options.sessionId ?? "session"), currentUserRequest: "inspect", sources: { permissionContext: options.permissionContext ?? "Original permission rules." },
		ledger: store.modelInputLedger, maxPromptTokens: 100_000, clock: now,
	});
	const finish = (turnId: string, sessionId = "session"): void => { store.turnTerminalizations.terminalize({ kind: "completed", sessionId, clientTurnId: turnId, assistantText: "Final response.", usage: {}, completedAt: now() }); };
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
