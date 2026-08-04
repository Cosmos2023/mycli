import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseGatewayEvent, parseJsonRpcMessage } from "@mycli/contracts";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import { fingerprintSubmission, type RuntimeEvent } from "@mycli/core";
import type { NoToolSubmission } from "@mycli/runtime";
import { createNodeGateway } from "../src/node-runtime/node-gateway.ts";

type RpcMessage = ReturnType<typeof parseJsonRpcMessage>;

function gatewayHarness(options: {
	conversation?: readonly { role: "user" | "assistant"; content: string }[];
	existingTurn?: RuntimeTurnRecord;
	reserve?: (submission: NoToolSubmission) => {
		readonly kind: "reserved" | "existing";
		readonly turn: RuntimeTurnRecord;
	};
} = {}) {
	let emitRuntime: ((event: RuntimeEvent) => void) | null = null;
	let signal: AbortSignal | null = null;
	let closeCalls = 0;
	let runtimeSettled = false;
	let releaseTurn!: () => void;
	const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
	const submissions: NoToolSubmission[] = [];
	const runtime = {
		reserve: options.reserve ?? ((submission: NoToolSubmission) => {
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
		submit: async (submission: NoToolSubmission, emit: (event: RuntimeEvent) => void, options: { signal: AbortSignal }) => {
			submissions.push(submission);
			emitRuntime = emit;
			signal = options.signal;
			await turnReleased;
			runtimeSettled = true;
			return turnRecord(submission, options.signal.aborted ? "interrupted" : "completed");
		},
	};
	const gateway = createNodeGateway({
		sessionId: "session-node",
		workspaceRoot: "/repo",
		provider: "openai",
		model: "gpt-test",
		runtime,
		loadConversation: () => options.conversation ?? [],
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
	}
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
	const reserve = (submission: NoToolSubmission) => {
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
	submission: NoToolSubmission,
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
