import process from "node:process";
import { parseGatewayParams, readErrorContext, type GatewayMethod, type GatewayParams, type GatewayResult } from "@mycli/contracts";
import { GatewayClient, GatewayRequestError, type GatewayEvent } from "../transport/gateway-client.ts";
import { loadEarlierProviderAttemptHistory } from "../state/provider-attempt-history.ts";
import {
	initialRuntimeState,
	type RuntimeShellState,
	type RuntimeLocalUserInput,
} from "../state/runtime-state-model.ts";
import {
	reduceDecodedRuntimeEventWithOutcome,
	reduceRuntimeEvent,
} from "../state/runtime-event-reducer.ts";
import {
	RuntimeStateProjector,
} from "../state/runtime-projection.ts";
import {
	runtimeStateFromBootstrap,
	runtimeStateAfterSessionResume,
	runtimeStateWithSessionCommandNotice,
} from "../state/session-state.ts";
import { runtimeStateWithCommandResult } from "../state/command-state.ts";
import { generationValue, stringValue } from "../state/payload-values.ts";
import { SessionTransitionController, type SessionMutationContext } from "./session-transition.ts";
import {
	runtimeStateFromTranscript,
	runtimeStateFromOlderTranscriptPage,
} from "../state/transcript-history.ts";
import {
	runtimeStateWithSettingsSnapshot,
	settingsSnapshotFromResult,
} from "../state/settings-state.ts";
import {
	runtimeStateWithCredentialReadiness,
	runtimeStateWithModelCatalog,
	runtimeStateWithProviderDirectory,
	resourcesFromResult,
	modelsFromResult,
	providerRoutesFromResult,
	sessionResumePreviewFromResult,
	sessionsFromResult,
	sessionTreeFromResult,
} from "../state/catalog-state.ts";
import {
	runtimeStateWithPendingSteer,
	runtimeStateWithSubmittingMessage,
	runtimeStateWithLocalFollowUp,
	runtimeInputDisposition,
	resolveLocalInterruptInputs,
	nextLocalUserInput,
	removeLocalUserInput,
	removeLocalUserInputForSession,
	runtimeStateAcknowledgeQueuedInput,
} from "../state/input-queue.ts";
import {
	permissionStateFromUnknown,
} from "../state/permission-state.ts";
import {
	MycliShellRuntime,
} from "./shell-runtime.ts";
import { NativeChatRuntime } from "./native-chat-runtime.ts";
import type {
	MycliShellLoginResult,
	MycliShellPendingApproval,
	MycliShellPendingClarification,
	MycliShellModel,
	MycliShellPermissionProfile,
	MycliShellPermissionState,
	MycliShellProviderRoute,
	MycliShellResumeRepairAction,
	MycliShellResumeRepairPreview,
	MycliShellSession,
	MycliShellSettingsSnapshot,
	MycliShellSettingChange,
	MycliShellState,
} from "../model.ts";
import type {
	MycliShellLocalImageAttachment,
	MycliShellQueuedInput,
	MycliShellSubmitAttachments,
} from "./runtime-options.ts";
import type { ProjectTrustDecision } from "../components/selectors/trust-selector.ts";
import { openTtyStreams, StreamTerminal, TtyOpenError, type TtyStreams } from "../platform/tty-terminal.ts";
import { GatewayEventDeduper } from "../transport/gateway-events.ts";
import { TUI_VERSION } from "../version.ts";
import {
	clientActionFromResult,
	slashCommandNamesFromResult,
	slashCommandsFromResult,
} from "../interaction/slash-commands.ts";
import { commandResultFromGateway } from "../state/command-results.ts";
import type { MycliShellCommandSpec } from "../model.ts";
import {
	closeGatewayTransport,
	gatewayTransport,
} from "../transport/gateway-transport.ts";
import {
	bootstrapGateway,
	sidecarStartupTimeoutMs,
	verifyGatewayManifest,
} from "../transport/gateway-handshake.ts";
import { classifyRuntimeTranscriptUpdate } from "../state/transcript-update.ts";
import {
	planImplementationMessage,
	type PlanImplementationAction,
} from "../interaction/plan-implementation.ts";
import { appendFatalTuiDiagnostic, fatalTuiErrorContext } from "../platform/fatal-error.ts";
import { errorSummary, sanitizeRuntimeErrorDetail } from "@mycli/contracts";
import { safeErrorMessage } from "../safe-ui-text.ts";
import { createMycliUiActionDispatcher } from "../interaction/ui-actions.ts";

type QueueKind = "steer" | "followUp";
type QueuedTurnInput = {
	kind: QueueKind;
	message: string;
	attachments?: MycliShellSubmitAttachments;
	clientUserMessageId: string;
	source?: string;
};
type RestorableQueuedInput = RuntimeLocalUserInput & {
	readonly kind: "pending_steer" | "rejected_steer" | "follow_up";
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
let latestSubmissionClientTurnId: string | null = null;
let localDispatchEligible = false;
let localDispatchScheduled = false;
let interruptRequested = false;
let extensionRefreshScheduled = false;
let commandCatalogRevision = 0;
let sessionListRevision = 0;
let shuttingDown = false;
let viewModeOverride: RuntimeShellState["viewMode"] | undefined;
let fatalTuiHandling = false;
const runtimeStateProjector = new RuntimeStateProjector();
const TRANSCRIPT_PAGE_LIMIT = 500;
const sessionTransitions = new SessionTransitionController({
	current: () => runtimeState,
	update: (state, replaceTranscript) => setRuntimeState(state, { replaceSessionTranscript: replaceTranscript }),
	loadTranscript: (sessionId) => send("transcript.load", {
		session_id: sessionId, before: null, limit: TRANSCRIPT_PAGE_LIMIT,
	}, { recordErrors: false }),
});
const uiActions = createMycliUiActionDispatcher(async (action) => {
	switch (action.type) {
		case "submit":
			return submitTurn(action.text, { localImages: action.localImages ?? [] });
		case "follow_up":
			return submitFollowUp(action.text, { localImages: action.localImages ?? [] });
		case "command":
			return runCommand(action.command);
		case "transcript.clear":
			sessionTransitions.invalidate();
			setRuntimeState({ ...runtimeState, transcript: [], transcriptNextBefore: null, providerAttemptsNextBefore: null });
			return;
		case "view.set":
			viewModeOverride = action.mode;
			setRuntimeState(runtimeStateWithSettingsSnapshot(runtimeState, withViewModeOverride({
				settings: runtimeState.settings,
				...(runtimeState.settingsCatalog ? { catalog: runtimeState.settingsCatalog } : {}),
			})));
			return;
		case "interrupt":
			return interruptTurn({ rollbackUserInput: action.rollbackUserInput });
		case "dequeue_queued_input":
			return popLastQueuedFollowUp();
		case "approval.respond":
			return respondApproval(action.approval.decisionId, action.choice, action.approval);
		case "clarification.respond":
			return respondClarification(
				action.clarification.requestId,
				action.response,
				action.clarification,
			);
		case "exit":
			return action.reason === "interrupt" ? interruptExit(130) : shutdown(0);
	}
});

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
	if (event.method === "extension.updated") {
		scheduleExtensionRefresh();
		return;
	}
	const decoded = eventDeduper.consume(event);
	if (!decoded) return;
	const { method, params } = decoded;
	if (
		method === "turn.interrupted" &&
		params.requested === true &&
		!interruptRequested
	) {
		return;
	}
	const reduction = reduceDecodedRuntimeEventWithOutcome(runtimeState, decoded);
	if (!reduction.applied) return;
	let nextState = reduction.state;
	const interrupted =
		(method === "turn.interrupted" && params.requested !== true) ||
		(method === "turn.completed" && params.turn_state === "interrupted");
	const shouldResolveInterrupt =
		interrupted &&
		(interruptRequested || runtimeState.turnRunning || runtimeState.activeTurnId !== null);
	if (shouldResolveInterrupt && !interruptRequested) {
		const resolution = resolveLocalInterruptInputs(
			nextState,
			false,
		);
		nextState = resolution.state;
		localDispatchEligible = resolution.dispatchNext;
		runtime?.completeInterruptedTurn(
			resolution.restoreToComposer.map((input) => ({
				text: input.message,
				...(input.attachments.length ? { localImages: input.attachments } : {}),
			})),
			{
				restoreSubmittedInput: params.input_rolled_back === true,
			},
		);
	}
	setRuntimeState(nextState, { eventType: method });
	if (method === "session.changed") {
		sessionTransitions.invalidate();
		backendTurnBusy = false;
		localDispatchEligible = false;
		interruptRequested = false;
		if (bootstrapped) void loadSessions().catch(() => undefined);
	}
	if (method === "turn.started") {
		backendTurnBusy = true;
	}
	if (
		(method === "turn.completed" && !interrupted) ||
		method === "turn.failed"
	) {
		localDispatchEligible = true;
	}
	if (method === "status.changed" && params.turn_running === false) {
		backendTurnBusy = false;
	}
	if (!backendTurnBusy && !interruptRequested) {
		scheduleNextLocalInput();
	}
}

function scheduleExtensionRefresh(): void {
	if (extensionRefreshScheduled || shuttingDown) return;
	extensionRefreshScheduled = true;
	queueMicrotask(() => {
		extensionRefreshScheduled = false;
		if (shuttingDown) return;
		void Promise.all([
			send("extension.manifest", {}, { recordErrors: false }).then(verifyGatewayManifest),
			loadResources(),
			loadCommands(),
		]).catch(() => undefined);
	});
}

async function send<M extends GatewayMethod>(
	method: M,
	params: GatewayParams<M>,
	options: { recordErrors?: boolean } = {},
): Promise<GatewayResult<M>> {
	try {
		return await client.request(method, params);
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
					...requestDiagnosticFields(gatewayError.data),
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

async function validateProviderConnectivity(): Promise<{ ok: boolean; message?: string }> {
	const payload = await send("provider.connectivity.validate", {}, { recordErrors: false });
	return {
		ok: payload.ok === true,
		...(typeof payload.message === "string" ? { message: payload.message.slice(0, 240) } : {}),
	};
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
	const bootstrapPayload = await bootstrapGateway((params) => send("session.bootstrap", {
		...params,
		client: { name: "mycli-shell-tui", version: TUI_VERSION },
	}, { recordErrors: false }));
	setRuntimeState(runtimeStateFromBootstrap(runtimeState, bootstrapPayload));
	const transcriptPayload = await send("transcript.load", {
		session_id: runtimeState.sessionId ?? undefined,
		before: null,
		limit: TRANSCRIPT_PAGE_LIMIT,
	});
	setRuntimeState(runtimeStateFromTranscript(runtimeState, transcriptPayload));
	await loadRetryHistory();
	await loadCommands();
	await loadSettings();
	await loadSessions().catch(() => undefined);
	bootstrapped = true;
}

async function loadSettings(): Promise<MycliShellSettingsSnapshot | undefined> {
	try {
		const result = await send("settings.load", {}, { recordErrors: false });
		const snapshot = withViewModeOverride(settingsSnapshotFromResult(result));
		setRuntimeState(runtimeStateWithSettingsSnapshot(runtimeState, snapshot));
		return snapshot;
	} catch {
		// Keep built-in defaults when the gateway does not support persistent settings.
		return undefined;
	}
}

function withViewModeOverride(snapshot: MycliShellSettingsSnapshot): MycliShellSettingsSnapshot {
	const mode = viewModeOverride;
	if (mode === undefined) return snapshot;
	return {
		...snapshot,
		settings: { ...snapshot.settings, viewMode: mode },
		...(snapshot.catalog ? { catalog: {
			...snapshot.catalog,
			items: snapshot.catalog.items.map((item) => item.clientKey === "viewMode"
				? { ...item, value: mode, source: "session", scope: "session" } : item),
		} } : {}),
	};
}

async function loadCommands(): Promise<void> {
	const revision = ++commandCatalogRevision;
	const payload = await send("command.list", { surface: commandSurface }, { recordErrors: false });
	if (revision !== commandCatalogRevision || shuttingDown) return;
	slashCommands = slashCommandsFromResult(payload);
	slashCommandNames = slashCommandNamesFromResult(payload);
	runtime?.setCommands(slashCommands, slashCommandNames);
	nativeRuntime?.setCommands(slashCommands, slashCommandNames);
}

async function loadSessions(): Promise<MycliShellSession[]> {
	const revision = ++sessionListRevision;
	const context = currentSessionMutationContext();
	const result = await send("session.list", {}, { recordErrors: false });
	if (revision === sessionListRevision && sessionMutationContextIsCurrent(context) && !shuttingDown) {
		sessions = sessionsFromResult(result);
		refreshRuntime();
	}
	return sessions;
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
		await queueFollowUp({
			kind: "followUp",
			message: text,
			attachments,
			clientUserMessageId,
		});
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
	latestSubmissionClientTurnId = clientTurnId;
	const context = currentSessionMutationContext();
	const localInput = runtimeLocalInput(clientUserMessageId, text, attachments);
	setRuntimeState({ ...runtimeStateWithSubmittingMessage(runtimeState, localInput), activeClientTurnId: clientTurnId });
	backendTurnBusy = true;
	try {
		const result = await send(
			"turn.submit",
				{
					message: text,
					client_turn_id: clientTurnId,
					client_user_message_id: clientUserMessageId,
					...sessionMutationFields(context),
					...(options.collaborationMode ? { collaboration_mode: options.collaborationMode } : {}),
					...(attachments?.localImages?.length ? { local_images: attachments.localImages.map((image) => image.path) } : {}),
				},
			{ recordErrors: false },
		);
		if (!sessionMutationContextIsCurrent(context) || latestSubmissionClientTurnId !== clientTurnId) return;
		if (result.admission_cancelled === true) {
			if (sessionMutationContextIsCurrent(context) && runtimeState.activeClientTurnId === clientTurnId) {
				backendTurnBusy = false;
				setRuntimeState({ ...removeLocalUserInput(runtimeState, clientUserMessageId),
					turnRunning: false, activeTurnId: null, activeClientTurnId: null, liveStatus: null });
			}
			return;
		}
		const turnId = typeof result.turn_id === "string" ? result.turn_id : null;
		if (backendTurnBusy) {
			setRuntimeState({
				...runtimeState,
				turnRunning: true,
				activeTurnId: turnId ?? runtimeState.activeTurnId,
				activeClientTurnId: clientTurnId,
			});
		}
	} catch (error) {
		if (!sessionMutationContextIsCurrent(context) || latestSubmissionClientTurnId !== clientTurnId) return;
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
				...(error instanceof GatewayRequestError
					? requestDiagnosticFields(error.data)
					: {}),
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
		interruptRequested ||
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
		await queueFollowUp(input);
		return;
	}
	await submitTurn(input.message, input.attachments, input.clientUserMessageId);
}

async function queueFollowUp(input: QueuedTurnInput): Promise<void> {
	const context = currentSessionMutationContext();
	const sessionId = context.sessionId;
	const localInput = runtimeLocalInput(
		input.clientUserMessageId,
		input.message,
		input.attachments,
	);
	setRuntimeState(runtimeStateWithLocalFollowUp(runtimeState, localInput));
	try {
		const result = await send("turn.follow_up", {
			message: input.message,
			client_turn_id: input.clientUserMessageId,
			...sessionMutationFields(context),
			...(input.attachments?.localImages?.length
				? { local_images: input.attachments.localImages }
				: {}),
		}, { recordErrors: false });
		setRuntimeState(runtimeStateAcknowledgeQueuedInput(
			runtimeState,
			input.clientUserMessageId,
			result,
			sessionId,
		));
	} catch (error) {
		if (!sessionMutationContextIsCurrent(context)) return;
		setRuntimeState(removeLocalUserInputForSession(
			runtimeState,
			sessionId,
			input.clientUserMessageId,
		));
		throw error;
	}
}

async function queueSteeringTurn(input: QueuedTurnInput): Promise<void> {
	const context = currentSessionMutationContext();
	const sessionId = context.sessionId;
	const localInput = runtimeLocalInput(
		input.clientUserMessageId,
		input.message,
		input.attachments,
	);
	setRuntimeState(runtimeStateWithPendingSteer(runtimeState, localInput));
	let expectedTurnId = runtimeState.activeTurnId;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			if (!expectedTurnId) throw new GatewayRequestError({ method: "turn.steer", code: "invalid_params", message: "Active turn is unavailable." });
			const result = await send("turn.steer", {
				message: input.message,
				client_user_message_id: input.clientUserMessageId,
				expected_turn_id: expectedTurnId,
				...sessionMutationFields(context),
				...(input.attachments?.localImages?.length
					? { local_images: input.attachments.localImages }
					: {}),
			}, { recordErrors: false });
			setRuntimeState(runtimeStateAcknowledgeQueuedInput(
				runtimeState,
				input.clientUserMessageId,
				result,
				sessionId,
			));
			return;
		} catch (error) {
			if (!sessionMutationContextIsCurrent(context)) return;
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
			setRuntimeState(removeLocalUserInputForSession(
				runtimeState,
				sessionId,
				input.clientUserMessageId,
			));
			throw error;
		}
	}
}

async function popLastQueuedFollowUp(): Promise<MycliShellQueuedInput | null> {
	const context = currentSessionMutationContext();
	const result = await send(
		"turn.queue.pop",
		sessionMutationFields(context),
		{ recordErrors: false },
	);
	if (!sessionMutationContextIsCurrent(context)) return null;
	const item = typeof result.item === "object" && result.item !== null
		? result.item as Record<string, unknown>
		: null;
	const clientUserMessageId = item
		? stringField(item.client_user_message_id ?? item.client_turn_id)
		: undefined;
	const nextState = reduceRuntimeEvent(runtimeState, "turn.queue.updated", result);
	setRuntimeState(clientUserMessageId
		? removeLocalUserInput(nextState, clientUserMessageId)
		: nextState);
	if (!item) return null;
	const text = stringField(item.message ?? item.text);
	if (!text) return null;
	const localImages = localImageAttachmentsFromGateway(item.local_images);
	return {
		text,
		...(localImages.length > 0 ? { localImages } : {}),
	};
}

async function interruptTurn(options: { rollbackUserInput: boolean }): Promise<boolean> {
	const context = currentSessionMutationContext();
	const requestedClientTurnId = runtimeState.activeClientTurnId;
	const pendingClarification = runtimeState.pendingClarification;
	const pendingClarificationTurnId = pendingClarification
		? stringField(pendingClarification.turn_id) ?? stringField(pendingClarification.turnId)
		: null;
	const clarificationPending = pendingClarification !== null && pendingClarificationTurnId !== null;
	if (backendTurnBusy || runtimeState.turnRunning || runtimeState.activeTurnId || clarificationPending) {
		interruptRequested = true;
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
			if (!sessionMutationContextIsCurrent(context)) return false;
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
					...(requestedClientTurnId ? { client_turn_id: requestedClientTurnId } : {}),
					...sessionMutationFields(context),
				}, { recordErrors: false });
				if (result.accepted !== true || result.requested !== true) {
					if (!sessionMutationContextIsCurrent(context)
						|| (requestedClientTurnId && runtimeState.activeClientTurnId
							&& runtimeState.activeClientTurnId !== requestedClientTurnId)) return false;
					backendTurnBusy = result.turn_running === true;
					setRuntimeState(reduceRuntimeEvent(runtimeState, "status.changed", result));
					clearOptimisticInterrupt();
					return false;
				}
				await resolveRequestedInterrupt(result, context);
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

async function resolveRequestedInterrupt(
	result: Record<string, unknown>,
	context: SessionMutationContext,
): Promise<void> {
	if (!sessionMutationContextIsCurrent(context)) {
		interruptRequested = false;
		return;
	}
	if (result.admission_cancelled === true) {
		if (latestSubmissionClientTurnId === result.client_turn_id
			&& (!runtimeState.activeClientTurnId || runtimeState.activeClientTurnId === result.client_turn_id)) {
			backendTurnBusy = false;
			const inputId = stringField(result.client_user_message_id);
			setRuntimeState({ ...(inputId ? removeLocalUserInput(runtimeState, inputId) : runtimeState),
				turnRunning: false, activeTurnId: null, activeClientTurnId: null, liveStatus: null });
			runtime?.completeInterruptedTurn([], { restoreSubmittedInput: result.input_rolled_back === true });
		}
		interruptRequested = false;
		return;
	}
	const resubmitted = result.pending_steers_resubmitted === true;
	let nextState = runtimeState;
	let restoreInputs: RuntimeLocalUserInput[] = [];
	let restoreToken: string | undefined;
	if (resubmitted) {
		const resolution = resolveLocalInterruptInputs(nextState, true);
		nextState = resolution.state;
	} else {
		let durableInputs: RestorableQueuedInput[] = [];
		try {
			restoreToken = `restore_${nextClientTurnId("queue")}`;
			const cleared = await send("turn.queue.clear", {
				...sessionMutationFields(context),
				restore_token: restoreToken,
			}, { recordErrors: false });
			if (!sessionMutationContextIsCurrent(context)) {
				interruptRequested = false;
				return;
			}
			durableInputs = clearedQueuedInputs(cleared);
			nextState = reduceRuntimeEvent(nextState, "turn.queue.updated", cleared);
		} catch (error) {
			nextState = reduceRuntimeEvent(nextState, "gateway.error", {
				code: error instanceof GatewayRequestError ? error.code : "request_failed",
				message: safeErrorMessage(error, "Queued input could not be restored."),
				method: "turn.queue.clear",
				...(error instanceof GatewayRequestError
					? requestDiagnosticFields(error.data)
					: {}),
			});
		}
		if (!sessionMutationContextIsCurrent(context)) {
			interruptRequested = false;
			return;
		}
		const localInputs: RestorableQueuedInput[] = [
			...nextState.localRejectedSteers.map((input) => ({ ...input, kind: "rejected_steer" as const })),
			...nextState.localPendingSteers.map((input) => ({ ...input, kind: "pending_steer" as const })),
			...nextState.localFollowUps.map((input) => ({ ...input, kind: "follow_up" as const })),
		];
		const resolution = resolveLocalInterruptInputs(nextState, false);
		nextState = resolution.state;
		restoreInputs = mergeRestoredInputs(durableInputs, localInputs);
	}
	setRuntimeState(nextState);
	runtime?.completeInterruptedTurn(
		restoreInputs.map((input) => ({
			text: input.message,
			...(input.attachments.length ? { localImages: input.attachments } : {}),
		})),
		{ restoreSubmittedInput: result.input_rolled_back === true },
	);
	if (restoreToken) {
		try {
			const acknowledged = await send("turn.queue.restore.ack", {
				...sessionMutationFields(context),
				restore_token: restoreToken,
			}, { recordErrors: false });
			if (sessionMutationContextIsCurrent(context)) {
				setRuntimeState(reduceRuntimeEvent(runtimeState, "turn.queue.updated", acknowledged));
			}
		} catch (error) {
			if (sessionMutationContextIsCurrent(context)) {
				setRuntimeState(reduceRuntimeEvent(runtimeState, "gateway.error", {
					code: error instanceof GatewayRequestError ? error.code : "request_failed",
					message: safeErrorMessage(error, "Restored input could not be acknowledged."),
					method: "turn.queue.restore.ack",
					...(error instanceof GatewayRequestError
						? requestDiagnosticFields(error.data)
						: {}),
				}));
			}
		}
	}
	localDispatchEligible = false;
	interruptRequested = false;
}

async function respondApproval(
	decisionId: string,
	choice: string,
	approval?: MycliShellPendingApproval,
): Promise<void> {
	try {
		await send("approval.respond", parseGatewayParams("approval.respond", {
			decision_id: decisionId,
			choice,
			...(approval?.sessionId ? { session_id: approval.sessionId } : {}),
			...(approval?.generation ? { generation: approval.generation } : {}),
		}), { recordErrors: false });
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
		await bootstrapGateway((params) => send("session.bootstrap", {
			...params,
			client: { name: "mycli-shell-tui", version: TUI_VERSION },
		}, { recordErrors: false }));
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
): Promise<MycliShellLoginResult> {
	const result = await send("auth.api_key.save", {
		provider_id: providerId,
		api_key: apiKey,
		...(authRef ? { auth_ref: authRef } : {}),
	});
	setRuntimeState(runtimeStateWithCredentialReadiness(runtimeState, result));
	return {
		message: typeof result.message === "string" ? result.message : undefined,
		authProviders: runtimeState.authProviders,
		authReadiness: runtimeState.authReadiness ?? undefined,
	};
}

async function loadProviderRoutes(): Promise<MycliShellProviderRoute[]> {
	const result = await send("provider.list", {}, { recordErrors: false });
	return providerRoutesFromResult(result);
}

async function loadProviderModels(providerId: string): Promise<MycliShellModel[]> {
	const result = await send("model.list", { provider: providerId }, { recordErrors: false });
	if (stringField(result.provider) !== providerId) {
		throw new Error("Gateway returned models for a different provider route.");
	}
	return modelsFromResult(result);
}

async function runCommand(command: string): Promise<void> {
	const source = currentSessionMutationContext();
	const result = await send("command.run", { command, surface: commandSurface });
	if (shuttingDown) return;
	const destination = stringValue(result.session_id);
	const generation = generationValue(result.generation);
	if (result.mutated_session === true && destination
		&& (destination !== source.sessionId || (generation !== null && generation !== source.generation))) {
		if (!await sessionTransitions.resume(result, undefined, source)) return;
		if (runtimeState.sessionId !== destination
			|| (generation !== null && runtimeState.sessionGeneration !== generation)) return;
		setRuntimeState(runtimeStateWithSessionCommandNotice(runtimeState, command, result));
		await loadRetryHistory();
		return;
	}
	if (!sessionMutationContextIsCurrent(source)) return;
	const clientAction = clientActionFromResult(result);
	if (clientAction && runtime) {
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
	setRuntimeState(runtimeStateWithCommandResult(runtimeState, command, result));
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
	const source = currentSessionMutationContext();
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
	const applied = await sessionTransitions.resume(
		{ ...result, session_id: resumedSessionId }, session?.title ?? sessionId, source,
	);
	if (!applied) throw new Error("The active session changed while loading history.");
	await loadRetryHistory();
	return resumedSessionId;
}

async function loadOlderTranscriptHistory(before: string): Promise<void> {
	const sessionId = runtimeState.sessionId;
	const generation = runtimeState.sessionGeneration;
	if (!sessionId || (runtimeState.transcriptNextBefore ?? "") !== before) return;
	if (before) {
		const payload = await send("transcript.load", {
			session_id: sessionId, before, limit: TRANSCRIPT_PAGE_LIMIT,
		}, { recordErrors: false });
		if (runtimeState.sessionId !== sessionId || runtimeState.sessionGeneration !== generation
			|| runtimeState.transcriptNextBefore !== before) return;
		setRuntimeState(runtimeStateFromOlderTranscriptPage(runtimeState, payload), { eventType: "transcript.history.prepended" });
	}
	await loadRetryHistory(true);
}

async function loadRetryHistory(force = false): Promise<void> {
	await loadEarlierProviderAttemptHistory({
		current: () => runtimeState,
		update: (state) => { setRuntimeState(state, { eventType: "transcript.history.prepended" }); },
		load: (params) => send("provider.attempts.load", params, { recordErrors: false }),
		force,
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
	if (change.settingId === "tui.view_mode") viewModeOverride = undefined;
	const snapshot = withViewModeOverride(settingsSnapshotFromResult(result));
	setRuntimeState(runtimeStateWithSettingsSnapshot(runtimeState, snapshot));
	return snapshot;
}

async function resetSettingsKeymap(): Promise<MycliShellSettingsSnapshot> {
	const result = await send("settings.keymap.reset", {});
	const snapshot = withViewModeOverride(settingsSnapshotFromResult(result));
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

async function handleUnexpectedGatewayClose(error: Error): Promise<void> {
	const firstDiagnostic = rpcTransport.diagnostic?.();
	await stopLocalRuntime().catch(() => undefined);
	const diagnostic = firstDiagnostic || rpcTransport.diagnostic?.()
		|| ("code" in error && typeof error.code === "string" ? error.code : "");
	const code = /^[a-z][a-z0-9_]{0,63}$/u.test(diagnostic) ? diagnostic : undefined;
	const errorContext = fatalTuiErrorContext("connection", code);
	const logPath = appendFatalTuiDiagnostic(error, {
		errorContext,
		...(runtimeState.sessionId ? { sessionId: runtimeState.sessionId } : {}),
		...(code ? { diagnosticCode: code } : {}),
	});
	process.stderr.write(`[mycli-shell] ${errorSummary(errorContext)}`
		+ (logPath ? " Diagnostics were written to ~/.mycli/logs/tui-errors.log.\n" : "\n"));
	process.exitCode = 1;
}

async function handleFatalTuiError(error: unknown): Promise<void> {
	if (fatalTuiHandling) return;
	fatalTuiHandling = true;
	const errorContext = fatalTuiErrorContext(error instanceof TtyOpenError ? "terminal" : "render");
	const logPath = appendFatalTuiDiagnostic(error, { errorContext });
	await stopLocalRuntime().catch(() => undefined);
	process.stderr.write(`[mycli-shell] ${errorSummary(errorContext)}`
		+ (logPath ? " Diagnostics were written to ~/.mycli/logs/tui-errors.log.\n" : "\n"));
	process.exitCode = 1;
}

async function stopLocalRuntime(): Promise<void> {
	shuttingDown = true;
	sessionTransitions.invalidate();
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
			actions: uiActions,
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
		actions: uiActions,
		onSuspend: process.platform === "win32"
			? undefined
			: () => process.kill(0, "SIGTSTP"),
		onFatalError: (error) => { void handleFatalTuiError(error); },
		onPlanImplementation: startPlanImplementation,
		onApiKeyLogin: saveApiKey,
		onConnectivityValidate: validateProviderConnectivity,
		onProviderLoad: loadProviderRoutes,
		onModelLoad: loadProviderModels,
		onProviderRoutesChange: (providerRoutes) => {
			setRuntimeState(runtimeStateWithProviderDirectory(runtimeState, { providers: providerRoutes }));
		},
		onModelCatalogChange: (provider, models) => {
			setRuntimeState(runtimeStateWithModelCatalog(runtimeState, { provider, models }));
		},
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
		onSessionLoad: loadSessions,
		onSessionSelect: selectSession,
		onSessionTreeLoad: loadSessionTree,
		onSettingsLoad: loadSettings,
		onSettingsChange: saveSettings,
		onSettingsKeymapReset: resetSettingsKeymap,
		onResourceLoad: loadResources,
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

export function installStandaloneGatewayLifecycle(): void {
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

function localImageAttachmentsFromGateway(value: unknown): MycliShellLocalImageAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 16).flatMap((entry, index) => {
		if (typeof entry !== "object" || entry === null) return [];
		const record = entry as Record<string, unknown>;
		const path = stringField(record.path);
		if (!path) return [];
		return [{
			path,
			placeholder: stringField(record.placeholder) ?? `[image #${index + 1}]`,
		}];
	});
}

function clearedQueuedInputs(payload: Record<string, unknown>): RestorableQueuedInput[] {
	const steering = queueInputsFromUnknown(payload.steering_items, "pending_steer");
	const deferred = queueInputsFromUnknown(payload.follow_up_items, "follow_up");
	return [
		...deferred.filter((input) => input.kind === "rejected_steer"),
		...steering,
		...deferred.filter((input) => input.kind !== "rejected_steer"),
	];
}

function queueInputsFromUnknown(
	value: unknown,
	fallbackKind: "pending_steer" | "follow_up",
): RestorableQueuedInput[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry, index) => {
		if (typeof entry !== "object" || entry === null) return [];
		const record = entry as Record<string, unknown>;
		const message = stringField(record.message ?? record.text);
		if (!message) return [];
		const rawKind = stringField(record.kind);
		const kind = rawKind === "rejected_steer"
			? "rejected_steer"
			: rawKind === "follow_up"
				? "follow_up"
				: fallbackKind;
		return [{
			clientUserMessageId: stringField(
				record.client_user_message_id ?? record.client_turn_id,
			) ?? `interrupt-restore-${kind}-${index}`,
			message,
			attachments: localImageAttachmentsFromGateway(record.local_images),
			kind,
		}];
	});
}

function mergeRestoredInputs(
	durable: readonly RestorableQueuedInput[],
	local: readonly RestorableQueuedInput[],
): RuntimeLocalUserInput[] {
	const seen = new Set<string>();
	const merged: RuntimeLocalUserInput[] = [];
	for (const kind of ["rejected_steer", "pending_steer", "follow_up"] as const) {
		for (const { kind: _kind, ...input } of [...durable, ...local]) {
			if (_kind !== kind || seen.has(input.clientUserMessageId)) continue;
			seen.add(input.clientUserMessageId);
			merged.push(input);
		}
	}
	return merged;
}

function integerField(value: unknown): number | undefined {
	return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function currentSessionMutationContext(): SessionMutationContext {
	return Object.freeze({
		sessionId: runtimeState.sessionId,
		generation: runtimeState.sessionGeneration,
	});
}

function sessionMutationFields(context: SessionMutationContext): Record<string, unknown> {
	return {
		...(context.sessionId ? { session_id: context.sessionId } : {}),
		...(context.generation !== null ? { generation: context.generation } : {}),
	};
}

function sessionMutationContextIsCurrent(context: SessionMutationContext): boolean {
	return context.sessionId === runtimeState.sessionId
		&& context.generation === runtimeState.sessionGeneration;
}

function requestDiagnosticFields(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const errorContext = readErrorContext(data.error_context);
	const additionalDetails = sanitizeRuntimeErrorDetail(data.additional_details);
	const occurrenceId = boundedStringField(data.occurrence_id, 96);
	const category = boundedStringField(data.category, 32);
	const recoveryActions = Array.isArray(data.recovery_actions)
		? data.recovery_actions.flatMap((value) => {
			const id = boundedStringField(value, 64);
			return id ? [id] : [];
		}).slice(0, 4)
		: [];
	return {
		...(errorContext ? { error_context: errorContext } : {}),
		...(additionalDetails ? { additional_details: additionalDetails } : {}),
		...(data.error_context_invalid === true ? { error_context_invalid: true } : {}),
		...(occurrenceId ? { occurrence_id: occurrenceId } : {}),
		...(category ? { category } : {}),
		...(recoveryActions.length > 0 ? { recovery_actions: recoveryActions } : {}),
	};
}

function boundedStringField(value: unknown, maxLength: number): string | undefined {
	const field = stringField(value);
	return field && field.length <= maxLength ? field : undefined;
}
