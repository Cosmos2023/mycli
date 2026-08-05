import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseGatewayEvent, parseJsonRpcMessage } from "@mycli/contracts";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	fingerprintSubmission,
	type QueueSnapshot,
	type RuntimeEvent,
	type ShellLifecycleEvent,
} from "@mycli/core";
import {
	QueueCoordinator,
	SessionCoordinator,
	type PendingApprovalChoice,
	type PreparedSession,
	type QueueCoordinatorStore,
	type TurnSubmission,
} from "@mycli/runtime";
import { StorageFailure } from "@mycli/storage";
import type { SessionOverview, TranscriptItem } from "@mycli/storage";
import type { ShellSessionSnapshot } from "@mycli/tools";
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
		readonly initialPendingApproval?: boolean;
		readonly targetPendingApproval?: boolean;
		readonly approvalOptions?: readonly PendingApprovalChoice[];
	};
	queue?: {
		readonly initial?: QueueSnapshot;
	};
	approvalFailure?: Error;
	shell?: boolean;
} = {}) {
	let emitRuntime: ((event: RuntimeEvent) => void) | null = null;
	let signal: AbortSignal | null = null;
	let closeCalls = 0;
	let runtimeSettled = false;
	let releaseTurn!: () => void;
	const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
	const submissions: TurnSubmission[] = [];
	const approvalResolutions: Array<{
		readonly decisionId: string;
		readonly choice: PendingApprovalChoice;
	}> = [];
	const reservedClientTurnIds: string[] = [];
	const queue = options.queue
		? gatewayQueueFixture(options.queue.initial ?? emptyQueue("session-node"))
		: undefined;
	const shell = options.shell ? gatewayShellFixture() : undefined;
	const reserve = options.reserve ?? ((submission: TurnSubmission) => {
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
	});
	const runtime = {
		...(queue ? { queueCoordinator: queue.coordinator } : {}),
		reserve: (submission: TurnSubmission) => {
			reservedClientTurnIds.push(submission.clientTurnId);
			return reserve(submission);
		},
		resolveApproval: async (
			input: { readonly decisionId: string; readonly choice: PendingApprovalChoice },
			emit: (event: RuntimeEvent) => void,
			runtimeOptions: { readonly signal: AbortSignal },
		) => {
			approvalResolutions.push(input);
			emitRuntime = emit;
			signal = runtimeOptions.signal;
			if (options.approvalFailure) throw options.approvalFailure;
			await turnReleased;
			runtimeSettled = true;
			return turnRecord({
				clientTurnId: "client-session-node",
				turnId: "turn-session-node",
				message: "original",
			}, runtimeOptions.signal.aborted ? "interrupted" : "completed");
		},
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
		...(shell ? {
			shellManager: shell.manager,
			shellLifecycle: shell.lifecycle,
		} : {}),
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
		reservedClientTurnIds,
		approvalResolutions,
		send,
		emit: (event: RuntimeEvent) => emitRuntime?.(event),
		signal: () => signal,
		releaseTurn,
		closeCalls: () => closeCalls,
		runtimeSettled: () => runtimeSettled,
		sessionCoordinator,
		queue,
		shell,
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

test("shell bootstrap and control RPCs stay scoped to the active owner", async () => {
	const harness = gatewayHarness({ shell: true });
	assert.ok(harness.shell);
	harness.shell.snapshots.push(shellSnapshot({ ownerSessionId: "session-node" }));
	harness.shell.snapshots.push(shellSnapshot({
		ownerSessionId: "another-session",
		shellId: "deadbeef",
	}));

	const initialized = await harness.send("initialize", { protocol_version: 1 });
	assert.ok("result" in initialized);
	assert.deepEqual("result" in initialized ? initialized.result.background_shells : [], [
		assertedShellPayload("a1b2c3d4", 1),
	]);
	const listed = await harness.send("shell.list");
	assert.deepEqual("result" in listed ? listed.result.shells : [], [
		assertedShellPayload("a1b2c3d4", 1),
	]);
	const stopped = await harness.send("shell.stop", { shell_id: "a1b2c3d4" });
	assert.equal("result" in stopped ? stopped.result.shell_id : null, "a1b2c3d4");
	const stoppedAll = await harness.send("shell.stop_all");
	assert.equal("result" in stoppedAll ? stoppedAll.result.stopped : null, 1);
	assert.deepEqual(harness.shell.terminations, [
		{ ownerSessionId: "session-node", shellId: "a1b2c3d4" },
	]);
	assert.deepEqual(harness.shell.terminatedOwners, ["session-node"]);
	await harness.gateway.close();
});

test("shell command routes expose ps and stop through the active owner manager", async () => {
	const harness = gatewayHarness({ shell: true });
	assert.ok(harness.shell);
	harness.shell.snapshots.push(shellSnapshot());

	const listed = await harness.send("command.list", { surface: "tui" });
	assert.deepEqual(
		"result" in listed
			? listed.result.commands.map((command: { name: string }) => command.name)
			: [],
		["/ps"],
	);
	const ps = await harness.send("command.run", { command: "/ps", surface: "tui" });
	assert.equal("result" in ps ? ps.result.command_kind : null, "background_shells");
	assert.deepEqual("result" in ps ? ps.result.processes : [], [
		assertedShellPayload("a1b2c3d4", 1),
	]);
	const stopped = await harness.send("command.run", { command: "/stop", surface: "tui" });
	assert.equal("result" in stopped ? stopped.result.command_kind : null, "shell_stop");
	assert.deepEqual("result" in stopped ? stopped.result.lines : [], [
		"Stopping all background terminals.",
	]);
	assert.deepEqual(harness.shell.terminatedOwners, ["session-node"]);
	await harness.gateway.close();
});

test("shell lifecycle filters stale sessions and publishes the active generation", async () => {
	const harness = gatewayHarness({ shell: true, sessions: {} });
	assert.ok(harness.shell);
	harness.shell.publish(shellLifecycle({
		ownerSessionId: "session-node",
		kind: "shell.output",
		outputDelta: "source",
		nextCursor: 6,
	}));
	const source = await waitFor(() => notification(harness.messages, "shell.output"));
	assert.equal(source.params.session_id, "session-node");
	assert.equal(source.params.generation, 1);

	harness.shell.snapshots.push(shellSnapshot({
		ownerSessionId: "target",
		shellId: "e5f6a7b8",
		callId: "call-target",
	}));
	await harness.send("session.resume", { session_id: "target" });
	const targetStatus = await waitFor(() => notificationForSession(
		harness.messages,
		"status.changed",
		"target",
	));
	assert.deepEqual(targetStatus.params.background_shells, [
		assertedShellPayload("e5f6a7b8", 2, "target", "call-target"),
	]);
	const before = notifications(harness.messages, "shell.output").length;
	harness.shell.publish(shellLifecycle({
		ownerSessionId: "session-node",
		kind: "shell.output",
		sequence: 2,
		outputDelta: "stale",
		nextCursor: 11,
	}));
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(notifications(harness.messages, "shell.output").length, before);

	harness.shell.publish(shellLifecycle({
		ownerSessionId: "target",
		shellId: "e5f6a7b8",
		callId: "call-target",
		kind: "shell.output",
		outputDelta: "target",
		nextCursor: 6,
	}));
	const target = await waitFor(() => notifications(harness.messages, "shell.output")
		.find((message) => message.params.session_id === "target"));
	assert.equal(target.params.generation, 2);
	assert.equal(target.params.output_delta, "target");
	parseGatewayEvent(target);
	await harness.gateway.close();
});

test("session RPCs atomically resume and publish one target generation", async () => {
	const harness = gatewayHarness({ sessions: { targetPendingApproval: true } });
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
		background_shells: [],
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

test("approval respond resumes the owning turn without reserving a new turn", async () => {
	const harness = gatewayHarness({ sessions: { initialPendingApproval: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const response = await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "approve_once",
		session_id: "session-node",
		generation: 1,
	});

	assert.ok("result" in response, JSON.stringify(response));
	assert.deepEqual("result" in response ? response.result : null, {
		accepted: true,
		decision_id: "decision-session-node",
		client_turn_id: "client-session-node",
		turn_id: "turn-session-node",
		session_id: "session-node",
		generation: 1,
	});
	assert.deepEqual(harness.approvalResolutions, [{
		decisionId: "decision-session-node",
		choice: "approve_once",
	}]);
	assert.deepEqual(harness.reservedClientTurnIds, []);
	const projected = await waitFor(() => notification(harness.messages, "approval.respond"));
	assert.equal(projected.params.generation, 1);
	parseGatewayEvent(projected);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("approval respond accepts always allow only when the pending backend option offers it", async () => {
	const harness = gatewayHarness({
		sessions: {
			initialPendingApproval: true,
			approvalOptions: ["approve_once", "reject", "allow_session", "always_allow"],
		},
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	const response = await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "always_allow",
		generation: 1,
	});

	assert.ok("result" in response, JSON.stringify(response));
	assert.deepEqual(harness.approvalResolutions, [{
		decisionId: "decision-session-node",
		choice: "always_allow",
	}]);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("approval respond rejects unsupported choices stale generations and wrong decisions", async () => {
	const harness = gatewayHarness({ sessions: { initialPendingApproval: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));

	for (const params of [
		{ decision_id: "decision-session-node", choice: "allow_session", generation: 1 },
		{ decision_id: "decision-session-node", choice: "approve_once", generation: 2 },
		{ decision_id: "wrong", choice: "approve_once", generation: 1 },
	]) {
		const response = await harness.send("approval.respond", params);
		assert.ok("error" in response);
		assert.equal(
			"error" in response ? response.error.code : null,
			params.choice === "allow_session" ? "invalid_params" : "approval_not_pending",
		);
	}
	assert.deepEqual(harness.approvalResolutions, []);

	harness.releaseTurn();
	await harness.gateway.close();
});

test("approval resolution failure restores the pending request without terminating the turn", async () => {
	const harness = gatewayHarness({
		approvalFailure: new StorageFailure("approval persistence failed"),
		sessions: { initialPendingApproval: true },
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	const approvalRequestCount = notificationCount(harness.messages, "approval.request");

	const response = await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "approve_once",
		generation: 1,
	});

	assert.ok("result" in response, JSON.stringify(response));
	await waitFor(() => notificationCount(harness.messages, "approval.request") === approvalRequestCount + 1);
	const approvalRequests = harness.messages.filter((message) =>
		"method" in message && !("id" in message) && message.method === "approval.request",
	);
	assert.equal(approvalRequests.at(-1)?.params.decision_id, "decision-session-node");
	assert.equal(harness.sessionCoordinator?.snapshot().pendingApproval?.decisionId, "decision-session-node");
	assert.equal(notificationCount(harness.messages, "turn.failed"), 0);
	const statusUpdates = harness.messages.filter((message) =>
		"method" in message && !("id" in message) && message.method === "status.update",
	);
	assert.equal(statusUpdates.at(-1)?.params.state, "waiting_approval");
	const error = await waitFor(() => notification(harness.messages, "gateway.error"));
	assert.deepEqual(error.params, {
		code: "internal_error",
		message: "Session persistence failed.",
		method: "approval.respond",
	});
	await harness.gateway.close();
});

test("approval resolution excludes normal turns and session transitions", async () => {
	const harness = gatewayHarness({ sessions: { initialPendingApproval: true } });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("approval.respond", {
		decision_id: "decision-session-node",
		choice: "reject",
		generation: 1,
	});

	const submitted = await harness.send("turn.submit", {
		message: "must wait",
		client_turn_id: "new-client",
		client_user_message_id: "new-user",
	});
	const resumed = await harness.send("session.resume", { session_id: "target" });
	assert.equal("error" in submitted ? submitted.error.code : null, "turn_in_progress");
	assert.equal("error" in resumed ? resumed.error.code : null, "turn_in_progress");

	harness.releaseTurn();
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

test("queue RPCs persist before publication and deduplicate lost responses", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "inspect",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});

	const first = await harness.send("turn.steer", {
		message: "also inspect package.json",
		client_user_message_id: "steer-message-1",
		expected_turn_id: "turn-node",
		local_images: [{ path: "/tmp/context.png", placeholder: "[image #1]" }],
	});
	const updated = await waitFor(() => notification(harness.messages, "turn.queue.updated"));

	assert.equal("result" in first ? first.result.disposition : null, "accepted_for_turn");
	assert.equal("result" in first ? first.result.queue_revision : null, 1);
	assert.equal("result" in first ? first.result.record.queue_id : null, "queue-1");
	assert.deepEqual(harness.queue?.persistedRevisions, [1]);
	assert.equal(updated.params.queue_revision, 1);
	assert.deepEqual(updated.params.steering, ["also inspect package.json"]);
	assert.equal(updated.params.queue_items.pending_steers[0].local_images[0].path, "/tmp/context.png");
	parseGatewayEvent(updated);
	const responseIndex = harness.messages.indexOf(first);
	assert.ok(harness.messages.indexOf(updated) < responseIndex);

	const eventCount = notificationCount(harness.messages, "turn.queue.updated");
	const duplicate = await harness.send("turn.steer", {
		message: "also inspect package.json",
		client_user_message_id: "steer-message-1",
		expected_turn_id: "turn-node",
		local_images: [{ path: "/tmp/context.png", placeholder: "[image #1]" }],
	});

	assert.equal("result" in duplicate ? duplicate.result.disposition : null, "duplicate");
	assert.equal("result" in duplicate ? duplicate.result.record.queue_id : null, "queue-1");
	assert.equal("result" in duplicate ? duplicate.result.queue_revision : null, 1);
	assert.deepEqual(harness.queue?.persistedRevisions, [1]);
	assert.equal(notificationCount(harness.messages, "turn.queue.updated"), eventCount);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("stale steers are durably deferred instead of losing user input", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "inspect",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});

	const response = await harness.send("turn.steer", {
		message: "use a newer turn",
		client_turn_id: "stale-steer",
		expected_turn_id: "turn-old",
	});

	assert.equal("result" in response ? response.result.disposition : null, "deferred_to_end_of_turn");
	assert.equal("result" in response ? response.result.record.kind : null, "rejected_steer");
	assert.deepEqual(
		harness.queue?.coordinator.snapshot().rejectedSteers.map((item) => item.text),
		["use a newer turn"],
	);
	harness.releaseTurn();
	await harness.gateway.close();
});

test("follow-up input racing terminal completion remains durably queued", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "inspect",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});

	const followUp = harness.send("turn.follow_up", {
		message: "summarize afterward",
		client_turn_id: "follow-up-1",
	});
	harness.releaseTurn();
	const response = await followUp;
	await waitFor(() => notification(harness.messages, "turn.completed"));
	await waitFor(() => harness.submissions.length >= 2);

	assert.equal("result" in response ? response.result.disposition : null, "queued_follow_up");
	assert.equal(harness.queue?.persistedRevisions.includes(1), true);
	assert.equal(harness.submissions[1]?.message, "summarize afterward");
	await harness.gateway.close();
});

test("reserves one queued next turn before removing its queue record", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "first turn",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	await harness.send("turn.follow_up", {
		message: "queued next turn",
		client_turn_id: "queued-client-id",
	});

	harness.releaseTurn();
	await waitFor(() => harness.submissions.length >= 2);

	assert.deepEqual(harness.reservedClientTurnIds, ["client-turn", "queued-client-id"]);
	assert.deepEqual(harness.submissions[1], {
		clientTurnId: "queued-client-id",
		turnId: "turn-node",
		message: "queued next turn",
		localImages: [],
	});
	assert.equal(harness.queue?.coordinator.snapshot().followUps.length, 0);
	await harness.gateway.close();
});

test("retains queued input when the next-turn reservation fails", async () => {
	const harness = gatewayHarness({
		queue: {},
		reserve: (submission) => {
			if (submission.clientTurnId === "queued-client-id") {
				throw new StorageFailure("private reservation failure");
			}
			return { kind: "reserved", turn: turnRecord(submission, "in_progress") };
		},
	});
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "first turn",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	await harness.send("turn.follow_up", {
		message: "keep queued",
		client_turn_id: "queued-client-id",
	});

	harness.releaseTurn();
	await waitFor(() => harness.reservedClientTurnIds.includes("queued-client-id"));
	const failure = await waitFor(() => notification(harness.messages, "gateway.error"));

	assert.deepEqual(
		harness.queue?.coordinator.snapshot().followUps.map((item) => item.text),
		["keep queued"],
	);
	assert.equal(failure.params.code, "queue_worker_start_failed");
	assert.equal(JSON.stringify(failure).includes("private reservation failure"), false);
	await harness.gateway.close();
});

test("queue pop, clear, and legacy migration ack return durable revisions", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.follow_up", { message: "first", client_turn_id: "follow-1" });
	await harness.send("turn.follow_up", { message: "second", client_turn_id: "follow-2" });

	const popped = await harness.send("turn.queue.pop");
	assert.equal("result" in popped ? popped.result.item.text : null, "second");
	assert.equal("result" in popped ? popped.result.queue_revision : null, 3);
	const cleared = await harness.send("turn.queue.clear");
	assert.deepEqual("result" in cleared ? cleared.result.follow_up : null, ["first"]);
	assert.equal(harness.queue?.coordinator.snapshot().followUps.length, 0);

	await harness.send("turn.follow_up", { message: "legacy", client_turn_id: "legacy-1" });
	const bootstrap = await harness.send("session.bootstrap", { protocol_version: 1 });
	const migration = "result" in bootstrap ? bootstrap.result.legacy_user_queue_migration : undefined;
	assert.equal(migration.records[0].text, "legacy");
	const acknowledged = await harness.send("turn.queue.migration.ack", { token: migration.token });
	assert.equal("result" in acknowledged ? acknowledged.result.acknowledged : false, true);
	assert.equal(harness.queue?.coordinator.snapshot().followUps.length, 0);
	await harness.gateway.close();
});

test("queue storage failures return sanitized errors without publishing", async () => {
	const harness = gatewayHarness({ queue: {} });
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	if (harness.queue) harness.queue.failSave = true;
	const before = notificationCount(harness.messages, "turn.queue.updated");

	const response = await harness.send("turn.follow_up", {
		message: "must persist",
		client_turn_id: "follow-secret",
	});

	assert.deepEqual("error" in response ? response.error : null, {
		code: "persistence_error",
		message: "Session persistence failed.",
	});
	assert.equal(notificationCount(harness.messages, "turn.queue.updated"), before);
	assert.equal(JSON.stringify(harness.messages).includes("private sqlite path"), false);
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

test("projects compaction lifecycle events with the canonical bounded payload", async () => {
	const harness = gatewayHarness();
	await waitFor(() => notification(harness.messages, "runtime.ready"));
	await harness.send("turn.submit", {
		message: "continue",
		client_turn_id: "client-turn",
		client_user_message_id: "client-message",
		local_images: [],
	});
	harness.emit({
		type: "compaction_started",
		clientTurnId: "client-turn",
		source: "pre_turn",
		beforeTokens: 95_000,
		maxTokens: 100_000,
	});
	harness.emit({
		type: "compaction_completed",
		clientTurnId: "client-turn",
		source: "pre_turn",
		status: "compressed",
		beforeTokens: 95_000,
		afterTokens: 12_000,
		maxTokens: 100_000,
		durationSeconds: 0.25,
	});
	await new Promise<void>((resolve) => { setImmediate(resolve); });

	const direct = harness.messages.filter((message) =>
		"method" in message
		&& !("id" in message)
		&& ["compaction.started", "compaction.completed"].includes(message.method),
	);
	assert.deepEqual(direct.map((message) => "method" in message ? message.method : ""), [
		"compaction.started",
		"compaction.completed",
	]);
	assert.deepEqual("method" in direct[0]! ? direct[0].params : {}, {
		client_turn_id: "client-turn",
		source: "pre_turn",
		before_tokens: 95_000,
		max_tokens: 100_000,
	});
	assert.deepEqual("method" in direct[1]! ? direct[1].params : {}, {
		client_turn_id: "client-turn",
		source: "pre_turn",
		status: "compressed",
		before_tokens: 95_000,
		after_tokens: 12_000,
		max_tokens: 100_000,
		duration_s: 0.25,
	});
	for (const message of direct) parseGatewayEvent(message);
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

function notifications(messages: RpcMessage[], method: string) {
	return messages.filter((message) => "method" in message
		&& !("id" in message)
		&& message.method === method);
}

function gatewayShellFixture() {
	const snapshots: ShellSessionSnapshot[] = [];
	const terminations: Array<{ readonly ownerSessionId: string; readonly shellId: string }> = [];
	const terminatedOwners: string[] = [];
	const listeners = new Set<(event: ShellLifecycleEvent) => void>();
	return {
		snapshots,
		terminations,
		terminatedOwners,
		manager: {
			list: (ownerSessionId: string) => snapshots.filter(
				(snapshot) => snapshot.ownerSessionId === ownerSessionId,
			),
			terminate: async (ownerSessionId: string, shellId: string) => {
				terminations.push({ ownerSessionId, shellId });
				return snapshots.find((snapshot) => snapshot.ownerSessionId === ownerSessionId
					&& snapshot.shellId === shellId) ?? shellSnapshot({
					ownerSessionId,
					shellId,
					success: false,
					status: "error",
					processState: "shell_not_found",
				});
			},
			terminateOwner: async (ownerSessionId: string) => {
				terminatedOwners.push(ownerSessionId);
				return snapshots.filter((snapshot) => snapshot.ownerSessionId === ownerSessionId
					&& snapshot.status === "running");
			},
		},
		lifecycle: {
			subscribe: (listener: (event: ShellLifecycleEvent) => void) => {
				listeners.add(listener);
				return () => { listeners.delete(listener); };
			},
		},
		publish: (event: ShellLifecycleEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
}

function shellSnapshot(
	overrides: Partial<ShellSessionSnapshot> = {},
): ShellSessionSnapshot {
	return Object.freeze({
		success: true,
		shellId: "a1b2c3d4",
		ownerSessionId: "session-node",
		callId: "call-shell-1",
		background: true,
		status: "running",
		processState: "running_background",
		output: "ready\n",
		stdout: "ready\n",
		stderr: "",
		nextCursor: 6,
		outputChars: 6,
		newOutputChars: 6,
		omittedOutputChars: 0,
		stdoutChars: 6,
		stderrChars: 0,
		stdoutOmittedChars: 0,
		stderrOmittedChars: 0,
		cursorWasEvicted: false,
		transport: "pipe",
		tty: false,
		yielded: true,
		decodeReplacementCount: 0,
		commandPreview: "npm test",
		startedAt: "2026-08-05T00:00:00.000Z",
		wallTimeSeconds: 1,
		...overrides,
	});
}

function assertedShellPayload(
	shellId: string,
	generation: number,
	sessionId = "session-node",
	callId = "call-shell-1",
) {
	return {
		shell_id: shellId,
		session_id: sessionId,
		generation,
		call_id: callId,
		command_preview: "npm test",
		background: true,
		status: "running",
		process_state: "running_background",
		output: "ready\n",
		next_cursor: 6,
		output_chars: 6,
		omitted_output_chars: 0,
		transport: "pipe",
		tty: false,
		yielded: true,
		started_at: "2026-08-05T00:00:00.000Z",
	};
}

function shellLifecycle(
	overrides: Partial<ShellLifecycleEvent> = {},
): ShellLifecycleEvent {
	return Object.freeze({
		type: "shell_lifecycle",
		kind: "shell.started",
		shellId: "a1b2c3d4",
		ownerSessionId: "session-node",
		callId: "call-shell-1",
		sequence: 1,
		commandPreview: "npm test",
		background: true,
		processState: "running_background",
		transport: "pipe",
		tty: false,
		yielded: true,
		...overrides,
	});
}

function gatewaySessionCoordinator(
	runtime: NodeGatewayRuntime,
	options: {
		readonly targetFailure?: string;
		readonly targetReadOnly?: boolean;
		readonly prepareTarget?: () => Promise<void>;
		readonly targetQueue?: QueueSnapshot;
		readonly initialPendingApproval?: boolean;
		readonly targetPendingApproval?: boolean;
		readonly approvalOptions?: readonly PendingApprovalChoice[];
	},
): SessionCoordinator<NodeGatewayRuntime> {
	return new SessionCoordinator({
		initial: preparedGatewaySession(
			"session-node",
			runtime,
			false,
			emptyQueue("session-node"),
			options.initialPendingApproval ?? false,
			options.approvalOptions,
		),
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
				options.targetPendingApproval ?? false,
				options.approvalOptions,
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
	pendingApproval = false,
	approvalOptions: readonly PendingApprovalChoice[] = ["approve_once", "reject"],
): PreparedSession<NodeGatewayRuntime> {
	return {
		sessionId,
		workspaceRoot: "/repo",
		threadId: sessionId,
		transcript: [transcriptItem(sessionId)],
		queue,
		...(pendingApproval ? { pendingApproval: {
			sessionId,
			clientTurnId: `client-${sessionId}`,
			turnId: `turn-${sessionId}`,
			decisionId: `decision-${sessionId}`,
			callId: `call-${sessionId}`,
			toolName: "Write",
			preview: "Write notes.txt",
			reason: "Approval required",
			options: approvalOptions,
		} } : {}),
		suspendedTurn: pendingApproval,
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

function gatewayQueueFixture(initial: QueueSnapshot) {
	let durable = initial;
	let nextQueueId = 0;
	const persistedRevisions: number[] = [];
	const fixture = {
		failSave: false,
		persistedRevisions,
		coordinator: undefined as unknown as QueueCoordinator,
	};
	const store: QueueCoordinatorStore = {
		loadCommittedQueueIds: () => new Set(),
		saveSnapshot: (snapshot) => {
			if (fixture.failSave) {
				throw new StorageFailure("private sqlite path /Users/example/.mycli/sessions.db");
			}
			durable = snapshot;
			persistedRevisions.push(snapshot.revision);
		},
		commitPending: (_turnId, records) => {
			const ids = new Set(records.map((record) => record.queueId));
			durable = Object.freeze({
				...durable,
				revision: durable.revision + 1,
				pendingSteers: Object.freeze(durable.pendingSteers.filter(
					(record) => !ids.has(record.queueId),
				)),
			});
			persistedRevisions.push(durable.revision);
			return durable;
		},
	};
	fixture.coordinator = new QueueCoordinator({
		initial,
		store,
		activeTurnId: null,
		createQueueId: () => `queue-${++nextQueueId}`,
		clock: () => "2026-08-04T00:00:00.000Z",
	});
	return fixture;
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
