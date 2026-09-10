import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayEventOwnership,
	RuntimeGatewayEventMethod,
} from "../src/node-runtime/node-gateway-event-projector.ts";
import { NodeGatewayInteractiveController } from "../src/node-runtime/node-gateway-interactive-controller.ts";

type JsonObject = Record<string, unknown>;

interface PublishedEvent {
	readonly method: RuntimeGatewayEventMethod;
	readonly params: JsonObject;
	readonly ownership: GatewayEventOwnership;
}

test("interactive controller serializes requests and preserves each source ownership", () => {
	const events: PublishedEvent[] = [];
	const controller = new NodeGatewayInteractiveController({
		publish: (method, params, ownership) => { events.push({ method, params, ownership }); },
	});
	const root = Object.freeze({ sessionId: "root", generation: 3, turnId: "root-turn" });
	const child = Object.freeze({ sessionId: "root", generation: 3 });

	controller.emit("approval.request", {
		session_id: "root",
		generation: 3,
		decision_id: "root-decision",
		preview: "root action",
		options: [],
	}, root);
	controller.emit("clarify.request", {
		session_id: "child",
		child_session_id: "child",
		request_id: "child-question",
		tool_id: "tool",
		call_id: "call",
		tool_name: "AskUserQuestion",
		question: "Continue?",
		options: [],
		multi_select: false,
	}, child);

	assert.equal(controller.hasPending(), true);
	assert.deepEqual(events.map((event) => event.method), ["approval.request"]);
	controller.emit("approval.respond", {
		session_id: "root",
		generation: 3,
		decision_id: "root-decision",
		choice: "approve_once",
	}, root);
	assert.deepEqual(events.map((event) => event.method), [
		"approval.request",
		"approval.respond",
		"clarify.request",
	]);
	assert.equal(events[1]?.ownership, root);
	assert.equal(events[2]?.ownership, child);
	controller.clear();
	assert.equal(controller.hasPending(), false);
});

test("interactive controller publishes visible cancellation before presenting the next request", () => {
	const events: PublishedEvent[] = [];
	const controller = new NodeGatewayInteractiveController({
		publish: (method, params, ownership) => { events.push({ method, params, ownership }); },
	});
	const ownership = Object.freeze({ sessionId: "root", generation: 1 });
	controller.emit("approval.request", {
		session_id: "child-a",
		decision_id: "decision-a",
		preview: "A",
		options: [],
	}, ownership);
	controller.emit("approval.request", {
		session_id: "child-b",
		decision_id: "decision-b",
		preview: "B",
		options: [],
	}, ownership);

	const cancelled = {
		session_id: "child-a",
		child_session_id: "child-a",
		generation: 1,
		client_turn_id: "child-client-a",
		turn_id: "child-turn-a",
		decision_id: "decision-a",
	};
	assert.equal(controller.cancel(cancelled), true);
	assert.deepEqual(events.map((event) => event.method), [
		"approval.request",
		"interactive.cancelled",
		"approval.request",
	]);
	assert.equal(events[1]?.params, cancelled);
	assert.equal(events[1]?.ownership, ownership);
	assert.equal(controller.hasPending(), true);
});

test("bootstrap re-emits only the current interactive request without requeuing resolved decisions", () => {
	const events: PublishedEvent[] = [];
	const controller = new NodeGatewayInteractiveController({
		publish: (method, params, ownership) => { events.push({ method, params, ownership }); },
	});
	const ownership = Object.freeze({ sessionId: "root", generation: 2 });
	const approval = { session_id: "child", decision_id: "decision", preview: "Action", options: [] };
	const clarification = { session_id: "root", request_id: "question", question: "Continue?" };
	assert.equal(controller.reemitVisibleRequest(), false);
	controller.emit("approval.request", approval, ownership);
	controller.emit("clarify.request", clarification, ownership);
	controller.emit("approval.request", approval, ownership);
	assert.equal(events.length, 1);
	assert.equal(controller.reemitVisibleRequest(), true);
	assert.deepEqual(events[1], events[0]);
	controller.emit("approval.respond", { session_id: "child", decision_id: "decision", choice: "approve_once" }, ownership);
	assert.equal(controller.reemitVisibleRequest(), true);
	assert.deepEqual(events.map((event) => event.method), [
		"approval.request", "approval.request", "approval.respond", "clarify.request", "clarify.request",
	]);
	controller.cancel({ session_id: "root", request_id: "question" });
	assert.equal(controller.reemitVisibleRequest(), false);
	assert.equal(events.at(-1)?.method, "interactive.cancelled");
	assert.equal(controller.hasPending(), false);
});

test("interactive controller removes an unseen cancellation without publishing it", () => {
	const events: PublishedEvent[] = [];
	const controller = new NodeGatewayInteractiveController({
		publish: (method, params, ownership) => { events.push({ method, params, ownership }); },
	});
	const ownership = Object.freeze({ sessionId: "root", generation: 1 });
	controller.emit("approval.request", {
		session_id: "child-a",
		decision_id: "decision-a",
		preview: "A",
		options: [],
	}, ownership);
	controller.emit("clarify.request", {
		session_id: "child-b",
		request_id: "question-b",
		tool_id: "tool-b",
		call_id: "call-b",
		tool_name: "AskUserQuestion",
		question: "B?",
		options: [],
		multi_select: false,
	}, ownership);

	assert.equal(controller.cancel({ session_id: "child-b", request_id: "question-b" }), true);
	assert.deepEqual(events.map((event) => event.method), ["approval.request"]);
	assert.equal(controller.hasPending(), true);
});
