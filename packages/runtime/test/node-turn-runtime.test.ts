import assert from "node:assert/strict";
import test from "node:test";
import {
	NODE_RUNTIME_CONTEXT_DEFAULTS,
	type NodeRuntimeConfig,
} from "@mycli/config";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import type {
	CanonicalConversationItem,
	CanonicalToolCall,
	ProviderEvent,
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
	CompleteStoredTurnInput,
	FailStoredTurnInput,
	ReserveTurnInput,
	TurnStore,
	TurnReservation,
} from "@mycli/storage";
import { StorageFailure } from "@mycli/storage";
import {
	READ_TOOL_DEFINITION,
	SHELL_TOOL_DEFINITION,
	WRITE_TOOL_DEFINITION,
	type ToolExecutionResult,
	type ToolExecutionOptions,
	type ToolRouterContract,
} from "@mycli/tools";
import { ApprovalPolicy } from "../../tools/src/approval-policy.ts";
import {
	NodeTurnRuntime,
	ProviderContinuationCoordinator,
	QueueCoordinator,
	type CompactInput,
	type CompactionCoordinatorContract,
	type CompactionResult,
	type MemoryContextServiceContract,
	type NodeTurnRuntimeOptions,
	type PersistedProviderContinuation,
	type QueueCoordinatorStore,
} from "../src/index.ts";

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
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(trace.slice(-2), ["complete", "snapshot"]);
	assert.equal(trace.includes("memory:action"), false);
});

test("persists safe Responses continuation before tool execution and terminal completion", async () => {
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
	assert.ok(trace.indexOf("continuation:eligible:resp-tools") < trace.indexOf("tool:call-1"));
	assert.ok(trace.indexOf("continuation:eligible:resp-final") < trace.indexOf("complete"));
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
	const backendLifecycle: ShellLifecycleEvent[] = [];
	const instance = createRuntime({
		store,
		provider,
		toolRouter,
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
		"tool_call_accepted",
		"tool_execution_started",
		"tool_execution_completed",
		"text_delta",
		"message_complete",
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
	assert.equal(toolRouter.options?.ownerSessionId, "session-1");
	assert.equal(toolRouter.options?.callId, "call-1");
	toolRouter.options?.publishLifecycle(shellLifecycleEvent());
	assert.deepEqual(backendLifecycle, [shellLifecycleEvent()]);
	assert.equal(emitted.some((event) => event.type === "shell_lifecycle"), false);
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

test("strict mutation policy durably suspends before requesting approval", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-write", name: "Write", argumentsJson: WRITE_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);
	const router = new SequencedRouter(trace);
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
	const request = emitted.find((event) => event.type === "approval_requested");
	assert.ok(request);
	assert.equal("decisionId" in request ? request.decisionId : undefined, "call-write");
	assert.equal("preview" in request ? request.preview : "", "Write notes.txt");
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
	await instance.submit(submission(), () => {}, { signal: new AbortController().signal });
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

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		compactionCoordinator: coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(trace.slice(0, 3), ["reserve", "compact:pre_turn", "provider:1"]);
	assert.deepEqual([...coordinator.calls[0]!.freshItemIds], [
		"turn-1:user:client-1",
	]);
	assert.deepEqual(requests[0]?.items, compacted);
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
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.ok(trace.indexOf("queue:commit") < trace.indexOf("provider:2"));
	assert.deepEqual(requests[1]?.items?.at(-1), {
		type: "user",
		text: "Also inspect package.json",
	});
	assert.deepEqual(queue.committedQueueIds, ["queue-1"]);
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
		planTools: ({ shell }) => shell
			? [READ_TOOL_DEFINITION, SHELL_TOOL_DEFINITION]
			: [READ_TOOL_DEFINITION],
	});

	const result = await runtime.submit(submission(), () => undefined, {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), ["Read", "Shell"]);
	assert.deepEqual(calls, ["begin:turn-1", "finish:turn-1"]);
});

test("rejects provider calls for tools outside the frozen turn exposure", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const router = new SequencedRouter(trace);
	const provider = scriptedProvider(trace, [], [[
		{
			type: "tool_call",
			callId: "call-shell-untrusted",
			name: "Shell",
			argumentsJson: "{\"command\":\"printf unsafe\"}",
		},
		{ type: "completed", responseId: "resp-shell-untrusted" },
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

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "tool_protocol_error");
	assert.equal(router.calls, 0);
	assert.equal(trace.includes("persist:calls"), false);
});

function createRuntime(options: {
	readonly store: TurnStore;
	readonly provider: ModelProvider;
	readonly toolRouter: ToolRouterContract;
	readonly queueCoordinator?: QueueCoordinator;
	readonly monotonicClock?: () => number;
	readonly approvalPolicy?: ApprovalPolicy;
	readonly approvalCoordinator?: ApprovalCoordinatorFixture;
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
}): NodeTurnRuntime {
	return new NodeTurnRuntime({
		sessionId: "session-1",
		workspaceRoot: "/workspace",
		threadId: "session-1",
		instructions: "You are mycli.",
		store: options.store,
		resolveConfig: () => options.runtimeConfig ?? config(),
		createProvider: () => options.provider,
		createTurnId: () => "turn-1",
		clock: clockSequence(),
		sleep: async () => {},
		random: () => 0.5,
		planTools: options.planTools ?? (() => options.toolDefinitions ?? [READ_TOOL_DEFINITION]),
		toolRouter: options.toolRouter,
		publishLifecycle: options.publishLifecycle ?? (() => undefined),
		...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
		...(options.approvalCoordinator ? { approvalCoordinator: options.approvalCoordinator } : {}),
		...(options.queueCoordinator ? { queueCoordinator: options.queueCoordinator } : {}),
		...(options.monotonicClock ? { monotonicClock: options.monotonicClock } : {}),
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
	readonly turnId: string;
	readonly call: CanonicalToolCall;
	readonly remainingCalls: readonly CanonicalToolCall[];
	readonly userMessage: string;
	readonly providerProtocol: "responses" | "chat_completions";
	readonly assistantText: string;
	readonly responseId?: string;
	readonly usage: Readonly<Record<string, number>>;
	readonly preview: string;
	readonly reason: string;
}

interface ApprovalCoordinatorFixture {
	suspend(input: Omit<ApprovalRequestFixture, "sessionId" | "decisionId" | "callId" | "toolName" | "options">): ApprovalRequestFixture;
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
	}>;
	finish(decisionId: string): void;
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

function queueFixture(store: FakeStore, trace: string[]) {
	let durable = emptyQueue();
	const committedQueueIds: string[] = [];
	const fixture = {
		failCommit: false,
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
	turn: RuntimeTurnRecord | undefined;
	afterResultPersisted?: () => void;

	constructor(trace: string[]) {
		this.trace = trace;
	}

	reserveTurn(input: ReserveTurnInput): TurnReservation {
		this.trace.push("reserve");
		this.turn = turnRecord(input);
		this.items.push({ type: "user", text: input.userText });
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
		});
	}

	appendToolResult(input: AppendToolResultInput): void {
		this.trace.push(`persist:result:${input.result.callId}`);
		this.toolResults.push(input);
		this.items.push({ type: "tool_result", ...input.result });
		this.afterResultPersisted?.();
	}

	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord {
		this.trace.push("complete");
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
	options: ToolExecutionOptions | undefined;

	constructor(trace: string[], result: ToolExecutionResult) {
		this.#trace = trace;
		this.#result = result;
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
	calls = 0;

	constructor(trace: string[]) {
		this.#trace = trace;
	}

	async execute(call: CanonicalToolCall): Promise<ToolExecutionResult> {
		this.calls += 1;
		this.#trace.push(`tool:${call.callId}`);
		return successResult(call.callId);
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
		promptCacheKeyEnabled: true,
		...overrides,
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
const READ_OUTPUT = "Read succeeded\nPath: README.md";
const CALL: CanonicalToolCall = {
	callId: "call-1",
	name: "Read",
	argumentsJson: READ_ARGUMENTS,
};
