import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../src/index.ts";

const timestamp = "2026-08-04T00:00:00.000Z";

function parseRuntimeState(value: unknown): unknown {
	const parser = Reflect.get(contracts, "parseRuntimeState");
	assert.equal(typeof parser, "function");
	return Reflect.apply(parser as (input: unknown) => unknown, undefined, [value]);
}

function queuedInput(
	queueId: string,
	kind: "pending_steer" | "rejected_steer" | "follow_up",
) {
	return {
		queue_id: queueId,
		session_id: "s1",
		client_turn_id: `client-${queueId}`,
		target_turn_id: kind === "follow_up" ? null : "turn-1",
		kind,
		state: kind === "pending_steer" ? "accepted" : "queued",
		text: `message-${queueId}`,
		image_paths: [],
		source: "user",
		created_at: timestamp,
		updated_at: timestamp,
	};
}

function queueState() {
	return {
		kind: "input_queue",
		version: 1,
		payload: {
			session_id: "s1",
			revision: 3,
			pending_steers: [queuedInput("q1", "pending_steer")],
			rejected_steers: [queuedInput("q2", "rejected_steer")],
			follow_ups: [queuedInput("q3", "follow_up")],
			python_optional_field: { preserved: true },
		},
	} as const;
}

test("parses a Python-compatible queue snapshot", () => {
	const state = parseRuntimeState(queueState()) as { kind: string };
	assert.equal(state.kind, "input_queue");
});

test("rejects a queue record owned by another session", () => {
	const state = structuredClone(queueState());
	state.payload.pending_steers[0]!.session_id = "s2";
	assert.throws(() => parseRuntimeState(state), contracts.ContractValidationError);
});

test("rejects malformed queue roots, identities, and enums", () => {
	assert.throws(
		() => parseRuntimeState({ kind: "input_queue", version: 1, payload: [] }),
		contracts.ContractValidationError,
	);

	const missingIdentity = structuredClone(queueState());
	delete (missingIdentity.payload.pending_steers[0] as { queue_id?: string }).queue_id;
	assert.throws(
		() => parseRuntimeState(missingIdentity),
		contracts.ContractValidationError,
	);

	const invalidEnum = structuredClone(queueState());
	(invalidEnum.payload.pending_steers[0] as { state: string }).state = "delivered";
	assert.throws(() => parseRuntimeState(invalidEnum), contracts.ContractValidationError);
});

test("parses a Python-compatible pending decision", () => {
	assert.doesNotThrow(() => parseRuntimeState({
		kind: "pending_decision",
		version: 1,
		payload: {
			tool_call: {
				name: "Write",
				arguments: { file_path: "notes.txt", content: "hello" },
				reason: "Update notes",
				call_id: "call-write-1",
			},
			kind: "needs_choice",
			reason: "A workspace file will change.",
			preview: "Write notes.txt",
			options: ["approve_once", "reject"],
			command_pattern: null,
			proposed_execpolicy_pattern: null,
			metadata: { risk: "medium" },
		},
	}));
});

test("parses a Python-compatible suspended turn", () => {
	for (const providerProtocol of ["responses", "anthropic_messages"] as const) {
		assert.doesNotThrow(() => parseRuntimeState({
		kind: "suspended_turn",
		version: 1,
		payload: {
			user_message: "update the notes",
			conversation: [{
				role: "user",
				content: "update the notes",
				tool_call_id: null,
				response_id: null,
				metadata: {},
				blocks: [],
				tool_calls: [],
			}],
			suspend_reason: "approval_required",
			plan_items: [],
			pending_approval: {
				tool_call: {
					name: "Write",
					arguments: { file_path: "notes.txt", content: "hello" },
					reason: "Update notes",
					call_id: "call-write-1",
				},
				reason: "A workspace file will change.",
				preview: "Write notes.txt",
				command_pattern: null,
				proposed_execpolicy_pattern: null,
				metadata: {},
			},
			pending_clarification: null,
			client_turn_id: "client-1",
			turn_id: "turn-1",
			provider_protocol: providerProtocol,
			remaining_tool_calls: [],
		},
		}));
	}
});

test("parses an executing effect checkpoint", () => {
	assert.doesNotThrow(() => parseRuntimeState({
		kind: "effect_checkpoint",
		version: 1,
		payload: {
			session_id: "s1",
			client_turn_id: "client-1",
			turn_id: "turn-1",
			decision_id: "call-write-1",
			call_id: "call-write-1",
			tool_name: "Write",
			status: "executing",
			fingerprint: "sha256:abc123",
			updated_at: timestamp,
		},
	}));
});

test("parses a Python-compatible compact checkpoint", () => {
	assert.doesNotThrow(() => parseRuntimeState({
		kind: "compact_checkpoint",
		version: 1,
		payload: {
			version: 1,
			turn_id: "turn-1",
			reason: "context_limit",
			phase: "before_provider",
			window_number: 1,
			window_id: "window-1",
			history_item_count: 12,
			input_history_hash: "sha256:input",
			replacement_history_hash: "sha256:replacement",
			replacement_messages: [{
				role: "developer",
				content: "Summary",
				tool_call_id: null,
				response_id: null,
				metadata: {},
				blocks: [],
				tool_calls: [],
			}],
		},
	}));
});

test("parses an event-referenced compact checkpoint without replacement copies", () => {
	assert.doesNotThrow(() => parseRuntimeState({
		kind: "compact_checkpoint",
		version: 1,
		payload: {
			version: 1,
			turn_id: "turn-1",
			reason: "context_limit",
			phase: "pre_turn",
			window_number: 500,
			window_id: "window-500",
			history_item_count: 1_000,
			input_history_hash: "sha256:input",
			replacement_history_hash: "sha256:replacement",
			transcript_event_id: "compaction:window-500",
		},
	}));
	assert.throws(() => parseRuntimeState({
		kind: "compact_checkpoint",
		version: 1,
		payload: {
			version: 1,
			turn_id: "turn-1",
			reason: "context_limit",
			phase: "pre_turn",
			window_number: 1,
			window_id: "window-1",
			history_item_count: 1,
			input_history_hash: "sha256:input",
			replacement_history_hash: "sha256:replacement",
		},
	}), /compact checkpoint has no transcript source/u);
});

test("parses Python and Node Responses continuation fields", () => {
	assert.doesNotThrow(() => parseRuntimeState({
		kind: "responses_continuation",
		version: 1,
		payload: {
			response_id: "resp-1",
			request_signature: "sha256:request",
			request_input: [{ role: "user", content: "inspect" }],
			response_output: [{ role: "assistant", content: "done" }],
			eligible: true,
			failure_reason: null,
			session_id: "s1",
			protocol: "responses",
			model: "gpt-5.5",
			history_boundary: "history-12",
		},
	}));
});

test("rejects unsupported runtime state versions and missing checkpoint identity", () => {
	assert.throws(
		() => parseRuntimeState({ ...queueState(), version: 2 }),
		contracts.ContractValidationError,
	);
	assert.throws(
		() => parseRuntimeState({
			kind: "effect_checkpoint",
			version: 1,
			payload: {
				session_id: "s1",
				status: "waiting",
				updated_at: timestamp,
			},
		}),
		contracts.ContractValidationError,
	);
});

test("accepts generation-aware M5 gateway event payloads", () => {
	const events = [
		{
			method: "session.changed",
			params: { session_id: "s1", generation: 2 },
		},
		{
			method: "turn.queue.updated",
			params: {
				session_id: "s1",
				generation: 2,
				revision: 4,
				queue_revision: 4,
				queue_items: {
					pending_steers: [],
					rejected_steers: [],
					follow_ups: [],
				},
				steering: [],
				follow_up: [],
				has_pending_input: false,
				steering_count: 0,
				follow_up_count: 0,
			},
		},
		{
			method: "approval.request",
			params: {
				decision_id: "call-write-1",
				preview: "Write notes.txt",
				options: [
					{ choice: "approve_once", label: "Approve once" },
					{ choice: "reject", label: "Reject" },
				],
				session_id: "s1",
				generation: 2,
				checkpoint_status: "waiting",
			},
		},
		{
			method: "approval.respond",
			params: {
				decision_id: "call-write-1",
				choice: "approve_once",
				session_id: "s1",
				generation: 2,
				checkpoint_status: "approved",
			},
		},
		{
			method: "compaction.started",
			params: {
				client_turn_id: "client-1",
				source: "context_limit",
				before_tokens: 120,
				max_tokens: 100,
				session_id: "s1",
				generation: 2,
				checkpoint_id: "compact-1",
			},
		},
		{
			method: "compaction.completed",
			params: {
				client_turn_id: "client-1",
				source: "context_limit",
				status: "compressed",
				before_tokens: 120,
				after_tokens: 60,
				max_tokens: 100,
				duration_s: 0.5,
				session_id: "s1",
				generation: 2,
				checkpoint_id: "compact-1",
				compacted_item_count: 8,
			},
		},
	] as const;

	for (const event of events) {
		assert.doesNotThrow(() => contracts.parseGatewayEvent({
			jsonrpc: "2.0",
			...event,
		}));
	}
});

test("rejects negative M5 event generations", () => {
	assert.throws(
		() => contracts.parseGatewayEvent({
			jsonrpc: "2.0",
			method: "session.changed",
			params: { session_id: "s1", generation: -1 },
		}),
		contracts.ContractValidationError,
	);
});
