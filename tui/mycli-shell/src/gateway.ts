import process from "node:process";
import { pathToFileURL } from "node:url";
import { GatewayClient, GatewayRequestError, type GatewayEvent } from "./adapters/gateway-client.ts";
import {
	initialRuntimeState,
	reduceRuntimeEvent,
	RuntimeStateProjector,
	runtimeStateFromBootstrap,
	runtimeStateFromTranscript,
	runtimeStateFromOlderTranscriptPage,
	runtimeStateAfterSessionResume,
	runtimeStateAfterCommandResult,
	runtimeStateWithSettingsSnapshot,
	runtimeStateWithCredentialReadiness,
	runtimeStateWithModelCatalog,
	runtimeStateWithPendingSteer,
	runtimeStateWithSubmittingMessage,
	runtimeStateWithLocalFollowUp,
	runtimeInputDisposition,
	runtimeStateRejectPendingSteer,
	resolveLocalInterruptInputs,
	popLastLocalFollowUp,
	nextLocalUserInput,
	removeLocalUserInput,
	runtimeStateAcknowledgeQueuedInput,
	resourcesFromResult,
	permissionStateFromUnknown,
	sessionResumePreviewFromResult,
	sessionsFromResult,
	sessionTreeFromResult,
	settingsSnapshotFromResult,
	legacyQueueMigrationToken,
	runtimeStateWithLegacyQueueMigration,
	type RuntimeShellState,
	type RuntimeLocalUserInput,
} from "./adapters/runtime-state.ts";
import { MycliShellRuntime } from "./shell-runtime.ts";
import { NativeChatRuntime } from "./native-chat-runtime.ts";
import type {
	MycliShellPendingApproval,
	MycliShellPendingClarification,
	MycliShellPermissionProfile,
	MycliShellPermissionState,
	MycliShellResumeRepairAction,
	MycliShellResumeRepairPreview,
	MycliShellSession,
	MycliShellSettingsSnapshot,
	MycliShellSettingChange,
	MycliShellState,
	MycliShellVisualSettings,
} from "./model.ts";
import type {
	MycliShellQueuedInput,
	MycliShellSubmitAttachments,
} from "./shell-runtime.ts";
import type { ProjectTrustDecision } from "./components/trust-selector.ts";
import { openTtyStreams, StreamTerminal, type TtyStreams } from "./adapters/tty-terminal.ts";
import { GatewayEventDeduper } from "./adapters/gateway-events.ts";
import { TUI_VERSION } from "./version.ts";
import {
	clientActionFromResult,
	slashCommandNamesFromResult,
	slashCommandsFromResult,
} from "./adapters/slash-commands.ts";
import { commandResultFromGateway } from "./adapters/command-results.ts";
import { loadFullShellOutput } from "./adapters/shell-output.ts";
import type { MycliShellCommandSpec } from "./model.ts";
import {
	closeGatewayTransport,
	gatewayTransport,
} from "./adapters/gateway-transport.ts";
import {
	GATEWAY_PROTOCOL_VERSION,
	sidecarStartupTimeoutMs,
	verifyGatewayManifest,
} from "./adapters/gateway-handshake.ts";
import { classifyRuntimeTranscriptUpdate } from "./adapters/transcript-update.ts";
import {
	planImplementationMessage,
	type PlanImplementationAction,
} from "./plan-implementation.ts";
import { appendFatalTuiDiagnostic } from "./fatal-error.ts";
import { safeErrorMessage } from "./safe-ui-text.ts";

type QueueKind = "steer" | "followUp";
type QueuedTurnInput = {
	kind: QueueKind;
	message: string;
	attachments?: MycliShellSubmitAttachments;
	clientUserMessageId: string;
	source?: string;
};

const commandSurface = process.env.MYCLI_TUI_NATIVE === "1" ? "cli" : "tui";

const rpcTransport = gatewayTransport();
const client = new GatewayClient({
	input: rpcTransport.input,
	output: rpcTransport.output,
	log: (event) => handleGatewayEvent(event),
	onClose: (error) => {
		if (bootstrapped) void handleUnexpectedGatewayClose(error);
	},
});

let runtimeState: RuntimeShellState = initialRuntimeState();
let sessions: MycliShellSession[] = [];
let slashCommands: MycliShellCommandSpec[] = [];
let slashCommandNames: string[] = [];
let runtime: MycliShellRuntime | null = null;
let nativeRuntime: NativeChatRuntime | null = null;
let ttyStreams: TtyStreams | null = null;
let bootstrapped = false;
const eventDeduper = new GatewayEventDeduper();
let backendTurnBusy = false;
let clientTurnSequence = 0;
let localDispatchEligible = false;
let localDispatchScheduled = false;
let interruptRequested = false;
let resubmitPendingSteersAfterInterrupt = false;
let extensionRefreshScheduled = false;
let fatalTuiHandling = false;
const runtimeStateProjector = new RuntimeStateProjector();
const TRANSCRIPT_PAGE_LIMIT = 500;

function currentShellState(transcriptUpdate: "unchanged" | "tail" | "replace" = "unchanged"): MycliShellState {
	return runtimeStateProjector.project(runtimeState, sessions, transcriptUpdate);
}

function setRuntimeState(
	nextState: RuntimeShellState,
	options: { replaceSessionTranscript?: boolean; eventType?: string } = {},
): void {
	const previousState = runtimeState;
	const transcriptUpdate = options.replaceSessionTranscript
		? "replace"
		: classifyRuntimeTranscriptUpdate(previousState, nextState, options.eventType);
	runtimeState = nextState;
	const shellState = runtime || nativeRuntime
		? currentShellState(transcriptUpdate)
		: null;
	if (runtime && shellState) {
		if (options.replaceSessionTranscript) {
			runtime.replaceSessionState(shellState);
		} else {
			runtime.setState(shellState, {
				transcriptUpdate,
				eventType: options.eventType,
			});
		}
	}
	if (nativeRuntime && shellState) {
		nativeRuntime.setState(shellState);
	}
}

function refreshRuntime(): void {
	runtime?.setState(currentShellState(), { transcriptUpdate: "unchanged" });
	nativeRuntime?.setState(currentShellState());
}

function handleGatewayEvent(event: GatewayEvent): void {
	if (!eventDeduper.shouldConsume(event)) {
		return;
	}
	if (event.method === "extension.updated") {
		scheduleExtensionRefresh();
		return;
	}
	if (
		event.method === "turn.interrupted" &&
		event.params.requested === true &&
		!interruptRequested
	) {
		return;
	}
	let nextState = reduceRuntimeEvent(runtimeState, event.method, event.params);
	const interrupted =
		(event.method === "turn.interrupted" && event.params.requested !== true) ||
		(event.method === "turn.completed" && event.params.turn_state === "interrupted");
	const shouldResolveInterrupt =
		interrupted &&
		(interruptRequested || runtimeState.turnRunning || runtimeState.activeTurnId !== null);
	if (shouldResolveInterrupt) {
		const resolution = resolveLocalInterruptInputs(
			nextState,
			resubmitPendingSteersAfterInterrupt,
		);
		nextState = resolution.state;
		localDispatchEligible = resolution.dispatchNext;
		runtime?.completeInterruptedTurn(
			resolution.restoreToComposer.map((input) => ({
				text: input.message,
				...(input.attachments.length ? { localImages: input.attachments } : {}),
			})),
			{
				restoreSubmittedInput: event.params.input_rolled_back === true,
			},
		);
		interruptRequested = false;
		resubmitPendingSteersAfterInterrupt = false;
	}
	setRuntimeState(nextState, { eventType: runtimeEventType(event) });
	if (event.method === "turn.started") {
		backendTurnBusy = true;
	}
	if (
		(event.method === "turn.completed" && !interrupted) ||
		event.method === "turn.failed"
	) {
		localDispatchEligible = true;
	}
	if (event.method === "status.changed" && event.params.turn_running === false) {
		backendTurnBusy = false;
		scheduleNextLocalInput();
	} else if (shouldResolveInterrupt && !backendTurnBusy) {
		scheduleNextLocalInput();
	}
}

function scheduleExtensionRefresh(): void {
	if (extensionRefreshScheduled) return;
	extensionRefreshScheduled = true;
	queueMicrotask(() => {
		extensionRefreshScheduled = false;
		void Promise.all([
			send("extension.manifest", {}, { recordErrors: false }).then(verifyGatewayManifest),
			loadResources(),
		]).catch(() => undefined);
	});
}

function runtimeEventType(event: GatewayEvent): string {
	return event.method === "runtime.event" && typeof event.params.type === "string"
		? event.params.type
		: event.method;
}

async function send(
	method: string,
	params: Record<string, unknown> = {},
	options: { recordErrors?: boolean } = {},
): Promise<Record<string, unknown>> {
	try {
		return await client.send(method, params);
	} catch (error) {
		const rawGatewayError =
			error instanceof GatewayRequestError
				? error
				: new GatewayRequestError({
						code: "request_failed",
						message: safeErrorMessage(error, "Request failed."),
						method,
					});
		const gatewayError = new GatewayRequestError({
			code: rawGatewayError.code,
			message: safeErrorMessage(rawGatewayError, "Request failed."),
			method: rawGatewayError.method || method,
			data: rawGatewayError.data,
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

async function saveWorkspaceTrust(trusted: boolean): Promise<void> {
	const payload = await send("workspace.trust.set", {
		state: trusted ? "trusted" : "untrusted",
	});
	setRuntimeState(reduceRuntimeEvent(runtimeState, "workspace.trust.changed", payload));
}

async function bootstrap(): Promise<void> {
	client.start();
	await client.waitForEvent(
		"runtime.ready",
		() => true,
		sidecarStartupTimeoutMs(process.env),
	);
	const manifest = await send("extension.manifest", {}, { recordErrors: false });
	verifyGatewayManifest(manifest);
	const bootstrapPayload = await send("session.bootstrap", {
		protocol_version: GATEWAY_PROTOCOL_VERSION,
		client: { name: "mycli-shell-tui", version: TUI_VERSION },
	});
	setRuntimeState(runtimeStateFromBootstrap(runtimeState, bootstrapPayload));
	await acknowledgeLegacyQueueMigration(bootstrapPayload);
	const transcriptPayload = await send("transcript.load", {
		session_id: runtimeState.sessionId ?? undefined,
		before: null,
		limit: TRANSCRIPT_PAGE_LIMIT,
	});
	setRuntimeState(runtimeStateFromTranscript(runtimeState, transcriptPayload));
	const commandPayload = await send("command.list", { surface: commandSurface });
	slashCommands = slashCommandsFromResult(commandPayload);
	slashCommandNames = slashCommandNamesFromResult(commandPayload);
	await loadSettings();
	await loadSessions();
	bootstrapped = true;
}

async function loadSettings(): Promise<MycliShellSettingsSnapshot | undefined> {
	try {
		const result = await send("settings.load", {}, { recordErrors: false });
		const snapshot = settingsSnapshotFromResult(result);
		setRuntimeState(runtimeStateWithSettingsSnapshot(runtimeState, snapshot));
		return snapshot;
	} catch {
		// Keep built-in defaults when the gateway does not support persistent settings.
		return undefined;
	}
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

async function previewSessionResume(sessionId: string): Promise<MycliShellResumeRepairPreview> {
	const result = await send(
		"session.resume.preview",
		{ session_id: sessionId },
		{ recordErrors: false },
	);
	const preview = sessionResumePreviewFromResult(result);
	if (!preview) throw new Error("Gateway returned an invalid session recovery preview.");
	return preview;
}

async function acknowledgeLegacyQueueMigration(
	payload: Record<string, unknown>,
): Promise<void> {
	const migrationToken = legacyQueueMigrationToken(payload);
	if (!migrationToken) return;
	try {
		await send(
			"turn.queue.migration.ack",
			{ token: migrationToken },
			{ recordErrors: false },
		);
	} catch (error) {
		if (!(error instanceof GatewayRequestError && error.code === "queue_conflict")) {
			throw error;
		}
	}
}

async function submitTurn(
	message: string,
	attachments: MycliShellSubmitAttachments = {},
	clientUserMessageId = nextClientTurnId("user"),
	options: { collaborationMode?: "default" | "plan" } = {},
): Promise<void> {
	const text = message.trim();
	if (!text) {
		return;
	}
	const pendingClarification = runtimeState.pendingClarification;
	if (pendingClarification) {
		const requestId = typeof pendingClarification.request_id === "string"
			? pendingClarification.request_id
			: typeof pendingClarification.requestId === "string"
				? pendingClarification.requestId
				: "";
		if (requestId) {
			await respondClarification(requestId, text, {
				requestId,
				question: typeof pendingClarification.question === "string"
					? pendingClarification.question
					: "Clarification required",
				options: [],
				multiSelect: false,
				sessionId: stringField(pendingClarification.session_id),
				generation: integerField(pendingClarification.generation),
			});
			return;
		}
	}
	const disposition = runtimeInputDisposition(runtimeState, backendTurnBusy);
	if (disposition === "follow_up") {
		setRuntimeState(
			runtimeStateWithLocalFollowUp(
				runtimeState,
				runtimeLocalInput(clientUserMessageId, text, attachments),
			),
		);
		return;
	}
	if (disposition === "steer") {
		await queueSteeringTurn({
			kind: "steer",
			message: text,
			attachments,
			clientUserMessageId,
		});
		return;
	}
	const clientTurnId = nextClientTurnId("ui");
	const localInput = runtimeLocalInput(clientUserMessageId, text, attachments);
	setRuntimeState(runtimeStateWithSubmittingMessage(runtimeState, localInput));
	backendTurnBusy = true;
	try {
		const result = await send(
			"turn.submit",
				{
					message: text,
					client_turn_id: clientTurnId,
					client_user_message_id: clientUserMessageId,
					...(options.collaborationMode ? { collaboration_mode: options.collaborationMode } : {}),
					...(attachments?.localImages?.length ? { local_images: attachments.localImages } : {}),
				},
			{ recordErrors: false },
		);
		const turnId = typeof result.turn_id === "string" ? result.turn_id : null;
		if (backendTurnBusy) {
			setRuntimeState({
				...runtimeState,
				turnRunning: true,
				activeTurnId: turnId ?? runtimeState.activeTurnId,
			});
		}
	} catch (error) {
		setRuntimeState(removeLocalUserInput(runtimeState, clientUserMessageId));
		if (error instanceof GatewayRequestError && error.code === "turn_in_progress") {
			backendTurnBusy = true;
			localDispatchEligible = true;
			setRuntimeState(
				runtimeStateWithLocalFollowUp(
					runtimeState,
					runtimeLocalInput(clientUserMessageId, text, attachments),
				),
			);
			return;
		}
		if (error instanceof GatewayRequestError && error.code === "auth_required") {
			backendTurnBusy = false;
			throw error;
		}
		setRuntimeState(
			reduceRuntimeEvent(runtimeState, "gateway.error", {
				code: error instanceof GatewayRequestError ? error.code : "request_failed",
				message: safeErrorMessage(error, "Request failed."),
				method: "turn.submit",
			}),
		);
		backendTurnBusy = false;
		throw error;
	}
}

async function startPlanImplementation(
	action: PlanImplementationAction,
	planMarkdown: string,
): Promise<void> {
	if (action === "clear_context") {
		const created = await send("session.new", {}, { recordErrors: false });
		const sessionId = stringField(created.session_id);
		if (!sessionId) throw new Error("The fresh session did not return a session ID.");
		setRuntimeState(
			runtimeStateAfterSessionResume(runtimeState, sessionId, sessionId, created),
			{ replaceSessionTranscript: true },
		);
	}
	await submitTurn(
		planImplementationMessage(action, planMarkdown),
		{},
		nextClientTurnId("user"),
		{ collaborationMode: "default" },
	);
}

function nextClientTurnId(prefix: string): string {
	clientTurnSequence += 1;
	return `${prefix}_${Date.now()}_${clientTurnSequence}`;
}

function runtimeLocalInput(
	clientUserMessageId: string,
	message: string,
	attachments?: MycliShellSubmitAttachments,
): RuntimeLocalUserInput {
	return {
		clientUserMessageId,
		message,
		attachments: [...(attachments?.localImages ?? [])],
	};
}

function scheduleNextLocalInput(): void {
	if (!localDispatchEligible || localDispatchScheduled) {
		return;
	}
	localDispatchScheduled = true;
	queueMicrotask(() => {
		localDispatchScheduled = false;
		void dispatchNextLocalInput();
	});
}

async function dispatchNextLocalInput(): Promise<void> {
	if (
		!localDispatchEligible ||
		backendTurnBusy ||
		runtimeState.turnRunning ||
		runtimeState.activeTurnId ||
		runtimeState.pendingApproval ||
		runtimeState.pendingClarification
	) {
		return;
	}
	const next = nextLocalUserInput(runtimeState);
	if (!next) {
		localDispatchEligible = false;
		return;
	}
	localDispatchEligible = false;
	setRuntimeState(
		removeLocalUserInput(runtimeState, next.input.clientUserMessageId),
	);
	try {
		await submitTurn(
			next.input.message,
			{ localImages: next.input.attachments },
			next.input.clientUserMessageId,
		);
	} catch {
		const restored =
			next.kind === "rejected"
				? {
					...runtimeState,
					localRejectedSteers: [next.input, ...runtimeState.localRejectedSteers],
				}
				: {
					...runtimeState,
					localFollowUps: [next.input, ...runtimeState.localFollowUps],
				};
		setRuntimeState(restored);
	}
}

async function submitFollowUp(message: string, attachments?: MycliShellSubmitAttachments): Promise<void> {
	const text = message.trim();
	if (!text) {
		return;
	}
	const input: QueuedTurnInput = {
		kind: "followUp",
		message: text,
		attachments,
		clientUserMessageId: nextClientTurnId("followUp"),
	};
	if (runtimeState.turnRunning || runtimeState.activeTurnId || backendTurnBusy) {
		setRuntimeState(
			runtimeStateWithLocalFollowUp(
				runtimeState,
				runtimeLocalInput(input.clientUserMessageId, input.message, input.attachments),
			),
		);
		return;
	}
	await submitTurn(input.message, input.attachments, input.clientUserMessageId);
}

async function queueSteeringTurn(input: QueuedTurnInput): Promise<void> {
	const localInput = runtimeLocalInput(
		input.clientUserMessageId,
		input.message,
		input.attachments,
	);
	setRuntimeState(runtimeStateWithPendingSteer(runtimeState, localInput));
	let expectedTurnId = runtimeState.activeTurnId;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const result = await send("turn.steer", {
				message: input.message,
				client_user_message_id: input.clientUserMessageId,
				expected_turn_id: expectedTurnId,
				...(input.attachments?.localImages?.length
					? { local_images: input.attachments.localImages }
					: {}),
			}, { recordErrors: false });
			setRuntimeState(runtimeStateAcknowledgeQueuedInput(
				runtimeState,
				input.clientUserMessageId,
				result,
			));
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
				setRuntimeState({ ...runtimeState, activeTurnId: actualTurnId });
				continue;
			}
			setRuntimeState(
				runtimeStateRejectPendingSteer(
					runtimeState,
					input.clientUserMessageId,
				),
			);
			return;
		}
	}
}

async function popLastQueuedFollowUp(): Promise<MycliShellQueuedInput | null> {
	const popped = popLastLocalFollowUp(runtimeState);
	setRuntimeState(popped.state);
	return popped.input
		? {
			text: popped.input.message,
			...(popped.input.attachments.length
				? { localImages: popped.input.attachments }
				: {}),
		}
		: null;
}

async function interruptTurn(options: { rollbackUserInput: boolean }): Promise<boolean> {
	const pendingClarification = runtimeState.pendingClarification;
	const pendingClarificationTurnId = pendingClarification
		? stringField(pendingClarification.turn_id) ?? stringField(pendingClarification.turnId)
		: null;
	const clarificationPending = pendingClarification !== null && pendingClarificationTurnId !== null;
	if (backendTurnBusy || runtimeState.turnRunning || runtimeState.activeTurnId || clarificationPending) {
		interruptRequested = true;
		resubmitPendingSteersAfterInterrupt = runtimeState.localPendingSteers.length > 0;
		setRuntimeState(
			reduceRuntimeEvent(runtimeState, "turn.interrupted", {
				requested: true,
				message: "Interrupt requested",
				...(runtimeState.activeTurnId
					? { turn_id: runtimeState.activeTurnId }
					: pendingClarificationTurnId ? { turn_id: pendingClarificationTurnId } : {}),
			}),
		);
	}
	const clearOptimisticInterrupt = (): void => {
		interruptRequested = false;
		resubmitPendingSteersAfterInterrupt = false;
		if (runtimeState.liveStatus?.state === "interrupting") {
			setRuntimeState({
				...runtimeState,
				liveStatus: backendTurnBusy
					? { state: "running", kind: "running", text: "Running" }
					: null,
			});
		}
	};
	try {
		let expectedTurnId = runtimeState.activeTurnId ?? pendingClarificationTurnId;
		if (!expectedTurnId) {
			const status = await send("status.inspect", {}, { recordErrors: false });
			backendTurnBusy = status.turn_running === true;
			setRuntimeState(reduceRuntimeEvent(runtimeState, "status.changed", status));
			expectedTurnId = stringField(status.turn_id) ?? pendingClarificationTurnId;
			if (!backendTurnBusy || !expectedTurnId) {
				if (!clarificationPending || !expectedTurnId) {
					clearOptimisticInterrupt();
					return false;
				}
			}
		}
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const result = await send("turn.interrupt", {
					rollback_user_input: options.rollbackUserInput,
					turn_id: expectedTurnId,
				}, { recordErrors: false });
				if (result.accepted !== true || result.requested !== true) {
					backendTurnBusy = result.turn_running === true;
					setRuntimeState(reduceRuntimeEvent(runtimeState, "status.changed", result));
					clearOptimisticInterrupt();
					return false;
				}
				return true;
			} catch (error) {
				const actualTurnId =
					error instanceof GatewayRequestError
					&& error.code === "turn_id_mismatch"
					&& typeof error.data.actual_turn_id === "string"
						? error.data.actual_turn_id
						: null;
				if (attempt === 0 && actualTurnId && actualTurnId !== expectedTurnId) {
					expectedTurnId = actualTurnId;
					setRuntimeState({ ...runtimeState, activeTurnId: actualTurnId });
					continue;
				}
				throw error;
			}
		}
		return false;
	} catch (error) {
		clearOptimisticInterrupt();
		throw error;
	}
}

async function respondApproval(
	decisionId: string,
	choice: string,
	approval?: MycliShellPendingApproval,
): Promise<void> {
	try {
		await send("approval.respond", {
			decision_id: decisionId,
			choice,
			...(approval?.sessionId ? { session_id: approval.sessionId } : {}),
			...(approval?.generation ? { generation: approval.generation } : {}),
		}, { recordErrors: false });
	} catch (error) {
		if (!(error instanceof GatewayRequestError) || error.code !== "approval_not_pending") {
			throw error;
		}
		if (await reconcileInteractiveResponse("approval")) return;
		throw error;
	}
}

async function respondClarification(
	requestId: string,
	response: string,
	clarification?: MycliShellPendingClarification,
): Promise<void> {
	try {
		await send("clarify.respond", {
			request_id: requestId,
			response,
			...(clarification?.sessionId ? { session_id: clarification.sessionId } : {}),
			...(clarification?.generation ? { generation: clarification.generation } : {}),
		}, { recordErrors: false });
	} catch (error) {
		if (!(error instanceof GatewayRequestError) || error.code !== "clarification_not_pending") {
			throw error;
		}
		if (await reconcileInteractiveResponse("clarification")) return;
		throw error;
	}
}

async function reconcileInteractiveResponse(
	kind: "approval" | "clarification",
): Promise<boolean> {
	const pending = kind === "approval"
		? runtimeState.pendingApproval
		: runtimeState.pendingClarification;
	if (!pending) return true;

	let status: Record<string, unknown>;
	try {
		status = await send("status.inspect", {}, { recordErrors: false });
	} catch {
		return false;
	}
	if (!interactiveRequestBelongsToStatus(pending, status)) return false;

	setRuntimeState(reduceRuntimeEvent(runtimeState, "status.changed", status), {
		eventType: "status.changed",
	});
	const hasPending = kind === "approval"
		? status.pending_decision === true
		: status.suspended_turn === true;
	if (status.pending_decision !== false && status.suspended_turn !== false) {
		if (!hasPending) return false;
	} else if (!hasPending) {
		return true;
	}

	const responseMethod = kind === "approval" ? "approval.respond" : "clarify.respond";
	const responseParams = kind === "approval"
		? {
			decision_id: stringField(pending.decision_id) ?? stringField(pending.decisionId),
		}
		: {
			request_id: stringField(pending.request_id) ?? stringField(pending.requestId),
			response: "",
		};
	setRuntimeState(reduceRuntimeEvent(runtimeState, responseMethod, responseParams), {
		eventType: responseMethod,
	});
	try {
		await send("session.bootstrap", {
			protocol_version: GATEWAY_PROTOCOL_VERSION,
			client: { name: "mycli-shell-tui", version: TUI_VERSION },
		}, { recordErrors: false });
		return true;
	} catch {
		return false;
	}
}

function interactiveRequestBelongsToStatus(
	pending: Record<string, unknown>,
	status: Record<string, unknown>,
): boolean {
	const pendingSessionId =
		stringField(pending.session_id) ??
		stringField(pending.sessionId) ??
		stringField(pending.child_session_id) ??
		stringField(pending.childSessionId);
	const statusSessionId = stringField(status.session_id) ?? stringField(status.sessionId);
	if (pendingSessionId && statusSessionId) return pendingSessionId === statusSessionId;
	if (pendingSessionId && runtimeState.sessionId) return pendingSessionId === runtimeState.sessionId;
	return true;
}

async function saveApiKey(
	providerId: string,
	apiKey: string,
	authRef?: string,
): Promise<{ message?: string }> {
	const result = await send("auth.api_key.save", {
		provider_id: providerId,
		api_key: apiKey,
		...(authRef ? { auth_ref: authRef } : {}),
	});
	const modelResult = await send("model.list", {}, { recordErrors: false });
	setRuntimeState(runtimeStateWithCredentialReadiness(runtimeStateWithModelCatalog({
		...runtimeState,
		authProviders: runtimeState.authProviders.map((provider) =>
			provider.id === providerId
				? { ...provider, configured: true, authRef: authRef ?? provider.authRef ?? provider.id, credentialSource: "stored" }
				: provider,
		),
	}, modelResult), result));
	return { message: typeof result.message === "string" ? result.message : undefined };
}

async function runCommand(command: string): Promise<void> {
	const sourceSessionId = runtimeState.sessionId;
	const result = await send("command.run", { command, surface: commandSurface });
	const clientAction = clientActionFromResult(result);
	if (clientAction && runtime) {
		if (clientAction.action === "open_model_selector") {
			const modelResult = await send("model.list", {});
			setRuntimeState(runtimeStateWithModelCatalog(runtimeState, modelResult));
		}
		await runtime.handleClientAction(clientAction.action, clientAction.args);
		return;
	}
	if (result.presentation === "overlay" && runtime) {
		const overlay = commandResultFromGateway(result, `overlay:${command}`);
		if (overlay) {
			runtime.showCommandResultOverlay(overlay);
		}
		return;
	}
	const nextState = await runtimeStateAfterCommandResult(
		runtimeState,
		command,
		result,
			async (sessionId) =>
				await send("transcript.load", {
					session_id: sessionId,
					before: null,
					limit: TRANSCRIPT_PAGE_LIMIT,
				}),
		sourceSessionId,
	);
	const replacedSession =
		result.mutated_session === true &&
		nextState.sessionId !== null &&
		nextState.sessionId !== sourceSessionId;
	setRuntimeState(nextState, { replaceSessionTranscript: replacedSession });
	if (result.exit_requested === true) {
		await shutdown(0);
	}
}

async function selectSession(
	sessionId: string,
	repair?: {
		readonly action: MycliShellResumeRepairAction;
		readonly metadataRevision: number;
	},
): Promise<string | MycliShellResumeRepairPreview> {
	let result: Record<string, unknown>;
	try {
		result = await send("session.resume", {
			session_id: sessionId,
			...(repair ? {
				repair_action: repair.action,
				metadata_revision: repair.metadataRevision,
			} : {}),
		}, { recordErrors: false });
	} catch (error) {
		if (error instanceof GatewayRequestError && error.code === "session_repair_required") {
			const preview = sessionResumePreviewFromResult(
				typeof error.data.preview === "object" && error.data.preview !== null
					? error.data.preview as Record<string, unknown>
					: {},
			);
			if (preview) return preview;
		}
		throw error;
	}
	const session = sessions.find((candidate) => candidate.id === sessionId);
	const resumedSessionId = String(result.session_id ?? sessionId);
	runtimeState = runtimeStateAfterSessionResume(
		runtimeState,
		resumedSessionId,
		session?.title ?? sessionId,
		result,
	);
	setRuntimeState(runtimeState);
	await acknowledgeLegacyQueueMigration(result);
	const transcriptPayload = await send("transcript.load", {
		session_id: resumedSessionId,
		before: null,
		limit: TRANSCRIPT_PAGE_LIMIT,
	});
	setRuntimeState(runtimeStateFromTranscript(runtimeState, transcriptPayload));
	await loadSessions();
	return resumedSessionId;
}

async function loadOlderTranscriptHistory(before: string): Promise<void> {
	const sessionId = runtimeState.sessionId;
	if (!sessionId || runtimeState.transcriptNextBefore !== before) return;
	const payload = await send("transcript.load", {
		session_id: sessionId,
		before,
		limit: TRANSCRIPT_PAGE_LIMIT,
	}, { recordErrors: false });
	if (runtimeState.sessionId !== sessionId || runtimeState.transcriptNextBefore !== before) return;
	setRuntimeState(runtimeStateFromOlderTranscriptPage(runtimeState, payload), {
		eventType: "transcript.history.prepended",
	});
}

async function loadSessionTree() {
	const result = await send("session.tree", {});
	return sessionTreeFromResult(result);
}

async function loadResources() {
	const result = await send("resource.list", {});
	const resources = resourcesFromResult(result);
	runtimeState = { ...runtimeState, resources };
	refreshRuntime();
	return resources;
}

async function saveSettings(change: MycliShellSettingChange): Promise<MycliShellSettingsSnapshot> {
	const result = await send("settings.save", {
		setting_id: change.settingId,
		value: change.value,
	});
	const snapshot = settingsSnapshotFromResult(result);
	setRuntimeState(runtimeStateWithSettingsSnapshot(runtimeState, snapshot));
	return snapshot;
}

async function selectPermission(profile: MycliShellPermissionProfile): Promise<MycliShellPermissionState> {
	const result = await send("permissions.update", { profile: profile.id });
	const permissions = permissionStateFromUnknown(result.permissions);
	if (!permissions) throw new Error("Gateway returned an invalid permission profile payload.");
	runtimeState = {
		...runtimeState,
		permissions,
		status: typeof result.status === "object" && result.status !== null
			? result.status as Record<string, unknown>
			: runtimeState.status,
	};
	setRuntimeState(runtimeState);
	return permissions;
}

async function clearPermissionAllowances(): Promise<MycliShellPermissionState> {
	await send("command.run", { command: "/permissions clear", surface: "cli" });
	const result = await send("permissions.list", {});
	const permissions = permissionStateFromUnknown(result);
	if (!permissions) throw new Error("Gateway returned an invalid permission profile payload.");
	runtimeState = { ...runtimeState, permissions };
	setRuntimeState(runtimeState);
	return permissions;
}

async function shutdown(exitCode = 0): Promise<void> {
	try {
		client.expectClose();
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

async function handleUnexpectedGatewayClose(_error: Error): Promise<void> {
	await stopLocalRuntime();
	process.stderr.write("[mycli-shell] Runtime gateway closed unexpectedly.\n");
	process.exitCode = 1;
}

async function handleFatalTuiError(error: unknown): Promise<void> {
	if (fatalTuiHandling) return;
	fatalTuiHandling = true;
	const logPath = appendFatalTuiDiagnostic(error);
	await stopLocalRuntime();
	process.stderr.write(logPath
		? "[mycli-shell] Terminal UI crashed. Diagnostics were written to ~/.mycli/logs/tui-errors.log.\n"
		: "[mycli-shell] Terminal UI crashed.\n");
	process.exitCode = 1;
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
	await closeGatewayTransport();
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
			onClarificationRespond: respondClarification,
			onFollowUp: submitFollowUp,
			onCommandSubmit: runCommand,
			onExit: () => shutdown(0),
			onInterruptExit: () => interruptExit(130),
			commands: slashCommands,
			commandNames: slashCommandNames,
		});
		nativeRuntime.start();
		return;
	}
	ttyStreams = openTtyStreams();
	const alternateScreen = ["1", "true", "always"].includes(
		(process.env.MYCLI_TUI_ALTERNATE_SCREEN ?? "").trim().toLowerCase(),
	);
	runtime = new MycliShellRuntime({
		initialState: currentShellState(),
		terminal: new StreamTerminal(ttyStreams, { alternateScreen }),
		requireTrust: !runtimeState.trustGateDismissed,
		projectTrusted: runtimeState.trust.state === "trusted",
		trustSavedDecision: trustDecisionFromState(runtimeState.trust.state),
		onTrustSelect: saveWorkspaceTrust,
		onSubmit: submitTurn,
		onFollowUp: submitFollowUp,
		onInterrupt: interruptTurn,
		onInterruptExit: () => interruptExit(130),
		onDequeueQueuedInput: popLastQueuedFollowUp,
		onCommandSubmit: runCommand,
		onExit: () => shutdown(0),
		onSuspend: process.platform === "win32"
			? undefined
			: () => process.kill(0, "SIGTSTP"),
		onFatalError: (error) => { void handleFatalTuiError(error); },
		onApprovalRespond: respondApproval,
		onClarificationRespond: respondClarification,
		onPlanImplementation: startPlanImplementation,
		onApiKeyLogin: saveApiKey,
		onModelSelect: async (model, scope) => {
			if (!model.protocol || !model.baseUrl) {
				throw new Error("Model catalog entry is missing provider protocol or endpoint metadata.");
			}
			const result = await send("model.select", {
				provider: model.provider,
				protocol: model.protocol,
				model: model.model,
				base_url: model.baseUrl,
				reasoning_effort: model.thinkingLevel ?? null,
				scope,
			});
			setRuntimeState(runtimeStateWithModelCatalog(runtimeState, result));
			return model;
		},
		onPermissionSelect: selectPermission,
		onPermissionClearAllowances: clearPermissionAllowances,
		onSessionResumePreview: previewSessionResume,
		onSessionSelect: selectSession,
		onSessionTreeLoad: loadSessionTree,
		onSettingsLoad: loadSettings,
		onSettingsChange: saveSettings,
		onResourceLoad: loadResources,
		onTranscriptOutputLoad: (request) => loadFullShellOutput(send, request),
		onTranscriptHistoryLoad: loadOlderTranscriptHistory,
		commands: slashCommands,
		commandNames: slashCommandNames,
	});
	runtime.start();
}

export const gatewayStartup = main();
export async function gatewayShutdown(): Promise<void> {
	await shutdown(0);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	process.on("SIGINT", () => {
		if (runtime?.isStarted()) {
			return;
		}
		void interruptExit(130);
	});
	process.once("SIGTERM", () => {
		void shutdown(0).finally(() => process.exit(0));
	});
	void gatewayStartup.catch((error: unknown) => {
		const message = safeErrorMessage(error, "Unable to start mycli shell TUI.");
		process.stderr.write(`[mycli-shell] ${message}\n`);
		if (!bootstrapped) {
			client.stop();
		}
		process.exitCode = 1;
	});
}

function trustDecisionFromState(state: string | undefined): ProjectTrustDecision | null {
	if (state === "trusted") return true;
	if (state === "untrusted") return false;
	return null;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerField(value: unknown): number | undefined {
	return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}
