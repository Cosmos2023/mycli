import { writeFile } from "node:fs/promises";
import { GatewayRequestError, GatewayClient, type GatewayEvent } from "../../src/adapters/gateway-client.ts";
import { GatewayEventDeduper } from "../../src/adapters/gateway-events.ts";
import {
	initialRuntimeState,
	reduceRuntimeEvent,
	runtimeStateFromBootstrap,
	runtimeStateFromTranscript,
	runtimeStateAfterCommandResult,
	runtimeStateWithUserMessage,
	sessionsFromResult,
	type RuntimeShellState,
} from "../../src/adapters/runtime-state.ts";

type ExpectedScriptedTurnState =
	| "waiting_approval"
	| "waiting_clarification"
	| "completed"
	| "failed"
	| "interrupted"
	| "rejected";

type ScriptedAction =
	| { type: "approval.respond"; choice: string }
	| {
			type: "approval.respond_raw";
			decision_id: string;
			choice: string;
			expect_error?: boolean;
	  }
	| { type: "clarify.respond"; response: string }
	| { type: "session.resume"; session_id: string }
	| {
			type: "turn.submit_expect";
			message: string;
			expected_state: ExpectedScriptedTurnState;
	  }
	| {
			type: "turn.submit_queue";
			message: string;
			steering?: string[];
			follow_up?: string[];
			clear?: boolean;
			expected_state?: ExpectedScriptedTurnState;
	  }
	| { type: "turn.steer"; message: string }
	| { type: "turn.follow_up"; message: string }
	| { type: "turn.queue.clear" }
	| { type: "turn.submit_interrupt"; message: string };

let state: RuntimeShellState = initialRuntimeState();
let sessions: unknown[] = [];
const eventDeduper = new GatewayEventDeduper();

const client = new GatewayClient({
	input: process.stdin,
	output: process.stdout,
	log: (event) => handleGatewayEvent(event),
});

export async function runScriptedClient(
	scriptRaw = process.env.MYCLI_NODE_TUI_SCRIPT || "[]",
): Promise<void> {
	client.start();
	try {
		const bootstrap = await send("session.bootstrap", {
			protocol_version: 1,
			client: { name: "mycli-shell-scripted", version: "0.1.0" },
		});
		state = runtimeStateFromBootstrap(state, bootstrap);
		await loadTranscript();
		await loadSessions();

		const script = JSON.parse(scriptRaw) as unknown[];
		let turnSequence = 0;
		for (const item of script) {
			if (isScriptedAction(item)) {
				await runScriptedAction(item);
				continue;
			}
			if (typeof item !== "string" || !item.trim()) {
				continue;
			}
			if (item.startsWith("/")) {
				await runScriptedCommand(item);
				continue;
			}
			turnSequence += 1;
			const clientTurnId = `script_${turnSequence}`;
			state = runtimeStateWithUserMessage(state, item);
			await send("turn.submit", { message: item, client_turn_id: clientTurnId });
			await waitForSubmittedTurn(clientTurnId);
		}

		await send("shutdown", {});
		await dumpStateIfRequested();
	} finally {
		client.stop();
	}
}

function handleGatewayEvent(event: GatewayEvent): void {
	if (!eventDeduper.shouldConsume(event)) {
		return;
	}
	state = reduceRuntimeEvent(state, event.method, event.params);
	process.stderr.write(`[mycli-shell-scripted] ${event.method}\n`);
}

async function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	try {
		return await client.send(method, params);
	} catch (error) {
		void method;
		throw error;
	}
}

async function loadTranscript(): Promise<void> {
	const payload = await send("transcript.load", {
		session_id: state.sessionId ?? undefined,
		before: null,
	});
	state = runtimeStateFromTranscript(state, payload);
}

async function loadSessions(): Promise<void> {
	try {
		const result = await send("session.list", {});
		sessions = sessionsFromResult(result);
	} catch {
		sessions = [];
	}
}

async function runScriptedCommand(command: string): Promise<void> {
	const result = await send("command.run", { command, surface: "cli" });
	state = await runtimeStateAfterCommandResult(
		state,
		command,
		result,
		async (sessionId) =>
			await send("transcript.load", { session_id: sessionId, before: null }),
	);
	if (result.exit_requested === true) {
		await send("shutdown", {});
		await dumpStateIfRequested();
	}
}

async function runScriptedAction(action: ScriptedAction): Promise<void> {
	if (action.type === "turn.submit_interrupt") {
		const clientTurnId = `script_interrupt_${Date.now()}`;
		state = runtimeStateWithUserMessage(state, action.message);
		await send("turn.submit", {
			message: action.message,
			client_turn_id: clientTurnId,
		});
		await client.waitForEvent("turn.started", (event) => event.params.client_turn_id === clientTurnId);
		await send("turn.interrupt", {});
		await waitForInterruptedTerminal(clientTurnId);
		await waitForInterruptedStatus(clientTurnId);
		return;
	}

	if (action.type === "turn.submit_expect") {
		const clientTurnId = `script_expect_${Date.now()}`;
		state = runtimeStateWithUserMessage(state, action.message);
		await send("turn.submit", {
			message: action.message,
			client_turn_id: clientTurnId,
		});
		await waitForExpectedTurnState(clientTurnId, action.expected_state);
		return;
	}

	if (action.type === "turn.submit_queue") {
		const clientTurnId = `script_queue_${Date.now()}`;
		state = runtimeStateWithUserMessage(state, action.message);
		await send("turn.submit", {
			message: action.message,
			client_turn_id: clientTurnId,
		});
		await client.waitForEvent("turn.started", (event) => event.params.client_turn_id === clientTurnId);
		for (const message of action.steering ?? []) {
			await queueMessage("turn.steer", message, "steering");
		}
		for (const message of action.follow_up ?? []) {
			await queueMessage("turn.follow_up", message, "follow_up");
		}
		if (action.clear === true) {
			await send("turn.queue.clear", {});
			await waitForQueue((event) => queueValues(event, "steering").length === 0 && queueValues(event, "follow_up").length === 0);
		}
		await waitForExpectedTurnState(clientTurnId, action.expected_state ?? "completed");
		return;
	}

	if (action.type === "turn.steer") {
		await queueMessage("turn.steer", action.message, "steering");
		return;
	}

	if (action.type === "turn.follow_up") {
		await queueMessage("turn.follow_up", action.message, "follow_up");
		return;
	}

	if (action.type === "turn.queue.clear") {
		await send("turn.queue.clear", {});
		await waitForQueue((event) => queueValues(event, "steering").length === 0 && queueValues(event, "follow_up").length === 0);
		return;
	}

	if (action.type === "session.resume") {
		const result = await send("session.resume", { session_id: action.session_id });
		state = await runtimeStateAfterCommandResult(
			state,
			`/resume ${action.session_id}`,
			{ ...result, mutated_session: true },
			async (sessionId) =>
				await send("transcript.load", { session_id: sessionId, before: null }),
		);
		return;
	}

	if (action.type === "approval.respond") {
		const decisionId = pendingId(state.pendingApproval, "decision_id", "approval.respond");
		const result = await sendForScriptedState(
			"approval.respond",
			{
				decision_id: decisionId,
				choice: action.choice,
			},
			false,
		);
		const clientTurnId = requiredString(result, "client_turn_id", "approval.respond");
		await client.waitForEvent("turn.completed", (event) => event.params.client_turn_id === clientTurnId);
		await waitForTerminalStatus(clientTurnId);
		return;
	}

	if (action.type === "approval.respond_raw") {
		await sendForScriptedState(
			"approval.respond",
			{
				decision_id: action.decision_id,
				choice: action.choice,
			},
			action.expect_error === true,
		);
		return;
	}

	const requestId = pendingId(state.pendingClarification, "request_id", "clarify.respond");
	const result = await sendForScriptedState(
		"clarify.respond",
		{
			request_id: requestId,
			response: action.response,
		},
		false,
	);
	const clientTurnId = requiredString(result, "client_turn_id", "clarify.respond");
	await client.waitForEvent("turn.completed", (event) => event.params.client_turn_id === clientTurnId);
	await waitForTerminalStatus(clientTurnId);
}

async function queueMessage(method: "turn.steer" | "turn.follow_up", message: string, queueKey: "steering" | "follow_up"): Promise<void> {
	const expectedTurnId = state.activeTurnId;
	if (method === "turn.steer" && !expectedTurnId) {
		throw new Error("turn.steer requires an active server turn.");
	}
	const result = await send(method, {
		message,
		...(method === "turn.steer" ? { expected_turn_id: expectedTurnId } : {}),
	});
	if (result.accepted !== true) {
		throw new Error(`${method} was not accepted.`);
	}
	await waitForQueue((event) => queueValues(event, queueKey).includes(message));
}

async function waitForSubmittedTurn(clientTurnId: string): Promise<void> {
	const completed = await client.waitForEvent(
		"turn.completed",
		(event) => event.params.client_turn_id === clientTurnId,
	);
	if (completed.params.turn_state === "waiting_approval") {
		await waitForPending(() => state.pendingApproval, "approval.request");
		return;
	}
	if (completed.params.turn_state === "waiting_clarification") {
		await waitForPending(() => state.pendingClarification, "clarify.request");
		return;
	}
	await waitForTerminalStatus(clientTurnId);
}

async function waitForExpectedTurnState(
	clientTurnId: string,
	expectedState: ExpectedScriptedTurnState,
): Promise<void> {
	if (expectedState === "waiting_approval") {
		await waitForCompletedTurnState(clientTurnId, expectedState);
		await waitForPending(() => state.pendingApproval, "approval.request");
		await waitForLiveStatus(clientTurnId, expectedState);
		return;
	}
	if (expectedState === "waiting_clarification") {
		await waitForCompletedTurnState(clientTurnId, expectedState);
		await waitForPending(() => state.pendingClarification, "clarify.request");
		await waitForLiveStatus(clientTurnId, expectedState);
		return;
	}
	if (expectedState === "interrupted") {
		await waitForInterruptedTerminal(clientTurnId);
		await waitForInterruptedStatus(clientTurnId);
		return;
	}
	await waitForCompletedTurnState(clientTurnId, expectedState);
	await waitForLiveStatus(clientTurnId, expectedState);
}

async function waitForCompletedTurnState(
	clientTurnId: string,
	expectedState: ExpectedScriptedTurnState,
): Promise<void> {
	await client.waitForEvent(
		"turn.completed",
		(event) => event.params.client_turn_id === clientTurnId && event.params.turn_state === expectedState,
	);
}

async function waitForInterruptedTerminal(clientTurnId: string): Promise<void> {
	await Promise.race([
		client.waitForEvent(
			"turn.completed",
			(event) => event.params.client_turn_id === clientTurnId && event.params.turn_state === "interrupted",
		),
		client.waitForEvent(
			"turn.completion_suppressed",
			(event) => event.params.client_turn_id === clientTurnId && event.params.reason === "interrupt_requested",
		),
	]);
}

async function waitForInterruptedStatus(clientTurnId: string): Promise<void> {
	await client.waitForEvent(
		"turn.status",
		(event) =>
			event.params.client_turn_id === clientTurnId &&
			event.params.state === "interrupted" &&
			event.params.terminal === true,
	);
}

async function waitForLiveStatus(
	clientTurnId: string,
	expectedState: ExpectedScriptedTurnState,
): Promise<void> {
	await client.waitForEvent(
		"status.update",
		(event) => event.params.client_turn_id === clientTurnId && event.params.state === expectedState,
	);
}

async function waitForTerminalStatus(clientTurnId: string): Promise<void> {
	await client.waitForEvent(
		"status.update",
		(event) =>
			event.params.client_turn_id === clientTurnId &&
			(event.params.state === "completed" ||
				event.params.state === "failed" ||
				event.params.state === "interrupted" ||
				event.params.state === "rejected"),
	);
}

async function sendForScriptedState(
	method: string,
	params: Record<string, unknown>,
	expectError: boolean,
): Promise<Record<string, unknown>> {
	try {
		return await send(method, params);
	} catch (error: unknown) {
		if (expectError) {
			return {};
		}
		throw error;
	}
}

async function waitForPending(
	getPending: () => Record<string, unknown> | null,
	eventName: string,
): Promise<void> {
	if (getPending()) {
		return;
	}
	await Promise.resolve();
	if (getPending()) {
		return;
	}
	throw new Error(`${eventName} did not update scripted client state.`);
}

async function waitForQueue(matches: (event: GatewayEvent) => boolean): Promise<void> {
	await client.waitForEvent("turn.queue.updated", matches);
}

function queueValues(event: GatewayEvent, key: "steering" | "follow_up"): string[] {
	const value = event.params[key];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function isScriptedAction(item: unknown): item is ScriptedAction {
	if (typeof item !== "object" || item === null || Array.isArray(item)) {
		return false;
	}
	const record = item as Record<string, unknown>;
	if (record.type === "approval.respond") {
		return typeof record.choice === "string";
	}
	if (record.type === "approval.respond_raw") {
		return typeof record.decision_id === "string" && typeof record.choice === "string";
	}
	if (record.type === "clarify.respond") {
		return typeof record.response === "string";
	}
	if (record.type === "session.resume") {
		return typeof record.session_id === "string";
	}
	if (record.type === "turn.submit_expect") {
		return typeof record.message === "string" && isExpectedScriptedTurnState(record.expected_state);
	}
	if (record.type === "turn.submit_queue") {
		const steering = record.steering;
		const followUp = record.follow_up;
		return (
			typeof record.message === "string" &&
			(steering === undefined || isStringArray(steering)) &&
			(followUp === undefined || isStringArray(followUp)) &&
			(record.clear === undefined || typeof record.clear === "boolean") &&
			(record.expected_state === undefined || isExpectedScriptedTurnState(record.expected_state))
		);
	}
	if (record.type === "turn.steer") {
		return typeof record.message === "string";
	}
	if (record.type === "turn.follow_up") {
		return typeof record.message === "string";
	}
	if (record.type === "turn.queue.clear") {
		return true;
	}
	if (record.type === "turn.submit_interrupt") {
		return typeof record.message === "string";
	}
	return false;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isExpectedScriptedTurnState(value: unknown): value is ExpectedScriptedTurnState {
	return (
		value === "waiting_approval" ||
		value === "waiting_clarification" ||
		value === "completed" ||
		value === "failed" ||
		value === "interrupted" ||
		value === "rejected"
	);
}

function pendingId(
	pending: Record<string, unknown> | null,
	key: string,
	actionName: string,
): string {
	const value = pending?.[key];
	if (typeof value === "string" && value.trim()) {
		return value;
	}
	throw new Error(`${actionName} requires pending ${key}.`);
}

function requiredString(payload: Record<string, unknown>, key: string, actionName: string): string {
	const value = payload[key];
	if (typeof value === "string" && value.trim()) {
		return value;
	}
	throw new Error(`${actionName} response missing ${key}.`);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

async function dumpStateIfRequested(): Promise<void> {
	const dumpPath = process.env.MYCLI_NODE_TUI_STATE_DUMP;
	if (!dumpPath) {
		return;
	}
	const dump = {
		...state,
		currentTurnId: state.turnRunning ? state.activeAssistantItemId : null,
		sessions,
	};
	await writeFile(dumpPath, `${JSON.stringify(dump)}\n`, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runScriptedClient().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "scripted client failed";
		process.stderr.write(`[mycli-shell-scripted] error: ${message}\n`);
		process.exitCode = 1;
	});
}
