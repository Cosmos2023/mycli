import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseGatewayEvent, parseJsonRpcMessage } from "@mycli/contracts";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import { fingerprintSubmission, type QueueSnapshot, type RuntimeEvent } from "@mycli/core";
import {
	SessionCoordinator,
	type PreparedSession,
	type TurnSubmission,
} from "@mycli/runtime";
import type { SessionOverview, TranscriptItem } from "@mycli/storage";
import {
	createNodeGateway,
	type NodeGatewayRuntime,
} from "../src/node-runtime/node-gateway.ts";

type RpcMessage = ReturnType<typeof parseJsonRpcMessage>;

function gatewayHarness(options: {
	conversation?: readonly { role: "user" | "assistant"; content: string }[];
	existingTurn?: RuntimeTurnRecord;
	reserve?: (submission: TurnSubmission) => {
		readonly kind: "reserved" | "existing";
		readonly turn: RuntimeTurnRecord;
	};
	sessions?: {
		readonly targetFailure?: string;
		readonly targetReadOnly?: boolean;
		readonly prepareTarget?: () => Promise<void>;
		readonly targetQueue?: QueueSnapshot;
	};
} = {}) {
	let emitRuntime: ((event: RuntimeEvent) => void) | null = null;
	let signal: AbortSignal | null = null;
	let closeCalls = 0;
	let runtimeSettled = false;
	let releaseTurn!: () => void;
	const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
	const submissions: TurnSubmission[] = [];
	const runtime = {
		reserve: options.reserve ?? ((submission: TurnSubmission) => {
			const fingerprint = fingerprintSubmission({
				message: submission.message,
				localImages: submission.localImages,
			});
			if (options.existingTurn) {
				if (options.existingTurn.request_fingerprint !== fingerprint) {
					throw Object.assign(new Error("conflicting payload"), { code: "message_id_conflict" });
				}
				return { kind: "existing" as const, turn: options.existingTurn };
			}
			return {
				kind: "reserved" as const,
				turn: turnRecord(submission, "in_progress"),
			};
		}),
		submit: async (submission: TurnSubmission, emit: (event: RuntimeEvent) => void, options: { signal: AbortSignal }) => {
			submissions.push(submission);
			emitRuntime = emit;
			signal = options.signal;
			await turnReleased;
			runtimeSettled = true;
			return turnRecord(submission, options.signal.aborted ? "interrupted" : "completed");
		},
	};
	const sessionCoordinator = options.sessions
		? gatewaySessionCoordinator(runtime, options.sessions)
		: undefined;
	const gateway = createNodeGateway({
		sessionId: "session-node",
		workspaceRoot: "/repo",
		provider: "openai",
		model: "gpt-test",
		toolNames: ["Read"],
		runtime,
		loadConversation: () => options.conversation ?? [],
		...(sessionCoordinator ? { sessionCoordinator } : {}),
		close: () => { closeCalls += 1; },
		createTurnId: () => "turn-node",
		clock: () => 1_700_000_000,
	});
	const messages: RpcMessage[] = [];
	const lines = createInterface({ input: gateway.transport.input, crlfDelay: Infinity });
	lines.on("line", (line) => { messages.push(parseJsonRpcMessage(JSON.parse(line))); });
	let requestId = 0;
	async function send(method: string, params: Record<string, unknown> = {}) {
		const id = String(++requestId);
		gateway.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return waitFor(() => messages.find((message) => "id" in message && String(message.id) === id));
	}
	return {
		gateway,
		messages,
		submissions,
		send,
		emit: (event: RuntimeEvent) => emitRuntime?.(event),
		signal: () => signal,
		releaseTurn,
		closeCalls: () => closeCalls,
		runtimeSettled: () => runtimeSettled,
		sessionCoordinator,
	};
}

test("node gateway boots the real TUI startup sequence", async () => {
	const harness = gatewayHarness({
		conversation: [
			{ role: "user", content: "question" },
			{ role: "assistant", content: "answer" },
		],
	});
	const ready = await waitFor(() => notification(harness.messages, "runtime.ready"));
	assert.deepEqual(ready.params, { session_id: "session-node" });
	for (const [method, params] of [
		["initialize", { protocol_version: 1 }],
		["status.get", {}],
		["extension.manifest", {}],
		["session.bootstrap", { protocol_version: 1 }],
		["transcript.load", { session_id: "session-node", before: null }],
		["command.list", { surface: "tui" }],
		["settings.load", {}],
		["session.list", {}],
	] as const) {
		const response = await harness.send(method, params);
		assert.ok("result" in response, `${method} returned an error`);
		if (method === "transcript.load" && "result" in response) {
			assert.deepEqual(response.result.items, [
				{ id: "session-node:message:1", type: "user", text: "question", folded: false, metadata: {} },
				{ id: "session-node:message:2", type: "assistant_final", text: "answer", folded: false, metadata: {} },
			]);
		}
		if (method === "extension.manifest" && "result" in response) {
			assert.deepEqual(response.result.capabilities, {
				no_tool_turns: true,
				tools: true,
				tool_names: ["Read"],
			});
		}
	}
	await harness.gateway.close();
});

test("session RPCs atomically resume and publish one target generation", async () => {
	const harness = gatewayHarness({ sessions: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const listed = await harness.send("session.list", {});
	assert.ok("result" in listed);
	assert.deepEqual(
		"result" in listed
			? listed.result.sessions.map((item: { id: string; current: boolean }) => [item.id, item.current])
			: [],
		[["target", false], ["session-node", true]],
	);
	const tree = await harness.send("session.tree", { session_id: "target" });
	assert.deepEqual("result" in tree ? tree.result.active_path : null, ["session-node"]);

	const resumed = await harness.send("session.resume", { session_id: "target" });
	assert.deepEqual("result" in resumed ? resumed.result : null, {
		session_id: "target",
		generation: 2,
		read_only: false,
		lines: [],
	});
	assert.equal(harness.sessionCoordinator?.snapshot().sessionId, "target");

	const changed = await waitFor(() => notificationForSession(
		harness.messages,
		"session.changed",
		"target",
	));
	const status = await waitFor(() => notificationForSession(
		harness.messages,
		"status.changed",
		"target",
	));
	const approval = await waitFor(() => notificationForSession(
		harness.messages,
		"approval.request",
		"target",
	));
	assert.ok(harness.messages.indexOf(changed) < harness.messages.indexOf(status));
	assert.ok(harness.messages.indexOf(status) < harness.messages.indexOf(approval));
	assert.equal(changed.params.generation, 2);
	assert.equal(approval.params.decision_id, "decision-target");
	parseGatewayEvent(changed);
	parseGatewayEvent(status);
	parseGatewayEvent(approval);

	const transcript = await harness.send("transcript.load", {
		session_id: "target",
		before: null,
	});
	assert.deepEqual("result" in transcript ? transcript.result : null, {
		session_id: "target",
		items: [{
			id: "target:user:1",
			type: "user",
			text: "target",
			created_at: "",
			folded: false,
			metadata: {},
		}],
		next_before: null,
		read_only: false,
	});
	await harness.gateway.close();
});

test("failed session preparation keeps the source active and emits no target state", async () => {
	const harness = gatewayHarness({ sessions: { targetFailure: "session_state_invalid" } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const response = await harness.send("session.resume", { session_id: "target" });

	assert.equal("error" in response ? response.error.code : null, "session_state_invalid");
	assert.equal(harness.sessionCoordinator?.snapshot().sessionId, "session-node");
	assert.equal(notificationForSession(harness.messages, "session.changed", "target"), undefined);
	await harness.gateway.close();
});

test("read-only session replay rejects turn submission", async () => {
	const harness = gatewayHarness({ sessions: { targetReadOnly: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const resumed = await harness.send("session.resume", { session_id: "target" });
	assert.equal("result" in resumed ? resumed.result.read_only : false, true);

	const submitted = await harness.send("turn.submit", {
		message: "must not run",
		client_turn_id: "read-only-turn",
		client_user_message_id: "read-only-message",
		local_images: [],
	});

	assert.equal("error" in submitted ? submitted.error.code : null, "session_state_invalid");
	assert.deepEqual(harness.submissions, []);
	await harness.gateway.close();
});

test("status projects rejected steers as deferred follow-up input", async () => {
	const harness = gatewayHarness({ sessions: { targetQueue: populatedQueue("target") } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("session.resume", { session_id: "target" });
	const status = await waitFor(() => notificationForSession(
		harness.messages,
		"status.changed",
		"target",
	));

	assert.deepEqual(status.params.queued_steering, ["steer now"]);
	assert.deepEqual(status.params.queued_follow_up, ["deferred steer", "follow later"]);
	assert.deepEqual(status.params.queue_activity, {
		kind: "pending_input",
		has_pending_input: true,
		steering_count: 1,
		follow_up_count: 2,
	});
	assert.deepEqual(
		status.params.queue_items.rejected_steers.map((item: { queue_id: string }) => item.queue_id),
		["queue-rejected"],
	);
	await harness.gateway.close();
});

test("turn submission cannot reserve the source while target preparation is pending", async () => {
	let preparationStarted!: () => void;
	let releasePreparation!: () => void;
	const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
	const released = new Promise<void>((resolve) => { releasePreparation = resolve; });
	const harness = gatewayHarness({
		sessions: {
			prepareTarget: async () => {
				preparationStarted();
				await released;
			},
		},
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const resume = harness.send("session.resume", { session_id: "target" });
	await started;

	const submitted = await harness.send("turn.submit", {
		message: "must not reserve source",
		client_turn_id: "racing-turn",
		client_user_message_id: "racing-message",
		local_images: [],
	});
	releasePreparation();
	const resumed = await resume;
	if ("result" in submitted) harness.releaseTurn();

	assert.equal(
		"error" in submitted ? submitted.error.code : null,
		"turn_in_progress",
		JSON.stringify(submitted),
	);
	assert.ok("result" in resumed);
	assert.deepEqual(harness.submissions, []);
	await harness.gateway.close();
});

test("session resume rejects an executing turn and ignores stale generation callbacks", async () => {
	const harness = gatewayHarness({ sessions: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "hello",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	const blocked = await harness.send("session.resume", { session_id: "target" });
	assert.equal("error" in blocked ? blocked.error.code : null, "turn_in_progress");
	assert.equal(harness.sessionCoordinator?.snapshot().sessionId, "session-node");

	harness.releaseTurn();
	await waitFor(() => notification(harness.messages, "turn.completed"));
	await harness.send("session.resume", { session_id: "target" });
	const before = notificationCount(harness.messages, "message.delta");
	harness.emit({ type: "text_delta", text: "late source event" });
	await new Promise<void>((resolve) => { setImmediate(resolve); });
	assert.equal(notificationCount(harness.messages, "message.delta"), before);
	await harness.gateway.close();
});

test("turn submission responds immediately and emits validated direct events before mirrors", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const response = await harness.send("turn.submit", {
		message: "hello",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	assert.deepEqual("result" in response ? response.result : null, {
		accepted: true,
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		turn_id: "turn-node",
	});
	assert.deepEqual(harness.submissions, [{
		clientTurnId: "client-turn",
		turnId: "turn-node",
		message: "hello",
		localImages: [],
	}]);

	harness.emit({ type: "turn_started", clientTurnId: "client-turn", turnId: "turn-node" });
	const direct = await waitFor(() => notification(harness.messages, "turn.started"));
	const mirror = await waitFor(() => notification(harness.messages, "runtime.event"));
	parseGatewayEvent(direct);
	parseGatewayEvent(mirror);
	assert.ok(harness.messages.indexOf(direct) < harness.messages.indexOf(mirror));
	assert.deepEqual(mirror.params, {
		version: 1,
		sequence: 1,
		type: "turn.started",
		payload: direct.params,
		timestamp: 1_700_000_000,
	});
	harness.emit({ type: "text_delta", text: "hello" });
	const compatibility = await waitFor(() => notification(harness.messages, "turn.event"));
	parseGatewayEvent(compatibility);
	assert.equal(compatibility.params.kind, "text_delta");

	harness.releaseTurn();
	await harness.gateway.close();
});

test("projects bounded tool and mutation lifecycle events without sensitive fields", async () => {
	const harness = gatewayHarness();
	const fileContents = "private file contents";
	const privateHash = `sha256:${"f".repeat(64)}`;
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "read README",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	harness.emit({
		type: "tool_execution_started",
		callId: "call-1",
		toolName: "Edit",
	});
	harness.emit({
		type: "tool_execution_completed",
		callId: "call-1",
		toolName: "Edit",
		summary: "Edited src/a.ts",
		durationMs: 125,
		metadata: {
			path: "src/a.ts",
			status: "edited",
			matches: 1,
			diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n",
			addedLines: 1,
			removedLines: 1,
			diffTruncated: false,
			content: fileContents,
			sha256: privateHash,
			argumentsJson: "{\"content\":\"private\"}",
		},
	});
	harness.emit({
		type: "tool_execution_failed",
		callId: "call-2",
		toolName: "Edit",
		summary: "Failed to edit missing.txt",
		durationMs: 5,
		errorKind: "not_found",
		metadata: {
			path: "missing.txt",
			errorKind: "not_found",
			content: fileContents,
			sha256: privateHash,
			argumentsJson: "{\"file_path\":\"private\"}",
		},
	});
	await new Promise<void>((resolve) => { setImmediate(resolve); });

	const direct = harness.messages.filter((message) =>
		"method" in message
		&& !("id" in message)
		&& ["tool.start", "tool.complete", "tool.failed"].includes(message.method),
	);
	assert.deepEqual(direct.map((message) => "method" in message ? message.method : ""), [
		"tool.start",
		"tool.complete",
		"tool.failed",
	]);
	assert.deepEqual(direct.map((message) => "method" in message ? message.params.tool_id : ""), [
		"call-1",
		"call-1",
		"call-2",
	]);
	for (const message of direct) parseGatewayEvent(message);
	const turnEvents = harness.messages.filter((message) =>
		"method" in message && !("id" in message) && message.method === "turn.event",
	);
	assert.deepEqual(turnEvents.map((message) => message.params.kind), [
		"tool_start",
		"tool_complete",
		"tool_failed",
	]);
	assert.equal(turnEvents[0]?.params.tool_name, "Edit");
	assert.equal(turnEvents[0]?.params.metadata.call_id, "call-1");
	const complete = direct[1]!;
	assert.equal("method" in complete ? complete.params.path : undefined, "src/a.ts");
	assert.equal("method" in complete ? complete.params.status : undefined, "edited");
	assert.equal("method" in complete ? complete.params.matches : undefined, 1);
	assert.deepEqual("method" in complete ? complete.params.file_changes : undefined, [{
		version: 1,
		kind: "update",
		path: "src/a.ts",
		diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n",
		added_lines: 1,
		removed_lines: 1,
	}]);
	const failed = direct[2]!;
	assert.equal("method" in failed ? failed.params.path : undefined, "missing.txt");
	assert.equal("method" in failed ? failed.params.error_kind : undefined, "not_found");
	assert.deepEqual(turnEvents[1]?.params.metadata, {
		call_id: "call-1",
		duration_ms: 125,
		success: true,
		path: "src/a.ts",
		status: "edited",
		matches: 1,
		file_changes: [{
			version: 1,
			kind: "update",
			path: "src/a.ts",
			diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n",
			added_lines: 1,
			removed_lines: 1,
		}],
	});
	assert.deepEqual(turnEvents[2]?.params.metadata, {
		call_id: "call-2",
		duration_ms: 5,
		success: false,
		path: "missing.txt",
		error_kind: "not_found",
	});
	const serialized = JSON.stringify([...direct, ...turnEvents]);
	assert.equal(serialized.includes(fileContents), false);
	assert.equal(serialized.includes(privateHash), false);
	assert.equal(serialized.includes("argumentsJson"), false);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("turn submission rejects a conflicting client turn id before accepting it", async () => {
	const harness = gatewayHarness({
		existingTurn: {
			schema_version: 1,
			session_id: "session-node",
			client_turn_id: "client-turn",
			turn_id: "existing-turn",
			request_fingerprint: fingerprintSubmission({ message: "original", localImages: [] }),
			status: "completed",
			error_code: null,
			result: { assistant_text: "done", usage: {} },
			started_at: "2026-08-04T00:00:00.000Z",
			completed_at: "2026-08-04T00:00:01.000Z",
		},
	});
	try {
		const response = await harness.send("turn.submit", {
			message: "different",
			client_turn_id: "client-turn",
			client_user_message_id: "client-message",
			local_images: [],
		});
		assert.ok("error" in response);
		assert.equal("error" in response ? response.error.code : null, "message_id_conflict");
		assert.equal(harness.submissions.length, 0);
	} finally {
		harness.releaseTurn();
		await harness.gateway.close();
	}
});

test("two gateways atomically reject a conflicting concurrent client turn id", async () => {
	let reserved: RuntimeTurnRecord | undefined;
	const reserve = (submission: TurnSubmission) => {
		const fingerprint = fingerprintSubmission({
			message: submission.message,
			localImages: submission.localImages,
		});
		if (!reserved) {
			reserved = { ...turnRecord(submission, "in_progress"), request_fingerprint: fingerprint };
			return { kind: "reserved" as const, turn: reserved };
		}
		if (reserved.request_fingerprint !== fingerprint) {
			throw Object.assign(new Error("conflicting payload"), { code: "message_id_conflict" });
		}
		return { kind: "existing" as const, turn: reserved };
	};
	const first = gatewayHarness({ reserve });
	const second = gatewayHarness({ reserve });
	try {
		const [firstResponse, secondResponse] = await Promise.all([
			first.send("turn.submit", {
				message: "first",
				client_turn_id: "shared-client-turn",
				client_user_message_id: "first-message",
			}),
			second.send("turn.submit", {
				message: "second",
				client_turn_id: "shared-client-turn",
				client_user_message_id: "second-message",
			}),
		]);
		const responses = [firstResponse, secondResponse];
		assert.equal(responses.filter((response) => "result" in response).length, 1);
		const conflict = responses.find((response) => "error" in response);
		assert.equal(conflict && "error" in conflict ? conflict.error.code : null, "message_id_conflict");
		assert.equal(first.submissions.length + second.submissions.length, 1);
	} finally {
		first.releaseTurn();
		second.releaseTurn();
		await Promise.all([first.gateway.close(), second.gateway.close()]);
	}
});

test("turn interrupt aborts the active request and shutdown closes resources", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "wait",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
	});
	const interrupted = await harness.send("turn.interrupt", {});
	assert.deepEqual("result" in interrupted ? interrupted.result : null, {
		accepted: true,
		requested: true,
		client_turn_id: "client-turn",
	});
	assert.equal(harness.signal()?.aborted, true);
	harness.releaseTurn();
	const terminal = await waitFor(() => notification(harness.messages, "turn.interrupted"));
	assert.equal(terminal.params.requested, false);
	await harness.send("shutdown", {});
	await harness.gateway.completion;
	assert.equal(harness.closeCalls(), 1);
});

test("shutdown waits for an aborted turn to settle before closing resources", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "wait",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
	});
	await harness.send("shutdown", {});
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(harness.closeCalls(), 0);
	harness.releaseTurn();
	await harness.gateway.completion;
	assert.equal(harness.runtimeSettled(), true);
	assert.equal(harness.closeCalls(), 1);
});

test("unsupported methods return a stable error and observable gateway event", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const response = await harness.send("missing.method", {});
	assert.ok("error" in response);
	assert.equal("error" in response ? response.error.code : null, "method_not_found");
	const event = await waitFor(() => notification(harness.messages, "gateway.error"));
	const mirror = await waitFor(() => harness.messages.find((message) =>
		"method" in message
		&& !("id" in message)
		&& message.method === "runtime.event"
		&& message.params.type === "gateway.error",
	));
	parseGatewayEvent(event);
	parseGatewayEvent(mirror);
	assert.ok(harness.messages.indexOf(event) < harness.messages.indexOf(mirror));
	assert.deepEqual(event.params, {
		code: "method_not_found",
		message: "Unknown gateway method.",
		method: "missing.method",
	});
	await harness.gateway.close();
});

function notification(messages: RpcMessage[], method: string) {
	return messages.find((message) => "method" in message && !("id" in message) && message.method === method);
}

function notificationForSession(messages: RpcMessage[], method: string, sessionId: string) {
	return messages.find((message) => "method" in message
		&& !("id" in message)
		&& message.method === method
		&& message.params.session_id === sessionId);
}

function notificationCount(messages: RpcMessage[], method: string): number {
	return messages.filter((message) => "method" in message
		&& !("id" in message)
		&& message.method === method).length;
}

function gatewaySessionCoordinator(
	runtime: NodeGatewayRuntime,
	options: {
		readonly targetFailure?: string;
		readonly targetReadOnly?: boolean;
		readonly prepareTarget?: () => Promise<void>;
		readonly targetQueue?: QueueSnapshot;
	},
): SessionCoordinator<NodeGatewayRuntime> {
	return new SessionCoordinator({
		initial: preparedGatewaySession("session-node", runtime),
		prepare: async (sessionId) => {
			await options.prepareTarget?.();
			if (options.targetFailure) {
				throw Object.assign(new Error("target preparation failed"), {
					code: options.targetFailure,
				});
			}
			return preparedGatewaySession(
				sessionId,
				runtime,
				options.targetReadOnly ?? false,
				options.targetQueue,
			);
		},
		listSessions: () => [
			sessionOverview("target", "2026-08-04T00:00:01.000Z"),
			sessionOverview("session-node", "2026-08-04T00:00:00.000Z"),
		],
		loadSessionLineage: (sessionId) => sessionId === "target"
			? [
				{ sessionId: "session-node" },
				{ sessionId: "target", parentId: "session-node", forkPoint: 1 },
			]
			: [{ sessionId }],
	});
}

function preparedGatewaySession(
	sessionId: string,
	runtime: NodeGatewayRuntime,
	readOnly = false,
	queue: QueueSnapshot = emptyQueue(sessionId),
): PreparedSession<NodeGatewayRuntime> {
	return {
		sessionId,
		workspaceRoot: "/repo",
		threadId: sessionId,
		transcript: [transcriptItem(sessionId)],
		queue,
		pendingApproval: {
			sessionId,
			clientTurnId: `client-${sessionId}`,
			turnId: `turn-${sessionId}`,
			decisionId: `decision-${sessionId}`,
			callId: `call-${sessionId}`,
			toolName: "Write",
			preview: "Write notes.txt",
			reason: "Approval required",
			options: ["approve_once", "reject"],
		},
		suspendedTurn: true,
		readOnly,
		binding: runtime,
	};
}

function transcriptItem(sessionId: string): TranscriptItem {
	return { id: `${sessionId}:user:1`, type: "user_message", text: sessionId };
}

function emptyQueue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 0,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
}

function populatedQueue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 3,
		pendingSteers: Object.freeze([queuedInput(sessionId, "queue-pending", "pending_steer", "steer now")]),
		rejectedSteers: Object.freeze([
			queuedInput(sessionId, "queue-rejected", "rejected_steer", "deferred steer"),
		]),
		followUps: Object.freeze([queuedInput(sessionId, "queue-follow", "follow_up", "follow later")]),
	});
}

function queuedInput(
	sessionId: string,
	queueId: string,
	kind: "pending_steer" | "rejected_steer" | "follow_up",
	text: string,
) {
	return Object.freeze({
		queueId,
		sessionId,
		clientTurnId: `client-${queueId}`,
		targetTurnId: kind === "follow_up" ? null : "turn-target",
		kind,
		state: kind === "pending_steer" ? "accepted" as const : "queued" as const,
		text,
		imagePaths: Object.freeze([]),
		source: "user",
		createdAt: "2026-08-04T00:00:00.000Z",
		updatedAt: "2026-08-04T00:00:00.000Z",
	});
}

function sessionOverview(sessionId: string, lastActiveAt: string): SessionOverview {
	return {
		sessionId,
		workspaceRoot: "/repo",
		threadId: sessionId,
		createdAt: lastActiveAt,
		updatedAt: lastActiveAt,
		lastActiveAt,
		status: "active",
		messageCount: 1,
		summaryCount: 0,
	};
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 1_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("timed out waiting for gateway message");
}

function turnRecord(
	submission: TurnSubmission,
	status: "in_progress" | "completed" | "interrupted",
): RuntimeTurnRecord {
	return {
		schema_version: 1,
		session_id: "session-node",
		client_turn_id: submission.clientTurnId,
		turn_id: submission.turnId ?? "turn-node",
		request_fingerprint: fingerprintSubmission({
			message: submission.message,
			localImages: submission.localImages,
		}),
		status,
		error_code: status === "interrupted" ? "interrupted" : null,
		result: null,
		started_at: "2026-08-04T00:00:00.000Z",
		completed_at: status === "in_progress" ? null : "2026-08-04T00:00:01.000Z",
	};
}
