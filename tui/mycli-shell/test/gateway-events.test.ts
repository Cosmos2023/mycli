import assert from "node:assert/strict";
import test from "node:test";
import { GatewayEventDeduper } from "../src/adapters/gateway-events.ts";
import { initialRuntimeState, projectRuntimeState, reduceRuntimeEvent } from "../src/adapters/runtime-state.ts";
import type { GatewayEvent } from "../src/adapters/gateway-client.ts";

test("gateway event deduper skips mirrored runtime events after direct events", () => {
	const deduper = new GatewayEventDeduper();
	let state = initialRuntimeState();
	const events: GatewayEvent[] = [
		event("turn.started", { client_turn_id: "c1" }),
		runtimeEvent("turn.started", { client_turn_id: "c1" }),
		event("message.delta", { client_turn_id: "c1", text: "我是 mycli，" }),
		runtimeEvent("message.delta", { client_turn_id: "c1", text: "我是 mycli，" }),
		event("message.complete", { client_turn_id: "c1", final: true, text: "我是 mycli，你的本地编程助手。" }),
		runtimeEvent("message.complete", { client_turn_id: "c1", final: true, text: "我是 mycli，你的本地编程助手。" }),
	];

	for (const item of events) {
		if (deduper.shouldConsume(item)) {
			state = reduceRuntimeEvent(state, item.method, item.params);
		}
	}

	const shell = projectRuntimeState(state);
	const assistantMessages = shell.messages.filter((message) => message.role === "assistant");

	assert.equal(assistantMessages.length, 1);
	assert.equal(assistantMessages[0]?.text, "我是 mycli，你的本地编程助手。");
});

test("gateway event deduper still allows standalone runtime events", () => {
	const deduper = new GatewayEventDeduper();
	let state = initialRuntimeState();
	const item = runtimeEvent("status.update", { state: "running", text: "Thinking" });

	if (deduper.shouldConsume(item)) {
		state = reduceRuntimeEvent(state, item.method, item.params);
	}

	assert.equal(projectRuntimeState(state).footer.liveState, "Thinking");
});

test("gateway event deduper renders direct and mirrored Plan updates once", () => {
	const deduper = new GatewayEventDeduper();
	let state = initialRuntimeState();
	const payload = {
		client_turn_id: "c1",
		plan: { items: [{ id: "inspect", text: "Inspect runtime", status: "in_progress" }] },
		source: "Plan",
		completed: 0,
		total: 1,
	};

	for (const item of [event("plan.updated", payload), runtimeEvent("plan.updated", payload)]) {
		if (deduper.shouldConsume(item)) {
			state = reduceRuntimeEvent(state, item.method, item.params);
		}
	}

	assert.deepEqual(projectRuntimeState(state).transcript?.map((block) => block.kind), ["plan_update"]);
});

function event(method: string, params: Record<string, unknown>): GatewayEvent {
	return { jsonrpc: "2.0", method, params };
}

function runtimeEvent(type: string, payload: Record<string, unknown>): GatewayEvent {
	return event("runtime.event", { type, payload, sequence: 1, version: 1 });
}
