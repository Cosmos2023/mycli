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
	runtimeStateWithSettings,
	runtimeStateWithUserMessage,
	resourcesFromResult,
	sessionsFromResult,
	sessionTreeFromResult,
	settingsFromResult,
	type RuntimeQueuedInputPreview,
	type RuntimeShellState,
} from "./adapters/runtime-state.ts";
import { MycliShellRuntime } from "./shell-runtime.ts";
import { NativeChatRuntime } from "./native-chat-runtime.ts";
import type { MycliShellSession, MycliShellState, MycliShellVisualSettings } from "./model.ts";
import type {
	MycliShellLocalImageAttachment,
	MycliShellQueuedInput,
	MycliShellSubmitAttachments,
} from "./shell-runtime.ts";
import type { ProjectTrustDecision } from "./components/trust-selector.ts";
import { openTtyStreams, StreamTerminal, type TtyStreams } from "./adapters/tty-terminal.ts";
import { GatewayEventDeduper } from "./adapters/gateway-events.ts";
import { clientActionFromResult, slashCommandsFromResult } from "./adapters/slash-commands.ts";
import type { MycliShellCommandSpec } from "./model.ts";

type QueueKind = "steer" | "followUp";
type QueuedTurnInput = {
	kind: QueueKind;
	message: string;
	attachments?: MycliShellSubmitAttachments;
	clientTurnId?: string;
	source?: string;
};
type SubmitTurnOptions = { fromQueue?: QueueKind; attachments?: MycliShellSubmitAttachments };

const commandSurface = process.env.MYCLI_TUI_NATIVE === "1" ? "cli" : "tui";

const client = new GatewayClient({
	input: process.stdin,
	output: process.stdout,
	log: (event) => handleGatewayEvent(event),
});

let runtimeState: RuntimeShellState = initialRuntimeState();
let sessions: MycliShellSession[] = [];
let slashCommands: MycliShellCommandSpec[] = [];
let runtime: MycliShellRuntime | null = null;
let nativeRuntime: NativeChatRuntime | null = null;
let ttyStreams: TtyStreams | null = null;
let bootstrapped = false;
const eventDeduper = new GatewayEventDeduper();
const queuedSteeringTurns: QueuedTurnInput[] = [];
const queuedFollowUpTurns: QueuedTurnInput[] = [];
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
		queuedSteeringTurns.push(...queuedItemsValue(event.params.steering_items, "steer", event.params.steering));
		queuedFollowUpTurns.length = 0;
		queuedFollowUpTurns.push(...queuedItemsValue(event.params.follow_up_items, "followUp", event.params.follow_up));
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
	const commandPayload = await send("command.list", { surface: commandSurface });
	slashCommands = slashCommandsFromResult(commandPayload);
	await loadSettings();
	await loadSessions();
	bootstrapped = true;
}

async function loadSettings(): Promise<void> {
	try {
		const result = await send("settings.load", {}, { recordErrors: false });
		setRuntimeState(runtimeStateWithSettings(runtimeState, settingsFromResult(result)));
	} catch {
		// Keep built-in defaults when the gateway does not support persistent settings.
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

async function submitTurn(
	messageOrQueued: string | QueuedTurnInput,
	optionsOrAttachments: SubmitTurnOptions | MycliShellSubmitAttachments = {},
): Promise<void> {
	const options = normalizeSubmitOptions(optionsOrAttachments);
	const queuedInput = typeof messageOrQueued === "string" ? null : messageOrQueued;
	let rawText: string;
	if (queuedInput) {
		rawText = queuedInput.message;
	} else {
		rawText = messageOrQueued as string;
	}
	const text = rawText.trim();
	const attachments = queuedInput?.attachments ?? options.attachments;
	if (!text) {
		return;
	}
	if (!options.fromQueue && runtimeState.turnRunning) {
		await queueSteeringTurn({ kind: "steer", message: text, attachments });
		return;
	}
	const clientTurnId = queuedInput?.clientTurnId ?? nextClientTurnId(options.fromQueue ?? "ui");
	try {
		await send(
			"turn.submit",
			{
				message: text,
				client_turn_id: clientTurnId,
				...(attachments?.localImages?.length ? { local_images: attachments.localImages } : {}),
			},
			{ recordErrors: false },
		);
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
				enqueueSteeringTurn({ kind: "steer", message: text, attachments, clientTurnId });
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

function normalizeSubmitOptions(
	value: SubmitTurnOptions | MycliShellSubmitAttachments,
): SubmitTurnOptions {
	if ("localImages" in value) {
		return { attachments: value };
	}
	if ("fromQueue" in value || "attachments" in value) {
		return value;
	}
	return {};
}

function nextClientTurnId(prefix: string): string {
	clientTurnSequence += 1;
	return `${prefix}_${Date.now()}_${clientTurnSequence}`;
}

function enqueueSteeringTurn(input: QueuedTurnInput): void {
	queuedSteeringTurns.push(input);
	syncQueuedInputs();
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
		clientTurnId: nextClientTurnId("followUp"),
	};
	if (runtimeState.turnRunning || backendTurnBusy) {
		await queueFollowUpTurn(input);
		return;
	}
	await submitTurn(input);
}

async function queueSteeringTurn(input: QueuedTurnInput): Promise<void> {
	try {
		const result = await send("turn.steer", queueRpcPayload(input), { recordErrors: false });
		syncQueuedInputsFromResult(result);
		if (result.accepted === false) {
			enqueueSteeringTurn(input);
		}
	} catch {
		enqueueSteeringTurn(input);
	}
}

async function queueFollowUpTurn(input: QueuedTurnInput): Promise<void> {
	try {
		const result = await send("turn.follow_up", queueRpcPayload(input), { recordErrors: false });
		syncQueuedInputsFromResult(result);
		if (result.accepted === false) {
			queuedFollowUpTurns.push(input);
			syncQueuedInputs();
		}
	} catch {
		queuedFollowUpTurns.push(input);
		syncQueuedInputs();
	}
}

function queuedTurns(): QueuedTurnInput[] {
	return [...queuedSteeringTurns, ...queuedFollowUpTurns];
}

function visibleQueuedTurns(): string[] {
	return queuedTurns().map((input) => input.message).filter((message) => !isInternalTaskNotification(message));
}

function nextQueuedTurn(): QueuedTurnInput | null {
	const steering = queuedSteeringTurns[0];
	if (steering !== undefined) {
		return steering;
	}
	const followUp = queuedFollowUpTurns[0];
	if (followUp !== undefined) {
		return followUp;
	}
	return null;
}

function syncQueuedInputs(): void {
	setRuntimeState(runtimeStateWithMessageQueues(runtimeState, { steering: queuePreviews(queuedSteeringTurns), followUp: queuePreviews(queuedFollowUpTurns) }));
}

function syncQueuedInputsFromResult(result: Record<string, unknown>): void {
	queuedSteeringTurns.length = 0;
	queuedSteeringTurns.push(...queuedItemsValue(result.steering_items, "steer", result.steering));
	queuedFollowUpTurns.length = 0;
	queuedFollowUpTurns.push(...queuedItemsValue(result.follow_up_items, "followUp", result.follow_up));
	syncQueuedInputs();
}

async function popLastQueuedFollowUp(): Promise<MycliShellQueuedInput | null> {
	try {
		const result = await send("turn.queue.pop", {}, { recordErrors: false });
		syncQueuedInputsFromResult(result);
		const popped = queuedItemsValue(
			result.item === null || result.item === undefined ? [] : [result.item],
			"followUp",
			[],
		)[0];
		return popped ? combineQueuedInputs([popped]) : null;
	} catch {
		return null;
	}
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
		await submitTurn(next, { fromQueue: next.kind });
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
	await send("turn.interrupt", {});
}

async function respondApproval(decisionId: string, choice: string): Promise<void> {
	await send("approval.respond", { decision_id: decisionId, choice });
}

async function saveApiKey(providerId: string, apiKey: string): Promise<{ message?: string }> {
	const result = await send("auth.api_key.save", { provider_id: providerId, api_key: apiKey });
	runtimeState = {
		...runtimeState,
		authProviders: runtimeState.authProviders.map((provider) =>
			provider.id === providerId ? { ...provider, configured: true } : provider,
		),
	};
	refreshRuntime();
	return { message: typeof result.message === "string" ? result.message : undefined };
}

function queueRpcPayload(input: QueuedTurnInput): Record<string, unknown> {
	return {
		message: input.message,
		client_turn_id: input.clientTurnId ?? nextClientTurnId(input.kind),
		...(input.attachments?.localImages?.length ? { local_images: input.attachments.localImages } : {}),
	};
}

function queuePreviews(items: QueuedTurnInput[]): RuntimeQueuedInputPreview[] {
	return items.map((item) => ({
		message: item.message,
		hasImages: Boolean(item.attachments?.localImages?.length),
	}));
}

function queuedItemsValue(value: unknown, kind: QueueKind, fallback: unknown): QueuedTurnInput[] {
	const parsed = queuedItemsFromPayload(value, kind);
	if (parsed.length > 0) {
		return parsed;
	}
	return stringArrayValue(fallback).map((message) => ({ kind, message }));
}

function queuedItemsFromPayload(value: unknown, kind: QueueKind): QueuedTurnInput[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const inputs: QueuedTurnInput[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim()) {
			inputs.push({ kind, message: item.trim() });
			continue;
		}
		if (!item || typeof item !== "object") {
			continue;
		}
		const record = item as Record<string, unknown>;
		const rawMessage = record.message ?? record.text;
		if (typeof rawMessage !== "string" || !rawMessage.trim()) {
			continue;
		}
		const localImages = localImagesValue(record.local_images);
		inputs.push({
			kind,
			message: rawMessage.trim(),
			...(localImages.length ? { attachments: { localImages } } : {}),
			...(typeof record.client_turn_id === "string" ? { clientTurnId: record.client_turn_id } : {}),
			...(typeof record.source === "string" ? { source: record.source } : {}),
		});
	}
	return inputs;
}

function localImagesValue(value: unknown): MycliShellLocalImageAttachment[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const images: MycliShellLocalImageAttachment[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item === "string" && item.trim()) {
			images.push({ path: item.trim(), placeholder: `[image #${index + 1}]` });
			continue;
		}
		if (!item || typeof item !== "object") {
			continue;
		}
		const record = item as Record<string, unknown>;
		if (typeof record.path !== "string" || !record.path.trim()) {
			continue;
		}
		images.push({
			path: record.path.trim(),
			placeholder:
				typeof record.placeholder === "string" && record.placeholder.trim()
					? record.placeholder.trim()
					: `[image #${index + 1}]`,
		});
	}
	return images;
}

function combineQueuedInputs(inputs: QueuedTurnInput[]): MycliShellQueuedInput {
	const localImages: MycliShellLocalImageAttachment[] = [];
	const textParts: string[] = [];
	for (const input of inputs) {
		let text = input.message;
		for (const image of input.attachments?.localImages ?? []) {
			const nextPlaceholder = `[image #${localImages.length + 1}]`;
			if (image.placeholder && text.includes(image.placeholder)) {
				text = text.split(image.placeholder).join(nextPlaceholder);
			}
			localImages.push({ path: image.path, placeholder: nextPlaceholder });
		}
		if (text.trim()) {
			textParts.push(text.trim());
		}
	}
	return {
		text: textParts.join("\n\n"),
		...(localImages.length ? { localImages } : {}),
	};
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

function isInternalTaskNotification(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("<task-notification>") || trimmed.startsWith("<task-notification ");
}

async function runCommand(command: string): Promise<void> {
	const result = await send("command.run", { command, surface: commandSurface });
	const clientAction = clientActionFromResult(result);
	if (clientAction && runtime) {
		await runtime.handleClientAction(clientAction.action, clientAction.args);
		return;
	}
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

async function saveSettings(settings: MycliShellVisualSettings): Promise<MycliShellVisualSettings> {
	const result = await send("settings.save", { settings });
	const savedSettings = settingsFromResult(result);
	setRuntimeState(runtimeStateWithSettings(runtimeState, savedSettings));
	return savedSettings;
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
		onDequeueQueuedInput: popLastQueuedFollowUp,
		onCommandSubmit: runCommand,
		onExit: () => shutdown(0),
		onApprovalRespond: respondApproval,
		onApiKeyLogin: saveApiKey,
		onModelSelect: async (model) => {
			const thinking = model.thinkingLevel ? ` --thinking-effort ${model.thinkingLevel}` : "";
			await runCommand(`/model ${model.id}${thinking}`);
		},
		onSessionSelect: selectSession,
		onSessionTreeLoad: loadSessionTree,
		onSettingsChange: saveSettings,
		onResourceLoad: loadResources,
		commands: slashCommands,
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
