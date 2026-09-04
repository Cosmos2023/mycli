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

test("interactive controller removes a cancelled request and presents the next one", () => {
	const methods: RuntimeGatewayEventMethod[] = [];
	const controller = new NodeGatewayInteractiveController({
		publish: (method) => { methods.push(method); },
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

	assert.equal(controller.cancel({ session_id: "child-a", decision_id: "decision-a" }), true);
	assert.deepEqual(methods, ["approval.request", "approval.request"]);
	assert.equal(controller.hasPending(), true);
});
