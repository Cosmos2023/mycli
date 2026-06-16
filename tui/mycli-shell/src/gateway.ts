import process from "node:process";
import { GatewayClient, GatewayRequestError, type GatewayEvent } from "./adapters/gateway-client.ts";
import {
	initialRuntimeState,
	projectRuntimeState,
	reduceRuntimeEvent,
	runtimeStateFromBootstrap,
	runtimeStateFromTranscript,
	runtimeStateWithCommandResult,
	runtimeStateWithMessageQueues,
	runtimeStateWithUserMessage,
	sessionsFromResult,
	type RuntimeShellState,
} from "./adapters/runtime-state.ts";
import { MycliShellRuntime } from "./shell-runtime.ts";
import { NativeChatRuntime } from "./native-chat-runtime.ts";
import type { MycliShellSession, MycliShellState } from "./model.ts";
import type { ProjectTrustDecision } from "./components/trust-selector.ts";
import { openTtyStreams, StreamTerminal, type TtyStreams } from "./adapters/tty-terminal.ts";
import { GatewayEventDeduper } from "./adapters/gateway-events.ts";

const client = new GatewayClient({
	input: process.stdin,
	output: process.stdout,
	log: (event) => handleGatewayEvent(event),
});

let runtimeState: RuntimeShellState = initialRuntimeState();
let sessions: MycliShellSession[] = [];
let runtime: MycliShellRuntime | null = null;
let nativeRuntime: NativeChatRuntime | null = null;
let ttyStreams: TtyStreams | null = null;
let bootstrapped = false;
const eventDeduper = new GatewayEventDeduper();
const queuedSteeringTurns: string[] = [];
const queuedFollowUpTurns: string[] = [];
let queueDrainTimer: NodeJS.Timeout | null = null;
let queueDraining = false;
let backendTurnBusy = false;
let clientTurnSequence = 0;

function currentShellState(): MycliShellState {
	return projectRuntimeState(runtimeState, sessions);
}

function setRuntimeState(nextState: RuntimeShellState): void {
	runtimeState = nextState;
	if (runtime) {
		runtime.setState(currentShellState());
	}
	if (nativeRuntime) {
		nativeRuntime.setState(currentShellState());
	}
}

function refreshRuntime(): void {
	runtime?.setState(currentShellState());
	nativeRuntime?.setState(currentShellState());
}

function handleGatewayEvent(event: GatewayEvent): void {
	if (!eventDeduper.shouldConsume(event)) {
		return;
	}
	setRuntimeState(reduceRuntimeEvent(runtimeState, event.method, event.params));
	if (event.method === "turn.started") {
		backendTurnBusy = true;
	}
	if (event.method === "status.changed" && backendTurnBusy && event.params.turn_running === false) {
		backendTurnBusy = false;
	}
	if (event.method === "turn.queue.updated") {
		queuedSteeringTurns.length = 0;
		queuedSteeringTurns.push(...stringArrayValue(event.params.steering));
		queuedFollowUpTurns.length = 0;
		queuedFollowUpTurns.push(...stringArrayValue(event.params.follow_up));
	}
	scheduleQueuedTurnDrain();
}

async function send(
	method: string,
	params: Record<string, unknown> = {},
	options: { recordErrors?: boolean } = {},
): Promise<Record<string, unknown>> {
	try {
		return await client.send(method, params);
	} catch (error) {
		const gatewayError =
			error instanceof GatewayRequestError
				? error
				: new GatewayRequestError({
						code: "request_failed",
						message: error instanceof Error ? error.message : "Request failed.",
						method,
					});
		if (options.recordErrors !== false) {
			setRuntimeState(
				reduceRuntimeEvent(runtimeState, "gateway.error", {
					code: gatewayError.code,
					message: gatewayError.message,
					method: gatewayError.method || method,
				}),
			);
		}
		throw error;
	}
}

async function bootstrap(): Promise<void> {
	client.start();
	const bootstrapPayload = await send("session.bootstrap", {
		protocol_version: 1,
		client: { name: "mycli-shell-tui", version: "0.1.0" },
	});
	setRuntimeState(runtimeStateFromBootstrap(runtimeState, bootstrapPayload));
	const transcriptPayload = await send("transcript.load", {
		session_id: runtimeState.sessionId ?? undefined,
		before: null,
	});
	setRuntimeState(runtimeStateFromTranscript(runtimeState, transcriptPayload));
	await loadSessions();
	bootstrapped = true;
}

async function loadSessions(): Promise<void> {
	try {
		const result = await send("session.list", {});
		sessions = sessionsFromResult(result);
		refreshRuntime();
	} catch {
		sessions = [];
	}
}

async function submitTurn(message: string, options: { fromQueue?: "steer" | "followUp" } = {}): Promise<void> {
	const text = message.trim();
	if (!text) {
		return;
	}
	if (!options.fromQueue && runtimeState.turnRunning) {
		await queueSteeringTurn(text);
		return;
	}
	try {
		await send("turn.submit", { message: text, client_turn_id: nextClientTurnId(options.fromQueue ?? "ui") }, { recordErrors: false });
		backendTurnBusy = true;
		if (options.fromQueue === "steer") {
			queuedSteeringTurns.shift();
			syncQueuedInputs();
		} else if (options.fromQueue === "followUp") {
			queuedFollowUpTurns.shift();
			syncQueuedInputs();
		}
		setRuntimeState(runtimeStateWithUserMessage(runtimeState, text));
	} catch (error) {
		if (error instanceof GatewayRequestError && error.code === "turn_in_progress") {
			backendTurnBusy = true;
			if (!options.fromQueue) {
				enqueueSteeringTurn(text);
			}
			return;
		}
		setRuntimeState(
			reduceRuntimeEvent(runtimeState, "gateway.error", {
				code: error instanceof GatewayRequestError ? error.code : "request_failed",
				message: error instanceof Error ? error.message : "Request failed.",
				method: "turn.submit",
			}),
		);
		backendTurnBusy = false;
		throw error;
	}
}

function nextClientTurnId(prefix: string): string {
	clientTurnSequence += 1;
	return `${prefix}_${Date.now()}_${clientTurnSequence}`;
}

function enqueueSteeringTurn(message: string): void {
	queuedSteeringTurns.push(message);
	syncQueuedInputs();
}

async function submitFollowUp(message: string): Promise<void> {
	const text = message.trim();
	if (!text) {
		return;
	}
	if (runtimeState.turnRunning || backendTurnBusy) {
		await queueFollowUpTurn(text);
		return;
	}
	await submitTurn(text);
}

async function queueSteeringTurn(message: string): Promise<void> {
	try {
		const result = await send("turn.steer", { message }, { recordErrors: false });
		syncQueuedInputsFromResult(result);
		if (result.accepted === false) {
			enqueueSteeringTurn(message);
		}
	} catch {
		enqueueSteeringTurn(message);
	}
}

async function queueFollowUpTurn(message: string): Promise<void> {
	try {
		const result = await send("turn.follow_up", { message }, { recordErrors: false });
		syncQueuedInputsFromResult(result);
		if (result.accepted === false) {
			queuedFollowUpTurns.push(message);
			syncQueuedInputs();
		}
	} catch {
		queuedFollowUpTurns.push(message);
		syncQueuedInputs();
	}
}

function queuedTurns(): string[] {
	return [...queuedSteeringTurns, ...queuedFollowUpTurns];
}

function nextQueuedTurn(): { kind: "steer" | "followUp"; message: string } | null {
	const steering = queuedSteeringTurns[0];
	if (steering !== undefined) {
		return { kind: "steer", message: steering };
	}
	const followUp = queuedFollowUpTurns[0];
	if (followUp !== undefined) {
		return { kind: "followUp", message: followUp };
	}
	return null;
}

function clearQueuedTurns(): string[] {
	const allQueued = queuedTurns();
	queuedSteeringTurns.length = 0;
	queuedFollowUpTurns.length = 0;
	syncQueuedInputs();
	return allQueued;
}

function syncQueuedInputs(): void {
	setRuntimeState(runtimeStateWithMessageQueues(runtimeState, { steering: queuedSteeringTurns, followUp: queuedFollowUpTurns }));
}

function syncQueuedInputsFromResult(result: Record<string, unknown>): void {
	const steering = stringArrayValue(result.steering);
	const followUp = stringArrayValue(result.follow_up);
	queuedSteeringTurns.length = 0;
	queuedSteeringTurns.push(...steering);
	queuedFollowUpTurns.length = 0;
	queuedFollowUpTurns.push(...followUp);
	syncQueuedInputs();
}

async function dequeueQueuedInput(): Promise<string | null> {
	try {
		const result = await send("turn.queue.clear", {}, { recordErrors: false });
		const restored = [...stringArrayValue(result.steering), ...stringArrayValue(result.follow_up)];
		queuedSteeringTurns.length = 0;
		queuedFollowUpTurns.length = 0;
		syncQueuedInputs();
		if (restored.length > 0) {
			return restored.join("\n\n");
		}
	} catch {
		// Fall back to local queue below.
	}
	const allQueued = clearQueuedTurns();
	return allQueued.length > 0 ? allQueued.join("\n\n") : null;
}

function scheduleQueuedTurnDrain(): void {
	if (queueDrainTimer || queueDraining || !canDrainQueuedTurns()) {
		return;
	}
	queueDrainTimer = setTimeout(() => {
		queueDrainTimer = null;
		void drainQueuedTurns();
	}, 25);
	queueDrainTimer.unref?.();
}

async function drainQueuedTurns(): Promise<void> {
	if (queueDraining || !canDrainQueuedTurns()) {
		return;
	}
	const next = nextQueuedTurn();
	if (!next) {
		return;
	}
	queueDraining = true;
	try {
		await submitTurn(next.message, { fromQueue: next.kind });
	} finally {
		queueDraining = false;
		scheduleQueuedTurnDrain();
	}
}

function canDrainQueuedTurns(): boolean {
	return (
		queuedTurns().length > 0 &&
		!backendTurnBusy &&
		!runtimeState.turnRunning &&
		!runtimeState.pendingApproval &&
		!runtimeState.pendingClarification
	);
}

async function interruptTurn(): Promise<void> {
	const restored = await dequeueQueuedInput();
	if (restored) {
		runtime?.restoreQueuedText(restored);
	}
	await send("turn.interrupt", {});
}

async function respondApproval(decisionId: string, choice: string): Promise<void> {
	await send("approval.respond", { decision_id: decisionId, choice });
}

function stringArrayValue(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) {
		return [value.trim()];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

async function runCommand(command: string): Promise<void> {
	const result = await send("command.run", { command });
	setRuntimeState(runtimeStateWithCommandResult(runtimeState, command, result));
	if (result.exit_requested === true) {
		await shutdown(0);
	}
}

async function selectSession(sessionId: string): Promise<void> {
	const result = await send("session.resume", { session_id: sessionId });
	const session = sessions.find((candidate) => candidate.id === sessionId);
	runtimeState = {
		...runtimeState,
		sessionId,
		sessionTitle: session?.title ?? sessionId,
		transcript: [],
	};
	const transcriptPayload = await send("transcript.load", {
		session_id: String(result.session_id ?? sessionId),
		before: null,
	});
	setRuntimeState(runtimeStateFromTranscript(runtimeState, transcriptPayload));
}

async function shutdown(exitCode = 0): Promise<void> {
	try {
		await client.send("shutdown", {});
	} catch {
		// Best-effort shutdown.
	} finally {
		await stopLocalRuntime();
		process.exitCode = exitCode;
	}
}

async function interruptExit(exitCode = 130): Promise<void> {
	await stopLocalRuntime();
	process.exitCode = exitCode;
	process.exit(exitCode);
}

async function stopLocalRuntime(): Promise<void> {
	if (runtime?.isStarted()) {
		runtime.ui.stop();
	}
	if (nativeRuntime?.isStarted()) {
		await nativeRuntime.stop({ notifyExit: false });
	}
	ttyStreams?.close();
	ttyStreams = null;
	client.stop();
}

async function main(): Promise<void> {
	await bootstrap();
	if (process.env.MYCLI_TUI_NATIVE === "1") {
		ttyStreams = openTtyStreams();
		nativeRuntime = new NativeChatRuntime({
			initialState: currentShellState(),
			streams: {
				input: ttyStreams.input,
				output: ttyStreams.output,
			},
			columns: () => ttyStreams?.output.columns || Number(process.env.COLUMNS) || 100,
			onSubmit: submitTurn,
			onFollowUp: submitFollowUp,
			onCommandSubmit: runCommand,
			onExit: () => shutdown(0),
			onInterruptExit: () => interruptExit(130),
		});
		nativeRuntime.start();
		return;
	}
	ttyStreams = openTtyStreams();
	runtime = new MycliShellRuntime({
		initialState: currentShellState(),
		terminal: new StreamTerminal(ttyStreams),
		requireTrust: runtimeState.trust.state === "unknown" && !runtimeState.trustGateDismissed,
		projectTrusted: runtimeState.trust.state === "trusted",
		trustSavedDecision: trustDecisionFromState(runtimeState.trust.state),
		onSubmit: submitTurn,
		onFollowUp: submitFollowUp,
		onInterrupt: interruptTurn,
		onDequeueQueuedInput: dequeueQueuedInput,
		onCommandSubmit: runCommand,
		onExit: () => shutdown(0),
		onApprovalRespond: respondApproval,
		onModelSelect: async (model) => {
			const thinking = model.thinkingLevel ? ` --thinking-effort ${model.thinkingLevel}` : "";
			await runCommand(`/model ${model.id}${thinking}`);
		},
		onSessionSelect: selectSession,
		commands: [
			{
				id: "status",
				label: "/status",
				description: "Inspect runtime status",
				run: () => runCommand("/status"),
			},
			{
				id: "usage",
				label: "/usage",
				description: "Inspect token usage",
				run: () => runCommand("/usage"),
			},
			{
				id: "context",
				label: "/context",
				description: "Inspect context window",
				run: () => runCommand("/context"),
			},
		],
	});
	runtime.start();
}

process.on("SIGINT", () => {
	if (runtime?.isStarted()) {
		return;
	}
	void interruptExit(130);
});

process.once("SIGTERM", () => {
	void shutdown(0).finally(() => process.exit(0));
});

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : "Unable to start mycli shell TUI.";
	process.stderr.write(`[mycli-shell] ${message}\n`);
	if (!bootstrapped) {
		client.stop();
	}
	process.exit(1);
});

function trustDecisionFromState(state: string | undefined): ProjectTrustDecision | null {
	if (state === "trusted") return true;
	if (state === "untrusted") return false;
	return null;
}
