import assert from "node:assert/strict";
import test from "node:test";
import { parseGatewayToolRecord, type GatewayEventNotification } from "@mycli/contracts";
import {
	NodeGatewayEventProjector,
	type GatewayEventOwnership,
} from "../src/node-runtime/node-gateway-event-projector.ts";

test("runtime projection stamps direct and mirrored events with one ownership identity", () => {
	const notifications: GatewayEventNotification[] = [];
	const ownership: GatewayEventOwnership = Object.freeze({
		sessionId: "session-a",
		generation: 3,
		turnId: "turn-a",
	});
	const projector = new NodeGatewayEventProjector({
		clock: () => 42,
		currentOwnership: () => ownership,
		write: (notification) => { notifications.push(notification); },
	});

	projector.emitRuntime("message.delta", {
		client_turn_id: "client-turn-a",
		text: "hello",
	});

	assert.deepEqual(notifications, [
		{
			jsonrpc: "2.0",
			method: "message.delta",
			params: {
				client_turn_id: "client-turn-a",
				text: "hello",
				session_id: "session-a",
				generation: 3,
				turn_id: "turn-a",
			},
		},
		{
			jsonrpc: "2.0",
			method: "runtime.event",
			params: {
				version: 1,
				sequence: 1,
				type: "message.delta",
				payload: {
					client_turn_id: "client-turn-a",
					text: "hello",
					session_id: "session-a",
					generation: 3,
					turn_id: "turn-a",
				},
				timestamp: 42,
				session_id: "session-a",
				generation: 3,
				turn_id: "turn-a",
			},
		},
	]);
});

test("runtime projection accepts an explicit source ownership after the current session changes", () => {
	const notifications: GatewayEventNotification[] = [];
	const projector = new NodeGatewayEventProjector({
		clock: () => 7,
		currentOwnership: () => ({ sessionId: "session-b", generation: 5 }),
		write: (notification) => { notifications.push(notification); },
	});

	projector.emitRuntime(
		"turn.completed",
		{
			client_turn_id: "client-turn-a",
			turn_id: "turn-a",
			assistant_message: "done",
			activity_events: [],
			progress_updates: [],
			plan_steps: [],
			pending_decision: false,
			turn_state: "completed",
			usage: {},
		},
		{ sessionId: "session-a", generation: 4, turnId: "turn-a" },
	);

	const completed = notifications[0];
	const mirrored = notifications[1];
	assert.equal(completed?.method, "turn.completed");
	assert.equal(mirrored?.method, "runtime.event");
	if (completed?.method !== "turn.completed" || mirrored?.method !== "runtime.event") {
		assert.fail("expected completed and mirrored runtime notifications");
	}
	assert.equal(completed.params.session_id, "session-a");
	assert.equal(completed.params.generation, 4);
	assert.equal(mirrored.params.session_id, "session-a");
	assert.equal(mirrored.params.generation, 4);
});

test("direct global projection validates without adding session ownership", () => {
	const notifications: GatewayEventNotification[] = [];
	const projector = new NodeGatewayEventProjector({
		clock: () => 0,
		currentOwnership: () => ({ sessionId: "session-a", generation: 1 }),
		write: (notification) => { notifications.push(notification); },
	});

	projector.emitDirect("extension.updated", { version: 2 });

	assert.deepEqual(notifications, [{
		jsonrpc: "2.0",
		method: "extension.updated",
		params: { version: 2 },
	}]);
});

test("runtime projection preserves a child routing session while the envelope owns the root", () => {
	const notifications: GatewayEventNotification[] = [];
	const projector = new NodeGatewayEventProjector({
		clock: () => 9,
		currentOwnership: () => ({ sessionId: "root-session", generation: 6 }),
		write: (notification) => { notifications.push(notification); },
	});

	projector.emitRuntime("approval.request", {
		session_id: "child-session",
		child_session_id: "child-session",
		decision_id: "decision-1",
		preview: "run command",
		options: [],
	});

	const request = notifications[0];
	const mirrored = notifications[1];
	assert.equal(request?.method, "approval.request");
	assert.equal(mirrored?.method, "runtime.event");
	if (request?.method !== "approval.request" || mirrored?.method !== "runtime.event") {
		assert.fail("expected approval and mirrored runtime notifications");
	}
	assert.equal(request.params.session_id, "child-session");
	assert.equal(request.params.generation, undefined);
	assert.equal(mirrored.params.session_id, "root-session");
	assert.equal(mirrored.params.generation, 6);
});

test("tool lifecycle projection shares one validated allowlisted record with its runtime mirror", () => {
	for (const [method, status] of [["tool.start", "running"], ["tool.complete", "success"], ["tool.failed", "error"]] as const) {
		const notifications: GatewayEventNotification[] = [];
		const projector = new NodeGatewayEventProjector({
			clock: () => 0,
			currentOwnership: () => ({ sessionId: "session", generation: 1 }),
			write: (notification) => { notifications.push(notification); },
		});
		projector.emitRuntime(method, {
			client_turn_id: "client", call_id: "call", tool_id: "call", name: "Read", context: "source.ts",
			duration_s: 0.125, summary: "preview", summary_chars: 7, summary_truncated: false,
			success: method !== "tool.failed", error: "failed", error_chars: 6, error_truncated: false,
			arguments: { token: "private-argument" }, raw_payload: { credentials: "private-payload" }, rationale: "private-rationale",
		});
		const direct = notifications[0]!;
		const mirror = notifications[1]!;
		assert.equal(direct.method, method);
		assert.ok(mirror.method === "runtime.event");
		const record = parseGatewayToolRecord(direct.params.tool_record);
		assert.equal(record.status, status);
		assert.equal(record.call_id, "call");
		assert.equal(record.duration_ms, 125);
		assert.equal(mirror.params.payload.tool_record, record);
		assert.doesNotMatch(JSON.stringify(record), /private-|arguments|raw_payload|rationale/);
	}
});
