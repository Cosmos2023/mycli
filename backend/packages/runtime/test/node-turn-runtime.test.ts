import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	NODE_RUNTIME_CONTEXT_DEFAULTS,
	type NodeRuntimeConfig,
} from "@mycli/config";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import type {
	CanonicalConversationItem,
	CanonicalMessage,
	CanonicalToolCall,
	FileMutationPreviewChange,
	HookRunnerContract,
	ProviderEvent,
	ProtocolId,
	ProviderRequest,
	QueueSnapshot,
	QueuedInput,
	RuntimeEvent,
	ShellLifecycleEvent,
	ToolDefinition,
} from "@mycli/core";
import { ProviderFailure, type ModelProvider } from "@mycli/providers";
import type {
	AppendAssistantToolCallsInput,
	AppendToolResultInput,
	AgentRuntimeCheckpoint,
	CompleteStoredTurnInput,
	FailStoredTurnInput,
	ReserveTurnInput,
	TurnStore,
	TurnReservation,
} from "@mycli/storage";
import { SQLiteTranscriptEventRepository, StorageFailure } from "@mycli/storage";
import {
	ASK_USER_QUESTION_TOOL_DEFINITION,
	EDIT_TOOL_DEFINITION,
	PATCH_TOOL_DEFINITION,
	READ_TOOL_DEFINITION,
	SHELL_TOOL_DEFINITION,
	TOOL_SEARCH_TOOL_DEFINITION,
	UPDATE_PLAN_TOOL_DEFINITION,
	WRITE_TOOL_DEFINITION,
	ToolRouter,
	type PreparedMutationGuard,
	type PreparedToolCall,
	type ToolExecutionResult,
	type ToolExecutionOptions,
	type ToolPreviewOptions,
	type ToolRouterContract,
} from "@mycli/tools";
import { ApprovalPolicy } from "../../tools/src/approval-policy.ts";
import {
	NodeTurnRuntime,
	ContextItemCoordinator,
	ProviderContinuationCoordinator,
	QueueCoordinator,
	type CompactInput,
	type CompactionCoordinatorContract,
	type CompactionResult,
	type ContextItemCoordinatorContract,
	type MemoryContextServiceContract,
	type NodeTurnRuntimeOptions,
	type PersistedProviderContinuation,
	type QueueCoordinatorStore,
	type RuntimeDiagnosticEvent,
} from "../src/index.ts";

const ASK_ARGUMENTS = JSON.stringify({
	question: "Which runtime?",
	options: [
		{ label: "Node" },
		{ label: "Python" },
	],
	header: "Runtime",
	multi_select: false,
});

test("runs unchanged provider and live-event contracts on the normalized turn store", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-normalized-runtime-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const store = new SQLiteTranscriptEventRepository({
		dbPath: join(root, "sessions.db"),
		clock: clockSequence(),
	});
	t.after(() => store.close());
	const trace: string[] = [];
	const requests: ProviderRequest[] = [];
	const liveEvents: RuntimeEvent[] = [];
	const runtime = createRuntime({
		store,
		provider: scriptedProvider(trace, requests, [[
			{ type: "text_delta", text: "Repository inspected." },
			{ type: "completed", responseId: "response-normalized" },
		]]),
		toolRouter: new SequencedRouter(trace),
		planTools: () => [],
	});

	const result = await runtime.submit(submission(), (event) => liveEvents.push(event), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.deepEqual(requests[0]?.items, [{ type: "user", text: "Read README.md" }]);
	assert.ok(liveEvents.findIndex((event) => event.type === "text_delta")
		< liveEvents.findIndex((event) => event.type === "turn_completed"));
	const completedEvent = liveEvents.find((event) => event.type === "turn_completed");
	assert.equal(
		completedEvent?.durationMs,
		Date.parse(result.completed_at!) - Date.parse(result.started_at),
	);
	assert.deepEqual(
		store.loadEventWindow("session-1", { limit: 20 }).events.map((event) => event.eventType),
		["user_input", "assistant_output", "display_activity", "turn_lifecycle"],
	);
	assert.deepEqual(store.loadConversationItems("session-1"), [
		{ type: "user", text: "Read README.md" },
		{ type: "assistant", text: "Repository inspected." },
	]);
});

test("persists hosted web search for resume while retaining provider-native replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-web-search-runtime-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const store = new SQLiteTranscriptEventRepository({
		dbPath: join(root, "sessions.db"),
		clock: clockSequence(),
	});
	t.after(() => store.close());
	const liveEvents: RuntimeEvent[] = [];
	const runtime = createRuntime({
		store,
		provider: scriptedProvider([], [], [[
			{ type: "web_search_started", callId: "ws-1" },
			{
				type: "web_search_completed",
				call: { callId: "ws-1", action: { type: "search", queries: ["mycli docs"] } },
			},
			{ type: "text_delta", text: "Found it." },
			{
				type: "provider_state",
				state: {
					provider: "openai",
					value: {
						responsesNativeItems: [{
							type: "web_search_call",
							id: "ws-1",
							status: "completed",
							action: { type: "search", queries: ["mycli docs"] },
						}],
					},
				},
			},
			{ type: "completed", responseId: "response-search" },
		]]),
		toolRouter: new SequencedRouter([]),
		planTools: () => [],
	});

	const result = await runtime.submit(submission(), (event) => liveEvents.push(event), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.deepEqual(liveEvents.filter((event) => event.type.startsWith("web_search")), [
		{ type: "web_search_started", callId: "ws-1" },
		{
			type: "web_search_completed",
			call: { callId: "ws-1", action: { type: "search", queries: ["mycli docs"] } },
		},
	]);
	const display = store.loadEventWindow("session-1", { limit: 20 }).events.find(
		(event) => event.eventType === "display_activity"
			&& event.payload.activityType === "web_search",
	);
	assert.ok(display && display.eventType === "display_activity");
	assert.equal(display.payload.callId, "ws-1");
	assert.equal(display.payload.status, "completed");
	assert.equal(display.payload.text, "mycli docs");
	assert.deepEqual(display.payload.metadata, {
		action_type: "search",
		queries: ["mycli docs"],
	});
	assert.deepEqual(store.loadConversationItems("session-1").at(-1), {
		type: "assistant",
		text: "Found it.",
		providerState: {
			provider: "openai",
			value: {
				responsesNativeItems: [{
					type: "web_search_call",
					id: "ws-1",
					status: "completed",
					action: { type: "search", queries: ["mycli docs"] },
				}],
			},
		},
	});
});

test("projects model output limits and cache intent into provider requests", async () => {
	const trace: string[] = [];
	const requests: ProviderRequest[] = [];
	const runtime = createRuntime({
		store: new FakeStore(trace),
		provider: scriptedProvider(trace, requests, [[
			{ type: "text_delta", text: "Done." },
			{ type: "completed", responseId: "response-options" },
		]]),
		toolRouter: new SequencedRouter(trace),
		planTools: () => [],
		runtimeConfig: config({ maxOutputTokens: 64, cacheRetention: "long" }),
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(requests[0]?.maxOutputTokens, 64);
	assert.equal(requests[0]?.sessionId, "session-1");
	assert.equal(requests[0]?.cacheRetention, "long");
	assert.equal(requests[0]?.webSearchMode, "live");
});

test("runs a mailbox-triggered turn without persisting a fabricated user message", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	queue.coordinator.enqueueInternalNotification({
		sessionId: "session-1",
		queueId: "mailbox-message-1",
		text: "<agent-mailbox>{\"kind\":\"message\"}</agent-mailbox>",
		source: "agent_mailbox",
	});
	const requests: ProviderRequest[] = [];
	const runtime = createRuntime({
		store,
		provider: scriptedProvider(trace, requests, [[
			{ type: "text_delta", text: "continued" },
			{ type: "completed", responseId: "resp-mailbox" },
		]]),
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	});

	const result = await runtime.submit({
		clientTurnId: "mailbox-turn",
		message: "",
		source: "agent_mailbox",
	}, () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(store.reservations[0]?.source, "agent_mailbox");
	assert.equal(store.items.some((item) => item.type === "user" && item.text === ""), false);
	assert.match(JSON.stringify(requests[0]?.items), /<agent-mailbox>/u);
});

test("loads and projects image attachments for a capable provider", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const loadedPaths: string[][] = [];
	const runtime = createRuntime({
		store,
		provider: scriptedProvider(trace, requests, [[
			{ type: "text_delta", text: "described" },
			{ type: "completed", responseId: "resp-image" },
		]]),
		toolRouter: new SequencedRouter(trace),
		loadLocalImages: (paths) => {
			loadedPaths.push([...paths]);
			return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
		},
	});

	const result = await runtime.submit({
		...submission(),
		localImages: ["/tmp/sample.png"],
	}, () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(loadedPaths, [["/tmp/sample.png"]]);
	assert.deepEqual(requests[0]?.items?.[0], {
		type: "user",
		text: "Read README.md",
		images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
	});
	assert.deepEqual(store.reservations[0]?.imagePaths, ["/tmp/sample.png"]);
});

test("fails before the provider request when image input is disabled", async () => {
	const store = new FakeStore([]);
	let providerCalls = 0;
	const runtime = createRuntime({
		store,
		provider: {
			stream: async function* () {
				providerCalls += 1;
				yield { type: "completed" } as const;
			},
		},
		toolRouter: new SequencedRouter([]),
		runtimeConfig: config({ supportsImages: false }),
	});

	const result = await runtime.submit({
		...submission(),
		localImages: ["/tmp/sample.png"],
	}, () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "unsupported_capability");
	assert.equal(providerCalls, 0);
});

test("injects dynamic memory after compaction and before fresh input without persisting it", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [[
		{ type: "text_delta", text: "done" },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const compacted: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "[compact-summary]\nEarlier work." },
		{ type: "user", text: "Read README.md" },
	];
	const memory = memoryContextFixture(trace);
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		compactionCoordinator: new ScriptedCompactionCoordinator(trace, [
			compactionResult("compressed", compacted),
		]),
		memoryContextService: memory.service,
		runtimeConfig: config({ memoryEnabled: true }),
	});

	const signal = new AbortController().signal;
	const result = await runtime.submit(submission(), () => {}, { signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(requests[0]?.items, [
		{ type: "user", text: "[compact-summary]\nEarlier work." },
		{ type: "user", text: "<memory-reference>\nnot current input\n</memory-reference>" },
		{ type: "user", text: "Read README.md" },
	]);
	assert.equal(store.items.some((item) => item.type === "user" && item.text.includes("memory-reference")), false);
	assert.deepEqual(memory.actions, ["Read README.md"]);
	assert.equal(memory.collectSignals[0], signal);
	assert.equal(trace.indexOf("complete") < trace.indexOf("memory:action"), true);
});

test("collects memory once and reuses it across provider tool steps", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[
			{ type: "text_delta", text: "done" },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const memory = memoryContextFixture(trace);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		memoryContextService: memory.service,
		runtimeConfig: config({ memoryEnabled: true }),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(memory.collectCalls, 1);
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(request.items?.filter((item) => (
			item.type === "user" && item.text.includes("memory-reference")
		)).length, 1);
	}
});

test("writes the terminal snapshot after durable completion and before memory actions", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const memory = memoryContextFixture(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "text_delta", text: "done" },
		{ type: "completed", responseId: "resp-final" },
	]]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		memoryContextService: memory.service,
		writeTerminalSnapshot: async () => { trace.push("snapshot"); },
		runtimeConfig: config({ memoryEnabled: true }),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.ok(trace.indexOf("complete") < trace.indexOf("snapshot"));
	assert.ok(trace.indexOf("snapshot") < trace.indexOf("memory:action"));
});

test("keeps a durably completed turn and skips memory when snapshot writing fails", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const memory = memoryContextFixture(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "completed", responseId: "resp-final" },
	]]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		memoryContextService: memory.service,
		writeTerminalSnapshot: async () => {
			trace.push("snapshot");
			throw new Error("private snapshot path");
		},
		runtimeConfig: config({ memoryEnabled: true }),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(trace.slice(-2), ["complete", "snapshot"]);
	assert.equal(trace.includes("memory:action"), false);
});

test("persists safe Responses continuation after canonical output and before reuse", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[
			{ type: "text_delta", text: "done" },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const continuation = continuationFixture(trace);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		providerContinuation: continuation.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(requests[0]?.previousResponseId, undefined);
	assert.equal(requests[1]?.previousResponseId, "resp-tools");
	assert.ok(trace.indexOf("persist:calls") < trace.indexOf("continuation:eligible:resp-tools"));
	assert.ok(trace.indexOf("continuation:eligible:resp-tools") < trace.indexOf("tool:call-1"));
	assert.ok(trace.indexOf("complete") < trace.indexOf("continuation:eligible:resp-final"));
	assert.equal(continuation.states.at(-1)?.eligible, true);
});

test("invalidates Responses continuation after terminal provider rejection", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const continuation = continuationFixture(trace);
	const provider: ModelProvider = {
		stream: () => failingProviderEvents(new ProviderFailure({
			code: "provider_error",
			message: "private rejection",
		})),
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		providerContinuation: continuation.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(continuation.states.at(-1)?.eligible, false);
	assert.equal(continuation.states.at(-1)?.failure_reason, "provider_rejected");
});

test("Chat uses canonical replay and records no eligible response continuation", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const continuation = continuationFixture(trace, {
		response_id: "resp-old",
		request_signature: "old",
		request_input: [],
		response_output: [],
		eligible: true,
		failure_reason: null,
		session_id: "session-1",
		protocol: "responses",
		model: "gpt-test",
		history_boundary: "turn-1",
	});
	const provider = scriptedProvider(trace, requests, [[
		{ type: "completed", responseId: "chat-1" },
	]]);

	await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		providerContinuation: continuation.coordinator,
		runtimeConfig: config({ protocol: "chat_completions" }),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(requests[0]?.previousResponseId, undefined);
	assert.equal(continuation.states.at(-1)?.eligible, false);
	assert.equal(continuation.states.at(-1)?.failure_reason, "chat_replay");
});

test("Chat replays canonically after approval even without a continuation coordinator", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [
		[
			{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson: WRITE_ARGUMENTS },
			{ type: "completed", responseId: "chat-tools" },
		],
		[{ type: "completed", responseId: "chat-final" }],
	]);
	const router = new SequencedRouter(trace);
	const approvals = approvalRuntimeFixture(trace, router, store);
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({ workspaceRoot: "/workspace", autoApproveMedium: false }),
		approvalCoordinator: approvals.coordinator,
		toolDefinitions: [WRITE_TOOL_DEFINITION],
		runtimeConfig: config({ protocol: "chat_completions" }),
	});
	await runtime.submit(submission(), () => {}, { signal: new AbortController().signal });
	await resolveApproval(runtime, {
		decisionId: "call-write",
		choice: "approve_once",
	}, () => {}, new AbortController().signal);

	assert.equal(requests[1]?.previousResponseId, undefined);
});

test("writes a recoverable snapshot after durable approval suspension", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson: WRITE_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);
	const router = new SequencedRouter(trace);
	const approvals = approvalRuntimeFixture(trace, router, store);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({ workspaceRoot: "/workspace", autoApproveMedium: false }),
		approvalCoordinator: approvals.coordinator,
		toolDefinitions: [WRITE_TOOL_DEFINITION],
		writeTerminalSnapshot: async () => { trace.push("snapshot"); },
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "in_progress");
	assert.ok(trace.indexOf("approval:suspend") < trace.indexOf("snapshot"));
});

test("memory_enabled=false bypasses runtime collection and explicit actions", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[{ type: "completed", responseId: "resp-final" }]]);
	const memory = memoryContextFixture(trace);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		memoryContextService: memory.service,
		runtimeConfig: config({ memoryEnabled: false }),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(memory.collectCalls, 0);
	assert.deepEqual(memory.actions, []);
});

test("failed turns do not run explicit memory actions", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const memory = memoryContextFixture(trace);
	const provider: ModelProvider = {
		stream: async function* () {
			yield await Promise.reject<ProviderEvent>(
				new ProviderFailure({ code: "provider_error", message: "failed" }),
			);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		memoryContextService: memory.service,
		runtimeConfig: config({ memoryEnabled: true }),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.deepEqual(memory.actions, []);
});

test("memory action failures do not rewrite an already completed provider turn", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[{ type: "completed", responseId: "resp-final" }]]);
	const memory = memoryContextFixture(trace, true);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		memoryContextService: memory.service,
		runtimeConfig: config({ memoryEnabled: true }),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(memory.actions, ["Read README.md"]);
	assert.equal(trace.filter((event) => event === "complete").length, 1);
	assert.equal(trace.includes("fail"), false);
});

test("persists and executes Read before continuing the same Responses turn", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "usage", usage: { input_tokens: 10, output_tokens: 2 } },
			{ type: "completed", responseId: "resp-tools-1" },
		],
		[
			{ type: "text_delta", text: "README inspected." },
			{ type: "usage", usage: { input_tokens: 5, output_tokens: 3 } },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const toolRouter = new FakeRouter(trace, successResult("call-1"));
	const checkpoints: AgentRuntimeCheckpoint[] = [];
	const backendLifecycle: ShellLifecycleEvent[] = [];
	const instance = createRuntime({
		store,
		provider,
		toolRouter,
		agentCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); },
		isMutatingTool: () => false,
		publishLifecycle: backendLifecycle.push.bind(backendLifecycle),
	});
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.deepEqual(trace, [
		"reserve",
		"provider:1",
		"persist:calls",
		"tool:call-1",
		"persist:result:call-1",
		"provider:2",
		"complete",
	]);
	assert.deepEqual(emitted.map((event) => event.type), [
		"turn_started",
		"message_complete",
		"provider_usage",
		"tool_call_accepted",
		"tool_execution_started",
		"tool_execution_completed",
		"text_delta",
		"message_complete",
		"provider_usage",
		"turn_completed",
	]);
	assert.equal(requests.length, 2);
	assert.equal(requests[1]?.previousResponseId, "resp-tools-1");
	assert.deepEqual(requests[1]?.items?.slice(-2), [
		{ type: "assistant_tool_calls", text: "", calls: [CALL], responseId: "resp-tools-1" },
		{ type: "tool_result", callId: "call-1", toolName: "Read", output: READ_OUTPUT, success: true },
	]);
	assert.deepEqual(result.result, {
		assistant_text: "README inspected.",
		response_id: "resp-final",
		usage: { input_tokens: 15, output_tokens: 5 },
	});
	assert.deepEqual(store.completions[0]?.lastTokenUsage, {
		input_tokens: 5,
		output_tokens: 3,
	});
	assert.equal(toolRouter.options?.ownerSessionId, "session-1");
	assert.equal(toolRouter.options?.ownerTurnId, "turn-1");
	assert.equal(toolRouter.options?.callId, "call-1");
	toolRouter.options?.publishLifecycle(shellLifecycleEvent());
	assert.deepEqual(backendLifecycle, [shellLifecycleEvent()]);
	assert.equal(emitted.some((event) => event.type === "shell_lifecycle"), false);
	assert.deepEqual(checkpoints, [
		{ kind: "provider_turn", committed: false, turnId: "turn-1" },
		{ kind: "provider_turn", committed: true, turnId: "turn-1" },
		{ kind: "tool_call", committed: false, turnId: "turn-1", callId: "call-1", mutating: false },
		{ kind: "tool_call", committed: true, turnId: "turn-1", callId: "call-1", mutating: false },
		{ kind: "provider_turn", committed: false, turnId: "turn-1" },
	]);
});

test("orders hooks tool persistence skill context and provider continuation", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[{ type: "completed", responseId: "resp-final" }],
	]);
	const hookRunner: HookRunnerContract = {
		run: async (input) => {
			trace.push(input.point);
			return [];
		},
	};
	const artifact = {
		kind: "skill_instructions" as const,
		name: "review",
		text: "instructions",
		sourceKind: "repo",
		contentSha256: "a".repeat(64),
		contentLength: 12,
	};
	const contextItemCoordinator = new ContextItemCoordinator({
		extractArtifact: (metadata) => metadata.artifact === artifact ? artifact : undefined,
	});
	const router = new FakeRouter(trace, {
		...successResult("call-1"),
		metadata: { artifact },
	});

	const result = await createRuntime({
		store,
		provider,
		toolRouter: router,
		hookRunner,
		contextItemCoordinator,
	}).submit(submission(), () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(trace.filter((entry) => [
		"user_prompt_submit",
		"provider:1",
		"pre_tool_use",
		"tool:call-1",
		"persist:result:call-1",
		"post_tool_use",
		"persist:context",
		"provider:2",
		"stop",
	].includes(entry)), [
		"user_prompt_submit",
		"provider:1",
		"pre_tool_use",
		"tool:call-1",
		"persist:result:call-1",
		"post_tool_use",
		"persist:context",
		"provider:2",
		"stop",
	]);
	assert.equal(
		store.items.find((item) => item.type === "context")?.text,
		"instructions",
	);
});

for (const action of ["deny", "error"] as const) {
	test(`pre-tool hook ${action} prevents execution and persists a failure`, async () => {
		const trace: string[] = [];
		const store = new FakeStore(trace);
		const router = new SequencedRouter(trace);
		const provider = scriptedProvider(trace, [], [
			[
				{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
				{ type: "completed", responseId: "resp-tools" },
			],
			[{ type: "completed", responseId: "resp-final" }],
		]);
		const hookRunner: HookRunnerContract = {
			run: async (input) => input.point === "pre_tool_use"
				? [{ hookId: "guard", result: { action, message: "blocked" } }]
				: [],
		};

		const result = await createRuntime({
			store,
			provider,
			toolRouter: router,
			hookRunner,
		}).submit(submission(), () => undefined, { signal: new AbortController().signal });

		assert.equal(result.status, "completed");
		assert.equal(router.calls, 0);
		assert.equal(store.toolResults[0]?.errorKind, action === "deny"
			? "tool_denied_by_hook"
			: "tool_hook_error");
	});
}

test("hook-modified arguments are schema revalidated before adapter execution", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	let adapterCalls = 0;
	const router = new ToolRouter({
		exposure: [READ_TOOL_DEFINITION],
		adapters: [{
			definition: READ_TOOL_DEFINITION,
			execute: async () => {
				adapterCalls += 1;
				return successResult("call-1");
			},
		}],
	});
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[{ type: "completed", responseId: "resp-final" }],
	]);
	const hookRunner: HookRunnerContract = {
		run: async (input) => input.point === "pre_tool_use"
			? [{ hookId: "modify", result: { action: "modify", arguments: { offset: 0 } } }]
			: [],
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: router,
		hookRunner,
	}).submit(submission(), () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(adapterCalls, 0);
	assert.equal(store.toolResults[0]?.errorKind, "invalid_arguments");
});

test("post-tool hook failure cannot rewrite a persisted successful result", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[{ type: "completed", responseId: "resp-final" }],
	]);
	const hookRunner: HookRunnerContract = {
		run: async (input) => input.point === "post_tool_use"
			? [{ hookId: "broken", result: { action: "error", message: "failed" } }]
			: [],
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new FakeRouter(trace, successResult("call-1")),
		hookRunner,
	}).submit(submission(), () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(store.toolResults.length, 1);
	assert.equal(store.toolResults[0]?.result.success, true);
});

test("persists provider replay state with tool calls before tool results", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const providerState = {
		provider: "openai" as const,
		value: { thinking: "checked", signature: "sig-test" },
	};
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "provider_state", state: providerState },
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools-1" },
		],
		[
			{ type: "text_delta", text: "done" },
			{ type: "completed", responseId: "resp-final" },
		],
	]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new FakeRouter(trace, successResult("call-1")),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(store.items.at(1), {
		type: "assistant_tool_calls",
		text: "",
		calls: [CALL],
		responseId: "resp-tools-1",
		providerState,
	});
	assert.equal(trace.indexOf("persist:calls") < trace.indexOf("persist:result:call-1"), true);
});

test("persists provider replay state with the final assistant output", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const events: RuntimeEvent[] = [];
	const providerState = {
		provider: "openai" as const,
		value: {
			responsesReasoningItems: [{
				type: "reasoning",
				summary: [],
				encrypted_content: "encrypted-final",
			}],
		},
	};
	const provider = scriptedProvider(trace, [], [[
		{ type: "provider_state", state: providerState },
		{
			type: "usage",
			usage: {
				input_tokens: 1_250,
				output_tokens: 80,
				total_tokens: 1_330,
				reasoning_tokens: 64,
			},
		},
		{ type: "text_delta", text: "done" },
		{ type: "completed", responseId: "resp-final" },
	]]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new FakeRouter(trace, successResult("unused")),
	}).submit(
		submission(),
		events.push.bind(events),
		{ signal: new AbortController().signal },
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(store.completions[0]?.providerState, {
		...providerState,
		tokenEstimate: 64,
	});
	assert.deepEqual(events.find((event) => event.type === "provider_usage"), {
		type: "provider_usage",
		usage: {
			input_tokens: 1_250,
			output_tokens: 80,
			total_tokens: 1_330,
			reasoning_tokens: 64,
		},
	});
});

test("runs Anthropic tool continuations through the shared runtime", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [
		[
			{
				type: "provider_state",
				state: {
					provider: "anthropic",
					value: { thinkingBlocks: [{ thinking: "checked", signature: "sig-test" }] },
				},
			},
			{ type: "tool_call", callId: "toolu-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed" },
		],
		[
			{ type: "text_delta", text: "done" },
			{ type: "completed" },
		],
	]);
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: new FakeRouter(trace, successResult("toolu-1")),
		runtimeConfig: config({
			provider: "anthropic",
			protocol: "anthropic_messages",
			model: "claude-test",
			apiBaseUrl: "https://api.anthropic.com",
			authRef: "anthropic",
			cacheRetention: "long",
		}),
	});

	const result = await runtime.submit(submission(), () => {}, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(requests.length, 2);
	assert.equal(requests[0]?.protocol, "anthropic_messages");
	assert.equal(requests[0]?.cacheRetention, "long");
	assert.equal(requests[1]?.previousResponseId, undefined);
	assert.equal(store.items.at(1)?.type, "assistant_tool_calls");
});

test("continues after a failed Read result and exposes the failure event", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools-1" },
		],
		[
			{ type: "text_delta", text: "The file was unavailable." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const failed = {
		...successResult("call-1"),
		success: false,
		modelOutput: "Read failed\nError kind: not_found",
		summary: "Failed to read README.md",
		errorKind: "not_found",
	};
	const emitted: RuntimeEvent[] = [];

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new FakeRouter(trace, failed),
	}).submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(emitted.some((event) => event.type === "tool_execution_failed"), true);
	assert.deepEqual(store.items.at(-2), {
		type: "tool_result",
		callId: "call-1",
		toolName: "Read",
		output: failed.modelOutput,
		success: false,
	});
});

test("emits a terminal tool lifecycle event when tool execution is interrupted", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);
	let executionStarted!: () => void;
	const started = new Promise<void>((resolve) => { executionStarted = resolve; });
	const toolRouter: ToolRouterContract = {
		execute: async (_call, options) => {
			executionStarted();
			await new Promise<void>((_resolve, reject) => {
				const abort = (): void => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				};
				if (options.signal.aborted) abort();
				else options.signal.addEventListener("abort", abort, { once: true });
			});
			throw new Error("unreachable");
		},
	};
	const emitted: RuntimeEvent[] = [];
	const controller = new AbortController();
	const pending = createRuntime({ store, provider, toolRouter }).submit(
		submission(),
		emitted.push.bind(emitted),
		{ signal: controller.signal },
	);
	await started;
	controller.abort();
	const result = await pending;

	assert.equal(result.status, "interrupted");
	const startIndex = emitted.findIndex((event) => event.type === "tool_execution_started");
	const failureIndex = emitted.findIndex((event) =>
		event.type === "tool_execution_failed" && event.errorKind === "tool_interrupted",
	);
	const turnIndex = emitted.findIndex((event) => event.type === "turn_interrupted");
	assert.ok(startIndex >= 0 && startIndex < failureIndex);
	assert.ok(failureIndex < turnIndex);
});

test("force interrupt terminalizes an abort-ignoring mutation as outcome unknown once", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-1", name: "Write", argumentsJson: WRITE_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);
	let executionStarted!: () => void;
	const started = new Promise<void>((resolve) => { executionStarted = resolve; });
	let releaseTool!: () => void;
	const released = new Promise<void>((resolve) => { releaseTool = resolve; });
	const toolRouter: ToolRouterContract = {
		execute: async () => {
			executionStarted();
			await released;
			return {
				callId: "call-1",
				toolName: "Write",
				success: true,
				modelOutput: "late output",
				summary: "Write completed late",
				metadata: {},
			};
		},
	};
	const emitted: RuntimeEvent[] = [];
	const controller = new AbortController();
	const runtime = createRuntime({
		store,
		provider,
		toolRouter,
		toolDefinitions: [WRITE_TOOL_DEFINITION],
	});
	const pending = runtime.submit(
		submission(),
		emitted.push.bind(emitted),
		{ signal: controller.signal },
	);
	await started;
	controller.abort();
	const interrupted = await runtime.forceInterrupt(
		{ clientTurnId: "client-1", turnId: "turn-1" },
		emitted.push.bind(emitted),
	);

	assert.equal(interrupted.status, "interrupted");
	assert.equal(store.loadTurn()?.status, "interrupted");
	assert.equal(
		emitted.filter((event) => event.type === "tool_execution_failed").length,
		1,
	);
	assert.equal(
		emitted.find((event) => event.type === "tool_execution_failed")?.errorKind,
		"effect_outcome_unknown",
	);
	assert.equal(
		emitted.filter((event) => event.type === "turn_interrupted").length,
		1,
	);
	const toolTerminalIndex = emitted.findIndex((event) => event.type === "tool_execution_failed");
	const turnTerminalIndex = emitted.findIndex((event) => event.type === "turn_interrupted");
	assert.ok(toolTerminalIndex >= 0 && toolTerminalIndex < turnTerminalIndex);

	releaseTool();
	const lateResult = await pending;
	assert.equal(lateResult.status, "interrupted");
	assert.equal(store.toolResults.length, 0);
	assert.equal(emitted.some((event) => event.type === "tool_execution_completed"), false);
	assert.equal(emitted.some((event) => event.type === "turn_failed"), false);
	assert.equal(
		emitted.filter((event) => event.type === "tool_execution_failed").length,
		1,
	);
});

test("does not misclassify an unexpected tool exception as a persistence failure", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);
	const toolRouter: ToolRouterContract = {
		execute: async () => { throw new Error("private tool detail"); },
	};

	const result = await createRuntime({ store, provider, toolRouter })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "provider_error");
	assert.deepEqual(result.result, { message: "provider request failed" });
});

test("continues beyond eight provider steps", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const steps = Array.from({ length: 9 }, (_, index): ProviderEvent[] => [
		{
			type: "tool_call",
			callId: `call-${index + 1}`,
			name: "Read",
			argumentsJson: READ_ARGUMENTS,
		},
		{ type: "completed", responseId: `resp-${index + 1}` },
	]);
	steps.push([
		{ type: "text_delta", text: "Finished after a long tool chain." },
		{ type: "completed", responseId: "resp-final" },
	]);
	const provider = scriptedProvider(trace, [], steps);
	const router = new SequencedRouter(trace);

	const result = await createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(trace.filter((item) => item.startsWith("provider:")).length, 10);
	assert.equal(router.calls, 9);
});

test("executes a provider batch above sixteen calls", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const calls = Array.from({ length: 17 }, (_, index): ProviderEvent => ({
		type: "tool_call",
		callId: `call-${index + 1}`,
		name: "Read",
		argumentsJson: READ_ARGUMENTS,
	}));
	const provider = scriptedProvider(trace, [], [
		[
			...calls,
			{ type: "completed", responseId: "resp-many-tools" },
		],
		[
			{ type: "text_delta", text: "All ranges inspected." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const router = new SequencedRouter(trace);

	const result = await createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(router.calls, 17);
	assert.equal(trace.includes("persist:calls"), true);
});

test("rejects duplicate call IDs before persistence or execution", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "completed", responseId: "resp-duplicate" },
	]]);
	const router = new SequencedRouter(trace);

	const result = await createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "tool_protocol_error");
	assert.equal(router.calls, 0);
	assert.equal(trace.includes("persist:calls"), false);
});

test("rejects a missing call ID before persistence or execution", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "", name: "Read", argumentsJson: READ_ARGUMENTS },
	]]);
	const router = new SequencedRouter(trace);

	const result = await createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "tool_protocol_error");
	assert.equal(router.calls, 0);
	assert.equal(trace.includes("persist:calls"), false);
});

test("rejects provider events emitted after completion", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "completed", responseId: "resp-final" },
		{ type: "text_delta", text: "late output" },
	]]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "provider_error");
	assert.equal(trace.includes("complete"), false);
});

test("executes multiple calls sequentially in provider order", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: "call-2", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[
			{ type: "text_delta", text: "Both ranges inspected." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(trace, [
		"reserve",
		"provider:1",
		"persist:calls",
		"tool:call-1",
		"persist:result:call-1",
		"tool:call-2",
		"persist:result:call-2",
		"provider:2",
		"complete",
	]);
});

test("executes safe tool phases concurrently and preserves provider result order around barriers", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new ControlledToolRouter(trace, new Set(["Read"]));
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-read-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: "call-read-2", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson: WRITE_ARGUMENTS },
			{ type: "tool_call", callId: "call-read-3", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[
			{ type: "text_delta", text: "All tools completed." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const running = createRuntime({
		store,
		provider,
		toolRouter: router,
		toolDefinitions: [READ_TOOL_DEFINITION, WRITE_TOOL_DEFINITION],
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	await router.waitForStarted(2);
	assert.deepEqual(router.startedCallIds, ["call-read-1", "call-read-2"]);
	router.release("call-read-2");
	assert.equal(store.toolResults.length, 0);
	router.release("call-read-1");

	await router.waitForStarted(3);
	assert.deepEqual(router.startedCallIds, ["call-read-1", "call-read-2", "call-write"]);
	assert.deepEqual(store.toolResults.map((entry) => entry.result.callId), ["call-read-1", "call-read-2"]);
	router.release("call-write");

	await router.waitForStarted(4);
	assert.deepEqual(router.startedCallIds, ["call-read-1", "call-read-2", "call-write", "call-read-3"]);
	router.release("call-read-3");

	const result = await running;
	assert.equal(result.status, "completed");
	assert.deepEqual(store.toolResults.map((entry) => entry.result.callId), [
		"call-read-1",
		"call-read-2",
		"call-write",
		"call-read-3",
	]);
});

test("executes allowed Shell calls concurrently with per-call sandbox authorization", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new ControlledToolRouter(trace, new Set(["Shell"]));
	const provider = scriptedProvider(trace, [], [[
		{
			type: "tool_call",
			callId: "call-shell-elevated",
			name: "Shell",
			argumentsJson: JSON.stringify({
				command: "printf elevated",
				sandbox_permissions: "require_escalated",
			}),
		},
		{
			type: "tool_call",
			callId: "call-shell-default",
			name: "Shell",
			argumentsJson: JSON.stringify({ command: "printf default" }),
		},
		{ type: "completed", responseId: "resp-shell-tools" },
	], [
		{ type: "text_delta", text: "Both commands completed." },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const running = createRuntime({
		store,
		provider,
		toolRouter: router,
		toolDefinitions: [SHELL_TOOL_DEFINITION],
		approvalPolicy: {
			evaluate: (call) => ({
				kind: "allow",
				callId: call.callId,
				toolName: call.name,
				preview: "Shell command allowed",
				reason: "Allowed for test.",
				...(call.callId === "call-shell-elevated"
					? { sandboxOverrideApproved: true }
					: {}),
			}),
		},
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	await router.waitForStarted(2);
	assert.deepEqual(router.startedCallIds, ["call-shell-elevated", "call-shell-default"]);
	assert.equal(
		router.executionOptionsByCallId.get("call-shell-elevated")?.sandboxOverrideApproved,
		true,
	);
	assert.equal(
		router.executionOptionsByCallId.get("call-shell-default")?.sandboxOverrideApproved,
		undefined,
	);
	router.release("call-shell-default");
	assert.equal(store.toolResults.length, 0);
	router.release("call-shell-elevated");

	const result = await running;
	assert.equal(result.status, "completed");
	assert.deepEqual(store.toolResults.map((entry) => entry.result.callId), [
		"call-shell-elevated",
		"call-shell-default",
	]);
});

test("isolates an ordinary failed result inside a successful parallel phase", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new ControlledToolRouter(trace, new Set(["Read"]));
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-read-failed", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: "call-read-success", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[
			{ type: "text_delta", text: "Handled both results." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const running = createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	await router.waitForStarted(2);
	router.release("call-read-success");
	router.releaseFailure("call-read-failed");
	const result = await running;

	assert.equal(result.status, "completed");
	assert.deepEqual(store.toolResults.map((entry) => [entry.result.callId, entry.result.success]), [
		["call-read-failed", false],
		["call-read-success", true],
	]);
});

test("interrupts every active call in a parallel tool phase exactly once", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new ControlledToolRouter(trace, new Set(["Read"]));
	const emitted: RuntimeEvent[] = [];
	const controller = new AbortController();
	const running = createRuntime({
		store,
		provider: scriptedProvider(trace, [], [[
			{ type: "tool_call", callId: "call-read-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: "call-read-2", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		]]),
		toolRouter: router,
	}).submit(submission(), (event) => { emitted.push(event); }, { signal: controller.signal });

	await router.waitForStarted(2);
	controller.abort();
	const result = await running;

	assert.equal(result.status, "interrupted");
	assert.equal(result.error_code, "interrupted");
	assert.equal(store.toolResults.length, 0);
	assert.deepEqual(emitted.filter((event) => event.type === "tool_execution_started").map(
		(event) => event.callId,
	), ["call-read-1", "call-read-2"]);
	assert.deepEqual(emitted.filter((event) => event.type === "tool_execution_failed").map(
		(event) => [event.callId, event.errorKind],
	), [
		["call-read-1", "tool_interrupted"],
		["call-read-2", "tool_interrupted"],
	]);
	assert.equal(emitted.some((event) => event.type === "tool_execution_completed"), false);
});

test("tracks parallel calls by their full ids when bounded event ids collide", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new ControlledToolRouter(trace, new Set(["Read"]));
	const emitted: RuntimeEvent[] = [];
	const controller = new AbortController();
	const sharedPrefix = "x".repeat(256);
	const runtime = createRuntime({
		store,
		provider: scriptedProvider(trace, [], [[
			{ type: "tool_call", callId: `${sharedPrefix}-1`, name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: `${sharedPrefix}-2`, name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		]]),
		toolRouter: router,
	});
	const running = runtime.submit(submission(), (event) => { emitted.push(event); }, {
		signal: controller.signal,
	});

	await router.waitForStarted(2);
	const interrupted = await runtime.forceInterrupt({
		clientTurnId: "client-turn-1",
		turnId: "turn-1",
	}, (event) => { emitted.push(event); });

	assert.equal(interrupted.status, "interrupted");
	assert.equal(emitted.filter((event) => event.type === "tool_execution_failed").length, 2);
	const settled = await running;
	assert.equal(settled.status, "interrupted");
	assert.equal(controller.signal.aborted, false);
	assert.equal(emitted.filter((event) => event.type === "tool_execution_failed").length, 2);
});

test("fails a parallel phase without persisting sibling results or duplicating terminal events", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new ControlledToolRouter(trace, new Set(["Read"]));
	const emitted: RuntimeEvent[] = [];
	const running = createRuntime({
		store,
		provider: scriptedProvider(trace, [], [[
			{ type: "tool_call", callId: "call-read-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: "call-read-2", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		]]),
		toolRouter: router,
	}).submit(submission(), (event) => { emitted.push(event); }, {
		signal: new AbortController().signal,
	});

	await router.waitForStarted(2);
	router.fail("call-read-1");
	const result = await running;

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "provider_error");
	assert.equal(store.toolResults.length, 0);
	assert.deepEqual(emitted.filter((event) => event.type === "tool_execution_failed").map(
		(event) => [event.callId, event.errorKind],
	), [
		["call-read-1", "tool_execution_failed"],
		["call-read-2", "tool_interrupted"],
	]);
	assert.equal(emitted.some((event) => event.type === "tool_execution_completed"), false);
});

test("flushes a safe phase before approval and preserves untouched remaining calls", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new SequencedRouter(trace, new Set(["Read"]));
	const approvals = approvalRuntimeFixture(trace, router, store);
	const result = await createRuntime({
		store,
		provider: scriptedProvider(trace, [], [[
			{ type: "tool_call", callId: "call-read-before", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson: WRITE_ARGUMENTS },
			{ type: "tool_call", callId: "call-read-after", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		]]),
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({ workspaceRoot: "/workspace", autoApproveMedium: false }),
		approvalCoordinator: approvals.coordinator,
		toolDefinitions: [READ_TOOL_DEFINITION, WRITE_TOOL_DEFINITION],
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "in_progress");
	assert.deepEqual(store.toolResults.map((entry) => entry.result.callId), ["call-read-before"]);
	assert.equal(approvals.pending()?.decisionId, "call-write");
	assert.deepEqual(approvals.pending()?.remainingCalls.map((call) => call.callId), ["call-read-after"]);
	assert.ok(trace.indexOf("persist:result:call-read-before") < trace.indexOf("approval:suspend"));
	assert.equal(trace.includes("tool:call-read-after"), false);
});

test("persists a structured plan update before emitting its runtime event", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{
				type: "tool_call",
				callId: "call-plan",
				name: "update_plan",
				argumentsJson: JSON.stringify({
					plan: [{ step: "Wire runtime", status: "in_progress" }],
				}),
			},
			{ type: "completed", responseId: "resp-plan" },
		],
		[
			{ type: "text_delta", text: "Plan recorded." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const router: ToolRouterContract = {
		execute: async (call) => ({
			callId: call.callId,
			toolName: call.name,
			success: true,
			modelOutput: "Plan updated.",
			summary: "Updated plan with 1 steps",
			metadata: {},
			planUpdate: {
				explanation: "Start implementation",
				items: [{ id: "step-1", text: "Wire runtime", status: "in_progress" }],
			},
		}),
	};
	const emitted: RuntimeEvent[] = [];

	const result = await createRuntime({
		store,
		provider,
		toolRouter: router,
		toolDefinitions: [UPDATE_PLAN_TOOL_DEFINITION],
	}).submit(submission(), (event) => {
		trace.push(`event:${event.type}`);
		emitted.push(event);
	}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(store.toolResults[0]?.planUpdate, {
		explanation: "Start implementation",
		items: [{ id: "step-1", text: "Wire runtime", status: "in_progress" }],
	});
	assert.ok(trace.indexOf("persist:result:call-plan") < trace.indexOf("event:plan_updated"));
	assert.deepEqual(emitted.find((event) => event.type === "plan_updated"), {
		type: "plan_updated",
		explanation: "Start implementation",
		items: [{ id: "step-1", text: "Wire runtime", status: "in_progress" }],
	});
});

test("exposes deferred tools only after a durable tool_search activation", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const continuation = continuationFixture(trace);
	const deferred: ToolDefinition = Object.freeze({
		id: "plugin:docs:search",
		name: "docs_search",
		description: "Search documents",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({ query: Object.freeze({ type: "string" }) }),
			required: Object.freeze(["query"]),
			additionalProperties: false,
		}),
	});
	const provider = scriptedProvider(trace, requests, [
		[
			{ type: "tool_call", callId: "call-search", name: "tool_search", argumentsJson: '{"query":"docs"}' },
			{ type: "completed", responseId: "resp-search" },
		],
		[
			{ type: "tool_call", callId: "call-docs", name: "docs_search", argumentsJson: '{"query":"runtime"}' },
			{ type: "completed", responseId: "resp-docs" },
		],
		[
			{ type: "text_delta", text: "Found it." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const router: ToolRouterContract = {
		execute: async (call) => {
			trace.push(`tool:${call.callId}`);
			return call.name === "tool_search"
				? {
					callId: call.callId,
					toolName: call.name,
					success: true,
					modelOutput: '{"tools":[{"name":"docs_search"}]}',
					summary: "Activated 1 deferred tool",
					metadata: {},
					toolActivation: { names: ["docs_search"] },
				}
				: {
					callId: call.callId,
					toolName: call.name,
					success: true,
					modelOutput: "Document result",
					summary: "Searched documents",
					metadata: {},
				};
		},
	};
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: router,
		toolDefinitions: [TOOL_SEARCH_TOOL_DEFINITION],
		deferredTools: [deferred],
		loadToolActivations: () => store.toolResults.flatMap(
			(result) => result.toolActivation?.names ?? [],
		),
		providerContinuation: continuation.coordinator,
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), ["tool_search"]);
	assert.deepEqual(requests[1]?.tools.map((tool) => tool.name), ["tool_search", "docs_search"]);
	assert.deepEqual(requests[2]?.tools.map((tool) => tool.name), ["tool_search", "docs_search"]);
	assert.equal(requests[1]?.previousResponseId, undefined);
	assert.ok(trace.indexOf("persist:result:call-search") < trace.indexOf("provider:2"));
	assert.ok(trace.indexOf("tool:call-docs") < trace.indexOf("provider:3"));
	assert.equal(trace.filter((item) => item === "continuation:invalid:tool_exposure_changed").length, 1);
});

test("does not expose tool_search activations when result persistence fails", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	store.failToolResultPersistence = true;
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [[
		{ type: "tool_call", callId: "call-search", name: "tool_search", argumentsJson: '{"query":"docs"}' },
		{ type: "completed", responseId: "resp-search" },
	], [
		{ type: "text_delta", text: "This request must never be sent." },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: {
			execute: async (call) => ({
				callId: call.callId,
				toolName: call.name,
				success: true,
				modelOutput: '{"tools":[{"name":"docs_search"}]}',
				summary: "Activated 1 deferred tool",
				metadata: {},
				toolActivation: { names: ["docs_search"] },
			}),
		},
		toolDefinitions: [TOOL_SEARCH_TOOL_DEFINITION],
		deferredTools: [{
			id: "plugin:docs:search",
			name: "docs_search",
			description: "Search documents",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}],
		loadToolActivations: () => store.toolResults.flatMap(
			(result) => result.toolActivation?.names ?? [],
		),
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "persistence_error");
	assert.equal(requests.length, 1);
	assert.equal(store.toolResults.length, 0);
	assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), ["tool_search"]);
});

test("keeps repeated activations stable without another continuation invalidation", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const continuation = continuationFixture(trace);
	const provider = scriptedProvider(trace, requests, [[
		{ type: "tool_call", callId: "call-search-1", name: "tool_search", argumentsJson: '{"query":"docs"}' },
		{ type: "completed", responseId: "resp-search-1" },
	], [
		{ type: "tool_call", callId: "call-search-2", name: "tool_search", argumentsJson: '{"query":"docs"}' },
		{ type: "completed", responseId: "resp-search-2" },
	], [
		{ type: "text_delta", text: "Ready." },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: {
			execute: async (call) => ({
				callId: call.callId,
				toolName: call.name,
				success: true,
				modelOutput: '{"tools":[{"name":"docs_search"}]}',
				summary: "Activated 1 deferred tool",
				metadata: {},
				toolActivation: { names: ["docs_search"] },
			}),
		},
		toolDefinitions: [TOOL_SEARCH_TOOL_DEFINITION],
		deferredTools: [{
			id: "plugin:docs:search",
			name: "docs_search",
			description: "Search documents",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}],
		loadToolActivations: () => store.toolResults.flatMap(
			(result) => result.toolActivation?.names ?? [],
		),
		providerContinuation: continuation.coordinator,
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(trace.filter((item) => item === "continuation:invalid:tool_exposure_changed").length, 1);
	assert.equal(requests[1]?.previousResponseId, undefined);
	assert.equal(requests[2]?.previousResponseId, "resp-search-2");
});

test("filters stale durable activations through the current deferred catalog", async () => {
	const requests: ProviderRequest[] = [];
	const runtime = createRuntime({
		store: new FakeStore([]),
		provider: scriptedProvider([], requests, [[
			{ type: "text_delta", text: "Ready." },
			{ type: "completed", responseId: "resp-final" },
		]]),
		toolRouter: new SequencedRouter([]),
		toolDefinitions: [TOOL_SEARCH_TOOL_DEFINITION],
		deferredTools: [{
			id: "plugin:docs:search",
			name: "docs_search",
			description: "Search documents",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}, {
			id: "plugin:calendar:list",
			name: "calendar_list",
			description: "List calendars",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}],
		loadToolActivations: () => ["calendar_list", "missing_tool", "docs_search"],
	});

	await runtime.submit(submission(), () => undefined, { signal: new AbortController().signal });

	assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), [
		"tool_search",
		"docs_search",
		"calendar_list",
	]);
});

test("restores deferred tool exposure when an approval continuation rebuilds context", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const deferred: ToolDefinition = {
		id: "plugin:docs:search",
		name: "docs_search",
		description: "Search documents",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	};
	const provider = scriptedProvider(trace, requests, [[
		{ type: "tool_call", callId: "call-search", name: "tool_search", argumentsJson: '{"query":"docs"}' },
		{ type: "completed", responseId: "resp-search" },
	], [
		{ type: "tool_call", callId: "call-docs", name: "docs_search", argumentsJson: '{"query":"runtime"}' },
		{ type: "completed", responseId: "resp-docs" },
	], [
		{ type: "text_delta", text: "Approved result." },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const router: ToolRouterContract = {
		execute: async (call) => call.name === "tool_search"
			? {
				callId: call.callId,
				toolName: call.name,
				success: true,
				modelOutput: '{"tools":[{"name":"docs_search"}]}',
				summary: "Activated 1 deferred tool",
				metadata: {},
				toolActivation: { names: ["docs_search"] },
			}
			: {
				callId: call.callId,
				toolName: call.name,
				success: true,
				modelOutput: "Document result",
				summary: "Searched documents",
				metadata: {},
			},
	};
	const approvals = approvalRuntimeFixture(trace, router, store);
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: router,
		toolDefinitions: [TOOL_SEARCH_TOOL_DEFINITION],
		deferredTools: [deferred],
		loadToolActivations: () => store.toolResults.flatMap(
			(result) => result.toolActivation?.names ?? [],
		),
		approvalPolicy: {
			evaluate: (call) => call.name === "docs_search"
				? {
					kind: "request",
					callId: call.callId,
					toolName: call.name,
					preview: "Search documents",
					reason: "Approval required for deferred integration",
					options: ["approve_once", "reject"] as const,
				}
				: {
					kind: "allow",
					callId: call.callId,
					toolName: call.name,
					preview: "Search tools",
					reason: "Discovery is auto-allowed",
				},
		},
		approvalCoordinator: approvals.coordinator,
	});

	const suspended = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});
	assert.equal(suspended.status, "in_progress");
	assert.equal(approvals.pending()?.decisionId, "call-docs");
	assert.deepEqual(requests[1]?.tools.map((tool) => tool.name), ["tool_search", "docs_search"]);

	const completed = await resolveApproval(runtime, {
		decisionId: "call-docs",
		choice: "approve_once",
	}, () => undefined, new AbortController().signal);

	assert.equal(completed.status, "completed");
	assert.deepEqual(requests[2]?.tools.map((tool) => tool.name), ["tool_search", "docs_search"]);
});

test("strict mutation policy durably suspends before requesting approval", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson: WRITE_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);
	const router = new SequencedRouter(
		trace,
		new Set(),
		WRITE_PREVIEW_CHANGES,
		WRITE_PREPARED_GUARD,
	);
	const approvals = approvalRuntimeFixture(trace, router, store);
	const emitted: RuntimeEvent[] = [];

	const result = await createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({ workspaceRoot: "/workspace", autoApproveMedium: false }),
		approvalCoordinator: approvals.coordinator,
		toolDefinitions: [READ_TOOL_DEFINITION, WRITE_TOOL_DEFINITION],
	}).submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "in_progress");
	assert.equal(router.calls, 0);
	assert.deepEqual(trace, ["reserve", "provider:1", "persist:calls", "approval:suspend"]);
	const proposal = emitted.find((event) => event.type === "file_mutation_started");
	const request = emitted.find((event) => event.type === "approval_requested");
	assert.ok(proposal);
	assert.ok(request);
	assert.ok(emitted.indexOf(proposal) < emitted.indexOf(request));
	assert.equal(proposal.preview, "Write notes.txt");
	assert.equal(proposal.contentPreview, "hello");
	assert.deepEqual(proposal.fileChanges, WRITE_PREVIEW_CHANGES);
	assert.deepEqual(approvals.pending()?.preparedMutationGuard, WRITE_PREPARED_GUARD);
	assert.equal("decisionId" in request ? request.decisionId : undefined, "call-write");
	assert.equal("preview" in request ? request.preview : "", "Write notes.txt");
	assert.equal("contentPreview" in request ? request.contentPreview : undefined, "hello");
	assert.equal("contentLineCount" in request ? request.contentLineCount : undefined, 1);
	assert.equal("contentChars" in request ? request.contentChars : undefined, 5);
	assert.equal("contentTruncated" in request ? request.contentTruncated : undefined, false);
});

test("full access presents a file mutation before executing without approval", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const argumentsJson = JSON.stringify({
		file_path: "notes.txt",
		content: "hello",
		sandbox_permissions: "workspace-write",
		justification: "Redundant non-escalation reason from the model.",
	});
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson },
		{ type: "completed", responseId: "resp-tools" },
	], [
		{ type: "text_delta", text: "Write completed." },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const router = new FakeRouter(trace, {
		callId: "call-write",
		toolName: "Write",
		success: true,
		modelOutput: "Write completed",
		summary: "Write completed",
		metadata: {},
	}, WRITE_PREVIEW_CHANGES);
	const emitted: RuntimeEvent[] = [];

	const result = await createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({
			workspaceRoot: "/workspace",
			autoApproveMedium: false,
			permissionProfile: "full-access",
		}),
		toolDefinitions: [WRITE_TOOL_DEFINITION],
	}).submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(emitted.some((event) => event.type === "approval_requested"), false);
	const proposalIndex = emitted.findIndex((event) => event.type === "file_mutation_started");
	const executionIndex = emitted.findIndex((event) => event.type === "tool_execution_started");
	assert.ok(proposalIndex >= 0 && proposalIndex < executionIndex);
	const proposal = emitted[proposalIndex];
	assert.equal(proposal?.type === "file_mutation_started" ? proposal.contentPreview : undefined, "hello");
	assert.deepEqual(
		proposal?.type === "file_mutation_started" ? proposal.fileChanges : undefined,
		WRITE_PREVIEW_CHANGES,
	);
	assert.equal(router.previewOptions?.ownerTurnId, "turn-1");
	assert.ok(trace.indexOf("tool:call-write") >= 0);
});

test("policy denials preserve file sandbox error kinds", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new SequencedRouter(trace);
	const provider = scriptedProvider(trace, [], [[
		{
			type: "tool_call",
			callId: "call-write",
			name: "Write",
			argumentsJson: JSON.stringify({
				file_path: "notes.txt",
				content: "hello",
				sandbox_permissions: "host",
			}),
		},
		{ type: "completed", responseId: "resp-tools" },
	], [
		{ type: "text_delta", text: "The write arguments were invalid." },
		{ type: "completed", responseId: "resp-final" },
	]]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({ workspaceRoot: "/workspace" }),
		toolDefinitions: [WRITE_TOOL_DEFINITION],
	}).submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(router.calls, 0);
	assert.equal(store.toolResults[0]?.errorKind, "invalid_sandbox_permissions");
	assert.match(store.toolResults[0]?.result.output ?? "", /invalid_sandbox_permissions/u);
});

test("approval resolution continues the original turn without reserving or duplicating the user", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson: WRITE_ARGUMENTS },
			{ type: "tool_call", callId: "call-read", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[
			{ type: "text_delta", text: "Mutation and read completed." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const router = new SequencedRouter(trace);
	const approvals = approvalRuntimeFixture(trace, router, store);
	const instance = createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({ workspaceRoot: "/workspace", autoApproveMedium: false }),
		approvalCoordinator: approvals.coordinator,
		toolDefinitions: [READ_TOOL_DEFINITION, WRITE_TOOL_DEFINITION],
	});
	await instance.submit({
		...submission(),
		clientUserMessageId: "client-user-message-1",
	}, () => {}, { signal: new AbortController().signal });
	assert.equal(approvals.pending()?.clientUserMessageId, "client-user-message-1");
	const userCountBefore = store.items.filter((item) => item.type === "user").length;

	const result = await resolveApproval(instance, {
		decisionId: "call-write",
		choice: "approve_once",
	}, (event) => { trace.push(`event:${event.type}`); }, new AbortController().signal);

	assert.equal(result.status, "completed");
	assert.equal(trace.filter((item) => item === "reserve").length, 1);
	assert.equal(store.items.filter((item) => item.type === "user").length, userCountBefore);
	assert.ok(trace.indexOf("approval:resolve:call-write") < trace.indexOf("tool:call-read"));
	assert.ok(trace.indexOf("event:tool_execution_started") < trace.indexOf("tool:call-write"));
	assert.ok(trace.indexOf("tool:call-write") < trace.indexOf("event:tool_execution_completed"));
	assert.ok(trace.indexOf("approval:finish:call-write") < trace.indexOf("tool:call-read"));
	assert.ok(trace.indexOf("tool:call-read") < trace.indexOf("provider:2"));
});

test("approval interruption closes the claimed tool lifecycle with an unknown outcome", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const pending: ApprovalRequestFixture = {
		sessionId: "session-1",
		decisionId: "call-1",
		callId: "call-1",
		toolName: "Read",
		options: ["approve_once", "reject"],
		clientTurnId: "client-1",
		clientUserMessageId: "client-1",
		turnId: "turn-1",
		call: CALL,
		remainingCalls: [],
		conversation: [{ role: "user", content: "Read README.md" }],
		userMessage: "Read README.md",
		providerProtocol: "responses",
		assistantText: "",
		responseId: "response-approval",
		usage: {},
		preview: "Read README.md",
		reason: "approval required",
	};
	const interruptedTurn: RuntimeTurnRecord = {
		schema_version: 1,
		session_id: "session-1",
		client_turn_id: "client-1",
		turn_id: "turn-1",
		request_fingerprint: "fingerprint",
		status: "interrupted",
		error_code: "interrupted",
		result: { message: "turn interrupted" },
		started_at: "2026-08-04T00:00:00+00:00",
		completed_at: "2026-08-04T00:00:01+00:00",
	};
	const coordinator: ApprovalCoordinatorFixture = {
		suspend: () => pending,
		pending: () => pending,
		resolve: async (input) => {
			input.onExecutionStart?.();
			return { status: "interrupted", turn: interruptedTurn };
		},
		finish: () => undefined,
	};
	const emitted: RuntimeEvent[] = [];
	const result = await resolveApproval(
		createRuntime({
			store,
			provider: scriptedProvider(trace, [], []),
			toolRouter: new SequencedRouter(trace),
			approvalCoordinator: coordinator,
		}),
		{ decisionId: "call-1", choice: "approve_once" },
		emitted.push.bind(emitted),
		new AbortController().signal,
	);

	assert.equal(result.status, "interrupted");
	assert.deepEqual(emitted.map((event) => event.type), [
		"tool_execution_started",
		"tool_execution_failed",
		"turn_interrupted",
	]);
	const failed = emitted[1];
	assert.equal(failed?.type === "tool_execution_failed" ? failed.errorKind : undefined, "effect_outcome_unknown");
});

test("approval finalization failure preserves the running turn for retry", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson: WRITE_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);
	const router = new SequencedRouter(trace);
	const approvals = approvalRuntimeFixture(trace, router, store, { finishFailure: true });
	const instance = createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({ workspaceRoot: "/workspace", autoApproveMedium: false }),
		approvalCoordinator: approvals.coordinator,
		toolDefinitions: [WRITE_TOOL_DEFINITION],
	});
	await instance.submit(submission(), () => {}, { signal: new AbortController().signal });
	const emitted: RuntimeEvent[] = [];

	await assert.rejects(resolveApproval(instance, {
		decisionId: "call-write",
		choice: "approve_once",
	}, emitted.push.bind(emitted), new AbortController().signal), StorageFailure);

	assert.equal(store.turn?.status, "in_progress");
	assert.equal(emitted.some((event) => event.type === "turn_failed"), false);
});

test("one provider batch can pause for multiple approvals in original order", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const secondWrite = JSON.stringify({ file_path: "second.txt", content: "second" });
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-write-1", name: "Write", argumentsJson: WRITE_ARGUMENTS },
			{ type: "tool_call", callId: "call-write-2", name: "Write", argumentsJson: secondWrite },
			{ type: "completed", responseId: "resp-tools" },
		],
		[{ type: "completed", responseId: "resp-final" }],
	]);
	const router = new SequencedRouter(trace);
	const approvals = approvalRuntimeFixture(trace, router, store);
	const instance = createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalPolicy: new ApprovalPolicy({ workspaceRoot: "/workspace", autoApproveMedium: false }),
		approvalCoordinator: approvals.coordinator,
		toolDefinitions: [WRITE_TOOL_DEFINITION],
	});

	await instance.submit(submission(), () => {}, { signal: new AbortController().signal });
	const first = await resolveApproval(instance, {
		decisionId: "call-write-1",
		choice: "approve_once",
	}, () => {}, new AbortController().signal);
	assert.equal(first.status, "in_progress");
	assert.equal(approvals.pending()?.decisionId, "call-write-2");

	const completed = await resolveApproval(instance, {
		decisionId: "call-write-2",
		choice: "reject",
	}, () => {}, new AbortController().signal);

	assert.equal(completed.status, "completed");
	assert.deepEqual(trace.filter((item) => item.startsWith("approval:")), [
		"approval:suspend",
		"approval:resolve:call-write-1",
		"approval:finish:call-write-1",
		"approval:suspend",
		"approval:resolve:call-write-2",
		"approval:finish:call-write-2",
	]);
	assert.deepEqual(store.items.filter((item) => item.type === "tool_result").map((item) => item.callId), [
		"call-write-1",
		"call-write-2",
	]);
	assert.equal(router.calls, 1);
});

test("clarification response resumes the original provider loop without a new user turn", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-question", name: "AskUserQuestion", argumentsJson: ASK_ARGUMENTS },
			{ type: "tool_call", callId: "call-read", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-question" },
		],
		[
			{ type: "text_delta", text: "Node selected." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const router: ToolRouterContract = {
		execute: async (call) => {
			trace.push(`tool:${call.callId}`);
			return call.name === "AskUserQuestion"
				? {
					callId: call.callId,
					toolName: call.name,
					success: true,
					modelOutput: "Awaiting user response.",
					summary: "Awaiting user response",
					metadata: {
						status: "awaiting_user_response",
						question: "Which runtime?",
						options: [{ label: "Node" }, { label: "Python" }, { label: "Other" }],
						header: "Runtime",
						multi_select: false,
					},
				}
				: successResult(call.callId);
		},
	};
	const clarifications = clarificationRuntimeFixture(trace, store);
	const approvalCoordinator: ApprovalCoordinatorFixture = {
		suspend: () => { throw new Error("approval suspend is not expected"); },
		pending: () => undefined,
		resolve: async () => { throw new Error("approval resolution is not expected"); },
		finish: () => undefined,
	};
	const emitted: RuntimeEvent[] = [];
	const instance = createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalCoordinator,
		clarificationCoordinator: clarifications.coordinator,
		toolDefinitions: [ASK_USER_QUESTION_TOOL_DEFINITION, READ_TOOL_DEFINITION],
	});
	instance.configureRuntimeContext({ collaborationMode: "plan" });

	const waiting = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});
	assert.equal(waiting.status, "in_progress");
	assert.equal(instance.continuationTurnId(), "turn-1");
	assert.equal(trace.includes("persist:result:call-question"), false);
	assert.equal(trace.includes("tool:call-read"), false);
	const request = emitted.find((event) => event.type === "clarification_requested");
	assert.ok(request);
	assert.equal("requestId" in request ? request.requestId : undefined, "call-question");

	const completed = await resolveClarification(
		instance,
		{ requestId: "call-question", response: "Node" },
		emitted.push.bind(emitted),
		new AbortController().signal,
	);
	assert.equal(completed.status, "completed");
	assert.equal(store.items.filter((item) => item.type === "user").length, 1);
	assert.ok(trace.indexOf("clarification:resolve:call-question") < trace.indexOf("tool:call-read"));
	assert.equal(trace.filter((item) => item.startsWith("provider:")).length, 2);
});

test("force interrupt clears a pending clarification before terminalizing the turn", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-question", name: "AskUserQuestion", argumentsJson: ASK_ARGUMENTS },
		{ type: "completed", responseId: "resp-question" },
	]]);
	const router: ToolRouterContract = {
		execute: async (call) => ({
			callId: call.callId,
			toolName: call.name,
			success: true,
			modelOutput: "Awaiting user response.",
			summary: "Awaiting user response",
			metadata: {
				status: "awaiting_user_response",
				question: "Which runtime?",
				options: [{ label: "Node" }, { label: "Python" }],
				header: "Runtime",
				multi_select: false,
			},
		}),
	};
	const clarifications = clarificationRuntimeFixture(trace, store);
	const approvalCoordinator: ApprovalCoordinatorFixture = {
		suspend: () => { throw new Error("approval suspend is not expected"); },
		pending: () => undefined,
		resolve: async () => { throw new Error("approval resolution is not expected"); },
		finish: () => undefined,
	};
	const emitted: RuntimeEvent[] = [];
	const instance = createRuntime({
		store,
		provider,
		toolRouter: router,
		approvalCoordinator,
		clarificationCoordinator: clarifications.coordinator,
		toolDefinitions: [ASK_USER_QUESTION_TOOL_DEFINITION],
	});
	instance.configureRuntimeContext({ collaborationMode: "plan" });

	const waiting = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});
	assert.equal(waiting.status, "in_progress");
	assert.ok(clarifications.coordinator.pending());

	const interrupted = await instance.forceInterrupt(
		{ clientTurnId: "client-1", turnId: "turn-1" },
		emitted.push.bind(emitted),
	);

	assert.equal(interrupted.status, "interrupted");
	assert.equal(store.loadTurn()?.status, "interrupted");
	assert.equal(clarifications.coordinator.pending(), undefined);
	assert.deepEqual(
		trace.filter((item) => item.startsWith("clarification:")),
		["clarification:suspend", "clarification:cancel:call-question"],
	);
	assert.equal(emitted.filter((event) => event.type === "turn_interrupted").length, 1);
});

test("interrupts after a durable tool result without requesting a continuation", async () => {
	const trace: string[] = [];
	const controller = new AbortController();
	const store = new FakeStore(trace);
	store.afterResultPersisted = () => { controller.abort(); };
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
	}).submit(submission(), () => {}, { signal: controller.signal });

	assert.equal(result.status, "interrupted");
	assert.equal(result.error_code, "interrupted");
	assert.equal(store.items.at(-1)?.type, "tool_result");
	assert.equal(trace.filter((item) => item.startsWith("provider:")).length, 1);
});

test("applies the pre-event retry budget independently to each provider step", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	let providerAttempts = 0;
	const provider: ModelProvider = {
		stream: () => {
			providerAttempts += 1;
			trace.push(`provider:${providerAttempts}`);
			if (providerAttempts === 1 || providerAttempts === 3) {
				return failingProviderEvents(new ProviderFailure({
					code: "provider_error",
					message: "temporary provider failure",
					retryable: true,
				}));
			}
			if (providerAttempts === 2) {
				return providerEvents([
					{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
					{ type: "completed", responseId: "resp-tools" },
				]);
			}
			return providerEvents([
				{ type: "text_delta", text: "Recovered twice." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};
	const emitted: RuntimeEvent[] = [];

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
	}).submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(providerAttempts, 4);
	assert.equal(emitted.filter((event) => event.type === "stream_retrying").length, 2);
	assert.equal(emitted.filter((event) => event.type === "stream_recovered").length, 2);
});

test("compacts before the first provider request and keeps the current user item fresh", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [[
		{ type: "text_delta", text: "Continued from compact context." },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const compacted: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "[compact-summary]\nEarlier work." },
		{ type: "user", text: "Read README.md" },
	];
	const coordinator = new ScriptedCompactionCoordinator(trace, [
		compactionResult("compressed", compacted),
	]);
	const diagnostics: RuntimeDiagnosticEvent[] = [];

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		compactionCoordinator: coordinator,
		monotonicClock: numberSequence([10, 25]),
		recordDiagnostic: (event) => diagnostics.push(event),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(trace.slice(0, 3), ["reserve", "compact:pre_turn", "provider:1"]);
	assert.deepEqual([...coordinator.calls[0]!.freshItemIds], [
		"turn-1:user:client-1",
	]);
	assert.deepEqual(requests[0]?.items, compacted);
	assert.deepEqual(diagnostics.find((event) => event.kind === "compaction"), {
		kind: "compaction",
		turnId: "turn-1",
		source: "pre_turn",
		status: "compressed",
		beforeTokens: 100,
		afterTokens: 40,
		maxTokens: 12_000,
		durationMs: 15,
	});
});

test("uses the canonical queue history identity for a queued turn's fresh input", async () => {
	const trace: string[] = [];
	const requests: ProviderRequest[] = [];
	const coordinator = new ScriptedCompactionCoordinator(trace, [
		compactionResult("not_needed", []),
	]);
	const result = await createRuntime({
		store: new FakeStore(trace),
		provider: scriptedProvider(trace, requests, [[
			{ type: "text_delta", text: "Queued input completed." },
			{ type: "completed", responseId: "resp-queued" },
		]]),
		toolRouter: new SequencedRouter(trace),
		compactionCoordinator: coordinator,
	}).submit({
		clientTurnId: "queued-client",
		clientUserMessageId: "queued-client",
		queueId: "queue-1",
		inputSource: "submit",
		message: "Run queued input",
	}, () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual([...coordinator.calls[0]!.freshItemIds], ["turn-1:queue:queue-1"]);
	assert.deepEqual(requests[0]?.items, [{ type: "user", text: "Run queued input" }]);
});

test("publishes provider and tool diagnostics without exposing tool content", async () => {
	const trace: string[] = [];
	const diagnostics: RuntimeDiagnosticEvent[] = [];
	const runtime = createRuntime({
		store: new FakeStore(trace),
		provider: scriptedProvider(trace, [], [[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		], [
			{ type: "text_delta", text: "Done." },
			{ type: "completed", responseId: "resp-final" },
		]]),
		toolRouter: new SequencedRouter(trace),
		monotonicClock: numberSequence([10, 25]),
		recordDiagnostic: (event) => {
			diagnostics.push(event);
			throw new Error("diagnostic sink failed");
		},
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(
		diagnostics.filter((event) => event.kind === "model_stream_diagnostics").length,
		2,
	);
	const toolDiagnostic = diagnostics.find((event) => event.kind === "tool_execution");
	assert.deepEqual(toolDiagnostic, {
		kind: "tool_execution",
		turnId: "turn-1",
		callId: "call-1",
		toolName: "Read",
		durationMs: 15,
		success: true,
		outputChars: READ_OUTPUT.length,
		outputTruncated: false,
	});
	assert.equal(JSON.stringify(toolDiagnostic).includes("README.md"), false);
});

test("compacts mid-turn after tool results and continues from the replacement history", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [[
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	], [
		{ type: "text_delta", text: "Continued after compacting the tool phase." },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const compacted: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "Read README.md" },
		{ type: "user", text: "[compact-summary]\nREADME.md was read successfully." },
	];
	const coordinator = new ScriptedCompactionCoordinator(trace, [
		compactionResult("not_needed", []),
		compactionResult("compressed", compacted),
	]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		compactionCoordinator: coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(coordinator.calls.map((call) => call.source), ["pre_turn", "mid_turn"]);
	assert.ok(trace.indexOf("persist:result:call-1") < trace.indexOf("compact:mid_turn"));
	assert.ok(trace.indexOf("compact:mid_turn") < trace.indexOf("provider:2"));
	assert.deepEqual(requests[1]?.items, compacted);
	assert.equal(requests[1]?.previousResponseId, undefined);
});

test("creates compaction from the config resolved for the active turn", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "completed", responseId: "resp-final" },
	]]);
	const coordinator = new ScriptedCompactionCoordinator(trace, [
		compactionResult("not_needed", []),
	]);
	let resolvedModel = "";

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		createCompactionCoordinator: (resolved) => {
			resolvedModel = resolved.model;
			return coordinator;
		},
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(resolvedModel, "gpt-test");
	assert.deepEqual(coordinator.calls.map((call) => call.source), ["pre_turn"]);
});

test("reactively compacts once after a zero-event context rejection and clears continuation", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	let providerCalls = 0;
	const provider: ModelProvider = {
		stream: (request) => {
			providerCalls += 1;
			requests.push(request);
			trace.push(`provider:${providerCalls}`);
			if (providerCalls === 1) {
				return providerEvents([
					{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
					{ type: "completed", responseId: "resp-tools" },
				]);
			}
			if (providerCalls === 2) {
				return failingProviderEvents(new ProviderFailure({
					code: "context_window_exceeded",
					message: "private provider context detail",
				}));
			}
			return providerEvents([
				{ type: "text_delta", text: "Recovered after compaction." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};
	const reactiveProjection: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "[compact-summary]\nRead state was preserved." },
		{ type: "user", text: "Read README.md" },
		{ type: "assistant_tool_calls", text: "", calls: [CALL], responseId: "resp-tools" },
		{ type: "tool_result", ...successResult("call-1"), output: READ_OUTPUT },
	];
	const coordinator = new ScriptedCompactionCoordinator(trace, [
		compactionResult("not_needed", []),
		compactionResult("not_needed", []),
		compactionResult("compressed", reactiveProjection),
	]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		compactionCoordinator: coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(providerCalls, 3);
	assert.deepEqual(coordinator.calls.map((call) => call.source), [
		"pre_turn",
		"mid_turn",
		"context_overflow",
	]);
	assert.equal(requests[1]?.previousResponseId, "resp-tools");
	assert.equal(requests[2]?.previousResponseId, undefined);
	assert.deepEqual(requests[2]?.items, reactiveProjection);
});

test("does not compact or retry a context rejection after provider output", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	let providerCalls = 0;
	const provider: ModelProvider = {
		stream: () => {
			providerCalls += 1;
			return textThenFailure("partial output", new ProviderFailure({
				code: "context_window_exceeded",
				message: "private provider context detail",
			}));
		},
	};
	const coordinator = new ScriptedCompactionCoordinator(trace, [
		compactionResult("not_needed", []),
	]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		compactionCoordinator: coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "context_window_exceeded");
	assert.equal(providerCalls, 1);
	assert.deepEqual(coordinator.calls.map((call) => call.source), ["pre_turn"]);
});

test("reports bounded tool execution duration from a monotonic clock", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[{ type: "completed", responseId: "resp-final" }],
	]);
	const emitted: RuntimeEvent[] = [];

	await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		monotonicClock: numberSequence([100, 125]),
	}).submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	const completion = emitted.find((event) => event.type === "tool_execution_completed");
	assert.ok(completion);
	assert.equal("durationMs" in completion ? completion.durationMs : undefined, 25);
});

test("passes mutation metadata unchanged to durable tool-result storage", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const metadata = {
		path: "src/a.ts",
		status: "edited",
		matches: 1,
		diff: "-old\n+new\n",
		addedLines: 1,
		removedLines: 1,
		diffTruncated: false,
	};
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[{ type: "completed", responseId: "resp-final" }],
	]);
	const result = { ...successResult("call-1"), metadata };

	await createRuntime({
		store,
		provider,
		toolRouter: new FakeRouter(trace, result),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.strictEqual(store.toolResults[0]?.metadata, metadata);
});

test("commits accepted steers before the next provider request", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const requests: ProviderRequest[] = [];
	const events: RuntimeEvent[] = [];
	let step = 0;
	const provider: ModelProvider = {
		stream: (request) => {
			requests.push(request);
			trace.push(`provider:${++step}`);
			if (step === 1) {
				queue.coordinator.enqueueSteer({
					clientTurnId: "client-steer",
					expectedTurnId: "turn-1",
					activeTurnId: "turn-1",
					steerable: true,
					text: "Also inspect package.json",
				});
				return providerEvents([
					{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
					{ type: "completed", responseId: "resp-tools" },
				]);
			}
			return providerEvents([
				{ type: "text_delta", text: "Both files inspected." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), (event) => { events.push(event); }, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.ok(trace.indexOf("queue:commit") < trace.indexOf("provider:2"));
	assert.deepEqual(requests[1]?.items?.at(-1), {
		type: "user",
		text: "Also inspect package.json",
	});
	assert.deepEqual(queue.committedQueueIds, ["queue-1"]);
	assert.deepEqual(
		events
			.filter((event) => String(event.type).startsWith("user_message_"))
			.map((event) => JSON.parse(JSON.stringify(event))),
		[
			{
				type: "user_message_started",
				clientTurnId: "client-1",
				turnId: "turn-1",
				itemId: "turn-1:queue:queue-1",
				clientUserMessageId: "client-steer",
				content: "Also inspect package.json",
				source: "steer",
			},
			{
				type: "user_message_completed",
				clientTurnId: "client-1",
				turnId: "turn-1",
				itemId: "turn-1:queue:queue-1",
				clientUserMessageId: "client-steer",
				content: "Also inspect package.json",
				source: "steer",
			},
		],
	);
});

test("rejects unconsumed steers before normal terminal completion", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const provider: ModelProvider = {
		stream: () => {
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "Too late for this request",
			});
			return providerEvents([
				{ type: "text_delta", text: "Done." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(queue.coordinator.snapshot().pendingSteers.length, 0);
	assert.equal(queue.coordinator.snapshot().rejectedSteers[0]?.kind, "rejected_steer");
	assert.ok(trace.lastIndexOf("queue:save") < trace.indexOf("complete"));
});

test("retains pending steers when a turn is interrupted", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const controller = new AbortController();
	const provider: ModelProvider = {
		stream: () => {
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "Keep this steer",
			});
			controller.abort();
			return providerEvents([{ type: "completed", responseId: "resp-final" }]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: controller.signal });

	assert.equal(result.status, "interrupted");
	assert.equal(queue.coordinator.snapshot().pendingSteers[0]?.text, "Keep this steer");
	assert.equal(queue.coordinator.snapshot().rejectedSteers.length, 0);
});

test("does not continue the provider when committing a steer fails", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const requests: ProviderRequest[] = [];
	let step = 0;
	const provider: ModelProvider = {
		stream: (request) => {
			requests.push(request);
			step += 1;
			if (step > 1) {
				return providerEvents([
					{ type: "text_delta", text: "Continued without the steer." },
					{ type: "completed", responseId: "resp-final" },
				]);
			}
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "Persist me first",
			});
			queue.failCommit = true;
			return providerEvents([
				{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
				{ type: "completed", responseId: "resp-tools" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "persistence_error");
	assert.equal(requests.length, 1);
	assert.equal(trace.includes("complete"), false);
});

test("reports unavailable steering images as an unsupported capability", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	queue.failImageLoad = true;
	let requests = 0;
	const provider: ModelProvider = {
		stream: () => {
			requests += 1;
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-image-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "describe this",
				imagePaths: ["/tmp/missing.png"],
			});
			return providerEvents([
				{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
				{ type: "completed", responseId: "resp-tools" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "unsupported_capability");
	assert.equal(requests, 1);
	assert.equal(queue.coordinator.snapshot().pendingSteers.length, 1);
});

test("does not report terminal success when queue rejection persistence fails", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const provider: ModelProvider = {
		stream: () => {
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "Persist terminal transition",
			});
			queue.failSave = true;
			return providerEvents([
				{ type: "text_delta", text: "Done." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "persistence_error");
	assert.equal(trace.includes("complete"), false);
});

test("freezes execution policy tools for the provider loop and releases terminal turns", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [[
		{ type: "text_delta", text: "done" },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const calls: string[] = [];
	const executionPolicyCoordinator = {
		configure: () => undefined,
		snapshot: () => ({
			trusted: true,
			valid: true,
			profile: executionProfile(),
		}),
		beginTurn: (turnId: string) => {
			calls.push(`begin:${turnId}`);
			return { toolsEnabled: true, profile: executionProfile() };
		},
		finishTurn: (turnId: string) => { calls.push(`finish:${turnId}`); },
	};
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		executionPolicyCoordinator,
		planTools: ({ shell, collaborationMode }) => [
			READ_TOOL_DEFINITION,
			...(collaborationMode === "plan" ? [ASK_USER_QUESTION_TOOL_DEFINITION] : []),
			...(shell ? [SHELL_TOOL_DEFINITION] : []),
		],
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), ["Read", "Shell"]);
	assert.deepEqual(calls, ["begin:turn-1", "finish:turn-1"]);
});

test("Plan mode keeps stable tool exposure and rejects update_plan without side effects", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const hookPoints: string[] = [];
	const liveEvents: RuntimeEvent[] = [];
	let approvalEvaluations = 0;
	let previewCalls = 0;
	let executeCalls = 0;
	let providerStep = 0;
	const runtimeRef: { current?: NodeTurnRuntime } = {};
	const provider: ModelProvider = {
		stream: (request) => {
			requests.push(request);
			providerStep += 1;
			if (providerStep === 1) {
				runtimeRef.current?.configureRuntimeContext({ collaborationMode: "default" });
				return providerEvents([
					{
						type: "tool_call",
						callId: "call-update-plan",
						name: "update_plan",
						argumentsJson: JSON.stringify({
							plan: [{ step: "Inspect runtime", status: "in_progress" }],
						}),
					},
					{ type: "completed", responseId: "plan-update" },
				]);
			}
			return providerEvents([
				{ type: "text_delta", text: "I kept this turn in Plan mode." },
				{ type: "completed", responseId: "plan-final" },
			]);
		},
	};
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: {
			preview: async () => {
				previewCalls += 1;
				return [];
			},
			execute: async (call) => {
				executeCalls += 1;
				return successResult(call.callId);
			},
		},
		planTools: () => [
			READ_TOOL_DEFINITION,
			SHELL_TOOL_DEFINITION,
			WRITE_TOOL_DEFINITION,
			EDIT_TOOL_DEFINITION,
			PATCH_TOOL_DEFINITION,
			ASK_USER_QUESTION_TOOL_DEFINITION,
			UPDATE_PLAN_TOOL_DEFINITION,
		],
		approvalPolicy: {
			evaluate: (call) => {
				approvalEvaluations += 1;
				return {
					kind: "allow",
					callId: call.callId,
					toolName: call.name,
					preview: "allowed",
					reason: "test",
				};
			},
		},
		hookRunner: {
			run: async (input) => {
				hookPoints.push(input.point);
				return [];
			},
		},
	});
	runtimeRef.current = runtime;
	runtime.configureRuntimeContext({ collaborationMode: "plan" });

	const result = await runtime.submit(submission(), (event) => liveEvents.push(event), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(requests.length, 2);
	assert.deepEqual(requests.map((request) => request.tools.map((tool) => tool.name)), [
		["Read", "Shell", "Write", "Edit", "Patch", "AskUserQuestion", "update_plan"],
		["Read", "Shell", "Write", "Edit", "Patch", "AskUserQuestion", "update_plan"],
	]);
	assert.match(JSON.stringify(requests[1]?.items), /update_plan.*not allowed in Plan mode/u);
	assert.match(JSON.stringify(requests[1]), /# Plan Mode/u);
	assert.equal(approvalEvaluations, 0);
	assert.equal(previewCalls, 0);
	assert.equal(executeCalls, 0);
	assert.equal(hookPoints.includes("pre_tool_use"), false);
	assert.equal(hookPoints.includes("post_tool_use"), false);
	assert.equal(store.toolResults.length, 1);
	assert.equal(store.toolResults[0]?.result.success, false);
	assert.equal(store.toolResults[0]?.errorKind, "tool_not_allowed_in_plan_mode");
	assert.equal(
		liveEvents.some((event) => event.type === "tool_execution_failed"
			&& event.errorKind === "tool_not_allowed_in_plan_mode"),
		true,
	);
});

test("evaluates approvals with the frozen turn execution policy", async () => {
	const trace: string[] = [];
	const profile = executionProfile();
	const seenProfiles: unknown[] = [];
	const provider = scriptedProvider(trace, [], [[
		{
			type: "tool_call",
			callId: "call-read",
			name: "Read",
			argumentsJson: JSON.stringify({ file_path: "README.md", offset: 1, limit: 20 }),
		},
		{ type: "completed", responseId: "resp-read" },
	], [
		{ type: "text_delta", text: "done" },
		{ type: "completed", responseId: "resp-final" },
	]]);
	const runtime = createRuntime({
		store: new FakeStore(trace),
		provider,
		toolRouter: new SequencedRouter(trace),
		executionPolicyCoordinator: {
			configure: () => undefined,
			snapshot: () => ({ trusted: true, valid: true, profile }),
			beginTurn: () => ({ toolsEnabled: true, profile }),
			finishTurn: () => undefined,
		},
		planTools: () => [READ_TOOL_DEFINITION],
		approvalPolicy: {
			evaluate: (call, executionPolicy) => {
				seenProfiles.push(executionPolicy);
				return {
					kind: "allow",
					callId: call.callId,
					toolName: call.name,
					preview: "Read allowed",
					reason: "Allowed for test.",
				};
			},
		},
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.deepEqual(seenProfiles, [profile]);
});

test("runtime forwards an exact Shell sandbox override authorization to the router", async () => {
	const trace: string[] = [];
	const router = new FakeRouter(trace, {
		callId: "call-shell",
		toolName: "Shell",
		success: true,
		modelOutput: "Process exited with code 0",
		summary: "Shell completed",
		metadata: {},
	});
	const provider = scriptedProvider(trace, [], [[
		{
			type: "tool_call",
			callId: "call-shell",
			name: "Shell",
			argumentsJson: JSON.stringify({
				command: "python script.py",
				sandbox_permissions: "require_escalated",
			}),
		},
		{ type: "completed", responseId: "resp-shell" },
	], [
		{ type: "completed", responseId: "resp-final" },
	]]);

	const result = await createRuntime({
		store: new FakeStore(trace),
		provider,
		toolRouter: router,
		toolDefinitions: [SHELL_TOOL_DEFINITION],
		approvalPolicy: {
			evaluate: (call) => ({
				kind: "allow",
				callId: call.callId,
				toolName: call.name,
				preview: "Shell command allowed",
				reason: "Approved by exact execution rule.",
				sandboxOverrideApproved: true,
			}),
		},
	}).submit(submission(), () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(router.options?.sandboxOverrideApproved, true);
});

test("runtime withholds Shell sandbox override authorization after a hook changes the call", async () => {
	const trace: string[] = [];
	const router = new FakeRouter(trace, {
		callId: "call-shell",
		toolName: "Shell",
		success: true,
		modelOutput: "Process exited with code 0",
		summary: "Shell completed",
		metadata: {},
	});
	const provider = scriptedProvider(trace, [], [[
		{
			type: "tool_call",
			callId: "call-shell",
			name: "Shell",
			argumentsJson: JSON.stringify({
				command: "python script.py",
				sandbox_permissions: "require_escalated",
			}),
		},
		{ type: "completed", responseId: "resp-shell" },
	], [
		{ type: "completed", responseId: "resp-final" },
	]]);
	const hookRunner: HookRunnerContract = {
		run: async (input) => input.point === "pre_tool_use"
			? [{
				hookId: "modify-shell",
				result: { action: "modify", arguments: { command: "python changed.py" } },
			}]
			: [],
	};

	await createRuntime({
		store: new FakeStore(trace),
		provider,
		toolRouter: router,
		toolDefinitions: [SHELL_TOOL_DEFINITION],
		hookRunner,
		approvalPolicy: {
			evaluate: (call) => ({
				kind: "allow",
				callId: call.callId,
				toolName: call.name,
				preview: "Shell command allowed",
				reason: "Approved by exact execution rule.",
				sandboxOverrideApproved: true,
			}),
		},
	}).submit(submission(), () => undefined, { signal: new AbortController().signal });

	assert.equal(router.options?.sandboxOverrideApproved, undefined);
});

test("runtime reports executed workspace escapes back to the approval policy", async () => {
	const trace: string[] = [];
	const escaped: ToolExecutionResult = {
		callId: "call-write",
		toolName: "Write",
		success: false,
		modelOutput: "Write failed\nError kind: workspace_escape",
		summary: "Write failed",
		errorKind: "workspace_escape",
		metadata: {},
	};
	const router = new FakeRouter(trace, escaped);
	const provider = scriptedProvider(trace, [], [[
		{
			type: "tool_call",
			callId: "call-write",
			name: "Write",
			argumentsJson: JSON.stringify({ file_path: "link/outside.txt", content: "hello" }),
		},
		{ type: "completed", responseId: "resp-write" },
	], [
		{ type: "completed", responseId: "resp-final" },
	]]);
	let recorded: {
		readonly call: CanonicalToolCall;
		readonly result: ToolExecutionResult;
		readonly turnId?: string;
	} | undefined;

	const result = await createRuntime({
		store: new FakeStore(trace),
		provider,
		toolRouter: router,
		toolDefinitions: [WRITE_TOOL_DEFINITION],
		approvalPolicy: {
			evaluate: (call) => ({
				kind: "allow",
				callId: call.callId,
				toolName: call.name,
				preview: "Write allowed",
				reason: "Allowed for test.",
			}),
			recordResult: (call, toolResult, _executionPolicy, turnId) => {
				recorded = { call, result: toolResult, ...(turnId ? { turnId } : {}) };
			},
		},
	}).submit(submission(), () => undefined, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(recorded?.call.name, "Write");
	assert.equal(recorded?.result.errorKind, "workspace_escape");
	assert.equal(recorded?.turnId, "turn-1");
});

test("execution policy configuration updates routine approval profile", () => {
	const approvalPolicy = new ApprovalPolicy({
		workspaceRoot: "/workspace",
		autoApproveMedium: true,
		shellKind: "posix",
	});
	const shellCall: CanonicalToolCall = {
		callId: "call-shell",
		name: "Shell",
		argumentsJson: JSON.stringify({ command: "rm -rf build" }),
	};
	const runtime = createRuntime({
		store: new FakeStore([]),
		provider: scriptedProvider([], [], []),
		toolRouter: new SequencedRouter([]),
		approvalPolicy,
	});

	assert.equal(approvalPolicy.evaluate(shellCall).kind, "request");
	runtime.configureExecutionPolicy({ trust: "trusted", permission: "full-access" });
	assert.equal(approvalPolicy.evaluate(shellCall).kind, "allow");
});

test("closes provider calls outside the frozen exposure and lets the model recover", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new SequencedRouter(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [[
		{
			type: "tool_call",
			callId: "call-rg-files",
			name: "rg --files",
			argumentsJson: JSON.stringify({ path: "/workspace" }),
		},
		{ type: "completed", responseId: "resp-unsupported-tool" },
	], [
		{ type: "text_delta", text: "I will use Shell instead." },
		{ type: "completed", responseId: "resp-recovered" },
	]]);
	const runtime = createRuntime({
		store,
		provider,
		toolRouter: router,
		toolDefinitions: [READ_TOOL_DEFINITION],
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(router.calls, 0);
	assert.equal(trace.includes("persist:calls"), true);
	assert.equal(requests.length, 2);
	assert.match(JSON.stringify(requests[1]?.items), /unsupported call: rg --files/u);
	assert.equal(store.toolResults.length, 1);
	assert.equal(store.toolResults[0]?.result.callId, "call-rg-files");
	assert.equal(store.toolResults[0]?.result.toolName, "rg --files");
	assert.equal(store.toolResults[0]?.result.success, false);
	assert.equal(store.toolResults[0]?.errorKind, "unsupported_tool");
});

test("enforces explicit provider-step and tool-call budgets without implicit defaults", async () => {
	const turnTrace: string[] = [];
	const turnRequests: ProviderRequest[] = [];
	const turnRouter = new SequencedRouter(turnTrace);
	const turnRuntime = createRuntime({
		store: new FakeStore(turnTrace),
		provider: scriptedProvider(turnTrace, turnRequests, [[
			{ type: "tool_call", callId: "turn-call", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "turn-response" },
		], [
			{ type: "text_delta", text: "should not run" },
			{ type: "completed", responseId: "turn-final" },
		]]),
		toolRouter: turnRouter,
		agentBudget: { maxTurns: 1 },
	});
	const turnResult = await turnRuntime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});
	assert.equal(turnResult.error_code, "tool_budget_exceeded");
	assert.equal(turnRuntime.agentBudgetExhaustion(), "max_turns");
	assert.equal(turnRequests.length, 1);
	assert.equal(turnRouter.calls, 1);

	const toolTrace: string[] = [];
	const toolRequests: ProviderRequest[] = [];
	const toolRouter = new SequencedRouter(toolTrace);
	const toolRuntime = createRuntime({
		store: new FakeStore(toolTrace),
		provider: scriptedProvider(toolTrace, toolRequests, [[
			{ type: "tool_call", callId: "tool-call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "tool-response-1" },
		], [
			{ type: "tool_call", callId: "tool-call-2", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "tool-response-2" },
		]]),
		toolRouter,
		agentBudget: { maxToolCalls: 1 },
	});
	const toolResult = await toolRuntime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});
	assert.equal(toolResult.error_code, "tool_budget_exceeded");
	assert.equal(toolRuntime.agentBudgetExhaustion(), "max_tool_calls");
	assert.equal(toolRequests.length, 2);
	assert.equal(toolRouter.calls, 1);
});

test("enforces explicit token no-progress and wall-clock budgets", async () => {
	const tokenTrace: string[] = [];
	const tokenRouter = new SequencedRouter(tokenTrace);
	const tokenRuntime = createRuntime({
		store: new FakeStore(tokenTrace),
		provider: scriptedProvider(tokenTrace, [], [[
			{ type: "usage", usage: { total_tokens: 10 } },
			{ type: "tool_call", callId: "token-call", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "token-response" },
		]]),
		toolRouter: tokenRouter,
		agentBudget: { maxTokens: 10 },
	});
	const tokenResult = await tokenRuntime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});
	assert.equal(tokenResult.error_code, "tool_budget_exceeded");
	assert.equal(tokenRuntime.agentBudgetExhaustion(), "max_tokens");
	assert.equal(tokenRouter.calls, 0);

	const noProgressTrace: string[] = [];
	const noProgressRequests: ProviderRequest[] = [];
	const noProgressRuntime = createRuntime({
		store: new FakeStore(noProgressTrace),
		provider: scriptedProvider(noProgressTrace, noProgressRequests, [[
			{ type: "completed", responseId: "empty-1" },
		], [
			{ type: "completed", responseId: "empty-2" },
		]]),
		toolRouter: new SequencedRouter(noProgressTrace),
		agentBudget: { noProgressTurnLimit: 2 },
	});
	const noProgressResult = await noProgressRuntime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});
	assert.equal(noProgressResult.error_code, "tool_budget_exceeded");
	assert.equal(noProgressRuntime.agentBudgetExhaustion(), "no_progress");
	assert.equal(noProgressRequests.length, 2);

	const wallTrace: string[] = [];
	const wallRequests: ProviderRequest[] = [];
	const wallRuntime = createRuntime({
		store: new FakeStore(wallTrace),
		provider: scriptedProvider(wallTrace, wallRequests, []),
		toolRouter: new SequencedRouter(wallTrace),
		agentBudget: { wallClockMs: 5 },
		monotonicClock: numberSequence([0, 6]),
	});
	const wallResult = await wallRuntime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});
	assert.equal(wallResult.error_code, "tool_budget_exceeded");
	assert.equal(wallRuntime.agentBudgetExhaustion(), "wall_clock");
	assert.equal(wallRequests.length, 0);
});

function createRuntime(options: {
	readonly store: TurnStore;
	readonly provider: ModelProvider;
	readonly toolRouter: ToolRouterContract;
	readonly queueCoordinator?: QueueCoordinator;
	readonly monotonicClock?: () => number;
	readonly approvalPolicy?: NodeTurnRuntimeOptions["approvalPolicy"];
	readonly approvalCoordinator?: ApprovalCoordinatorFixture;
	readonly clarificationCoordinator?: ClarificationCoordinatorFixture;
	readonly toolDefinitions?: readonly ToolDefinition[];
	readonly compactionCoordinator?: CompactionCoordinatorContract;
	readonly createCompactionCoordinator?: NodeTurnRuntimeOptions["createCompactionCoordinator"];
	readonly memoryContextService?: MemoryContextServiceContract;
	readonly providerContinuation?: ProviderContinuationCoordinator;
	readonly writeTerminalSnapshot?: NodeTurnRuntimeOptions["writeTerminalSnapshot"];
	readonly publishLifecycle?: (event: ShellLifecycleEvent) => void;
	readonly runtimeConfig?: NodeRuntimeConfig;
	readonly executionPolicyCoordinator?: NodeTurnRuntimeOptions["executionPolicyCoordinator"];
	readonly planTools?: NonNullable<NodeTurnRuntimeOptions["planTools"]>;
	readonly deferredTools?: NodeTurnRuntimeOptions["deferredTools"];
	readonly loadToolActivations?: NodeTurnRuntimeOptions["loadToolActivations"];
	readonly hookRunner?: HookRunnerContract;
		readonly contextItemCoordinator?: ContextItemCoordinatorContract;
		readonly agentBudget?: NodeTurnRuntimeOptions["agentBudget"];
		readonly agentCheckpoint?: NodeTurnRuntimeOptions["agentCheckpoint"];
		readonly isMutatingTool?: NodeTurnRuntimeOptions["isMutatingTool"];
	readonly loadLocalImages?: NodeTurnRuntimeOptions["loadLocalImages"];
	readonly recordDiagnostic?: NodeTurnRuntimeOptions["recordDiagnostic"];
}): NodeTurnRuntime {
	return new NodeTurnRuntime({
		sessionId: "session-1",
		workspaceRoot: "/workspace",
		threadId: "session-1",
		instructions: "You are mycli.",
		...(options.agentBudget ? { agentBudget: options.agentBudget } : {}),
		store: options.store,
		resolveConfig: () => options.runtimeConfig ?? config(),
		createProvider: () => options.provider,
		loadLocalImages: options.loadLocalImages ?? ((paths) => paths.map(() => ({
			mediaType: "image/png" as const,
			data: "aW1hZ2U=",
		}))),
		createTurnId: () => "turn-1",
		clock: clockSequence(),
		sleep: async () => {},
		random: () => 0.5,
		planTools: options.planTools ?? (() => options.toolDefinitions ?? [READ_TOOL_DEFINITION]),
		...(options.deferredTools ? { deferredTools: options.deferredTools } : {}),
		...(options.loadToolActivations ? { loadToolActivations: options.loadToolActivations } : {}),
		toolRouter: options.toolRouter,
		publishLifecycle: options.publishLifecycle ?? (() => undefined),
		...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
		...(options.approvalCoordinator ? { approvalCoordinator: options.approvalCoordinator } : {}),
		...(options.clarificationCoordinator ? {
			clarificationCoordinator: options.clarificationCoordinator,
		} : {}),
		...(options.queueCoordinator ? { queueCoordinator: options.queueCoordinator } : {}),
		...(options.monotonicClock ? { monotonicClock: options.monotonicClock } : {}),
		...(options.recordDiagnostic ? { recordDiagnostic: options.recordDiagnostic } : {}),
		...(options.compactionCoordinator ? {
			compactionCoordinator: options.compactionCoordinator,
		} : {}),
		...(options.createCompactionCoordinator ? {
			createCompactionCoordinator: options.createCompactionCoordinator,
		} : {}),
		...(options.memoryContextService ? {
			memoryContextService: options.memoryContextService,
		} : {}),
		...(options.providerContinuation ? {
			providerContinuation: options.providerContinuation,
		} : {}),
		...(options.writeTerminalSnapshot ? {
			writeTerminalSnapshot: options.writeTerminalSnapshot,
		} : {}),
		...(options.executionPolicyCoordinator ? {
			executionPolicyCoordinator: options.executionPolicyCoordinator,
		} : {}),
		...(options.hookRunner ? { hookRunner: options.hookRunner } : {}),
		...(options.contextItemCoordinator ? {
			contextItemCoordinator: options.contextItemCoordinator,
		} : {}),
		...(options.agentCheckpoint ? { agentCheckpoint: options.agentCheckpoint } : {}),
		isMutatingTool: options.isMutatingTool ?? ((toolName) => toolName !== "Read"),
	});
}

function executionProfile() {
	return Object.freeze({
		mode: "workspace-write" as const,
		filesystem: "workspace_write" as const,
		network: "disabled" as const,
		writableRoots: Object.freeze(["/workspace"]),
	});
}

function continuationFixture(trace: string[], initialState?: unknown) {
	const states: PersistedProviderContinuation[] = [];
	const coordinator = new ProviderContinuationCoordinator({
		sessionId: "session-1",
		...(initialState === undefined ? {} : { initialState }),
		persist: (state) => {
			states.push(state);
			trace.push(state.eligible
				? `continuation:eligible:${state.response_id}`
				: `continuation:invalid:${state.failure_reason}`);
		},
	});
	return { coordinator, states };
}

function memoryContextFixture(trace: string[], failAction = false): {
	readonly service: MemoryContextServiceContract;
	readonly actions: string[];
	readonly collectCalls: number;
	readonly collectSignals: (AbortSignal | undefined)[];
} {
	const state = {
		collectCalls: 0,
		actions: [] as string[],
		collectSignals: [] as (AbortSignal | undefined)[],
	};
	return {
		get collectCalls() { return state.collectCalls; },
		actions: state.actions,
		collectSignals: state.collectSignals,
		service: {
			collect: async (input) => {
				state.collectCalls += 1;
				state.collectSignals.push(input.signal);
				trace.push("memory:collect");
				return {
					records: [],
					item: { type: "user", text: "<memory-reference>\nnot current input\n</memory-reference>" },
				};
			},
			applyExplicitActions: async ({ userMessage }) => {
				state.actions.push(userMessage);
				trace.push("memory:action");
				if (failAction) throw new Error("memory body must stay private");
				return [];
			},
		},
	};
}

class ScriptedCompactionCoordinator implements CompactionCoordinatorContract {
	readonly calls: CompactInput[] = [];
	readonly #trace: string[];
	readonly #results: readonly CompactionResult[];

	constructor(trace: string[], results: readonly CompactionResult[]) {
		this.#trace = trace;
		this.#results = results;
	}

	async compact(input: CompactInput): Promise<CompactionResult> {
		this.calls.push(input);
		this.#trace.push(`compact:${input.source}`);
		return this.#results[this.calls.length - 1]
			?? compactionResult("not_needed", input.conversation);
	}
}

function compactionResult(
	status: CompactionResult["status"],
	providerConversation: readonly CanonicalConversationItem[],
): CompactionResult {
	return {
		status,
		providerConversation,
		rehydration: [],
		beforeTokens: 100,
		afterTokens: status === "compressed" ? 40 : 100,
	};
}

interface ApprovalRequestFixture {
	readonly sessionId: string;
	readonly decisionId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly options: readonly ["approve_once", "reject"];
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly turnId: string;
	readonly call: CanonicalToolCall;
	readonly remainingCalls: readonly CanonicalToolCall[];
	readonly conversation: readonly CanonicalMessage[];
	readonly userMessage: string;
	readonly providerProtocol: ProtocolId;
	readonly assistantText: string;
	readonly responseId?: string;
	readonly usage: Readonly<Record<string, number>>;
	readonly preview: string;
	readonly reason: string;
	readonly preparedMutationGuard?: PreparedMutationGuard;
}

interface ApprovalCoordinatorFixture {
	suspend(input: Omit<
		ApprovalRequestFixture,
		"sessionId" | "decisionId" | "callId" | "toolName" | "options" | "clientUserMessageId"
	> & { readonly clientUserMessageId?: string }): ApprovalRequestFixture;
	pending(): ApprovalRequestFixture | undefined;
	resolve(input: {
		readonly decisionId: string;
		readonly choice: "approve_once" | "reject";
		readonly signal: AbortSignal;
		readonly onExecutionStart?: () => void;
	}): Promise<{
		readonly status: "completed" | "rejected";
		readonly continuation: ApprovalRequestFixture;
		readonly toolResult: ToolExecutionResult;
	} | {
		readonly status: "interrupted";
		readonly turn: RuntimeTurnRecord;
	}>;
	finish(decisionId: string): void;
}

interface ClarificationRequestFixture {
	readonly sessionId: string;
	readonly requestId: string;
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly turnId: string;
	readonly call: CanonicalToolCall;
	readonly remainingCalls: readonly CanonicalToolCall[];
	readonly conversation: readonly CanonicalMessage[];
	readonly userMessage: string;
	readonly providerProtocol: ProtocolId;
	readonly assistantText: string;
	readonly responseId?: string;
	readonly usage: Readonly<Record<string, number>>;
	readonly question: string;
	readonly options: readonly {
		readonly label: string;
		readonly description?: string;
	}[];
	readonly header: string;
	readonly multiSelect: boolean;
}

interface ClarificationCoordinatorFixture {
	suspend(input: Omit<ClarificationRequestFixture, "sessionId" | "requestId">): ClarificationRequestFixture;
	pending(): ClarificationRequestFixture | undefined;
	cancel(input: { readonly requestId: string }): ClarificationRequestFixture;
	resolve(input: { readonly requestId: string; readonly response: string }): {
		readonly continuation: ClarificationRequestFixture;
		readonly response: string;
	};
}

function clarificationRuntimeFixture(trace: string[], store: FakeStore) {
	let current: ClarificationRequestFixture | undefined;
	const coordinator: ClarificationCoordinatorFixture = {
		suspend: (input) => {
			trace.push("clarification:suspend");
			current = Object.freeze({
				...input,
				sessionId: "session-1",
				requestId: input.call.callId,
			});
			return current;
		},
		pending: () => current,
		cancel: (input) => {
			assert.ok(current);
			assert.equal(input.requestId, current.requestId);
			trace.push(`clarification:cancel:${input.requestId}`);
			const cancelled = current;
			current = undefined;
			return cancelled;
		},
		resolve: (input) => {
			assert.ok(current);
			assert.equal(input.requestId, current.requestId);
			trace.push(`clarification:resolve:${input.requestId}`);
			const continuation = current;
			store.appendToolResult({
				sessionId: "session-1",
				clientTurnId: continuation.clientTurnId,
				result: {
					callId: continuation.call.callId,
					toolName: continuation.call.name,
					output: `User response: ${input.response}`,
					success: true,
				},
				summary: "User answered clarification",
				metadata: { request_id: input.requestId },
			});
			current = undefined;
			return { continuation, response: input.response };
		},
	};
	return { coordinator };
}

function approvalRuntimeFixture(
	trace: string[],
	router: ToolRouterContract,
	store: FakeStore,
	options: { readonly finishFailure?: boolean } = {},
) {
	let current: ApprovalRequestFixture | undefined;
	const coordinator: ApprovalCoordinatorFixture = {
		suspend: (input) => {
			trace.push("approval:suspend");
			const pending: ApprovalRequestFixture = Object.freeze({
				...input,
				clientUserMessageId: input.clientUserMessageId ?? input.clientTurnId,
				sessionId: "session-1",
				decisionId: input.call.callId,
				callId: input.call.callId,
				toolName: input.call.name,
				options: Object.freeze(["approve_once", "reject"] as const),
			});
			current = pending;
			return pending;
		},
		pending: () => current,
		resolve: async (input) => {
			assert.ok(current);
			assert.equal(input.decisionId, current.decisionId);
			trace.push(`approval:resolve:${input.decisionId}`);
			const continuation = current;
			let toolResult: ToolExecutionResult;
			if (input.choice === "approve_once") {
				input.onExecutionStart?.();
				toolResult = await router.execute(continuation.call, {
					signal: input.signal,
					ownerSessionId: "session-1",
					callId: continuation.call.callId,
					publishLifecycle: () => {},
				});
			} else {
				toolResult = {
					callId: continuation.call.callId,
					toolName: continuation.call.name,
					success: false,
					modelOutput: "Tool denied\nError kind: approval_rejected",
					summary: "Tool rejected",
					errorKind: "approval_rejected",
					metadata: {},
				};
			}
			store.appendToolResult({
				sessionId: "session-1",
				clientTurnId: continuation.clientTurnId,
				result: {
					callId: toolResult.callId,
					toolName: toolResult.toolName,
					output: toolResult.modelOutput,
					success: toolResult.success,
				},
				summary: toolResult.summary,
				metadata: toolResult.metadata,
				...(toolResult.errorKind ? { errorKind: toolResult.errorKind } : {}),
			});
			return {
				status: input.choice === "approve_once" ? "completed" : "rejected",
				continuation,
				toolResult,
				};
		},
		finish: (decisionId) => {
			trace.push(`approval:finish:${decisionId}`);
			if (options.finishFailure) throw new StorageFailure("approval finalization failed");
			if (current?.decisionId === decisionId) current = undefined;
		},
		};
	return { coordinator, pending: () => current };
}

async function resolveApproval(
	runtime: NodeTurnRuntime,
	input: { readonly decisionId: string; readonly choice: "approve_once" | "reject" },
	emit: (event: RuntimeEvent) => void,
	signal: AbortSignal,
): Promise<RuntimeTurnRecord> {
	const method = Reflect.get(runtime, "resolveApproval");
	assert.equal(typeof method, "function", "NodeTurnRuntime.resolveApproval must exist");
	return method.call(runtime, input, emit, { signal }) as Promise<RuntimeTurnRecord>;
}

async function resolveClarification(
	runtime: NodeTurnRuntime,
	input: { readonly requestId: string; readonly response: string },
	emit: (event: RuntimeEvent) => void,
	signal: AbortSignal,
): Promise<RuntimeTurnRecord> {
	const method = Reflect.get(runtime, "resolveClarification");
	assert.equal(typeof method, "function", "NodeTurnRuntime.resolveClarification must exist");
	return method.call(runtime, input, emit, { signal }) as Promise<RuntimeTurnRecord>;
}

function queueFixture(store: FakeStore, trace: string[]) {
	let durable = emptyQueue();
	const committedQueueIds: string[] = [];
	const fixture = {
		failCommit: false,
		failImageLoad: false,
		failSave: false,
		committedQueueIds,
		coordinator: undefined as unknown as QueueCoordinator,
	};
	const queueStore: QueueCoordinatorStore = {
		loadCommittedQueueIds: () => new Set(committedQueueIds),
		saveSnapshot: (snapshot) => {
			if (fixture.failSave) throw new StorageFailure("queue save failed");
			durable = snapshot;
			trace.push("queue:save");
		},
		commitPending: (_turnId, records) => {
			if (fixture.failCommit) throw new StorageFailure("queue commit failed");
			for (const record of records) {
				if (!committedQueueIds.includes(record.queueId)) {
					committedQueueIds.push(record.queueId);
					store.items.push({ type: "user", text: record.text });
				}
			}
			const ids = new Set(records.map((record) => record.queueId));
			durable = Object.freeze({
				...durable,
				revision: durable.revision + 1,
				pendingSteers: Object.freeze(durable.pendingSteers.filter(
					(record) => !ids.has(record.queueId),
				)),
			});
			trace.push("queue:commit");
			return durable;
		},
	};
	let nextQueueId = 0;
	fixture.coordinator = new QueueCoordinator({
		initial: durable,
		store: queueStore,
		activeTurnId: null,
		createQueueId: () => `queue-${++nextQueueId}`,
		clock: () => "2026-08-04T00:00:00.000Z",
		loadLocalImages: () => {
			if (fixture.failImageLoad) throw new Error("image unavailable");
			return [{ mediaType: "image/png", data: "aW1hZ2U=" }];
		},
	});
	return fixture;
}

function emptyQueue(): QueueSnapshot {
	return Object.freeze({
		sessionId: "session-1",
		revision: 0,
		pendingSteers: Object.freeze([] as QueuedInput[]),
		rejectedSteers: Object.freeze([] as QueuedInput[]),
		followUps: Object.freeze([] as QueuedInput[]),
	});
}

class FakeStore implements TurnStore {
	readonly trace: string[];
	readonly items: CanonicalConversationItem[] = [];
	readonly toolResults: AppendToolResultInput[] = [];
	readonly reservations: ReserveTurnInput[] = [];
	readonly completions: CompleteStoredTurnInput[] = [];
	turn: RuntimeTurnRecord | undefined;
	afterResultPersisted?: () => void;
	failToolResultPersistence = false;

	constructor(trace: string[]) {
		this.trace = trace;
	}

	reserveTurn(input: ReserveTurnInput): TurnReservation {
		this.trace.push("reserve");
		this.reservations.push(input);
		this.turn = turnRecord(input);
		if (input.source !== "agent_mailbox") {
			this.items.push({
				type: "user",
				text: input.userText,
				...(input.images && input.images.length > 0 ? { images: input.images } : {}),
			});
		}
		return { kind: "reserved", turn: this.turn };
	}

	loadTurn(): RuntimeTurnRecord | undefined {
		return this.turn;
	}

	loadConversation() {
		return this.items.flatMap((item) => item.type === "user" || item.type === "assistant"
			? [{ role: item.type, content: item.text }]
			: []);
	}

	loadConversationItems(): readonly CanonicalConversationItem[] {
		return this.items;
	}

	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void {
		this.trace.push("persist:calls");
		this.items.push({
			type: "assistant_tool_calls",
			text: input.assistantText,
			calls: input.calls,
			...(input.responseId ? { responseId: input.responseId } : {}),
			...(input.providerState ? { providerState: input.providerState } : {}),
		});
	}

	appendContextItem(input: Parameters<TurnStore["appendContextItem"]>[0]): void {
		this.trace.push("persist:context");
		this.items.push({ type: "context", text: input.text, metadata: input.metadata });
	}

	appendToolResult(input: AppendToolResultInput): void {
		if (this.failToolResultPersistence) {
			throw new StorageFailure("tool result persistence failed");
		}
		this.trace.push(`persist:result:${input.result.callId}`);
		this.toolResults.push(input);
		this.items.push({ type: "tool_result", ...input.result });
		if (input.contextItem) {
			this.trace.push("persist:context");
			this.items.push({
				type: "context",
				text: input.contextItem.text,
				metadata: input.contextItem.metadata,
			});
		}
		this.afterResultPersisted?.();
	}

	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord {
		this.trace.push("complete");
		this.completions.push(input);
		assert.ok(this.turn);
		this.items.push({ type: "assistant", text: input.assistantText });
		this.turn = {
			...this.turn,
			status: "completed",
			result: {
				assistant_text: input.assistantText,
				...(input.responseId ? { response_id: input.responseId } : {}),
				usage: input.usage,
			},
			completed_at: input.completedAt,
		};
		return this.turn;
	}

	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord {
		assert.ok(this.turn);
		this.turn = {
			...this.turn,
			status: input.code === "interrupted" ? "interrupted" : "failed",
			error_code: input.code,
			result: { message: input.message },
			completed_at: input.completedAt,
		};
		return this.turn;
	}

	recoverInterruptedTurns(): number {
		return 0;
	}

	close(): void {}
}

class FakeRouter implements ToolRouterContract {
	readonly #trace: string[];
	readonly #result: ToolExecutionResult;
	readonly #previewChanges: readonly FileMutationPreviewChange[];
	options: ToolExecutionOptions | undefined;
	previewOptions: ToolPreviewOptions | undefined;

	constructor(
		trace: string[],
		result: ToolExecutionResult,
		previewChanges: readonly FileMutationPreviewChange[] = [],
	) {
		this.#trace = trace;
		this.#result = result;
		this.#previewChanges = previewChanges;
	}

	async preview(
		_call: CanonicalToolCall,
		options: ToolPreviewOptions,
	): Promise<readonly FileMutationPreviewChange[]> {
		this.previewOptions = options;
		return this.#previewChanges;
	}

	async execute(call: CanonicalToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
		this.options = options;
		this.#trace.push(`tool:${call.callId}`);
		return { ...this.#result, callId: call.callId };
	}
}

function shellLifecycleEvent(): ShellLifecycleEvent {
	return {
		type: "shell_lifecycle",
		kind: "shell.output",
		shellId: "shell-1",
		ownerSessionId: "session-1",
		callId: "call-1",
		sequence: 1,
		commandPreview: "npm test",
		background: true,
		processState: "running_background",
		tty: false,
		yielded: true,
		outputDelta: "ready\n",
	};
}

class SequencedRouter implements ToolRouterContract {
	readonly #trace: string[];
	readonly #parallelToolNames: ReadonlySet<string>;
	readonly #previewChanges: readonly FileMutationPreviewChange[];
	readonly #preparedGuard?: PreparedMutationGuard;
	calls = 0;

	constructor(
		trace: string[],
		parallelToolNames: ReadonlySet<string> = new Set(),
		previewChanges: readonly FileMutationPreviewChange[] = [],
		preparedGuard?: PreparedMutationGuard,
	) {
		this.#trace = trace;
		this.#parallelToolNames = parallelToolNames;
		this.#previewChanges = previewChanges;
		this.#preparedGuard = preparedGuard;
	}

	async prepare(): Promise<PreparedToolCall> {
		return Object.freeze({
			fileChanges: this.#previewChanges,
			...(this.#preparedGuard ? { mutationGuard: this.#preparedGuard } : {}),
		});
	}

	async preview(): Promise<readonly FileMutationPreviewChange[]> {
		return this.#previewChanges;
	}

	supportsParallelToolCalls(call: CanonicalToolCall): boolean {
		return this.#parallelToolNames.has(call.name);
	}

	async execute(call: CanonicalToolCall): Promise<ToolExecutionResult> {
		this.calls += 1;
		this.#trace.push(`tool:${call.callId}`);
		return successResult(call.callId);
	}
}

class ControlledToolRouter implements ToolRouterContract {
	readonly #trace: string[];
	readonly #parallelToolNames: ReadonlySet<string>;
	readonly #pending = new Map<string, {
		readonly call: CanonicalToolCall;
		readonly signal: AbortSignal;
		readonly onAbort: () => void;
		readonly resolve: (result: ToolExecutionResult) => void;
		reject(error: Error): void;
	}>();
	readonly #startedWaiters: Array<{ readonly count: number; resolve(): void }> = [];
	readonly startedCallIds: string[] = [];
	readonly executionOptionsByCallId = new Map<string, ToolExecutionOptions>();

	constructor(trace: string[], parallelToolNames: ReadonlySet<string>) {
		this.#trace = trace;
		this.#parallelToolNames = parallelToolNames;
	}

	supportsParallelToolCalls(call: CanonicalToolCall): boolean {
		return this.#parallelToolNames.has(call.name);
	}

	async execute(call: CanonicalToolCall, options: ToolExecutionOptions): Promise<ToolExecutionResult> {
		this.startedCallIds.push(call.callId);
		this.executionOptionsByCallId.set(call.callId, options);
		this.#trace.push(`tool:start:${call.callId}`);
		this.#resolveStartedWaiters();
		return await new Promise<ToolExecutionResult>((resolve, reject) => {
			const onAbort = () => {
				this.#pending.delete(call.callId);
				const error = new Error("tool interrupted");
				error.name = "AbortError";
				reject(error);
			};
			this.#pending.set(call.callId, { call, signal: options.signal, onAbort, resolve, reject });
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	release(callId: string): void {
		const pending = this.#pending.get(callId);
		assert.ok(pending, `tool ${callId} must be pending`);
		this.#pending.delete(callId);
		pending.signal.removeEventListener("abort", pending.onAbort);
		this.#trace.push(`tool:finish:${callId}`);
		pending.resolve({
			...successResult(callId),
			toolName: pending.call.name,
		});
	}

	releaseFailure(callId: string): void {
		const pending = this.#pending.get(callId);
		assert.ok(pending, `tool ${callId} must be pending`);
		this.#pending.delete(callId);
		pending.signal.removeEventListener("abort", pending.onAbort);
		this.#trace.push(`tool:finish:${callId}`);
		pending.resolve({
			callId,
			toolName: pending.call.name,
			success: false,
			modelOutput: "Read failed\nError kind: read_failed",
			summary: "Read failed",
			errorKind: "read_failed",
			metadata: Object.freeze({}),
		});
	}

	fail(callId: string): void {
		const pending = this.#pending.get(callId);
		assert.ok(pending, `tool ${callId} must be pending`);
		this.#pending.delete(callId);
		pending.signal.removeEventListener("abort", pending.onAbort);
		this.#trace.push(`tool:fail:${callId}`);
		pending.reject(new Error("controlled tool failure"));
	}

	waitForStarted(count: number): Promise<void> {
		if (this.startedCallIds.length >= count) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${count} tools`)), 1_000);
			this.#startedWaiters.push({
				count,
				resolve: () => {
					clearTimeout(timeout);
					resolve();
				},
			});
		});
	}

	#resolveStartedWaiters(): void {
		for (let index = this.#startedWaiters.length - 1; index >= 0; index -= 1) {
			const waiter = this.#startedWaiters[index]!;
			if (this.startedCallIds.length < waiter.count) continue;
			this.#startedWaiters.splice(index, 1);
			waiter.resolve();
		}
	}
}

function scriptedProvider(
	trace: string[],
	requests: ProviderRequest[],
	steps: readonly (readonly ProviderEvent[])[],
): ModelProvider {
	let index = 0;
	return {
		stream: (request) => {
			requests.push(request);
			trace.push(`provider:${index + 1}`);
			const events = steps[index++] ?? [];
			return providerEvents(events);
		},
	};
}

async function* providerEvents(events: readonly ProviderEvent[]): AsyncIterable<ProviderEvent> {
	for (const event of events) {
		yield event;
	}
}

async function* textThenFailure(text: string, error: Error): AsyncIterable<ProviderEvent> {
	yield { type: "text_delta", text };
	throw error;
}

function failingProviderEvents(error: Error): AsyncIterable<ProviderEvent> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
			return { next: () => Promise.reject(error) };
		},
	};
}

function successResult(callId: string): ToolExecutionResult {
	return {
		callId,
		toolName: "Read",
		success: true,
		modelOutput: READ_OUTPUT,
		summary: "Read README.md",
		metadata: { path: "README.md" },
	};
}

function submission() {
	return { clientTurnId: "client-1", message: "Read README.md" };
}

function config(overrides: Partial<NodeRuntimeConfig> = {}): NodeRuntimeConfig {
	return {
		...NODE_RUNTIME_CONTEXT_DEFAULTS,
		workspaceRoot: "/workspace",
		homeDir: "/home/test",
		provider: "openai",
		protocol: "responses",
		model: "gpt-test",
		apiBaseUrl: "https://api.openai.com/v1",
		apiKey: "test-key",
		authRef: "openai",
		sessionId: "session-1",
		sessionsDbPath: "/home/test/.mycli/sessions.db",
		maxPromptTokens: 12_000,
		requestMaxRetries: 4,
		streamMaxRetries: 5,
		reasoningEffort: "medium",
		thinkingEnabled: true,
		supportsImages: true,
		...overrides,
		webSearchMode: overrides.webSearchMode ?? "live",
		requestPermissionsToolEnabled: overrides.requestPermissionsToolEnabled ?? false,
		updatesCheckOnStartup: overrides.updatesCheckOnStartup ?? true,
	};
}

function numberSequence(values: readonly number[]): () => number {
	let index = 0;
	return () => values[index++] ?? values.at(-1) ?? 0;
}

function turnRecord(input: ReserveTurnInput): RuntimeTurnRecord {
	return {
		schema_version: 1,
		session_id: input.sessionId,
		client_turn_id: input.clientTurnId,
		turn_id: input.turnId,
		request_fingerprint: input.requestFingerprint,
		status: "in_progress",
		error_code: null,
		result: null,
		started_at: input.startedAt,
		completed_at: null,
	};
}

function clockSequence(): () => string {
	let tick = 0;
	return () => `2026-08-04T00:00:0${tick++}+00:00`;
}

const READ_ARGUMENTS = "{\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}";
const WRITE_ARGUMENTS = "{\"file_path\":\"notes.txt\",\"content\":\"hello\"}";
const WRITE_PREVIEW_CHANGES = Object.freeze([Object.freeze({
	version: 1 as const,
	kind: "add" as const,
	path: "notes.txt",
	diff: "--- notes.txt:before\n+++ notes.txt:after\n@@ -0,0 +1 @@\n+hello\n",
	addedLines: 1,
	removedLines: 0,
	truncated: false,
	omittedChars: 0,
})]);
const WRITE_PREPARED_GUARD: PreparedMutationGuard = Object.freeze({
	version: 1,
	mutationId: "a".repeat(64),
	intentSha256: "b".repeat(64),
	targets: Object.freeze([Object.freeze({
		pathSha256: "c".repeat(64),
		existed: false,
		resultSha256: "d".repeat(64),
	})]),
});
const READ_OUTPUT = "Read succeeded\nPath: README.md";
const CALL: CanonicalToolCall = {
	callId: "call-1",
	name: "Read",
	argumentsJson: READ_ARGUMENTS,
};
