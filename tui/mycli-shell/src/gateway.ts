import process from "node:process";
import { GatewayClient, GatewayRequestError, type GatewayEvent } from "./adapters/gateway-client.ts";
import {
	initialRuntimeState,
	projectRuntimeState,
	reduceRuntimeEvent,
	runtimeStateFromBootstrap,
	runtimeStateFromTranscript,
	runtimeStateWithCommandResult,
	runtimeStateWithUserMessage,
	sessionsFromResult,
	type RuntimeShellState,
} from "./adapters/runtime-state.ts";
import { MycliShellRuntime } from "./shell-runtime.ts";
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
let ttyStreams: TtyStreams | null = null;
let bootstrapped = false;
const eventDeduper = new GatewayEventDeduper();

function currentShellState(): MycliShellState {
	return projectRuntimeState(runtimeState, sessions);
}

function setRuntimeState(nextState: RuntimeShellState): void {
	runtimeState = nextState;
	if (runtime) {
		runtime.setState(currentShellState());
	}
}

function refreshRuntime(): void {
	runtime?.setState(currentShellState());
}

function handleGatewayEvent(event: GatewayEvent): void {
	if (!eventDeduper.shouldConsume(event)) {
		return;
	}
	setRuntimeState(reduceRuntimeEvent(runtimeState, event.method, event.params));
}

async function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
		setRuntimeState(
			reduceRuntimeEvent(runtimeState, "gateway.error", {
				code: gatewayError.code,
				message: gatewayError.message,
				method: gatewayError.method || method,
			}),
		);
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
		limit: 200,
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

async function submitTurn(message: string): Promise<void> {
	setRuntimeState(runtimeStateWithUserMessage(runtimeState, message));
	await send("turn.submit", { message, client_turn_id: `ui_${Date.now()}` });
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
		limit: 200,
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
		if (runtime?.isStarted()) {
			runtime.ui.stop();
		}
		ttyStreams?.close();
		ttyStreams = null;
		client.stop();
		process.exitCode = exitCode;
	}
}

async function main(): Promise<void> {
	await bootstrap();
	ttyStreams = openTtyStreams();
	runtime = new MycliShellRuntime({
		initialState: currentShellState(),
		terminal: new StreamTerminal(ttyStreams),
		requireTrust: runtimeState.trust.state === "unknown" && !runtimeState.trustGateDismissed,
		projectTrusted: runtimeState.trust.state === "trusted",
		trustSavedDecision: trustDecisionFromState(runtimeState.trust.state),
		onSubmit: submitTurn,
		onCommandSubmit: runCommand,
		onExit: () => shutdown(0),
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void shutdown(0).finally(() => process.exit(0));
	});
}

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
