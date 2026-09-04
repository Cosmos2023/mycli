import assert from "node:assert/strict";
import test from "node:test";
import * as runtime from "../src/index.ts";

test("clarification continuation survives coordinator recreation and commits the user response", () => {
	const store = new MemoryClarificationStore();
	const Coordinator = Reflect.get(runtime, "ClarificationContinuationCoordinator") as unknown as
		| (new (options: CoordinatorOptions) => CoordinatorContract)
		| undefined;
	assert.equal(typeof Coordinator, "function", "ClarificationContinuationCoordinator must be exported");
	const coordinator = new Coordinator!({
		sessionId: "session-1",
		workspaceRoot: "/repo",
		threadId: "thread-1",
		store,
		clock: () => "2026-08-06T00:00:00.000Z",
	});
	const pending = coordinator.suspend({
		clientTurnId: "client-1",
		clientUserMessageId: "message-1",
		turnId: "turn-1",
		userMessage: "Help me choose",
		providerProtocol: "responses",
		call: {
			callId: "call-question",
			name: "AskUserQuestion",
			argumentsJson: "{}",
		},
		remainingCalls: [],
		conversation: [{ role: "user", content: "Help me choose" }],
		assistantText: "",
		responseId: "resp-question",
		usage: { input_tokens: 3 },
		runSnapshot: runSnapshot(),
		question: "Which runtime?",
		options: [{ label: "Node" }, { label: "Python" }, { label: "Other" }],
		header: "Runtime",
		multiSelect: false,
	});
	assert.equal(pending.requestId, "call-question");
	assert.equal(store.turnRecord?.status, "waiting_clarification");

	const recovered = new Coordinator!({
		sessionId: "session-1",
		workspaceRoot: "/repo",
		threadId: "thread-1",
		store,
		clock: () => "2026-08-06T00:00:01.000Z",
	});
	assert.deepEqual(recovered.pending(), pending);
	assert.deepEqual(Reflect.get(recovered.pending() ?? {}, "runSnapshot"), runSnapshot());
	assert.throws(
		() => recovered.resolve({ requestId: "wrong", response: "Node" }),
		(error: unknown) => error instanceof Error
			&& "code" in error
			&& error.code === "clarification_not_pending",
	);
	assert.ok(recovered.pending());

	const resolved = recovered.resolve({ requestId: "call-question", response: "Node" });
	assert.equal(resolved.response, "Node");
	assert.equal(resolved.continuation.responseId, "resp-question");
	assert.deepEqual(store.toolResult, {
		callId: "call-question",
		toolName: "AskUserQuestion",
		output: "User response: Node",
		success: true,
	});
	assert.deepEqual(store.display, {
		header: "Runtime",
		question: "Which runtime?",
		response: "Node",
		multiSelect: false,
	});
	assert.equal(recovered.pending(), undefined);
});

test("reconstructs an event-referenced clarification conversation through the store", () => {
	const store = new MemoryClarificationStore();
	store.suspended = {
		user_message: "Help me choose",
		conversation: [],
		transcript_event_id: "event:tool-batch",
		suspend_reason: "clarification_required",
		pending_clarification: {
			request_id: "call-question",
			tool_call: {
				name: "AskUserQuestion",
				arguments: {},
				reason: "",
				call_id: "call-question",
			},
			question: "Which runtime?",
			options: [{ label: "Node" }],
			header: "Runtime",
			multi_select: false,
		},
		session_id: "session-1",
		client_turn_id: "client-1",
		client_user_message_id: "message-1",
		turn_id: "turn-1",
		provider_protocol: "responses",
		remaining_tool_calls: [],
		continuation: { assistant_text: "", response_id: "resp-question", usage: {} },
	};
	store.conversation = [
		{ role: "user", content: "Help me choose" },
		{ role: "assistant", content: "I need one detail." },
	];
	const Coordinator = Reflect.get(runtime, "ClarificationContinuationCoordinator") as unknown as
		new (options: CoordinatorOptions) => CoordinatorContract;
	const coordinator = new Coordinator({
		sessionId: "session-1",
		workspaceRoot: "/repo",
		threadId: "thread-1",
		store,
		clock: () => "2026-08-06T00:00:01.000Z",
	});

	assert.deepEqual(coordinator.pending()?.conversation, store.conversation);
});

interface CoordinatorOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly store: MemoryClarificationStore;
	readonly clock: () => string;
}

interface CoordinatorContract {
	suspend(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> & {
		readonly requestId: string;
	};
	pending(): Readonly<Record<string, unknown>> | undefined;
	resolve(input: { readonly requestId: string; readonly response: string }): {
		readonly response: string;
		readonly continuation: Readonly<Record<string, unknown>> & { readonly responseId?: string };
	};
}

class MemoryClarificationStore {
	suspended: unknown;
	conversation: readonly Readonly<{ readonly role: "user" | "assistant"; readonly content: string }>[] = [];
	turnRecord: Readonly<Record<string, unknown>> | undefined;
	toolResult: Readonly<Record<string, unknown>> | undefined;
	display: Readonly<Record<string, unknown>> | undefined;

	loadState(_sessionId: string, key: string): unknown {
		return key === "suspended_turn" ? this.suspended : undefined;
	}

	loadTurn(): { readonly status: "in_progress" } {
		return { status: "in_progress" };
	}

	loadConversation(): typeof this.conversation {
		return this.conversation;
	}

	deleteState(_sessionId: string, key: string): void {
		if (key === "suspended_turn") this.suspended = undefined;
		if (key === "turn_record") this.turnRecord = undefined;
	}

	saveClarificationSuspension(input: {
		readonly suspendedTurn: { readonly payload: unknown };
		readonly turnRecord: Readonly<Record<string, unknown>>;
	}): void {
		this.suspended = input.suspendedTurn.payload;
		this.turnRecord = input.turnRecord;
	}

	commitClarificationResponse(input: {
		readonly requestId: string;
		readonly display: Readonly<Record<string, unknown>>;
		readonly toolResult: { readonly result: Readonly<Record<string, unknown>> };
	}): void {
		const payload = this.suspended as {
			readonly pending_clarification?: { readonly request_id?: string };
		};
		assert.equal(payload.pending_clarification?.request_id, input.requestId);
		this.toolResult = input.toolResult.result;
		this.display = input.display;
		this.suspended = undefined;
		this.turnRecord = undefined;
	}
}

function runSnapshot() {
	return runtime.createRunExecutionSnapshot({
		turnId: "turn-1",
		collaborationMode: "plan",
		toolCatalog: {
			catalogVersion: 2,
			directTools: [{
				id: "builtin:AskUserQuestion",
				name: "AskUserQuestion",
				description: "Ask the user a question",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
			}],
		},
	});
}
