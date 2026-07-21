import { writeFile } from "node:fs/promises";
import { GatewayRequestError, GatewayClient, type GatewayEvent } from "../../src/adapters/gateway-client.ts";
import { GatewayEventDeduper } from "../../src/adapters/gateway-events.ts";
import {
	initialRuntimeState,
	reduceRuntimeEvent,
	runtimeStateFromBootstrap,
	runtimeStateFromTranscript,
	runtimeStateAfterCommandResult,
	runtimeStateWithLegacyQueueMigration,
	runtimeStateWithPendingSteer,
	runtimeStateWithSubmittingMessage,
	runtimeStateWithLocalFollowUp,
	runtimeStateRejectPendingSteer,
	restorePendingSteersAfterInterrupt,
	nextLocalUserInput,
	removeLocalUserInput,
	sessionsFromResult,
	legacyQueueMigrationToken,
	type RuntimeShellState,
	type RuntimeLocalUserInput,
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
let clientMessageSequence = 0;
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
		await acknowledgeLegacyQueueMigration(bootstrap);
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
			await submitScriptedTurn(item, clientTurnId);
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
	if (
		event.method === "turn.interrupted" ||
		(event.method === "turn.completed" && event.params.turn_state === "interrupted")
	) {
		state = restorePendingSteersAfterInterrupt(state);
	}
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

async function acknowledgeLegacyQueueMigration(
	payload: Record<string, unknown>,
): Promise<void> {
	const migrationToken = legacyQueueMigrationToken(payload);
	if (!migrationToken) return;
	try {
		await send("turn.queue.migration.ack", { token: migrationToken });
	} catch (error) {
		if (!(error instanceof GatewayRequestError && error.code === "queue_conflict")) {
			throw error;
		}
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
		await submitScriptedTurn(action.message, clientTurnId);
		await client.waitForEvent("turn.started", (event) => event.params.client_turn_id === clientTurnId);
		await send("turn.interrupt", {});
		await waitForInterruptedTerminal(clientTurnId);
		await waitForInterruptedStatus(clientTurnId);
		return;
	}

	if (action.type === "turn.submit_expect") {
		const clientTurnId = `script_expect_${Date.now()}`;
		await submitScriptedTurn(action.message, clientTurnId);
		await waitForExpectedTurnState(clientTurnId, action.expected_state);
		return;
	}

	if (action.type === "turn.submit_queue") {
		const clientTurnId = `script_queue_${Date.now()}`;
		await submitScriptedTurn(action.message, clientTurnId);
		await client.waitForEvent("turn.started", (event) => event.params.client_turn_id === clientTurnId);
		for (const message of action.steering ?? []) {
			await queueSteeringMessage(message);
		}
		for (const message of action.follow_up ?? []) {
			queueFollowUpMessage(message);
		}
		if (action.clear === true) {
			clearLocalQueuedMessages();
		}
		await waitForExpectedTurnState(clientTurnId, action.expected_state ?? "completed");
		await dispatchLocalInputs();
		return;
	}

	if (action.type === "turn.steer") {
		await queueSteeringMessage(action.message);
		return;
	}

	if (action.type === "turn.follow_up") {
		queueFollowUpMessage(action.message);
		return;
	}

	if (action.type === "turn.queue.clear") {
		clearLocalQueuedMessages();
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
		state = runtimeStateWithLegacyQueueMigration(state, result);
		await acknowledgeLegacyQueueMigration(result);
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

async function submitScriptedTurn(
	message: string,
	clientTurnId: string,
	input = localInput(message, "user"),
): Promise<void> {
	state = runtimeStateWithSubmittingMessage(state, input);
	try {
		await send("turn.submit", {
			message,
			client_turn_id: clientTurnId,
			client_user_message_id: input.clientUserMessageId,
		});
	} catch (error) {
		state = removeLocalUserInput(state, input.clientUserMessageId);
		throw error;
	}
}

async function dispatchLocalInputs(): Promise<void> {
	await client.waitForEvent(
		"status.changed",
		(event) => event.params.turn_running === false,
	);
	while (!state.pendingApproval && !state.pendingClarification) {
		const next = nextLocalUserInput(state);
		if (!next) {
			return;
		}
		state = removeLocalUserInput(state, next.input.clientUserMessageId);
		const clientTurnId = `script_local_${Date.now()}_${clientMessageSequence}`;
		await submitScriptedTurn(next.input.message, clientTurnId, next.input);
		await waitForSubmittedTurn(clientTurnId);
	}
}

async function queueSteeringMessage(message: string): Promise<void> {
	const input = localInput(message, "steer");
	state = runtimeStateWithPendingSteer(state, input);
	let expectedTurnId = state.activeTurnId;
	if (!expectedTurnId) {
		state = runtimeStateRejectPendingSteer(state, input.clientUserMessageId);
		return;
	}
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await send("turn.steer", {
				message,
				client_user_message_id: input.clientUserMessageId,
				expected_turn_id: expectedTurnId,
			});
			return;
		} catch (error) {
			const actualTurnId =
				error instanceof GatewayRequestError &&
				error.code === "turn_id_mismatch" &&
				typeof error.data.actual_turn_id === "string"
					? error.data.actual_turn_id
					: null;
			if (attempt === 0 && actualTurnId) {
				expectedTurnId = actualTurnId;
				state = { ...state, activeTurnId: actualTurnId };
				continue;
			}
			state = runtimeStateRejectPendingSteer(state, input.clientUserMessageId);
			return;
		}
	}
}

function queueFollowUpMessage(message: string): void {
	state = runtimeStateWithLocalFollowUp(state, localInput(message, "follow_up"));
}

function clearLocalQueuedMessages(): void {
	state = {
		...state,
		localPendingSteers: [],
		localRejectedSteers: [],
		localFollowUps: [],
	};
}

function localInput(message: string, prefix: string): RuntimeLocalUserInput {
	clientMessageSequence += 1;
	return {
		clientUserMessageId: `${prefix}_${Date.now()}_${clientMessageSequence}`,
		message,
		attachments: [],
	};
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
