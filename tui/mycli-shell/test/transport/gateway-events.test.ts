import assert from "node:assert/strict";
import test from "node:test";
import { gatewayContractCatalog } from "@mycli/contracts";
import { GatewayEventDeduper } from "../../src/transport/gateway-events.ts";
import { isRuntimeEventMethod } from "../../src/state/runtime-events.ts";
import {
	initialRuntimeState,
	type RuntimeShellState,
} from "../../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../../src/state/runtime-projection.ts";
import {
	reduceDecodedRuntimeEvent,
	reduceDecodedRuntimeEventWithOutcome,
} from "../../src/state/runtime-event-reducer.ts";
import type { GatewayEvent } from "../../src/transport/gateway-client.ts";

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
		state = consume(state, deduper, item);
	}

	const shell = projectRuntimeState(state);
	const assistantMessages = shell.messages.filter((message) => message.role === "assistant");

	assert.equal(assistantMessages.length, 1);
	assert.equal(assistantMessages[0]?.text, "我是 mycli，你的本地编程助手。");
});

test("runtime event decoding derives its method surface from the canonical catalog", () => {
	const excluded = new Set(["extension.updated", "runtime.event", "runtime.ready"]);
	assert.deepEqual(
		gatewayContractCatalog.eventStreams.filter(isRuntimeEventMethod),
		gatewayContractCatalog.eventStreams.filter((method) => !excluded.has(method)),
	);
});

test("gateway event deduper still allows standalone runtime events", () => {
	const deduper = new GatewayEventDeduper();
	let state = initialRuntimeState();
	const item = runtimeEvent("status.update", { state: "running", text: "Thinking" });

	state = consume(state, deduper, item);

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
		state = consume(state, deduper, item);
	}

	assert.deepEqual(projectRuntimeState(state).transcript?.map((block) => block.kind), ["plan_update"]);
});

test("gateway event deduper commits direct and mirrored user lifecycle once", () => {
	const deduper = new GatewayEventDeduper();
	let state = initialRuntimeState();
	const payload = {
		turn_id: "turn-1",
		item: {
			id: "turn-1:user:client-1",
			type: "user_message",
			client_user_message_id: "client-1",
			content: "inspect",
			source: "steer",
		},
	};

	for (const item of [event("item.completed", payload), runtimeEvent("item.completed", payload)]) {
		state = consume(state, deduper, item);
	}

	assert.deepEqual(projectRuntimeState(state).messages.map((item) => item.text), ["inspect"]);
});

test("decoded runtime events reject stale session generations before any feature reducer runs", () => {
	const deduper = new GatewayEventDeduper();
	const state = activeState();
	const staleEvents: GatewayEvent[] = [
		event("message.delta", owned({ text: "stale assistant text" }, { generation: 6 })),
		event("tool.start", owned({
			tool_id: "stale-tool",
			call_id: "stale-call",
			name: "Read",
			context: "old.ts",
		}, { generation: 6 })),
		event("plan.updated", owned({
			plan_steps: [{ id: "stale", step: "Stale plan", status: "in_progress" }],
		}, { generation: 6 })),
		event("compaction.started", owned({
			before_tokens: 20_000,
			max_tokens: 128_000,
			source: "pre_turn",
		}, { generation: 6 })),
		event("approval.request", {
			...owned({}, { generation: 6 }),
			decision_id: "stale-approval",
			options: [{ choice: "approve_once", label: "Approve" }],
		}),
	];

	for (const staleEvent of staleEvents) {
		assert.strictEqual(consume(state, deduper, staleEvent), state);
	}
});

test("stale status snapshots are rejected before gateway scheduling effects can run", () => {
	const deduper = new GatewayEventDeduper();
	const state = activeState();
	const decoded = deduper.consume(event("status.changed", {
		session_id: "root-session",
		generation: 6,
		turn_running: false,
	}));

	assert.ok(decoded);
	const reduction = reduceDecodedRuntimeEventWithOutcome(state, decoded);
	assert.equal(reduction.applied, false);
	assert.strictEqual(reduction.state, state);
});

test("current status snapshots produce an applied scheduling outcome", () => {
	const deduper = new GatewayEventDeduper();
	const state = activeState();
	const decoded = deduper.consume(event("status.changed", {
		session_id: "root-session",
		generation: 7,
		turn_running: false,
	}));

	assert.ok(decoded);
	const reduction = reduceDecodedRuntimeEventWithOutcome(state, decoded);
	assert.equal(reduction.applied, true);
	assert.equal(reduction.state.turnRunning, false);
});

test("decoded runtime events reject an older turn in the active session generation", () => {
	const deduper = new GatewayEventDeduper();
	const state = activeState();
	const staleTurnEvents: GatewayEvent[] = [
		event("message.delta", owned({ text: "stale" }, {
			turnId: "turn-old",
			clientTurnId: "client-old",
	})),
		event("tool.start", owned({
			tool_id: "stale-tool",
			call_id: "stale-call",
			name: "Read",
			context: "old.ts",
		}, { turnId: "turn-old", clientTurnId: "client-old" })),
		event("plan.updated", owned({
			plan_steps: [{ id: "stale", step: "Stale plan", status: "in_progress" }],
		}, { turnId: "turn-old", clientTurnId: "client-old" })),
		event("compaction.started", owned({
			before_tokens: 20_000,
			max_tokens: 128_000,
			source: "pre_turn",
		}, { turnId: "turn-old", clientTurnId: "client-old" })),
	];

	for (const staleEvent of staleTurnEvents) {
		assert.strictEqual(consume(state, deduper, staleEvent), state);
	}
});

test("anonymous terminal events cannot mutate an identified active turn", () => {
	const deduper = new GatewayEventDeduper();
	const state = activeState();
	for (const terminal of [
		event("turn.completed", {}),
		event("turn.failed", { code: "provider_error", message: "failed" }),
		event("turn.interrupted", { requested: false }),
		event("turn.status", {
			state: "completed",
			kind: "completed",
			text: "Completed",
			terminal: true,
		}),
	]) {
		assert.strictEqual(consume(state, deduper, terminal), state);
	}
});

test("terminal events cannot use an uncorrelated identity to release partial active ownership", () => {
	const deduper = new GatewayEventDeduper();
	const turnOnly = {
		...activeState(),
		activeClientTurnId: null,
	};
	assert.strictEqual(consume(turnOnly, deduper, event("turn.completed", owned({
		turn_state: "completed",
	}, {
		turnId: null,
		clientTurnId: "client-unknown",
	}))), turnOnly);

	const clientOnly = {
		...activeState(),
		activeTurnId: null,
	};
	assert.strictEqual(consume(clientOnly, deduper, event("turn.completed", owned({
		turn_state: "completed",
	}, {
		turnId: "turn-unknown",
		clientTurnId: null,
	}))), clientOnly);
});

test("workspace trust events cannot cross workspace ownership", () => {
	const deduper = new GatewayEventDeduper();
	const state = { ...activeState(), workspace: "/workspace/current" };
	const staleTrust = event("workspace.trust.changed", {
		session_id: "root-session",
		generation: 7,
		workspace: "/workspace/previous",
		state: "trusted",
		enforced: true,
	});

	assert.strictEqual(consume(state, deduper, staleTrust), state);
});

test("runtime envelopes retain root ownership for routed child clarification events", () => {
	const deduper = new GatewayEventDeduper();
	const childPayload = {
		session_id: "child-session",
		generation: 11,
		turn_id: "child-turn",
		client_turn_id: "child-client-turn",
		child_session_id: "child-session",
		agent_path: "/root/reviewer",
		worker_name: "reviewer",
		request_id: "child-question",
		tool_id: "ask-tool",
		tool_name: "AskUserQuestion",
		call_id: "ask-call",
		question: "Which path?",
		options: [{ label: "Runtime" }, { label: "TUI" }],
		multi_select: false,
	};
	let state = activeState();

	state = consume(state, deduper, event("clarify.request", childPayload));
	assert.equal(projectRuntimeState(state).pendingClarification, undefined);

	state = consume(state, deduper, runtimeEvent("clarify.request", childPayload, {
		sessionId: "root-session",
		generation: 7,
		turnId: "child-turn",
	}));

	assert.equal(projectRuntimeState(state).pendingClarification?.requestId, "child-question");
	assert.equal(projectRuntimeState(state).pendingClarification?.childSessionId, "child-session");
});

test("child interactive requests preserve the active root lifecycle and cancel exactly", () => {
	const deduper = new GatewayEventDeduper();
	const request = {
		session_id: "child-session",
		child_session_id: "child-session",
		generation: 11,
		turn_id: "child-turn",
		client_turn_id: "child-client-turn",
		decision_id: "child-decision",
		preview: "npm test",
		options: [{ choice: "approve_once", label: "Approve once" }],
	};
	let state = activeState();

	state = consume(state, deduper, event("approval.request", request));
	assert.equal(state.pendingApproval, null);
	state = consume(state, deduper, runtimeEvent("approval.request", request, {
		sessionId: "root-session",
		generation: 7,
	}));
	assert.equal(state.pendingApproval?.decision_id, "child-decision");
	assert.equal(state.turnRunning, true);
	assert.equal(state.activeTurnId, "turn-current");
	assert.equal(state.activeClientTurnId, "client-current");
	state = consume(state, deduper, event("subagent.updated", owned({
		subagent: {
			run_id: "child-run",
			child_session_id: "child-session",
			parent_turn_id: "turn-current",
			role: "worker",
			description: "Run tests",
			status: "interrupted",
			mode: "background",
		},
	})));
	assert.equal(state.pendingApproval?.decision_id, "child-decision");

	const wrongCancellation = {
		...request,
		decision_id: "another-decision",
	};
	state = consume(state, deduper, runtimeEvent("interactive.cancelled", wrongCancellation, {
		sessionId: "root-session",
		generation: 7,
	}));
	assert.equal(state.pendingApproval?.decision_id, "child-decision");
	state = consume(state, deduper, runtimeEvent("interactive.cancelled", {
		...request,
		generation: 10,
	}, {
		sessionId: "root-session",
		generation: 7,
	}));
	assert.equal(state.pendingApproval?.decision_id, "child-decision");

	state = consume(state, deduper, event("interactive.cancelled", request));
	assert.equal(state.pendingApproval?.decision_id, "child-decision");
	state = consume(state, deduper, runtimeEvent("interactive.cancelled", request, {
		sessionId: "root-session",
		generation: 7,
	}));
	assert.equal(state.pendingApproval, null);
	assert.equal(state.transcript.some((item) => item.type === "approval"), false);
	assert.equal(state.turnRunning, true);
	assert.equal(state.activeTurnId, "turn-current");
	assert.equal(state.activeClientTurnId, "client-current");
});

test("a child clarification response leaves an idle root idle", () => {
	const deduper = new GatewayEventDeduper();
	const request = {
		session_id: "child-session",
		child_session_id: "child-session",
		generation: 11,
		turn_id: "child-turn",
		client_turn_id: "child-client-turn",
		request_id: "child-question",
		tool_id: "ask-tool",
		call_id: "ask-call",
		tool_name: "AskUserQuestion",
		question: "Which path?",
		options: [{ label: "Runtime" }, { label: "TUI" }],
		multi_select: false,
	};
	let state: RuntimeShellState = {
		...initialRuntimeState(),
		sessionId: "root-session",
		sessionGeneration: 7,
	};

	state = consume(state, deduper, runtimeEvent("clarify.request", request, {
		sessionId: "root-session",
		generation: 7,
	}));
	assert.equal(state.pendingClarification?.request_id, "child-question");
	assert.equal(state.turnRunning, false);

	const response = {
		session_id: "child-session",
		generation: 11,
		turn_id: "child-turn",
		client_turn_id: "child-client-turn",
		request_id: "child-question",
		question: "Which path?",
		response: "Runtime",
		multi_select: false,
	};
	state = consume(state, deduper, event("clarify.respond", response));
	assert.equal(state.pendingClarification?.request_id, "child-question");
	state = consume(state, deduper, runtimeEvent("clarify.respond", response, {
		sessionId: "root-session",
		generation: 7,
	}));

	assert.equal(state.pendingClarification, null);
	assert.equal(state.turnRunning, false);
	assert.equal(state.activeTurnId, null);
	assert.equal(state.activeClientTurnId, null);
});

function consume(
	state: RuntimeShellState,
	deduper: GatewayEventDeduper,
	eventValue: GatewayEvent,
): RuntimeShellState {
	const decoded = deduper.consume(eventValue);
	return decoded ? reduceDecodedRuntimeEvent(state, decoded) : state;
}

function activeState(): RuntimeShellState {
	return {
		...initialRuntimeState(),
		sessionId: "root-session",
		sessionGeneration: 7,
		turnRunning: true,
		activeTurnId: "turn-current",
		activeClientTurnId: "client-current",
	};
}

function owned(
	params: Record<string, unknown>,
	overrides: {
		generation?: number;
		turnId?: string | null;
		clientTurnId?: string | null;
	} = {},
): Record<string, unknown> {
	return {
		...params,
		session_id: "root-session",
		generation: overrides.generation ?? 7,
		...(overrides.turnId === null
			? {}
			: { turn_id: overrides.turnId ?? "turn-current" }),
		...(overrides.clientTurnId === null
			? {}
			: { client_turn_id: overrides.clientTurnId ?? "client-current" }),
	};
}

function event(method: GatewayEvent["method"], params: Record<string, unknown>): GatewayEvent {
	return { jsonrpc: "2.0", method, params } as GatewayEvent;
}

function runtimeEvent(
	type: string,
	payload: Record<string, unknown>,
	ownership: { sessionId?: string; generation?: number; turnId?: string } = {},
): GatewayEvent {
	return event("runtime.event", {
		type,
		payload,
		sequence: 1,
		version: 1,
		timestamp: 1,
		...(ownership.sessionId ? { session_id: ownership.sessionId } : {}),
		...(ownership.generation === undefined ? {} : { generation: ownership.generation }),
		...(ownership.turnId ? { turn_id: ownership.turnId } : {}),
	});
}
