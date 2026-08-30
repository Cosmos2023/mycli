import {
	isRuntimeErrorCode,
	runtimeErrorNoticeSeverity,
	runtimeErrorRecoveryHint,
	sanitizeRuntimeErrorDetail,
	TURN_INTERRUPTED_NOTICE,
	turnCompletedDurationId,
	turnFailedNoticeId,
	turnFailureNotice,
	turnInterruptedNoticeId,
} from "@mycli/contracts";
import type {
	MycliShellAuthProvider,
	MycliShellBackgroundProcess,
	MycliShellBackgroundTerminals,
	MycliShellBash,
	MycliShellCommandDiagnostic,
	MycliShellCommandResult,
	MycliShellClarificationResponse,
	MycliShellCredentialReadiness,
	MycliShellCredentialSource,
	MycliShellDiagnosticMetric,
	MycliShellDiagnosticSection,
	MycliShellFileChange,
	MycliShellFileChangeEntry,
	MycliShellMessage,
	MycliShellLocalImageAttachment,
	MycliShellModel,
	MycliShellPendingApproval,
	MycliShellPendingClarification,
	MycliShellPermissionProfile,
	MycliShellPermissionState,
	MycliShellResource,
	MycliShellPlanUpdate,
	MycliShellPlanStep,
	MycliShellSession,
	MycliShellSessionTree,
	MycliShellSessionTreeNode,
	MycliShellState,
	MycliShellSubagent,
	MycliShellTranscriptBlock,
	MycliShellTool,
	MycliShellToolStatus,
	MycliShellVisualSettings,
	MycliShellWebSearch,
} from "../model.ts";
import {
	commandResultFromGateway,
	commandResultFromTranscriptItem,
} from "./command-results.ts";
import { boundedUiText } from "../safe-ui-text.ts";

const SEMANTIC_TOOL_ROW_NAMES = new Set([
	"askuserquestion",
	"followuptask",
	"interruptagent",
	"killshell",
	"listagents",
	"sendmessage",
	"spawnagent",
	"toolsearch",
	"updateplan",
	"waitagent",
]);

type RuntimeTranscriptItem = {
	id: string;
	type: string;
	text: string;
	folded?: boolean;
	metadata?: Record<string, unknown>;
	call_id?: string;
	status?: string;
};

type RuntimeShellProcess = {
	shellId: string;
	callId?: string;
	commandPreview: string;
	description?: string;
	background: boolean;
	processState: string;
	transport?: string;
	tty?: boolean;
	yielded?: boolean;
	terminalState?: string;
	exitCode?: number;
	sequence: number;
	startedAt?: string;
	completedAt?: string;
	outputPreview: string;
	nextCursor: number;
	outputChars: number;
	omittedOutputChars: number;
	cleanupResult?: string;
	shellKind?: string;
	shellEdition?: string;
};

type RuntimeQueuedInputPreview = {
	message: string;
	hasImages: boolean;
	source?: string;
};

export type RuntimeLocalUserInput = {
	clientUserMessageId: string;
	message: string;
	attachments: MycliShellLocalImageAttachment[];
};

type RuntimeLiveStatus = {
	state: string;
	text: string;
	kind?: string;
	message?: string;
	durationMs?: number;
};

export type RuntimeShellState = {
	sessionId: string | null;
	sessionTitle: string | null;
	workspace: string;
	model: string;
	collaborationMode: "default" | "plan";
	provider: string;
	trust: { state?: string; workspace?: string };
	trustGateDismissed: boolean;
	status: Record<string, unknown>;
	models: MycliShellModel[] | null;
	transcript: RuntimeTranscriptItem[];
	transcriptNextBefore: string | null;
	turnRunning: boolean;
	activeTurnId: string | null;
	activeAssistantItemId: string | null;
	queuedInputs: string[];
	queueRevision: number;
	queuedPendingSteers: RuntimeQueuedInputPreview[];
	queuedRejectedSteers: RuntimeQueuedInputPreview[];
	queuedFollowUpInputs: RuntimeQueuedInputPreview[];
	localPendingSteers: RuntimeLocalUserInput[];
	localRejectedSteers: RuntimeLocalUserInput[];
	localFollowUps: RuntimeLocalUserInput[];
	localSubmittingMessages: RuntimeLocalUserInput[];
	hasPendingInput: boolean;
	queueActivity: { kind: string; steeringCount: number; followUpCount: number } | null;
	liveStatus: RuntimeLiveStatus | null;
	retryRestoreStatus: RuntimeLiveStatus | null;
	liveReasoning: { text: string; kind: string } | null;
	viewMode: "default" | "verbose" | "focus";
	statusbarMode: "off" | "compact" | "full";
	settings: MycliShellVisualSettings;
	pendingApproval: Record<string, unknown> | null;
	pendingClarification: Record<string, unknown> | null;
	taskProgress: { completed: number; total: number } | null;
	authProviders: MycliShellAuthProvider[];
	authReadiness: MycliShellCredentialReadiness | null;
	resources: MycliShellResource[];
	permissions: MycliShellPermissionState | null;
	backgroundShells: Record<string, RuntimeShellProcess>;
	backgroundShellCount: number;
	shellEventSequences: Record<string, number>;
};

export function initialRuntimeState(): RuntimeShellState {
	return {
		sessionId: null,
		sessionTitle: null,
		workspace: process.cwd(),
		model: "",
		collaborationMode: "default",
		provider: "",
		trust: { state: "unknown", workspace: process.cwd() },
		trustGateDismissed: false,
		status: {},
		models: null,
		transcript: [],
		transcriptNextBefore: null,
		turnRunning: false,
		activeTurnId: null,
		activeAssistantItemId: null,
		queuedInputs: [],
		queueRevision: 0,
		queuedPendingSteers: [],
		queuedRejectedSteers: [],
		queuedFollowUpInputs: [],
		localPendingSteers: [],
		localRejectedSteers: [],
		localFollowUps: [],
		localSubmittingMessages: [],
		hasPendingInput: false,
		queueActivity: null,
		liveStatus: null,
		retryRestoreStatus: null,
		liveReasoning: null,
		viewMode: "default",
		statusbarMode: "full",
		settings: defaultVisualSettings(),
		pendingApproval: null,
		pendingClarification: null,
		taskProgress: null,
		authProviders: [],
		authReadiness: null,
		resources: [],
		permissions: null,
		backgroundShells: {},
		backgroundShellCount: 0,
		shellEventSequences: {},
	};
}

type RuntimeTranscriptProjection = {
	messages: MycliShellMessage[];
	tools: MycliShellTool[];
	bash: MycliShellBash[];
	transcript: MycliShellTranscriptBlock[];
};

type RuntimeProjectionCounts = {
	messages: number;
	tools: number;
	bash: number;
	transcript: number;
};

type RuntimeTranscriptProjectionCache = {
	projection: RuntimeTranscriptProjection;
	sourceTranscript: RuntimeTranscriptItem[];
	sourceLength: number;
	penultimateSourceItem?: RuntimeTranscriptItem;
	lastSourceItem?: RuntimeTranscriptItem;
	lastSourcePrefix: RuntimeProjectionCounts;
	activeAssistantItemId: string | null;
	activeAssistantSourceIndex: number | null;
	activeAssistantPrefix: RuntimeProjectionCounts | null;
	liveReasoningText?: string;
	liveReasoningKind?: string;
	workspace: string;
	turnRunning: boolean;
	toolDetailsDefault: MycliShellVisualSettings["toolDetailsDefault"];
};

export type RuntimeTranscriptUpdateKind = "unchanged" | "tail" | "replace";

/** Retains runtime-to-shell transcript work across gateway state projections. */
export class RuntimeStateProjector {
	private cache: RuntimeTranscriptProjectionCache | null = null;

	project(
		state: RuntimeShellState,
		sessions: MycliShellSession[] = [],
		transcriptUpdate: RuntimeTranscriptUpdateKind = "replace",
	): MycliShellState {
		let projection: RuntimeTranscriptProjection | null = null;
		let activeAssistantSourceIndex: number | null | undefined;
		if (this.cache && projectionContextMatches(this.cache, state)) {
			if (transcriptUpdate === "unchanged" && unchangedProjectionSource(this.cache, state)) {
				projection = this.cache.projection;
			} else if (transcriptUpdate === "tail") {
				const tail = projectRuntimeTranscriptTail(state, this.cache);
				projection = tail?.projection ?? null;
				activeAssistantSourceIndex = tail?.activeAssistantSourceIndex;
			}
		}

		if (!projection) {
			projection = projectRuntimeTranscriptRange(state, 0);
		}
		if (projection !== this.cache?.projection) {
			this.cache = runtimeTranscriptProjectionCache(
				state,
				projection,
				activeAssistantSourceIndex,
			);
		}
		return projectRuntimeShellState(state, sessions, projection);
	}
}

function unchangedProjectionSource(
	cache: RuntimeTranscriptProjectionCache,
	state: RuntimeShellState,
): boolean {
	return cache.sourceTranscript === state.transcript &&
		cache.activeAssistantItemId === state.activeAssistantItemId &&
		cache.liveReasoningText === state.liveReasoning?.text &&
		cache.liveReasoningKind === state.liveReasoning?.kind;
}

function projectionContextMatches(
	cache: RuntimeTranscriptProjectionCache,
	state: RuntimeShellState,
): boolean {
	return cache.workspace === state.workspace &&
		cache.turnRunning === state.turnRunning &&
		cache.toolDetailsDefault === state.settings.toolDetailsDefault;
}

function projectRuntimeTranscriptTail(
	state: RuntimeShellState,
	cache: RuntimeTranscriptProjectionCache,
): { projection: RuntimeTranscriptProjection; activeAssistantSourceIndex?: number | null } | null {
	const source = state.transcript;
	if (source.length < cache.sourceLength) return null;
	if (
		cache.sourceLength > 0 &&
		source.length > cache.sourceLength &&
		source[cache.sourceLength - 1] !== cache.lastSourceItem
	) {
		return null;
	}
	if (
		source.length === cache.sourceLength &&
		source.length > 1 &&
		source[source.length - 2] !== cache.penultimateSourceItem
	) {
		return null;
	}

	let sourceStart = source.length > cache.sourceLength
		? cache.sourceLength
		: source.length;
	let prefix = projectionCounts(cache.projection);
	if (
		source.length === cache.sourceLength &&
		source.length > 0 &&
		source[source.length - 1] !== cache.lastSourceItem
	) {
		sourceStart = source.length - 1;
		prefix = cache.lastSourcePrefix;
	}

	const reasoningChanged =
		cache.liveReasoningText !== state.liveReasoning?.text ||
		cache.liveReasoningKind !== state.liveReasoning?.kind;
	const activeAssistantChanged = cache.activeAssistantItemId !== state.activeAssistantItemId;
	if (reasoningChanged || activeAssistantChanged) {
		if (
			activeAssistantChanged ||
			cache.activeAssistantSourceIndex === null ||
			cache.activeAssistantPrefix === null
		) {
			return null;
		}
		if (cache.activeAssistantSourceIndex < sourceStart) {
			sourceStart = cache.activeAssistantSourceIndex;
			prefix = cache.activeAssistantPrefix;
		}
	}

	if (sourceStart === source.length) {
		return { projection: cache.projection, activeAssistantSourceIndex: cache.activeAssistantSourceIndex };
	}
	const suffix = projectRuntimeTranscriptRange(state, sourceStart);
	return {
		projection: combineRuntimeTranscriptProjection(cache.projection, prefix, suffix),
		activeAssistantSourceIndex: cache.activeAssistantSourceIndex,
	};
}

function combineRuntimeTranscriptProjection(
	previous: RuntimeTranscriptProjection,
	prefix: RuntimeProjectionCounts,
	suffix: RuntimeTranscriptProjection,
): RuntimeTranscriptProjection {
	return {
		messages: combineRuntimeProjectionArray(previous.messages, prefix.messages, suffix.messages),
		tools: combineRuntimeProjectionArray(previous.tools, prefix.tools, suffix.tools),
		bash: combineRuntimeProjectionArray(previous.bash, prefix.bash, suffix.bash),
		transcript: combineRuntimeProjectionArray(previous.transcript, prefix.transcript, suffix.transcript),
	};
}

function combineRuntimeProjectionArray<T>(previous: T[], prefixLength: number, suffix: T[]): T[] {
	if (prefixLength === previous.length && suffix.length === 0) return previous;
	if (prefixLength === previous.length - 1 && suffix.length === 1) {
		return previous.with(-1, suffix[0]!);
	}
	if (prefixLength === previous.length) return previous.concat(suffix);
	return [...previous.slice(0, prefixLength), ...suffix];
}

function runtimeTranscriptProjectionCache(
	state: RuntimeShellState,
	projection: RuntimeTranscriptProjection,
	activeAssistantSourceIndexHint?: number | null,
): RuntimeTranscriptProjectionCache {
	const source = state.transcript;
	const total = projectionCounts(projection);
	const lastSourceSuffix = source.length > 0
		? projectRuntimeTranscriptRange(state, source.length - 1)
		: emptyRuntimeTranscriptProjection();
	const lastSourcePrefix = subtractProjectionCounts(total, projectionCounts(lastSourceSuffix));
	const activeAssistantSourceIndex = resolveActiveAssistantSourceIndex(
		state,
		activeAssistantSourceIndexHint,
	);
	const activeAssistantSuffix = activeAssistantSourceIndex === null
		? null
		: activeAssistantSourceIndex === source.length - 1
			? lastSourceSuffix
			: projectRuntimeTranscriptRange(state, activeAssistantSourceIndex);
	return {
		projection,
		sourceTranscript: source,
		sourceLength: source.length,
		penultimateSourceItem: source.length >= 2 ? source[source.length - 2] : undefined,
		lastSourceItem: source.at(-1),
		lastSourcePrefix,
		activeAssistantItemId: state.activeAssistantItemId,
		activeAssistantSourceIndex,
		activeAssistantPrefix: activeAssistantSuffix
			? subtractProjectionCounts(total, projectionCounts(activeAssistantSuffix))
			: null,
		liveReasoningText: state.liveReasoning?.text,
		liveReasoningKind: state.liveReasoning?.kind,
		workspace: state.workspace,
		turnRunning: state.turnRunning,
		toolDetailsDefault: state.settings.toolDetailsDefault,
	};
}

function resolveActiveAssistantSourceIndex(
	state: RuntimeShellState,
	hint?: number | null,
): number | null {
	const activeId = state.activeAssistantItemId;
	if (!activeId) return null;
	if (hint !== undefined && hint !== null && state.transcript[hint]?.id === activeId) return hint;
	const index = state.transcript.findLastIndex((item) => item.id === activeId);
	return index >= 0 ? index : null;
}

function projectRuntimeTranscriptRange(
	state: RuntimeShellState,
	sourceStart: number,
): RuntimeTranscriptProjection {
	const shell = projectRuntimeShellState(state, [], undefined, sourceStart);
	return {
		messages: shell.messages,
		tools: shell.tools,
		bash: shell.bash,
		transcript: shell.transcript ?? [],
	};
}

function emptyRuntimeTranscriptProjection(): RuntimeTranscriptProjection {
	return { messages: [], tools: [], bash: [], transcript: [] };
}

function projectionCounts(projection: RuntimeTranscriptProjection): RuntimeProjectionCounts {
	return {
		messages: projection.messages.length,
		tools: projection.tools.length,
		bash: projection.bash.length,
		transcript: projection.transcript.length,
	};
}

function subtractProjectionCounts(
	total: RuntimeProjectionCounts,
	suffix: RuntimeProjectionCounts,
): RuntimeProjectionCounts {
	return {
		messages: total.messages - suffix.messages,
		tools: total.tools - suffix.tools,
		bash: total.bash - suffix.bash,
		transcript: total.transcript - suffix.transcript,
	};
}

export function projectRuntimeState(state: RuntimeShellState, sessions: MycliShellSession[] = []): MycliShellState {
	return projectRuntimeShellState(state, sessions);
}

function projectRuntimeShellState(
	state: RuntimeShellState,
	sessions: MycliShellSession[] = [],
	projectedTranscript?: RuntimeTranscriptProjection,
	sourceStart = 0,
): MycliShellState {
	const messages: MycliShellMessage[] = projectedTranscript?.messages ?? [];
	const tools: MycliShellTool[] = projectedTranscript?.tools ?? [];
	const bash: MycliShellBash[] = projectedTranscript?.bash ?? [];
	const transcript: MycliShellTranscriptBlock[] = projectedTranscript?.transcript ?? [];
	const pendingSteers = state.localPendingSteers.map((item) => ({
		text: item.message,
		hasImages: item.attachments.length > 0,
	})).concat(state.queuedPendingSteers.map((item) => ({
		text: item.message,
		hasImages: item.hasImages,
	})));
	const rejectedSteers = state.localRejectedSteers.map((item) => ({
		text: item.message,
		hasImages: item.attachments.length > 0,
	})).concat(state.queuedRejectedSteers.map((item) => ({
		text: item.message,
		hasImages: item.hasImages,
	})));
	const followUps = state.localFollowUps.map((item) => ({
		text: item.message,
		hasImages: item.attachments.length > 0,
	})).concat(state.queuedFollowUpInputs.map((item) => ({
		text: item.message,
		hasImages: item.hasImages,
	})));

	for (
		let transcriptIndex = projectedTranscript ? state.transcript.length : sourceStart;
		transcriptIndex < state.transcript.length;
		transcriptIndex += 1
	) {
		const item = state.transcript[transcriptIndex]!;
		if (isInternalTaskNotification(item.text)) {
			continue;
		}
		if (
			state.turnRunning &&
			booleanValue(recordValue(item.metadata).deferred_until_turn_complete) === true
		) {
			continue;
		}
		if (item.type === "user") {
			const message: MycliShellMessage = { id: item.id, role: "user", text: item.text };
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "assistant_stream" || item.type === "assistant_final") {
			const thinking = reasoningForAssistant(item, transcriptIndex, state);
			const message: MycliShellMessage = {
				id: item.id,
				role: "assistant",
				text: item.text,
				...(thinking ? { thinking, thinkingHidden: true } : {}),
			};
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "turn_completed") {
			const durationMs = turnDurationMsValue(recordValue(item.metadata).duration_ms);
			if (durationMs !== undefined) {
				transcript.push({
					id: item.id,
					kind: "turn_completed",
					turnCompleted: { id: item.id, durationMs },
				});
			}
		} else if (item.type === "web_search") {
			const webSearch = webSearchFromTranscriptItem(item);
			if (webSearch) {
				transcript.push({ id: item.id, kind: "web_search", webSearch });
			}
		} else if (item.type === "warning") {
			const message: MycliShellMessage = {
				id: item.id,
				role: "warning",
				text: item.text,
				...noticeDiagnostic(item.metadata),
			};
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "error") {
			const code = stringValue(recordValue(item.metadata).code);
			const message: MycliShellMessage = {
				id: item.id,
				role: code && isRuntimeErrorCode(code)
					? runtimeErrorNoticeSeverity(code)
					: "error",
				text: item.text,
				...noticeDiagnostic(item.metadata),
			};
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "clarification") {
			const clarification = clarificationResponseFromTranscriptItem(item);
			if (clarification) {
				transcript.push({ id: item.id, kind: "clarification", clarification });
			} else {
				const message: MycliShellMessage = { id: item.id, role: "system", text: item.text };
				messages.push(message);
				transcript.push({ id: item.id, kind: "message", message });
			}
		} else if (item.type === "system_notice" || item.type === "command_output" || item.type === "approval") {
			const message: MycliShellMessage = { id: item.id, role: "system", text: item.text };
			messages.push(message);
			transcript.push({ id: item.id, kind: "message", message });
		} else if (item.type === "command_result") {
			const commandResult = commandResultFromTranscriptItem(item);
			if (commandResult) {
				transcript.push({ id: item.id, kind: "command_result", commandResult });
			}
		} else if (item.type === "proposed_plan") {
			transcript.push({
				id: item.id,
				kind: "plan",
				plan: {
					id: item.id,
					text: item.text,
					status: planStatus(item.metadata),
				},
			});
		} else if (item.type === "plan_update") {
			const planUpdate = planUpdateFromTranscriptItem(item);
			if (planUpdate) {
				transcript.push({ id: item.id, kind: "plan_update", planUpdate });
			}
		} else if (item.type === "tool_summary" || item.type === "tool_detail") {
			const fileChange = fileChangeFromTranscriptItem(item);
			if (fileChange) {
				transcript.push({
					id: item.id,
					kind: "file_change",
					fileChange,
					message: {
						id: item.id,
						role: fileChange.status === "error" ? "error" : "system",
						text: fileChangeFallbackText(fileChange),
					},
				});
				continue;
			}
			const tool = toolFromTranscriptItem(item, state.workspace, state.settings.toolDetailsDefault);
			if (suppressGenericToolRow(tool)) {
				continue;
			}
			if (isShellTool(tool.name)) {
				const metadata = recordValue(item.metadata);
				const display = toolDisplayFromMetadata(metadata);
				const displayMetrics = display?.metrics ?? {};
				const bashItem: MycliShellBash = {
					id: tool.id,
					toolName: tool.name,
					command: stringValue(metadata.command_preview) ?? tool.args ?? tool.name,
					description: stringValue(metadata.description)?.trim() || undefined,
					status: tool.status,
					shellId: stringValue(metadata.shell_id) ?? stringValue(displayMetrics.shell_id) ?? undefined,
					callId: stringValue(metadata.call_id) ?? undefined,
					background: booleanValue(metadata.background) ?? undefined,
					processState: stringValue(metadata.process_state) ?? undefined,
					transport: stringValue(metadata.transport) ?? undefined,
					tty: booleanValue(metadata.tty) ?? undefined,
					yielded: booleanValue(metadata.yielded) ?? undefined,
					terminalState: stringValue(metadata.terminal_state) ?? undefined,
					exitCode: numberValue(metadata.exit_code) ?? numberValue(displayMetrics.exit_code) ?? undefined,
					sequence: numberValue(metadata.shell_sequence) ?? undefined,
					startedAt: stringValue(metadata.started_at) ?? undefined,
					completedAt: stringValue(metadata.completed_at) ?? undefined,
					outputChars: numberValue(metadata.output_chars) ?? undefined,
					omittedOutputChars:
						numberValue(metadata.omitted_output_chars) ??
						(display?.truncated ? display.omittedChars : undefined),
					cleanupResult: stringValue(metadata.cleanup_result) ?? undefined,
					shellKind: stringValue(metadata.shell_kind) ?? undefined,
					shellEdition: stringValue(metadata.shell_edition) ?? undefined,
					outputPreview: tool.detailPreview ?? tool.outputPreview,
					hiddenLineCount: tool.hiddenLineCount ?? (display?.truncated ? 1 : undefined),
					expanded: tool.expanded,
				};
				bash.push(bashItem);
				transcript.push({ id: item.id, kind: "bash", bash: bashItem });
			} else {
				tools.push(tool);
				transcript.push({ id: item.id, kind: "tool", tool });
			}
		} else if (item.type === "subagent") {
			const subagent = subagentFromTranscriptItem(item);
			if (subagent) {
				transcript.push({ id: item.id, kind: "subagent", subagent });
			}
		} else if (item.type === "command_diagnostic") {
			const diagnostic = diagnosticFromTranscriptItem(item);
			if (diagnostic) {
				transcript.push({ id: item.id, kind: "diagnostic", diagnostic });
			}
		} else if (item.type === "background_terminals") {
			const backgroundTerminals = backgroundTerminalsFromTranscriptItem(item);
			if (backgroundTerminals) {
				transcript.push({ id: item.id, kind: "background_terminals", backgroundTerminals });
			}
		}
	}

	return {
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
		title: "mycli",
		messages,
		tools,
		bash,
		transcript,
		transcriptNextBefore: state.transcriptNextBefore,
		pendingInput:
			pendingSteers.length > 0 || rejectedSteers.length > 0 || followUps.length > 0
				? { pendingSteers, rejectedSteers, followUps }
				: undefined,
		footer: {
			cwd: state.workspace || process.cwd(),
			sessionName: state.sessionTitle ?? state.sessionId ?? undefined,
			provider: state.provider || undefined,
			model: state.model || undefined,
			reasoningLevel: reasoningLevelFromStatus(state.status),
			...usageFooterData(state.status),
			queueCount: queuedInputCount(state),
			steeringQueueCount: pendingSteers.length,
			followUpQueueCount: rejectedSteers.length + followUps.length,
			hasPendingInput: queuedInputCount(state) > 0,
			queueActivity: state.queueActivity?.kind ?? (queuedInputCount(state) > 0 ? "pending_input" : "idle"),
			trust: state.trust.state ?? "unknown",
			collaborationMode: state.collaborationMode,
			liveState: footerLiveState(state),
			liveStateKind: state.liveStatus?.kind ?? state.liveStatus?.state,
			liveStateDetail: state.liveStatus?.message,
			turnDurationMs: state.liveStatus?.durationMs,
			turnRunning: state.turnRunning,
			backgroundShellCount: state.backgroundShellCount,
			taskProgress: state.taskProgress ?? undefined,
			autoCompact: true,
		},
		pendingNotice: pendingNotice(state),
		pendingApproval: pendingApprovalFromRecord(state.pendingApproval),
		pendingClarification: pendingClarificationFromRecord(state.pendingClarification),
		models: state.models
			?? (state.model
				? [currentModel(state.provider, state.model, reasoningLevelFromStatus(state.status))]
				: []),
		authProviders: state.authProviders,
		authReadiness: state.authReadiness ?? undefined,
		currentModel: currentModel(state.provider, state.model, reasoningLevelFromStatus(state.status)),
		settings: {
			...state.settings,
			viewMode: state.viewMode,
			statusbarMode: state.statusbarMode,
		},
		sessions,
		resources: state.resources,
		permissions: state.permissions ?? undefined,
	};
}

export function runtimeStateWithSettings(state: RuntimeShellState, settings: MycliShellVisualSettings): RuntimeShellState {
	const nextSettings = normalizeVisualSettings(settings, state.settings);
	return {
		...state,
		settings: nextSettings,
		viewMode: nextSettings.viewMode ?? state.viewMode,
		statusbarMode: nextSettings.statusbarMode ?? state.statusbarMode,
	};
}

export function settingsFromResult(payload: Record<string, unknown>): MycliShellVisualSettings {
	const settings = recordValue(payload.settings);
	return normalizeVisualSettings(Object.keys(settings).length > 0 ? settings : payload);
}

export function resourcesFromResult(payload: Record<string, unknown>): MycliShellResource[] {
	const resources = Array.isArray(payload.resources) ? payload.resources : [];
	return resources.map(resourceFromUnknown).filter((resource): resource is MycliShellResource => resource !== null);
}

function footerLiveState(state: RuntimeShellState): string {
	if (state.turnRunning) {
		return state.liveStatus?.text ?? "Running";
	}
	if (state.pendingApproval) {
		return "Waiting approval";
	}
	if (state.pendingClarification) {
		return "Waiting clarification";
	}
	const liveStatusKind = state.liveStatus?.kind ?? state.liveStatus?.state;
	if (liveStatusKind === "failed") {
		return "Idle";
	}
	if (liveStatusKind === "completed") {
		return "Completed";
	}
	if (state.collaborationMode === "plan") {
		return "Plan";
	}
	return "Idle";
}

export function runtimeStateFromBootstrap(state: RuntimeShellState, payload: Record<string, unknown>): RuntimeShellState {
	const status = recordValue(payload.status);
	const migration = recordValue(payload.legacy_user_queue_migration);
	const hasLegacyMigration = Array.isArray(migration.records) && migration.records.length > 0;
	const trust = trustFromPayload(payload.trust ?? status.trust, String(payload.workspace ?? state.workspace));
	const welcome = recordValue(payload.welcome);
	const startupMark = recordValue(welcome.startup_mark);
	const welcomeText = welcome
		? `${String(startupMark.text ?? "mycli")}\n${String(welcome.workspace ?? payload.workspace ?? "")}`.trim()
		: "mycli";
	const provider = stringValue(payload.provider) ?? state.provider;
	const model = stringValue(payload.model) ?? state.model;
	const models = modelCatalogFromPayload(payload)
		?? modelCatalogFromPayload(status)
		?? state.models;
	const bootstrapState = {
		...state,
		sessionId: stringValue(payload.session_id) ?? state.sessionId,
		sessionTitle: stringValue(payload.session_title) ?? state.sessionTitle,
		workspace: stringValue(payload.workspace) ?? state.workspace,
		model,
		collaborationMode: collaborationModeValue(payload.collaboration_mode) ?? collaborationModeValue(status.collaboration_mode) ?? state.collaborationMode,
		provider,
		models,
		authProviders: authProvidersFromUnknown(payload.auth_providers),
		authReadiness: credentialReadinessFromUnknown(payload.auth_status) ?? state.authReadiness,
		permissions: permissionStateFromUnknown(payload.permissions ?? status.permissions) ?? state.permissions,
		status,
		trust,
		trustGateDismissed: trust.state === "trusted",
		activeTurnId: stringValue(status.turn_id),
		transcript: [
			...state.transcript,
			{ id: "welcome", type: "system_notice", text: welcomeText, folded: false, metadata: welcome },
		],
	};
	const nextState = hasLegacyMigration
		? runtimeStateWithMessageQueues(bootstrapState, {
			pendingSteers: [],
			rejectedSteers: [],
			followUps: [],
		})
		: applyQueuePayload(bootstrapState, status, "status");
	return applyShellBootstrap(
		runtimeStateWithLegacyQueueMigration(nextState, payload),
		Array.isArray(payload.background_shells) ? payload.background_shells : status.background_shells,
	);
}

export function legacyQueueMigrationToken(payload: Record<string, unknown>): string | null {
	return stringValue(recordValue(payload.legacy_user_queue_migration).token);
}

export function runtimeStateWithLegacyQueueMigration(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	const migration = recordValue(payload.legacy_user_queue_migration);
	const migrated = applyLegacyQueueMigration(
		state,
		migration,
	);
	return Array.isArray(migration.records) && migration.records.length > 0
		? runtimeStateWithMessageQueues(migrated, {
			pendingSteers: [],
			rejectedSteers: [],
			followUps: [],
		})
		: migrated;
}

export function runtimeStateAfterSessionResume(
	state: RuntimeShellState,
	sessionId: string,
	sessionTitle: string,
	payload: Record<string, unknown>,
): RuntimeShellState {
	const eventStatus = stringValue(state.status.session_id) === sessionId
		? state.status
		: {};
	let nextState: RuntimeShellState = {
		...reduceRuntimeEvent(state, "session.changed", {
			session_id: sessionId,
			session_title: sessionTitle,
		}),
		transcript: [],
	};
	if (Object.keys(eventStatus).length > 0) {
		nextState = reduceRuntimeEvent(nextState, "status.changed", eventStatus);
	}
	const backgroundShells = Array.isArray(payload.background_shells)
		? payload.background_shells
		: eventStatus.background_shells;
	nextState = applyShellBootstrap(nextState, backgroundShells);
	nextState = runtimeStateWithCredentialReadiness(nextState, payload);
	const authProviders = authProvidersFromUnknown(payload.auth_providers);
	if (authProviders.length > 0) nextState = { ...nextState, authProviders };
	return runtimeStateWithLegacyQueueMigration(nextState, payload);
}

export function runtimeStateFromTranscript(state: RuntimeShellState, payload: Record<string, unknown>): RuntimeShellState {
	return runtimeStateFromTranscriptPage(state, payload, "merge");
}

export function runtimeStateFromOlderTranscriptPage(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	return runtimeStateFromTranscriptPage(state, payload, "prepend");
}

function runtimeStateFromTranscriptPage(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
	mode: "merge" | "prepend",
): RuntimeShellState {
	const rawItems = Array.isArray(payload.items)
		? payload.items
				.filter(isTranscriptItem)
				.map((item) => ({ ...item, metadata: recordValue(item.metadata) }))
		: [];
	const items = rawItems.flatMap((item) => {
		if (item.type === "command_result") return [];
		if (item.type !== "plan_update") return [item];
		const normalized = planUpdateFromPayload(recordValue(item.metadata), item.id, item.text);
		return normalized ? [normalized] : [];
	});
	const resumedItems = items.map((item) =>
		isToolTranscriptItem(item)
			? { ...item, folded: true }
			: item,
	);
	const transcript = coalesceResumedShellOutputItems(
		coalesceLegacyToolItems(mergeTranscriptItemsById(
			mode === "prepend" ? resumedItems : state.transcript,
			mode === "prepend" ? state.transcript : resumedItems,
		)),
	);
	const latestPlanUpdate = [...transcript].reverse().find((item) => item.type === "plan_update");
	return {
		...state,
		transcript,
		transcriptNextBefore: typeof payload.next_before === "string"
			? payload.next_before
			: null,
		taskProgress: latestPlanUpdate ? taskProgressFromPlanUpdate(latestPlanUpdate) : state.taskProgress,
	};
}

function mergeTranscriptItemsById(
	existing: RuntimeTranscriptItem[],
	incoming: RuntimeTranscriptItem[],
): RuntimeTranscriptItem[] {
	const merged: RuntimeTranscriptItem[] = [];
	const indexes = new Map<string, number>();
	for (const item of [...existing, ...incoming]) {
		const index = indexes.get(item.id);
		if (index === undefined) {
			indexes.set(item.id, merged.length);
			merged.push(item);
		} else {
			merged[index] = item;
		}
	}
	return merged;
}

function coalesceResumedShellOutputItems(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	let coalesced: RuntimeTranscriptItem[] = [];
	for (const item of items) {
		const metadata = recordValue(item.metadata);
		const display = recordValue(metadata.display);
		const failed =
			booleanValue(metadata.success) === false ||
			["error", "failed", "cancelled"].includes(stringValue(display.status) ?? stringValue(metadata.status) ?? "");
		if (isShellOutputLifecycle(metadata) && !failed) {
			const merged = mergeShellOutputIntoExecution(coalesced, metadata);
			if (merged !== null) {
				coalesced = merged;
			}
			continue;
		}
		coalesced.push(item);
	}
	return coalesced;
}

function coalesceLegacyToolItems(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	const coalesced: RuntimeTranscriptItem[] = [];
	const pendingByCallId = new Map<string, number>();

	for (const item of items) {
		const callId = toolItemCallId(item);
		const existingIndex = callId ? pendingByCallId.get(callId) : undefined;
		const existing = existingIndex === undefined ? undefined : coalesced[existingIndex];
		if (existing && isToolSummaryDetailPair(existing, item)) {
			coalesced[existingIndex!] = mergeToolSummaryDetail(existing, item);
			pendingByCallId.delete(callId!);
			continue;
		}

		const index = coalesced.push(item) - 1;
		if (callId && isToolTranscriptItem(item)) {
			pendingByCallId.set(callId, index);
		}
	}

	return coalesced;
}

function toolItemCallId(item: RuntimeTranscriptItem): string | null {
	if (!isToolTranscriptItem(item)) return null;
	const metadata = recordValue(item.metadata);
	return stringValue(metadata.call_id) ?? stringValue(metadata.callId);
}

function isToolTranscriptItem(item: RuntimeTranscriptItem): boolean {
	return item.type === "tool_summary" || item.type === "tool_detail";
}

function isToolSummaryDetailPair(first: RuntimeTranscriptItem, second: RuntimeTranscriptItem): boolean {
	return (first.type === "tool_summary" && second.type === "tool_detail")
		|| (first.type === "tool_detail" && second.type === "tool_summary");
}

function mergeToolSummaryDetail(first: RuntimeTranscriptItem, second: RuntimeTranscriptItem): RuntimeTranscriptItem {
	const summary = first.type === "tool_summary" ? first : second;
	const detail = first.type === "tool_detail" ? first : second;
	const summaryMetadata = recordValue(summary.metadata);
	const detailMetadata = recordValue(detail.metadata);
	const outputPreview = textValue(detailMetadata.output_preview) ?? textValue(detail.text);
	return {
		...summary,
		metadata: {
			...summaryMetadata,
			...detailMetadata,
			status: stringValue(detailMetadata.status) ?? "done",
			...(outputPreview ? { output_preview: outputPreview } : {}),
		},
	};
}

export function reduceRuntimeEvent(
	state: RuntimeShellState,
	method: string,
	input: object,
): RuntimeShellState {
	const params = Object.fromEntries(Object.entries(input));
	if (method === "runtime.event") {
		const type = stringValue(params.type);
		const payload = recordValue(params.payload);
		return type ? reduceRuntimeEvent(state, type, payload) : state;
	}
	if (method.startsWith("shell.")) {
		return applyShellLifecycle(state, method, params);
	}
	if (method === "turn.started") {
		const preserveApproval = pendingRequestBelongsToDifferentTurn(state.pendingApproval, params);
		const preserveClarification = pendingRequestBelongsToDifferentTurn(
			state.pendingClarification,
			params,
		);
		return {
			...state,
			turnRunning: true,
			activeTurnId: stringValue(params.turn_id) ?? state.activeTurnId,
			activeAssistantItemId: nextId("assistant"),
			liveStatus: { state: "running", kind: "running", text: "Running" },
			retryRestoreStatus: null,
			pendingApproval: preserveApproval ? state.pendingApproval : null,
			pendingClarification: preserveClarification ? state.pendingClarification : null,
			transcript: preserveApproval || preserveClarification
				? state.transcript
				: removeTransientClarificationItems(removeTransientApprovalItems(state.transcript)),
		};
	}
	if (method === "item.started") {
		const item = recordValue(params.item);
		if (stringValue(item.type) === "web_search") {
			const itemId = stringValue(item.id);
			const callId = stringValue(item.call_id);
			if (!itemId || !callId) return state;
			const transcript = sealActiveAssistantStream(
				state.transcript,
				state.activeAssistantItemId,
			);
			return {
				...state,
				activeAssistantItemId: null,
				liveStatus: { state: "running", kind: "running", text: "Running" },
				transcript: upsertTranscriptItem(transcript, {
					id: itemId,
					type: "web_search",
					text: "",
					folded: false,
					call_id: callId,
					status: "running",
					metadata: { call_id: callId, status: "running", transient: true },
				}),
			};
		}
		if (stringValue(item.type) !== "file_change") return state;
		const itemId = stringValue(item.id);
		const callId = stringValue(item.call_id);
		const toolName = stringValue(item.name);
		const preview = stringValue(item.preview);
		if (!itemId || !callId || !toolName || !preview) return state;
		const target = fileMutationTargetPreview(preview, toolName);
		const contentLineCount = numberValue(item.content_line_count);
		const contentChars = numberValue(item.content_chars);
		const contentTruncated = booleanValue(item.content_truncated);
		const diffChars = numberValue(item.diff_chars);
		const diffTruncated = booleanValue(item.diff_truncated);
		const fileChanges = fileChangeEntriesFromUnknown(item.file_changes);
		const transcript = sealActiveAssistantStream(
			state.transcript,
			state.activeAssistantItemId,
		);
		return {
			...state,
			activeAssistantItemId: null,
			transcript: applyToolLifecycle(transcript, "file_mutation.started", {
				client_turn_id: params.client_turn_id,
				tool_id: itemId,
				call_id: callId,
				name: toolName,
				path: target,
				context: preview,
				args_preview: target,
				file_mutation_proposal: true,
				...(typeof item.content_preview === "string"
					? { content_preview: item.content_preview }
					: {}),
				...(contentLineCount === null
					? {}
					: { content_line_count: contentLineCount }),
				...(contentChars === null
					? {}
					: { content_chars: contentChars }),
				...(contentTruncated === null
					? {}
					: { content_truncated: contentTruncated }),
				...(typeof item.diff === "string" ? { diff: item.diff } : {}),
				...(diffChars === null
					? {}
					: { diff_chars: diffChars }),
				...(diffTruncated === null
					? {}
					: { diff_truncated: diffTruncated }),
				...(fileChanges.length > 0 ? { file_changes: fileChanges } : {}),
			}),
		};
	}
	if (method === "item.completed") {
		const item = recordValue(params.item);
		const itemId = stringValue(item.id);
		const itemType = stringValue(item.type);
		if (itemType === "web_search") {
			const callId = stringValue(item.call_id);
			if (!itemId || !callId) return state;
			const action = webSearchActionMetadata(item.action);
			return {
				...state,
				liveStatus: { state: "running", kind: "running", text: "Running" },
				transcript: upsertTranscriptItem(state.transcript, {
					id: itemId,
					type: "web_search",
					text: textValue(item.detail) ?? webSearchDetail(action),
					folded: false,
					call_id: callId,
					status: "completed",
					metadata: {
						call_id: callId,
						status: "completed",
						transient: true,
						...action,
					},
				}),
			};
		}
		const clientUserMessageId = stringValue(item.client_user_message_id);
		const content = textValue(item.content);
		if (
			itemType !== "user_message" ||
			!itemId ||
			!clientUserMessageId ||
			!content?.trim() ||
			isInternalTaskNotification(content)
		) {
			return state;
		}
		const withoutIdentity = (inputs: RuntimeLocalUserInput[]) =>
			inputs.filter((input) => input.clientUserMessageId !== clientUserMessageId);
		const transcript = state.transcript.some((entry) => entry.id === itemId)
			? state.transcript
			: [
				...sealActiveAssistantStream(state.transcript, state.activeAssistantItemId),
				{
					id: itemId,
					type: "user",
					text: content,
					folded: false,
					metadata: item,
				},
			];
		return {
			...state,
			activeAssistantItemId: null,
			localPendingSteers: withoutIdentity(state.localPendingSteers),
			localRejectedSteers: withoutIdentity(state.localRejectedSteers),
			localFollowUps: withoutIdentity(state.localFollowUps),
			localSubmittingMessages: withoutIdentity(state.localSubmittingMessages),
			transcript,
		};
	}
	if (method === "message.delta") {
		const assistantId = state.activeAssistantItemId ?? nextId("assistant");
		return {
			...state,
			activeAssistantItemId: assistantId,
			transcript: applyAssistantDelta(state.transcript, assistantId, String(params.text ?? "")),
		};
	}
	if (method === "message.reset") {
		return rollbackActiveAssistantAttempt(state);
	}
	if (method === "stream.retrying") {
		const text = boundedUiText(params.text, "Reconnecting...", 256);
		const additionalDetails = sanitizeRuntimeErrorDetail(params.additional_details);
		const retryRestoreStatus =
			state.liveStatus?.kind === "reconnecting"
				? state.retryRestoreStatus
				: state.liveStatus;
		return {
			...state,
			turnRunning: true,
			liveStatus: {
				state: "running",
				kind: "reconnecting",
				text,
				...(additionalDetails
					? { message: additionalDetails }
					: {}),
			},
			retryRestoreStatus,
		};
	}
	if (method === "stream.recovered") {
		return {
			...state,
			liveStatus:
				state.retryRestoreStatus ??
				{ state: "running", kind: "running", text: "Running" },
			retryRestoreStatus: null,
		};
	}
	if (method === "message.complete") {
		const text = String(params.text ?? "");
		const assistantId = state.activeAssistantItemId;
		return {
			...state,
			turnRunning: state.turnRunning,
			activeAssistantItemId: params.final === true ? null : state.activeAssistantItemId,
			liveReasoning: null,
			transcript: commitCompletedWebSearchItems(
				params.final === true
					? reconcileFinalAnswer(state.transcript, assistantId, text)
					: state.transcript,
			),
		};
	}
	if (method === "turn.event" && params.kind === "queued_message_committed") {
		const metadata = recordValue(params.metadata);
		const text = textValue(params.text);
		const queueId = stringValue(metadata.queue_id);
		if (
			!text?.trim()
			|| metadata.source === "task_notification"
			|| isInternalTaskNotification(text)
			|| (queueId && state.transcript.some((item) => stringValue(recordValue(item.metadata).queue_id) === queueId))
		) {
			return state;
		}
		return {
			...state,
			transcript: [
				...state.transcript,
				{
					id: queueId ? `queued_user_${queueId}` : nextId("queued-user"),
					type: "user",
					text,
					folded: false,
					metadata,
				},
			],
		};
	}
	if (method === "plan.proposed") {
		const assistantId = state.activeAssistantItemId;
		return {
			...state,
			activeAssistantItemId: null,
			transcript: applyProposedPlan(sealActiveAssistantStream(state.transcript, assistantId), params),
		};
	}
	if (method === "plan.updated") {
		const item = planUpdateFromPayload(params, nextId("plan-update"));
		if (!item) return state;
		return {
			...state,
			activeAssistantItemId: null,
			transcript: [
				...sealActiveAssistantStream(state.transcript, state.activeAssistantItemId),
				item,
			],
			taskProgress: taskProgressFromPlanUpdate(item),
		};
	}
	if (method === "subagent.updated") {
		const subagent = recordValue(params.subagent);
		const item = transcriptItemFromSubagent(subagent);
		if (!item) {
			return state;
		}
		const childSessionId = stringValue(subagent.child_session_id)
			?? stringValue(subagent.childSessionId);
		const terminal = ["completed", "failed", "interrupted"].includes(
			stringValue(subagent.status) ?? "",
		);
		const clearApproval = terminal
			&& pendingRequestSessionId(state.pendingApproval) === childSessionId;
		const clearClarification = terminal
			&& pendingRequestSessionId(state.pendingClarification) === childSessionId;
		return {
			...state,
			pendingApproval: clearApproval ? null : state.pendingApproval,
			pendingClarification: clearClarification ? null : state.pendingClarification,
			transcript: upsertSubagentTranscriptItem(
				clearClarification
					? removeTransientClarificationItems(state.transcript)
					: clearApproval
						? removeTransientApprovalItems(state.transcript)
						: state.transcript,
				item,
			),
		};
	}
	if (method === "reasoning.delta" || method === "thinking.delta") {
		const text = reasoningText(params);
		const transcript =
			method === "thinking.delta" && state.liveReasoning?.text === text
				? state.transcript
				: applyReasoning(state.transcript, text, params);
		return {
			...state,
			turnRunning: true,
			liveReasoning: { kind: method === "thinking.delta" ? "thinking" : "reasoning", text },
			transcript,
		};
	}
	if (method === "tool.start" || method === "tool.progress" || method === "tool.complete" || method === "tool.failed") {
		const transcript =
			method === "tool.start" && state.activeAssistantItemId
				? sealAssistantStream(state.transcript, state.activeAssistantItemId)
				: state.transcript;
		const emptyShellPoll = method === "tool.start" && isEmptyWriteStdinPoll(params);
		const shellId = stringValue(params.session_id);
		const waitingCommand = shellId ? state.backgroundShells[shellId]?.commandPreview : undefined;
		const leavingBackgroundWait =
			(method === "tool.complete" || method === "tool.failed") &&
			state.liveStatus?.kind === "waiting_background_terminal";
		return {
			...state,
			activeAssistantItemId: method === "tool.start" ? null : state.activeAssistantItemId,
			liveStatus: emptyShellPoll
				? {
					state: "running",
					kind: "waiting_background_terminal",
					text: "Waiting for background terminal",
					...(waitingCommand ? { message: waitingCommand } : {}),
				}
				: leavingBackgroundWait
					? { state: "running", kind: "running", text: "Running" }
					: state.liveStatus,
			transcript: applyToolLifecycle(transcript, method, params),
		};
	}
	if (method === "compaction.started" || method === "compaction.completed") {
		return {
			...state,
			turnRunning: true,
			liveStatus:
				method === "compaction.started"
					? { state: "running", kind: "compaction", text: "Compressing context" }
					: { state: "running", kind: "running", text: "Running" },
			transcript: applyCompactionLifecycle(state.transcript, method, params),
		};
	}
	if (method === "turn.completed") {
		const turnState = stringValue(params.turn_state);
		const durationMs = turnDurationMsValue(params.duration_ms);
		const inputRolledBack = params.input_rolled_back === true;
		const finalizedSearches = finalizeTransientWebSearchItems(state.transcript);
		const terminalTranscript =
			inputRolledBack
				? rollbackOutputFreeUserTurn(finalizedSearches)
				: turnState === "interrupted"
					? finalizeInterruptedTools(appendInterruptedNotice(finalizedSearches, params))
					: finalizedSearches;
		const preserveApproval = pendingRequestBelongsToDifferentTurn(state.pendingApproval, params);
		const preserveClarification = pendingRequestBelongsToDifferentTurn(
			state.pendingClarification,
			params,
		);
		const completedTurnIdentity = stringValue(params.turn_id)
			?? state.activeTurnId
			?? stringValue(params.client_turn_id);
		const transcriptWithDuration = (turnState === null || turnState === "completed")
			&& durationMs !== undefined
			&& completedTurnIdentity
			? upsertTranscriptItem(terminalTranscript, {
				id: turnCompletedDurationId(completedTurnIdentity),
				type: "turn_completed",
				text: "",
				folded: false,
				metadata: { duration_ms: durationMs },
			})
			: terminalTranscript;
		return {
			...state,
			turnRunning: false,
			activeTurnId: activeTurnIdAfterTerminal(state, params),
			activeAssistantItemId: null,
			liveReasoning: null,
			retryRestoreStatus: null,
			liveStatus:
				turnState === "interrupted"
					? {
						state: "interrupted",
						kind: "interrupted",
						text: "Interrupted",
						message: TURN_INTERRUPTED_NOTICE,
					}
					: turnState === "failed"
					? {
						state: "failed",
						kind: "failed",
						text: "Failed",
					}
					: {
						state: "completed",
						kind: "completed",
						text: "Completed",
						...(durationMs === undefined ? {} : { durationMs }),
					},
			pendingApproval: preserveApproval
				|| params.pending_decision === true
				|| params.turn_state === "waiting_approval"
				? state.pendingApproval
				: null,
			pendingClarification: preserveClarification
				|| params.turn_state === "waiting_clarification"
				? state.pendingClarification
				: null,
			transcript: transcriptWithDuration,
		};
	}
	if (method === "turn.status" || method === "status.update") {
		if (params.state === "failed") {
			return {
				...state,
				turnRunning: false,
				activeTurnId: activeTurnIdAfterTerminal(state, params),
				activeAssistantItemId: null,
				liveReasoning: null,
				retryRestoreStatus: null,
				liveStatus: {
					state: "failed",
					kind: stringValue(params.kind) ?? "failed",
					text: stringValue(params.text) ?? "Failed",
				},
				transcript: finalizeTransientWebSearchItems(state.transcript),
			};
		}
		const durationMs = turnDurationMsValue(params.duration_ms)
			?? (params.state === "completed" ? state.liveStatus?.durationMs : undefined);
		return {
			...state,
			turnRunning: params.state === "running" || params.state === "waiting_approval" || params.state === "waiting_clarification",
			liveStatus: {
				state: stringValue(params.state) ?? "running",
				kind: stringValue(params.kind) ?? "status",
				text: stringValue(params.text) ?? stringValue(params.message) ?? "Running",
				...(stringValue(params.message) ? { message: stringValue(params.message)! } : {}),
				...(durationMs === undefined ? {} : { durationMs }),
			},
		};
	}
	if (method === "turn.interrupted") {
		const message = stringValue(params.message) ?? "Interrupt requested";
		if (params.requested === true) {
			return {
				...state,
				turnRunning: true,
				liveStatus: {
					state: "interrupting",
					kind: "interrupting",
					text: "Interrupting",
					message,
				},
				retryRestoreStatus: null,
			};
		}
		return {
			...state,
			turnRunning: false,
			activeTurnId: activeTurnIdAfterTerminal(state, params),
			activeAssistantItemId: null,
			liveReasoning: null,
			retryRestoreStatus: null,
			liveStatus: {
				state: "interrupted",
				kind: "interrupted",
				text: "Interrupted",
				message: TURN_INTERRUPTED_NOTICE,
			},
			transcript: finalizeInterruptedTools(appendInterruptedNotice(
				finalizeTransientWebSearchItems(state.transcript),
				params,
			)),
		};
	}
	if (method === "turn.failed" || method === "gateway.error") {
		// The response handler reconciles this race with status.inspect; avoid leaving
		// a misleading error row behind while the selector is being replaced or cleared.
		const staleInteractiveError = method === "gateway.error"
			&& (
				(params.code === "approval_not_pending"
					&& (state.pendingApproval !== null || state.liveStatus?.state === "waiting_approval"))
				|| (params.code === "clarification_not_pending"
					&& (state.pendingClarification !== null || state.liveStatus?.state === "waiting_clarification"))
			);
		if (staleInteractiveError) return state;
		const message = method === "turn.failed"
			? turnFailureMessage(params)
			: boundedUiText(params.message, "Request failed.");
		const previousWaitingStatus =
			method === "gateway.error" &&
			(state.liveStatus?.state === "waiting_approval" || state.liveStatus?.state === "waiting_clarification")
				? state.liveStatus
				: null;
		if (method === "gateway.error") {
			return {
				...state,
				liveStatus: previousWaitingStatus ?? state.liveStatus,
				transcript: appendErrorNotice(state.transcript, params, message),
			};
		}
		return {
			...state,
			turnRunning: false,
			activeTurnId: activeTurnIdAfterTerminal(state, params),
			activeAssistantItemId: null,
			liveReasoning: null,
			retryRestoreStatus: null,
			liveStatus: { state: "failed", kind: "failed", text: message, message },
			transcript: finalizeFailedTools(appendTurnFailureNotice(
				finalizeTransientWebSearchItems(state.transcript),
				params,
			), params),
		};
	}
	if (method === "approval.request" || method === "approval.pending") {
		const transcript = sealActiveAssistantStream(
			state.transcript,
			state.activeAssistantItemId,
		);
		const duplicateRequest = interactiveResponseMatches(
			state.pendingApproval,
			params,
			"decision_id",
			"decisionId",
		);
		const hasMutationProposal = hasMatchingFileMutationProposal(transcript, params);
		return {
			...state,
			pendingApproval: params,
			turnRunning: false,
			activeAssistantItemId: null,
			liveStatus: { state: "waiting_approval", kind: "approval", text: "Waiting approval" },
			transcript: duplicateRequest || hasMutationProposal
				? transcript
				: [
					...transcript,
					{ id: nextId("approval"), type: "approval", text: String(params.preview ?? "Approval required"), folded: false, metadata: params },
				],
		};
	}
	if (method === "approval.respond") {
		if (!interactiveResponseMatches(
			state.pendingApproval,
			params,
			"decision_id",
			"decisionId",
		)) return state;
		const pending = state.pendingApproval;
		return {
			...state,
			pendingApproval: null,
			turnRunning: true,
			activeTurnId: interactiveResponseTurnId(state, pending, params),
			liveStatus: { state: "running", kind: "running", text: "Running" },
			transcript: removeTransientApprovalItems(
				state.transcript,
				stringValue(params.decision_id) ?? stringValue(params.decisionId) ?? undefined,
			),
		};
	}
	if (method === "clarify.request") {
		const duplicateRequest = interactiveResponseMatches(
			state.pendingClarification,
			params,
			"request_id",
			"requestId",
		);
		return {
			...state,
			pendingClarification: params,
			turnRunning: false,
			activeAssistantItemId: null,
			liveStatus: { state: "waiting_clarification", kind: "clarification", text: "Waiting clarification" },
			transcript: duplicateRequest
				? state.transcript
				: [
					...state.transcript,
					{ id: nextId("clarification"), type: "clarification", text: String(params.question ?? "Clarification required"), folded: false, metadata: params },
				],
		};
	}
	if (method === "clarify.respond") {
		if (state.pendingClarification && !interactiveResponseMatches(
			state.pendingClarification,
			params,
			"request_id",
			"requestId",
		)) return state;
		const requestId = stringValue(params.request_id) ?? stringValue(params.requestId);
		const response = stringValue(params.response);
		const pending = state.pendingClarification;
		const question = stringValue(params.question) ?? stringValue(pending?.question);
		const header = stringValue(params.header) ?? stringValue(pending?.header);
		const multiSelect = booleanValue(params.multi_select)
			?? booleanValue(pending?.multi_select)
			?? false;
		const resolved = requestId && question && response
			? {
				id: clarificationResponseItemId(requestId),
				type: "clarification",
				text: response,
				folded: false,
				metadata: {
					...recordValue(pending),
					...params,
					request_id: requestId,
					...(header ? { header } : {}),
					question,
					response,
					multi_select: multiSelect,
					status: "answered",
				},
			} satisfies RuntimeTranscriptItem
			: undefined;
		return {
			...state,
			pendingClarification: null,
			turnRunning: true,
			activeTurnId: interactiveResponseTurnId(state, pending, params),
			liveStatus: { state: "running", kind: "running", text: "Running" },
			transcript: [
				...removeTransientClarificationItems(
					state.transcript,
					requestId ?? undefined,
				),
				...(resolved ? [resolved] : []),
			],
		};
	}
	if (method === "status.changed") {
		const trust = trustFromPayload(params.trust, state.workspace);
		const turnRunning = booleanValue(params.turn_running);
		const statusSessionId = stringValue(params.session_id) ?? stringValue(params.sessionId) ?? undefined;
		const clearApproval = params.pending_decision === false
			&& pendingRequestBelongsToStatusSession(state.pendingApproval, statusSessionId, state.sessionId ?? undefined);
		const clearClarification = params.suspended_turn === false
			&& pendingRequestBelongsToStatusSession(state.pendingClarification, statusSessionId, state.sessionId ?? undefined);
		const approvalDecisionId = clearApproval
			? stringValue(state.pendingApproval?.decision_id)
				?? stringValue(state.pendingApproval?.decisionId)
				?? undefined
			: undefined;
		const clarificationRequestId = clearClarification
			? stringValue(state.pendingClarification?.request_id)
				?? stringValue(state.pendingClarification?.requestId)
				?? undefined
			: undefined;
		const model = stringValue(params.model) ?? state.model;
		const provider = stringValue(params.provider) ?? state.provider;
		const nextState = applyQueuePayload({
			...state,
			status: params,
			models: modelCatalogFromPayload(params) ?? state.models,
			turnRunning: turnRunning ?? state.turnRunning,
			activeTurnId:
				turnRunning === false
					? null
					: stringValue(params.turn_id) ?? state.activeTurnId,
			activeAssistantItemId: turnRunning === false ? null : state.activeAssistantItemId,
			liveReasoning: turnRunning === false ? null : state.liveReasoning,
			liveStatus:
				turnRunning === false && state.liveStatus?.state === "interrupting"
					? null
					: state.liveStatus,
			sessionTitle: stringValue(params.session_title) ?? state.sessionTitle,
			model,
			collaborationMode: collaborationModeValue(params.collaboration_mode) ?? state.collaborationMode,
			provider,
			permissions: permissionStateFromUnknown(params.permissions) ?? state.permissions,
			trust,
			trustGateDismissed: trust.state === "trusted",
		}, params, "status");
		let transcript = nextState.transcript;
		if (clearApproval) transcript = removeTransientApprovalItems(transcript, approvalDecisionId);
		if (clearClarification) transcript = removeTransientClarificationItems(transcript, clarificationRequestId);
		return applyShellBootstrap({
			...nextState,
			pendingApproval: clearApproval ? null : nextState.pendingApproval,
			pendingClarification: clearClarification ? null : nextState.pendingClarification,
			liveStatus:
				!nextState.turnRunning
					&& ((clearApproval && nextState.liveStatus?.state === "waiting_approval")
						|| (clearClarification && nextState.liveStatus?.state === "waiting_clarification"))
					? null
					: nextState.liveStatus,
			transcript,
		}, params.background_shells);
	}
	if (method === "workspace.trust.changed") {
		const trust = trustFromPayload(params, state.workspace);
		return { ...state, trust, trustGateDismissed: trust.state === "trusted" };
	}
	if (method === "turn.queue.updated") {
		return applyQueuePayload(state, params, "event");
	}
	if (method === "session.changed") {
		return {
			...state,
			sessionId: stringValue(params.session_id) ?? state.sessionId,
			sessionTitle: stringValue(params.session_title) ?? state.sessionTitle,
			pendingApproval: null,
			pendingClarification: null,
			turnRunning: false,
			activeTurnId: null,
			activeAssistantItemId: null,
			liveStatus: null,
			liveReasoning: null,
			taskProgress: null,
			transcriptNextBefore: null,
			status: {},
			queueRevision: 0,
			queuedInputs: [],
			queuedPendingSteers: [],
			queuedRejectedSteers: [],
			queuedFollowUpInputs: [],
			localPendingSteers: [],
			localRejectedSteers: [],
			localFollowUps: [],
			localSubmittingMessages: [],
			hasPendingInput: false,
			queueActivity: null,
			retryRestoreStatus: null,
			backgroundShells: {},
			backgroundShellCount: 0,
			shellEventSequences: {},
			transcript: finalizeTransientWebSearchItems(removeTransientClarificationItems(
				removeTransientApprovalItems(state.transcript),
			)),
		};
	}
	return state;
}

export function runtimeStateWithUserMessage(state: RuntimeShellState, message: string): RuntimeShellState {
	return {
		...state,
		transcript: [...state.transcript, { id: nextId("user"), type: "user", text: message, folded: false, metadata: {} }],
	};
}

export function runtimeStateWithPendingSteer(
	state: RuntimeShellState,
	input: RuntimeLocalUserInput,
): RuntimeShellState {
	return {
		...state,
		localPendingSteers: appendLocalInput(state.localPendingSteers, input),
	};
}

export function runtimeStateWithSubmittingMessage(
	state: RuntimeShellState,
	input: RuntimeLocalUserInput,
): RuntimeShellState {
	return {
		...state,
		localSubmittingMessages: appendLocalInput(state.localSubmittingMessages, input),
	};
}

export function runtimeInputDisposition(
	state: RuntimeShellState,
	backendTurnBusy: boolean,
): "submit" | "steer" | "follow_up" {
	if (state.liveStatus?.state === "interrupting") {
		return "follow_up";
	}
	if (state.turnRunning || state.activeTurnId) {
		return "steer";
	}
	return backendTurnBusy ? "follow_up" : "submit";
}

export function runtimeStateWithLocalFollowUp(
	state: RuntimeShellState,
	input: RuntimeLocalUserInput,
): RuntimeShellState {
	return {
		...state,
		localFollowUps: appendLocalInput(state.localFollowUps, input),
	};
}

export function runtimeStateRejectPendingSteer(
	state: RuntimeShellState,
	clientUserMessageId: string,
): RuntimeShellState {
	const input = state.localPendingSteers.find(
		(candidate) => candidate.clientUserMessageId === clientUserMessageId,
	);
	if (!input) return state;
	return {
		...state,
		localPendingSteers: state.localPendingSteers.filter(
			(candidate) => candidate.clientUserMessageId !== clientUserMessageId,
		),
		localRejectedSteers: appendLocalInput(state.localRejectedSteers, input),
	};
}

export function restorePendingSteersAfterInterrupt(state: RuntimeShellState): RuntimeShellState {
	return {
		...state,
		localRejectedSteers: state.localPendingSteers.reduce(
			(inputs, input) => appendLocalInput(inputs, input),
			state.localRejectedSteers,
		),
		localPendingSteers: [],
	};
}

export function resolveLocalInterruptInputs(
	state: RuntimeShellState,
	resubmitPendingSteers: boolean,
): {
	state: RuntimeShellState;
	restoreToComposer: RuntimeLocalUserInput[];
	dispatchNext: boolean;
} {
	if (resubmitPendingSteers && state.localPendingSteers.length > 0) {
		return {
			state: restorePendingSteersAfterInterrupt(state),
			restoreToComposer: [],
			dispatchNext: true,
		};
	}

	const seen = new Set<string>();
	const restoreToComposer = [
		...state.localRejectedSteers,
		...state.localPendingSteers,
		...state.localFollowUps,
	].filter((input) => {
		if (seen.has(input.clientUserMessageId)) return false;
		seen.add(input.clientUserMessageId);
		return true;
	});
	return {
		state: {
			...state,
			localPendingSteers: [],
			localRejectedSteers: [],
			localFollowUps: [],
		},
		restoreToComposer,
		dispatchNext: false,
	};
}

export function popLastLocalFollowUp(
	state: RuntimeShellState,
): { state: RuntimeShellState; input: RuntimeLocalUserInput | null } {
	const input = state.localFollowUps.at(-1) ?? null;
	return {
		state: input ? { ...state, localFollowUps: state.localFollowUps.slice(0, -1) } : state,
		input,
	};
}

export function nextLocalUserInput(
	state: RuntimeShellState,
): { kind: "rejected" | "follow_up"; input: RuntimeLocalUserInput } | null {
	const rejected = state.localRejectedSteers[0];
	if (rejected) return { kind: "rejected", input: rejected };
	const followUp = state.localFollowUps[0];
	return followUp ? { kind: "follow_up", input: followUp } : null;
}

export function removeLocalUserInput(
	state: RuntimeShellState,
	clientUserMessageId: string,
): RuntimeShellState {
	const withoutIdentity = (inputs: RuntimeLocalUserInput[]) =>
		inputs.filter((input) => input.clientUserMessageId !== clientUserMessageId);
	return {
		...state,
		localPendingSteers: withoutIdentity(state.localPendingSteers),
		localRejectedSteers: withoutIdentity(state.localRejectedSteers),
		localFollowUps: withoutIdentity(state.localFollowUps),
		localSubmittingMessages: withoutIdentity(state.localSubmittingMessages),
	};
}

export function runtimeStateAcknowledgeQueuedInput(
	state: RuntimeShellState,
	clientUserMessageId: string,
	queuePayload: Record<string, unknown>,
): RuntimeShellState {
	return applyQueuePayload(
		removeLocalUserInput(state, clientUserMessageId),
		queuePayload,
		"event",
	);
}

function appendLocalInput(
	inputs: RuntimeLocalUserInput[],
	input: RuntimeLocalUserInput,
): RuntimeLocalUserInput[] {
	const normalized = {
		...input,
		attachments: input.attachments.map((attachment) => ({ ...attachment })),
	};
	const existing = inputs.find(
		(candidate) => candidate.clientUserMessageId === normalized.clientUserMessageId,
	);
	if (!existing) return [...inputs, normalized];
	if (
		existing.message !== normalized.message ||
		JSON.stringify(existing.attachments) !== JSON.stringify(normalized.attachments)
	) {
		throw new Error(`conflicting local user message id: ${normalized.clientUserMessageId}`);
	}
	return inputs;
}

function applyLegacyQueueMigration(
	state: RuntimeShellState,
	migration: Record<string, unknown>,
): RuntimeShellState {
	if (!Array.isArray(migration.records)) return state;
	let nextState = state;
	for (const value of migration.records) {
		const record = recordValue(value);
		const queueId = stringValue(record.queue_id);
		const message = stringValue(record.text) ?? stringValue(record.message);
		const kind = stringValue(record.kind);
		if (!queueId || !message || !kind) continue;
		const input: RuntimeLocalUserInput = {
			clientUserMessageId: stringValue(record.client_user_message_id) ?? queueId,
			message,
			attachments: localImageAttachments(record.local_images),
		};
		if (kind === "follow_up") {
			nextState = runtimeStateWithLocalFollowUp(nextState, input);
		} else if (kind === "pending_steer" || kind === "rejected_steer") {
			nextState = {
				...nextState,
				localRejectedSteers: appendLocalInput(nextState.localRejectedSteers, input),
			};
		}
	}
	return nextState;
}

function localImageAttachments(value: unknown): MycliShellLocalImageAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item, index) => {
		const record = recordValue(item);
		const path = stringValue(record.path);
		if (!path) return [];
		return [{
			path,
			placeholder: stringValue(record.placeholder) ?? `[image #${index + 1}]`,
		}];
	});
}

function applyQueuePayload(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
	legacyShape: "event" | "status",
): RuntimeShellState {
	const queueItems = recordValue(payload.queue_items);
	const hasStructuredItems =
		"pending_steers" in queueItems ||
		"rejected_steers" in queueItems ||
		"follow_ups" in queueItems;
	const revision = numberValue(payload.queue_revision);
	if (hasStructuredItems) {
		if (revision !== null && revision < state.queueRevision) {
			return state;
		}
		return runtimeStateWithMessageQueues(state, {
			pendingSteers: queuedInputPreviews(queueItems.pending_steers, []),
			rejectedSteers: queuedInputPreviews(queueItems.rejected_steers, []),
			followUps: queuedInputPreviews(queueItems.follow_ups, []),
			revision: revision ?? state.queueRevision,
			activity: payload.activity ?? payload.queue_activity,
		});
	}

	const itemPrefix = legacyShape === "status" ? "queued_" : "";
	return runtimeStateWithMessageQueues(state, {
		pendingSteers: queuedInputPreviews(
			payload[`${itemPrefix}steering_items`],
			payload[`${itemPrefix}steering`],
		),
		rejectedSteers: [],
		followUps: queuedInputPreviews(
			payload[`${itemPrefix}follow_up_items`],
			payload[`${itemPrefix}follow_up`],
		),
		activity: payload.activity ?? payload.queue_activity,
	});
}

function activeTurnIdAfterTerminal(
	state: RuntimeShellState,
	params: Record<string, unknown>,
): string | null {
	const terminalTurnId = stringValue(params.turn_id);
	return terminalTurnId !== null && terminalTurnId === state.activeTurnId
		? null
		: state.activeTurnId;
}

function appendInterruptedNotice(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
): RuntimeTranscriptItem[] {
	const currentTurnStart = items.findLastIndex((item) => item.type === "user");
	const currentTurnItems = items.slice(currentTurnStart + 1);
	if (
		currentTurnItems.some(
			(item) => item.type === "warning" && item.text === TURN_INTERRUPTED_NOTICE,
		)
	) {
		return items;
	}
	const turnId = stringValue(params.turn_id) ?? stringValue(params.client_turn_id);
	return [
		...items,
		{
			id: turnId ? turnInterruptedNoticeId(turnId) : nextId("turn-interrupted"),
			type: "warning",
			text: TURN_INTERRUPTED_NOTICE,
			folded: false,
			metadata: {
				event_kind: "turn_interrupted",
				...(turnId ? { interrupted_turn_id: turnId } : {}),
				status: "interrupted",
			},
		},
	];
}

function appendTurnFailureNotice(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
): RuntimeTranscriptItem[] {
	const code = stringValue(params.code) ?? stringValue(params.error_code) ?? "provider_error";
	const message = turnFailureNotice(code, stringValue(params.message) ?? undefined);
	const turnId = stringValue(params.turn_id) ?? stringValue(params.client_turn_id);
	return appendErrorNotice(items, {
		...params,
		code,
		event_kind: "turn_failed",
		status: "failed",
		source: "runtime",
	}, message, turnId ? turnFailedNoticeId(turnId) : undefined);
}

function appendErrorNotice(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
	message: string,
	id?: string,
): RuntimeTranscriptItem[] {
	if (id && items.some((item) => item.id === id)) return items;
	return [
		...items,
		{
			id: id ?? nextId("error"),
			type: "error",
			text: message,
			folded: false,
			metadata: errorNoticeMetadata(params),
		},
	];
}

function errorNoticeMetadata(params: Record<string, unknown>): Record<string, unknown> {
	const metadata: Record<string, unknown> = {};
	for (const key of ["source", "method", "code", "event_kind", "status"] as const) {
		const value = stringValue(params[key]);
		if (value) metadata[key] = value;
	}
	for (const key of ["turn_id", "client_turn_id"] as const) {
		const value = stringValue(params[key]);
		if (value) metadata[key] = value;
	}
	const additionalDetails = sanitizeRuntimeErrorDetail(params.additional_details);
	if (additionalDetails) {
		metadata.additional_details = additionalDetails;
	}
	return metadata;
}

function turnFailureMessage(params: Record<string, unknown>): string {
	return turnFailureNotice(
		stringValue(params.code) ?? stringValue(params.error_code) ?? "provider_error",
		stringValue(params.message) ?? undefined,
	);
}

function finalizeInterruptedTools(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	let changed = false;
	const finalized = items.map((item) => {
		if (item.type !== "tool_summary" && item.type !== "tool_detail") return item;
		const metadata = recordValue(item.metadata);
		if (stringValue(metadata.status) !== "running" || booleanValue(metadata.background) === true) {
			return item;
		}
		changed = true;
		return {
			...item,
			metadata: {
				...metadata,
				status: "failed",
				success: false,
				error_kind: "tool_interrupted",
				error: "tool_interrupted",
				summary: stringValue(metadata.summary) ?? `${stringValue(metadata.tool_name) ?? "Tool"} interrupted`,
			},
		};
	});
	return changed ? finalized : items;
}

function finalizeFailedTools(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
): RuntimeTranscriptItem[] {
	const message = turnFailureMessage(params);
	let changed = false;
	const finalized = items.map((item) => {
		if (item.type !== "tool_summary" && item.type !== "tool_detail") return item;
		const metadata = recordValue(item.metadata);
		if (stringValue(metadata.status) !== "running" || booleanValue(metadata.background) === true) {
			return item;
		}
		changed = true;
		return {
			...item,
			metadata: {
				...metadata,
				status: "failed",
				success: false,
				error_kind: "turn_failed",
				error: message,
				summary: stringValue(metadata.summary) ?? `${stringValue(metadata.tool_name) ?? "Tool"} failed`,
			},
		};
	});
	return changed ? finalized : items;
}

function noticeDiagnostic(
	value: Record<string, unknown> | undefined,
): { diagnostic?: { hint?: string; source?: string; method?: string; code?: string; details?: string } } {
	const metadata = recordValue(value);
	const source = stringValue(metadata.source);
	const method = stringValue(metadata.method);
	const code = stringValue(metadata.code);
	const details = sanitizeRuntimeErrorDetail(metadata.additional_details);
	const hint = code && isRuntimeErrorCode(code) ? runtimeErrorRecoveryHint(code) : undefined;
	return hint || source || method || code || details
		? {
			diagnostic: {
				...(hint ? { hint } : {}),
				...(source ? { source } : {}),
				...(method ? { method } : {}),
				...(code ? { code } : {}),
				...(details ? { details } : {}),
			},
		}
		: {};
}

function rollbackOutputFreeUserTurn(
	items: RuntimeTranscriptItem[],
): RuntimeTranscriptItem[] {
	const userIndex = items.findLastIndex((item) => item.type === "user");
	return userIndex < 0 ? items : items.slice(0, userIndex);
}

function runtimeStateWithMessageQueues(
	state: RuntimeShellState,
	queues: {
		pendingSteers: RuntimeQueuedInputPreview[];
		rejectedSteers: RuntimeQueuedInputPreview[];
		followUps: RuntimeQueuedInputPreview[];
		revision?: number;
		activity?: unknown;
	},
): RuntimeShellState {
	const pendingSteers = visibleQueuedPreviews(queues.pendingSteers);
	const rejectedSteers = visibleQueuedPreviews(queues.rejectedSteers);
	const followUps = visibleQueuedPreviews(queues.followUps);
	const queueActivity = queueActivityFromPayload(
		queues.activity,
		pendingSteers,
		[...rejectedSteers, ...followUps],
	);
	return {
		...state,
		queueRevision: queues.revision ?? state.queueRevision,
		queuedPendingSteers: pendingSteers,
		queuedRejectedSteers: rejectedSteers,
		queuedFollowUpInputs: followUps,
		queuedInputs: [...pendingSteers, ...rejectedSteers, ...followUps].map((item) => item.message),
		hasPendingInput: pendingSteers.length > 0 || rejectedSteers.length > 0 || followUps.length > 0,
		queueActivity,
	};
}

function queuedInputCount(state: RuntimeShellState): number {
	const splitQueueCount =
		state.localPendingSteers.length +
		state.localRejectedSteers.length +
		state.localFollowUps.length +
		state.queuedPendingSteers.length +
		state.queuedRejectedSteers.length +
		state.queuedFollowUpInputs.length;
	return splitQueueCount > 0 ? splitQueueCount : state.queuedInputs.length;
}

function queueActivityFromPayload(
	_value: unknown,
	steering: RuntimeQueuedInputPreview[],
	followUp: RuntimeQueuedInputPreview[],
): { kind: string; steeringCount: number; followUpCount: number } {
	const fallbackSteeringCount = steering.length;
	const fallbackFollowUpCount = followUp.length;
	const fallbackKind = fallbackSteeringCount > 0 || fallbackFollowUpCount > 0 ? "pending_input" : "idle";
	return {
		kind: fallbackKind,
		steeringCount: fallbackSteeringCount,
		followUpCount: fallbackFollowUpCount,
	};
}

function visibleQueuedMessages(messages: string[]): string[] {
	return messages.filter((message) => !isInternalTaskNotification(message));
}

function visibleQueuedPreviews(items: RuntimeQueuedInputPreview[]): RuntimeQueuedInputPreview[] {
	return items.filter(
		(item) => item.source !== "task_notification" && !isInternalTaskNotification(item.message),
	);
}

function queuedInputPreviews(items: unknown, fallback: unknown): RuntimeQueuedInputPreview[] {
	const raw = Array.isArray(items) && items.length > 0 ? items : stringArrayValue(fallback);
	return raw
		.map((item): RuntimeQueuedInputPreview | null => {
			if (typeof item === "string") {
				return item.trim() ? { message: item.trim(), hasImages: false } : null;
			}
			const record = recordValue(item);
			const message = stringValue(record.message) ?? stringValue(record.text);
			if (!message?.trim()) return null;
			return {
				message: message.trim(),
				hasImages: Array.isArray(record.local_images) && record.local_images.length > 0,
				...(stringValue(record.source) ? { source: stringValue(record.source)! } : {}),
			};
		})
		.filter((item): item is RuntimeQueuedInputPreview => item !== null)
		.filter((item) => !isInternalTaskNotification(item.message));
}

function isInternalTaskNotification(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("<task-notification>")
		|| trimmed.startsWith("<task-notification ")
		|| trimmed.startsWith("<agent-mailbox>")
		|| trimmed.startsWith("<agent-mailbox ");
}

export function runtimeStateWithCommandResult(state: RuntimeShellState, command: string, result: Record<string, unknown>): RuntimeShellState {
	const lines = Array.isArray(result.lines) ? result.lines.map((line) => String(line)) : [String(result.message ?? "Done")];
	const collaborationMode = collaborationModeValue(result.collaboration_mode);
	if (result.presentation === "overlay" || result.presentation === "none") {
		return {
			...state,
			collaborationMode: collaborationMode ?? state.collaborationMode,
		};
	}
	if (result.command_kind === "background_shells") {
		const backgroundTerminals: Omit<MycliShellBackgroundTerminals, "id"> = {
			processes: backgroundProcessesFromUnknown(result.processes),
		};
		const id = stringValue(result.result_id) ?? nextId("command");
		return {
			...state,
			collaborationMode: collaborationMode ?? state.collaborationMode,
			transcript: upsertTranscriptItem(
				state.transcript,
				{
					id,
					type: "background_terminals",
					text: "Background terminals",
					folded: false,
					metadata: commandResultMetadata(state, { command, backgroundTerminals }),
				},
			),
		};
	}
	const commandResult = commandResultFromGateway(result);
	if (commandResult) {
		return {
			...state,
			collaborationMode: collaborationMode ?? state.collaborationMode,
			transcript: upsertTranscriptItem(
				state.transcript,
				commandResultTranscriptItem(commandResult, state.turnRunning),
			),
		};
	}
	const fallbackId = stringValue(result.result_id) ?? nextId("command");
	const item = {
		id: fallbackId,
		type: "command_output",
		text: lines.join("\n"),
		folded: false,
		metadata: commandResultMetadata(state, { command }),
	};
	return {
		...state,
		collaborationMode: collaborationMode ?? state.collaborationMode,
		transcript: upsertTranscriptItem(state.transcript, item),
	};
}

export async function runtimeStateAfterCommandResult(
	state: RuntimeShellState,
	command: string,
	result: Record<string, unknown>,
	loadTranscript: (sessionId: string) => Promise<Record<string, unknown>>,
	sourceSessionId: string | null = state.sessionId,
): Promise<RuntimeShellState> {
	const destinationSessionId = stringValue(result.session_id);
	if (
		result.mutated_session !== true ||
		!destinationSessionId ||
		destinationSessionId === sourceSessionId
	) {
		return runtimeStateWithCommandResult(state, command, result);
	}
	const destinationState: RuntimeShellState = {
		...state,
		sessionId: destinationSessionId,
		sessionTitle: destinationSessionId,
		transcript: [],
		transcriptNextBefore: null,
		activeAssistantItemId: null,
		liveStatus: null,
		retryRestoreStatus: null,
		liveReasoning: null,
		pendingApproval: null,
		pendingClarification: null,
		taskProgress: null,
		backgroundShells: {},
		backgroundShellCount: 0,
		shellEventSequences: {},
	};
	const transcriptPayload = await loadTranscript(destinationSessionId);
	const loaded = runtimeStateFromTranscript(destinationState, transcriptPayload);
	const lines = Array.isArray(result.lines)
		? result.lines.filter((line): line is string => typeof line === "string")
		: [];
	const notice = lines.join("\n") || "Session changed.";
	return {
		...loaded,
		transcript: [
			...loaded.transcript,
			{
				id: nextId("session-notice"),
				type: "system_notice",
				text: notice,
				folded: false,
				metadata: { transient: true, command },
			},
		],
	};
}

function commandResultTranscriptItem(
	commandResult: MycliShellCommandResult,
	deferUntilTurnComplete: boolean,
): RuntimeTranscriptItem {
	return {
		id: commandResult.id,
		type: "command_result",
		text: commandResult.fallbackLines.join("\n"),
		folded: commandResult.folded,
		metadata: {
			command: commandResult.display.command,
			display: commandResultDisplayPayload(commandResult),
			fallback_lines: commandResult.fallbackLines,
			model_visible: false,
			...(deferUntilTurnComplete ? { deferred_until_turn_complete: true } : {}),
		},
	};
}

function commandResultMetadata(
	state: RuntimeShellState,
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	return state.turnRunning
		? { ...metadata, deferred_until_turn_complete: true }
		: metadata;
}

function commandResultDisplayPayload(commandResult: MycliShellCommandResult): Record<string, unknown> {
	const display = commandResult.display;
	return {
		version: display.version,
		kind: display.kind,
		command: display.command,
		title: display.title,
		severity: display.severity,
		...(display.summary !== undefined ? { summary: display.summary } : {}),
		...(display.fields.length > 0 ? { fields: display.fields } : {}),
		...(display.rows.length > 0 ? { rows: display.rows } : {}),
		...(display.sections.length > 0 ? { sections: display.sections } : {}),
		...(display.usage !== undefined ? { usage: display.usage } : {}),
		...(display.suggestions.length > 0 ? { suggestions: display.suggestions } : {}),
		...(display.preformatted !== undefined ? { preformatted: display.preformatted } : {}),
		...(display.totalRows !== undefined ? { total_rows: display.totalRows } : {}),
		...(display.omittedRows > 0 ? { omitted_rows: display.omittedRows } : {}),
		...(display.omittedChars > 0 ? { omitted_chars: display.omittedChars } : {}),
	};
}

function upsertTranscriptItem(
	items: RuntimeTranscriptItem[],
	item: RuntimeTranscriptItem,
): RuntimeTranscriptItem[] {
	const index = items.findIndex((existing) => existing.id === item.id);
	if (index < 0) return [...items, item];
	const updated = [...items];
	updated[index] = item;
	return updated;
}

function backgroundTerminalsFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellBackgroundTerminals | null {
	const metadata = recordValue(item.metadata);
	const value = recordValue(metadata.backgroundTerminals ?? metadata.background_terminals);
	return {
		id: item.id,
		processes: backgroundProcessesFromUnknown(value.processes),
	};
}

function backgroundProcessesFromUnknown(value: unknown): MycliShellBackgroundProcess[] {
	if (!Array.isArray(value)) return [];
	return value.map(backgroundProcessFromUnknown).filter((process): process is MycliShellBackgroundProcess => process !== null);
}

function backgroundProcessFromUnknown(value: unknown): MycliShellBackgroundProcess | null {
	const record = recordValue(value);
	const shellId = stringValue(record.shell_id) ?? stringValue(record.shellId);
	if (!shellId) return null;
	const output = stringValue(record.output) ?? "";
	const recentOutput = stringArrayValue(record.recentOutput ?? record.recent_output);
	return {
		shellId,
		commandPreview: stringValue(record.command_preview) ?? stringValue(record.commandPreview) ?? "command",
		recentOutput: (recentOutput.length > 0 ? recentOutput : output.split(/\r?\n/))
			.map((line) => line.replace(/[\r\n\t]/g, " ").trim())
			.filter(Boolean)
			.slice(-3)
			.map((line) => line.slice(0, 500)),
	};
}

export function sessionsFromResult(result: Record<string, unknown>): MycliShellSession[] {
	const raw = Array.isArray(result.sessions) ? result.sessions : Array.isArray(result.items) ? result.items : [];
	return raw.map(sessionFromUnknown).filter((session): session is MycliShellSession => session !== null);
}

export function sessionTreeFromResult(result: Record<string, unknown>): MycliShellSessionTree {
	const rawNodes = Array.isArray(result.nodes) ? result.nodes : [];
	return {
		sessionId: stringValue(result.session_id) ?? stringValue(result.sessionId) ?? "",
		activePath: stringArrayValue(result.active_path ?? result.activePath),
		nodes: rawNodes.map(sessionTreeNodeFromUnknown).filter((node): node is MycliShellSessionTreeNode => node !== null),
	};
}

function sessionFromUnknown(value: unknown): MycliShellSession | null {
	const record = recordValue(value);
	const id = stringValue(record.id) ?? stringValue(record.session_id) ?? stringValue(record.path);
	if (!id) return null;
	return {
		id,
		title: stringValue(record.title) ?? stringValue(record.name) ?? undefined,
		cwd: stringValue(record.cwd) ?? stringValue(record.workspace) ?? undefined,
		workspace: stringValue(record.workspace) ?? stringValue(record.workspace_root) ?? undefined,
		modified: stringValue(record.modified) ?? stringValue(record.last_active) ?? stringValue(record.updated_at) ?? undefined,
		created: stringValue(record.created) ?? stringValue(record.created_at) ?? undefined,
		updated: stringValue(record.updated) ?? stringValue(record.updated_at) ?? undefined,
		lastActive: stringValue(record.last_active) ?? stringValue(record.lastActive) ?? undefined,
		messageCount: numberValue(record.message_count) ?? numberValue(record.messageCount) ?? undefined,
		firstMessage: stringValue(record.first_message) ?? stringValue(record.firstMessage) ?? undefined,
		allMessagesText: stringValue(record.all_messages_text) ?? stringValue(record.allMessagesText) ?? undefined,
		parentSessionId: stringValue(record.parent_session_id) ?? stringValue(record.parentSessionId) ?? undefined,
		parentSessionPath: stringValue(record.parent_session_path) ?? stringValue(record.parentSessionPath) ?? undefined,
		named: booleanValue(record.named) ?? undefined,
		current: booleanValue(record.current) ?? undefined,
	};
}

function sessionTreeNodeFromUnknown(value: unknown): MycliShellSessionTreeNode | null {
	const record = recordValue(value);
	const id = stringValue(record.id);
	const kind = stringValue(record.kind);
	const sessionId = stringValue(record.session_id) ?? stringValue(record.sessionId);
	if (!id || !sessionId || (kind !== "session" && kind !== "message")) return null;
	return {
		id,
		kind,
		sessionId,
		parentId: stringValue(record.parent_id) ?? stringValue(record.parentId) ?? undefined,
		depth: numberValue(record.depth) ?? 0,
		role: stringValue(record.role) ?? kind,
		summary: stringValue(record.summary) ?? "",
		timestamp: stringValue(record.timestamp) ?? undefined,
		label: stringValue(record.label) ?? undefined,
		messageIndex: numberValue(record.message_index) ?? numberValue(record.messageIndex) ?? undefined,
		anchorId: stringValue(record.anchor_id) ?? stringValue(record.anchorId) ?? undefined,
		toolName: stringValue(record.tool_name) ?? stringValue(record.toolName) ?? undefined,
		active: booleanValue(record.active) ?? undefined,
		onActivePath: booleanValue(record.on_active_path) ?? booleanValue(record.onActivePath) ?? undefined,
		messageCount: numberValue(record.message_count) ?? numberValue(record.messageCount) ?? undefined,
		preview: stringValue(record.preview) ?? undefined,
	};
}

function pendingNotice(state: RuntimeShellState): string | undefined {
	if (state.pendingApproval) {
		return `Approval required: ${String(state.pendingApproval.preview ?? state.pendingApproval.tool_name ?? "")}`.trim();
	}
	if (state.pendingClarification) {
		return `Clarification required: ${String(state.pendingClarification.question ?? "")}`.trim();
	}
	return undefined;
}

function diagnosticFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellCommandDiagnostic | null {
	const metadata = recordValue(item.metadata);
	const diagnostic = recordValue(metadata.diagnostic);
	const command = stringValue(diagnostic.command) ?? stringValue(metadata.command);
	const title = stringValue(diagnostic.title);
	if (!command || !title) {
		return null;
	}
	const kind = diagnosticKindValue(diagnostic.kind);
	return {
		id: item.id,
		command,
		title,
		kind,
		metrics: diagnosticMetricsFromUnknown(diagnostic.metrics),
		sections: diagnosticSectionsFromUnknown(diagnostic.sections),
		rawLines: stringArrayValue(diagnostic.rawLines ?? diagnostic.raw_lines),
	};
}

function diagnosticKindValue(value: unknown): MycliShellCommandDiagnostic["kind"] {
	return value === "usage" || value === "context" ? value : "generic";
}

function diagnosticMetricsFromUnknown(value: unknown): MycliShellDiagnosticMetric[] {
	if (!Array.isArray(value)) return [];
	return value.map(diagnosticMetricFromUnknown).filter((item): item is MycliShellDiagnosticMetric => item !== null);
}

function diagnosticMetricFromUnknown(value: unknown): MycliShellDiagnosticMetric | null {
	const record = recordValue(value);
	const label = stringValue(record.label);
	const metricValue = stringValue(record.value);
	if (!label || metricValue === null) return null;
	const metric: MycliShellDiagnosticMetric = {
		label,
		value: metricValue,
	};
	const accent = diagnosticAccentValue(record.accent);
	if (accent) {
		metric.accent = accent;
	}
	return metric;
}

function diagnosticSectionsFromUnknown(value: unknown): MycliShellDiagnosticSection[] {
	if (!Array.isArray(value)) return [];
	return value.map(diagnosticSectionFromUnknown).filter((item): item is MycliShellDiagnosticSection => item !== null);
}

function diagnosticSectionFromUnknown(value: unknown): MycliShellDiagnosticSection | null {
	const record = recordValue(value);
	const title = stringValue(record.title);
	if (!title) return null;
	return {
		title,
		rows: diagnosticMetricsFromUnknown(record.rows),
	};
}

function diagnosticAccentValue(value: unknown): MycliShellDiagnosticMetric["accent"] | undefined {
	if (value === "success" || value === "warning" || value === "error" || value === "accent" || value === "muted") {
		return value;
	}
	return undefined;
}

function pendingApprovalFromRecord(value: Record<string, unknown> | null): MycliShellPendingApproval | undefined {
	if (!value) {
		return undefined;
	}
	const decisionId = stringValue(value.decision_id) ?? stringValue(value.decisionId);
	if (!decisionId) {
		return undefined;
	}
	const options = approvalOptionsFromPayload(value.options);
	return {
		decisionId,
		sessionId: stringValue(value.session_id) ?? stringValue(value.sessionId) ?? undefined,
		generation: numberValue(value.generation) ?? undefined,
		preview: stringValue(value.preview) ?? stringValue(value.action) ?? stringValue(value.tool_name) ?? "Approval required",
		reason: stringValue(value.reason) ?? undefined,
		toolName: stringValue(value.tool_name) ?? stringValue(value.toolName) ?? undefined,
		workerName:
			stringValue(value.worker_name) ??
			stringValue(value.workerName) ??
			stringValue(value.agent_name) ??
			stringValue(value.agentName) ??
			stringValue(value.role) ??
			undefined,
		workerColor: stringValue(value.worker_color) ?? stringValue(value.workerColor) ?? undefined,
		childSessionId: stringValue(value.child_session_id) ?? stringValue(value.childSessionId) ?? undefined,
		agentPath: stringValue(value.agent_path) ?? stringValue(value.agentPath) ?? undefined,
		options: options.length > 0 ? options : defaultApprovalOptions(),
		risk: stringValue(value.risk) ?? undefined,
		riskReason: stringValue(value.risk_reason) ?? stringValue(value.riskReason) ?? undefined,
		persistentRulePreview:
			stringValue(value.persistent_rule_preview) ?? stringValue(value.persistentRulePreview) ?? undefined,
		permissionRequest: permissionRequestFromPayload(
			value.permission_request ?? value.permissionRequest,
		),
		contentPreview: stringValue(value.content_preview) ?? stringValue(value.contentPreview) ?? undefined,
		contentLineCount: numberValue(value.content_line_count) ?? numberValue(value.contentLineCount) ?? undefined,
		diffPreview: diffPreviewForTool(value),
	};
}

function permissionRequestFromPayload(
	value: unknown,
): MycliShellPendingApproval["permissionRequest"] {
	const request = recordValue(value);
	if (Object.keys(request).length === 0) return undefined;
	const network = recordValue(request.network).enabled === true;
	const fileSystem = recordValue(request.file_system ?? request.fileSystem);
	const readPaths = stringArrayValue(fileSystem.read);
	const writePaths = stringArrayValue(fileSystem.write);
	if (!network && readPaths.length === 0 && writePaths.length === 0) return undefined;
	return { network, readPaths, writePaths };
}

function pendingClarificationFromRecord(
	value: Record<string, unknown> | null,
): MycliShellPendingClarification | undefined {
	if (!value) {
		return undefined;
	}
	const requestId = stringValue(value.request_id) ?? stringValue(value.requestId);
	const question = stringValue(value.question);
	if (!requestId || !question) {
		return undefined;
	}
	const rawOptions = Array.isArray(value.options) ? value.options : [];
	const options: MycliShellPendingClarification["options"] = [];
	for (const item of rawOptions) {
		const record = recordValue(item);
		const label = stringValue(record.label);
		if (!label) continue;
		const description = stringValue(record.description);
		options.push({ label, ...(description ? { description } : {}) });
	}
	const turnId = stringValue(value.turn_id) ?? stringValue(value.turnId);
	return {
		requestId,
		...(turnId ? { turnId } : {}),
		sessionId: stringValue(value.session_id) ?? stringValue(value.sessionId) ?? undefined,
		generation: numberValue(value.generation) ?? undefined,
		question,
		workerName: stringValue(value.worker_name) ?? stringValue(value.workerName) ?? undefined,
		childSessionId: stringValue(value.child_session_id) ?? stringValue(value.childSessionId) ?? undefined,
		agentPath: stringValue(value.agent_path) ?? stringValue(value.agentPath) ?? undefined,
		header: stringValue(value.header) ?? undefined,
		options,
		multiSelect: booleanValue(value.multi_select) ?? booleanValue(value.multiSelect) ?? false,
	};
}

function clarificationResponseFromTranscriptItem(
	item: RuntimeTranscriptItem,
): MycliShellClarificationResponse | null {
	const metadata = recordValue(item.metadata);
	const requestId = stringValue(metadata.request_id) ?? stringValue(metadata.requestId);
	const question = stringValue(metadata.question);
	const response = stringValue(metadata.response);
	if (!requestId || !question || !response) return null;
	const header = stringValue(metadata.header);
	return {
		id: item.id,
		requestId,
		...(header ? { header } : {}),
		question,
		response,
		multiSelect: booleanValue(metadata.multi_select) ?? booleanValue(metadata.multiSelect) ?? false,
	};
}

function webSearchFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellWebSearch | null {
	const metadata = recordValue(item.metadata);
	const callId = stringValue(item.call_id) ?? stringValue(metadata.call_id);
	if (!callId) return null;
	const rawStatus = stringValue(item.status) ?? stringValue(metadata.status);
	const rawAction = stringValue(metadata.action_type);
	const action: MycliShellWebSearch["action"] = rawAction === "search"
		|| rawAction === "open_page"
		|| rawAction === "find_in_page"
		? rawAction
		: "other";
	return {
		id: item.id,
		callId,
		status: rawStatus === "running" ? "running" : "completed",
		action,
		...(item.text.trim() ? { detail: item.text.trim() } : {}),
	};
}

function webSearchActionMetadata(value: unknown): Record<string, unknown> {
	const action = recordValue(value);
	const type = stringValue(action.type);
	if (type === "search") {
		const query = textValue(action.query);
		const queries = Array.isArray(action.queries)
			? action.queries
				.filter((item): item is string => typeof item === "string" && item.length > 0)
				.slice(0, 16)
			: [];
		return {
			action_type: type,
			...(query ? { query } : {}),
			...(queries.length > 0 ? { queries } : {}),
		};
	}
	if (type === "open_page") {
		const url = textValue(action.url);
		return { action_type: type, ...(url ? { url } : {}) };
	}
	if (type === "find_in_page") {
		const url = textValue(action.url);
		const pattern = textValue(action.pattern);
		return {
			action_type: type,
			...(url ? { url } : {}),
			...(pattern ? { pattern } : {}),
		};
	}
	return { action_type: "other" };
}

function webSearchDetail(metadata: Readonly<Record<string, unknown>>): string {
	const type = stringValue(metadata.action_type);
	if (type === "search") {
		const query = textValue(metadata.query);
		if (query) return query;
		const queries = Array.isArray(metadata.queries)
			? metadata.queries.filter((item): item is string => typeof item === "string" && item.length > 0)
			: [];
		return queries.length > 1 ? `${queries[0]} ...` : queries[0] ?? "";
	}
	if (type === "open_page") return textValue(metadata.url) ?? "";
	if (type === "find_in_page") {
		const url = textValue(metadata.url);
		const pattern = textValue(metadata.pattern);
		return pattern && url ? `'${pattern}' in ${url}` : pattern ? `'${pattern}'` : url ?? "";
	}
	return "";
}

function clarificationResponseItemId(requestId: string): string {
	return `clarification-response:${requestId}`;
}

function pendingRequestBelongsToDifferentTurn(
	pending: Record<string, unknown> | null,
	event: Record<string, unknown>,
): boolean {
	if (!pending) return false;
	const pendingSessionId = pendingRequestSessionId(pending);
	const eventSessionId = stringValue(event.session_id) ?? stringValue(event.sessionId);
	if (pendingSessionId && eventSessionId) return pendingSessionId !== eventSessionId;
	const pendingTurnId = stringValue(pending.client_turn_id) ?? stringValue(pending.clientTurnId);
	const eventTurnId = stringValue(event.client_turn_id) ?? stringValue(event.clientTurnId);
	if (pendingTurnId && eventTurnId) return pendingTurnId !== eventTurnId;
	return Boolean(
		stringValue(pending.child_session_id) ?? stringValue(pending.childSessionId),
	);
}

function pendingRequestBelongsToStatusSession(
	pending: Record<string, unknown> | null,
	statusSessionId: string | undefined,
	activeSessionId: string | undefined,
): boolean {
	if (!pending) return false;
	const pendingSessionId = pendingRequestSessionId(pending);
	if (pendingSessionId && statusSessionId) return pendingSessionId === statusSessionId;
	if (pendingSessionId && activeSessionId) return pendingSessionId === activeSessionId;
	return true;
}

function pendingRequestSessionId(pending: Record<string, unknown> | null): string | undefined {
	if (!pending) return undefined;
	return stringValue(pending.session_id)
		?? stringValue(pending.sessionId)
		?? stringValue(pending.child_session_id)
		?? stringValue(pending.childSessionId)
		?? undefined;
}

function interactiveResponseMatches(
	pending: Record<string, unknown> | null,
	response: Record<string, unknown>,
	snakeId: string,
	camelId: string,
): boolean {
	if (!pending) return false;
	const pendingId = stringValue(pending[snakeId]) ?? stringValue(pending[camelId]);
	const responseId = stringValue(response[snakeId]) ?? stringValue(response[camelId]);
	if (!pendingId || pendingId !== responseId) return false;
	const pendingSessionId = pendingRequestSessionId(pending);
	const responseSessionId = stringValue(response.session_id) ?? stringValue(response.sessionId);
	return !pendingSessionId || !responseSessionId || pendingSessionId === responseSessionId;
}

function interactiveResponseTurnId(
	state: RuntimeShellState,
	pending: Record<string, unknown> | null,
	response: Record<string, unknown>,
): string | null {
	const pendingSessionId = pendingRequestSessionId(pending);
	const responseSessionId = stringValue(response.session_id) ?? stringValue(response.sessionId);
	const isRootSession = !pendingSessionId
		|| !state.sessionId
		|| pendingSessionId === state.sessionId
		|| responseSessionId === state.sessionId;
	return isRootSession
		? stringValue(response.turn_id) ?? stringValue(response.turnId) ?? state.activeTurnId
		: state.activeTurnId;
}

function approvalOptionsFromPayload(value: unknown): MycliShellPendingApproval["options"] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => {
			const record = recordValue(item);
			const choice = stringValue(record.choice) ?? stringValue(record.value);
			if (!choice) {
				return null;
			}
			return {
				choice,
				label: stringValue(record.label) ?? choice,
			};
		})
		.filter((item): item is MycliShellPendingApproval["options"][number] => item !== null);
}

function defaultApprovalOptions(): MycliShellPendingApproval["options"] {
	return [
		{ choice: "approve_once", label: "Allow once" },
		{ choice: "reject", label: "Reject" },
	];
}

function toolFromTranscriptItem(
	item: RuntimeTranscriptItem,
	workspace: string,
	toolDetailsDefault: MycliShellVisualSettings["toolDetailsDefault"] = "collapsed",
): MycliShellTool {
	const metadata = recordValue(item.metadata);
	const status = toolStatus(metadata);
	const name = stringValue(metadata.tool_name) ?? stringValue(metadata.name) ?? item.text.split(/\s+/, 1)[0] ?? "Tool";
	const display = toolDisplayFromMetadata(metadata);
	if (display) {
		const mutating = display.presentation === "mutation" || mutatingTool(name, metadata);
		const writeContent = mutating && isWriteTool(name) ? display.detail : undefined;
		const mutationDiff = mutating && !isWriteTool(name) ? display.detail : undefined;
		return {
			id: item.id,
			name,
			args: compactTarget(commandTargetPreview(name, display.target ?? null), workspace) ?? undefined,
			status: display.status,
			durationMs: numberValue(display.metrics.duration_ms) ?? undefined,
			mutating,
			contentPreview: writeContent,
			contentLineCount:
				numberValue(display.metrics.line_count) ?? (writeContent ? lineCount(writeContent) : undefined),
			diffPreview: mutationDiff,
			summaryPreview: display.summary || undefined,
			detailPreview: writeContent || mutationDiff ? undefined : display.detail,
			outputPreview: display.summary || undefined,
			errorPreview: display.error,
			presentation: display.presentation,
			displayTruncated: display.truncated,
			displayOmittedChars: display.omittedChars,
			hiddenLineCount: display.truncated ? 1 : undefined,
			hidden: false,
			expanded: item.folded === false || (item.folded === undefined && toolDetailsDefault === "expanded"),
		};
	}
	const rawPayload = recordValue(metadata.raw_payload);
	const argumentsPayload = recordValue(metadata.arguments);
	const argumentSkillName = name.trim().toLowerCase() === "skill"
		? stringValue(argumentsPayload.name)
		: undefined;
	const target =
		stringValue(metadata.skill_name) ??
		stringValue(rawPayload.skill_name) ??
		stringValue(argumentsPayload.skill_name) ??
		argumentSkillName ??
		stringValue(metadata.path) ??
		stringValue(rawPayload.path) ??
		stringValue(argumentsPayload.file_path) ??
		stringValue(argumentsPayload.path) ??
		stringValue(metadata.command) ??
		stringValue(rawPayload.command) ??
		stringValue(metadata.query) ??
		stringValue(rawPayload.query) ??
		stringValue(metadata.context) ??
		stringValue(metadata.args_preview) ??
		item.text.replace(new RegExp(`^${escapeRegExp(name)}\\s*`), "");
	const contentPreview = contentPreviewForTool(name, metadata);
	const diffPreview = diffPreviewForTool(metadata);
	const outputPreview = outputPreviewForTool(name, status, metadata, item.text, contentPreview, diffPreview);
	const errorPreview = stringValue(metadata.error) ?? (status === "error" ? item.text : undefined);
	return {
		id: item.id,
		name,
		args: compactTarget(commandTargetPreview(name, target), workspace) ?? undefined,
		status,
		durationMs: durationMs(metadata),
		mutating: mutatingTool(name, metadata),
		contentPreview,
		contentLineCount: numberValue(metadata.content_line_count) ?? (contentPreview ? lineCount(contentPreview) : undefined),
		diffPreview,
		hidden: false,
		outputPreview,
		errorPreview,
		hiddenLineCount: hiddenLineCountForTool(metadata, contentPreview),
		expanded: item.folded === false || (item.folded === undefined && toolDetailsDefault === "expanded"),
	};
}

type ToolDisplay = {
	target?: string;
	status: MycliShellToolStatus;
	summary: string;
	detail?: string;
	error?: string;
	metrics: Record<string, string | number | boolean>;
	truncated: boolean;
	omittedChars: number;
	presentation: string;
	fileChanges: MycliShellFileChangeEntry[];
};

const DISPLAY_PRESENTATIONS = new Set([
	"tool",
	"context",
	"mutation",
	"shell",
	"skill",
	"web",
	"diagnostic",
	"control",
	"external",
]);

function toolDisplayFromMetadata(metadata: Record<string, unknown>): ToolDisplay | null {
	const display = recordValue(metadata.display);
	const rawStatus = stringValue(display.status);
	const summary = typeof display.summary === "string" ? display.summary : null;
	if (!rawStatus || summary === null) return null;
	let status: MycliShellToolStatus;
	if (rawStatus === "success" || rawStatus === "error" || rawStatus === "cancelled") {
		status = rawStatus;
	} else if (rawStatus === "running" || rawStatus === "waiting") {
		status = "running";
	} else {
		return null;
	}
	const rawPresentation = stringValue(display.presentation) ?? "tool";
	return {
		target: stringValue(display.target) ?? undefined,
		status,
		summary,
		detail: textValue(display.detail) ?? undefined,
		error: textValue(display.error) ?? undefined,
		metrics: scalarDisplayMetrics(display.metrics),
		truncated: booleanValue(display.truncated) ?? false,
		omittedChars: numberValue(display.omitted_chars) ?? 0,
		presentation: DISPLAY_PRESENTATIONS.has(rawPresentation) ? rawPresentation : "tool",
		fileChanges: fileChangeEntriesFromUnknown(display.file_changes),
	};
}

function fileChangeFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellFileChange | null {
	const metadata = recordValue(item.metadata);
	const display = toolDisplayFromMetadata(metadata);
	const name = stringValue(metadata.tool_name) ?? stringValue(metadata.name) ?? item.text.split(/\s+/, 1)[0] ?? "Tool";
	const recognizedMutation = isFileMutationTool(name);
	const directFiles = fileChangeEntriesFromUnknown(metadata.file_changes);
	if (!recognizedMutation && directFiles.length === 0 && (!display || display.fileChanges.length === 0)) {
		return null;
	}
	const status = display?.status ?? toolStatus(metadata);
	const proposal = metadata.file_mutation_proposal === true;
	if ((status === "running" && !proposal) || status === "cancelled") return null;

	const files = display?.fileChanges.length
		? display.fileChanges
		: directFiles.length > 0
			? directFiles
			: legacyFileChangeEntries(name, metadata, display?.target);
	const summary = display?.summary ?? stringValue(metadata.summary) ?? item.text;
	const target =
		display?.target ??
		stringValue(metadata.path) ??
		stringValue(recordValue(metadata.raw_payload).path) ??
		undefined;
	const callId = stringValue(metadata.call_id) ?? undefined;

	if (status === "error" && recognizedMutation) {
		return {
			id: item.id,
			callId,
			status: "error",
			summary: summary || "Failed to update file",
			target,
			files: [],
			error: display?.error ?? textValue(metadata.error) ?? undefined,
		};
	}
	if (files.length > 0) {
		return { id: item.id, callId, status: "success", summary, target, files };
	}
	if (recognizedMutation && summary.trim().toLowerCase().startsWith("no changes")) {
		return { id: item.id, callId, status: "unchanged", summary, target, files: [] };
	}
	return null;
}

function fileChangeEntriesFromUnknown(value: unknown): MycliShellFileChangeEntry[] {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, 64)
		.map(fileChangeEntryFromUnknown)
		.filter((entry): entry is MycliShellFileChangeEntry => entry !== null);
}

function fileChangeEntryFromUnknown(value: unknown): MycliShellFileChangeEntry | null {
	const record = recordValue(value);
	if (record.version !== 1) return null;
	const kind = fileChangeKind(record.kind);
	const path = stringValue(record.path);
	if (!kind || !path) return null;
	const diff = textValue(record.diff) ?? "";
	const counts = countDiffLines(diff);
	return {
		version: 1,
		kind,
		path,
		previousPath: stringValue(record.previous_path) ?? stringValue(record.previousPath) ?? undefined,
		diff,
		addedLines: nonnegativeInteger(record.added_lines) ?? nonnegativeInteger(record.addedLines) ?? counts.added,
		removedLines: nonnegativeInteger(record.removed_lines) ?? nonnegativeInteger(record.removedLines) ?? counts.removed,
		truncated: booleanValue(record.truncated) ?? false,
		omittedChars: nonnegativeInteger(record.omitted_chars) ?? nonnegativeInteger(record.omittedChars) ?? 0,
		language: stringValue(record.language) ?? languageForPath(path),
	};
}

function legacyFileChangeEntries(
	name: string,
	metadata: Record<string, unknown>,
	target: string | undefined,
): MycliShellFileChangeEntry[] {
	const normalized = normalizeToolName(name);
	const rawPayload = recordValue(metadata.raw_payload);
	const rawStatus = (stringValue(rawPayload.status) ?? stringValue(metadata.status) ?? "").toLowerCase();
	const legacyChanges = Array.isArray(metadata.file_changes) ? metadata.file_changes.map(recordValue) : [];
	const legacyKind = legacyChanges.map((change) => normalizeToolName(stringValue(change.kind) ?? ""));
	const safelyUpdated =
		normalized === "edit" ||
		normalized === "editfile" ||
		normalized === "patch" ||
		normalized === "patchfile" ||
		["edited", "patched", "overwritten", "written"].includes(rawStatus) ||
		legacyKind.some((kind) => kind === "edit" || kind === "patch");
	if (!safelyUpdated) return [];
	const diff = diffPreviewForTool(metadata);
	const path = target ?? stringValue(metadata.path) ?? stringValue(rawPayload.path);
	if (!diff || !path) return [];
	const counts = countDiffLines(diff);
	return [{
		version: 1,
		kind: "update",
		path,
		diff,
		addedLines: counts.added,
		removedLines: counts.removed,
		truncated: booleanValue(metadata.diff_truncated) ?? false,
		omittedChars: 0,
		language: languageForPath(path),
	}];
}

function fileChangeKind(value: unknown): MycliShellFileChangeEntry["kind"] | null {
	if (value === "move") return "rename";
	return value === "add" || value === "update" || value === "delete" || value === "rename"
		? value
		: null;
}

function countDiffLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return { added, removed };
}

function nonnegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function languageForPath(path: string): string | undefined {
	const leaf = path.replace(/\\/g, "/").split("/").pop() ?? "";
	const dot = leaf.lastIndexOf(".");
	return dot > 0 && dot < leaf.length - 1 ? leaf.slice(dot + 1).toLowerCase() : undefined;
}

function isFileMutationTool(name: string): boolean {
	return new Set(["write", "writefile", "edit", "editfile", "patch", "patchfile"]).has(normalizeToolName(name));
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase().replace(/[_-]/g, "");
}

function suppressGenericToolRow(tool: MycliShellTool): boolean {
	return tool.status !== "error"
		&& tool.status !== "cancelled"
		&& SEMANTIC_TOOL_ROW_NAMES.has(normalizeToolName(tool.name));
}

function fileChangeFallbackText(change: MycliShellFileChange): string {
	if (change.status === "error") return `${change.summary}${change.error ? `: ${change.error}` : ""}`;
	if (change.status === "unchanged") return change.target ? `No changes to ${change.target}` : change.summary;
	if (change.files.length === 1) {
		const file = change.files[0]!;
		const verb = file.kind === "add" ? "Added" : file.kind === "delete" ? "Deleted" : file.kind === "rename" ? "Renamed" : "Edited";
		return `${verb} ${file.path} (+${file.addedLines} -${file.removedLines})`;
	}
	const added = change.files.reduce((total, file) => total + file.addedLines, 0);
	const removed = change.files.reduce((total, file) => total + file.removedLines, 0);
	return `Edited ${change.files.length} files (+${added} -${removed})`;
}

function scalarDisplayMetrics(value: unknown): Record<string, string | number | boolean> {
	const raw = recordValue(value);
	const metrics: Record<string, string | number | boolean> = {};
	for (const [key, item] of Object.entries(raw).slice(0, 16)) {
		if (typeof item === "string" || typeof item === "boolean") {
			metrics[key] = item;
		} else if (typeof item === "number" && Number.isFinite(item)) {
			metrics[key] = item;
		}
	}
	return metrics;
}

function transcriptItemFromSubagent(subagent: Record<string, unknown>): RuntimeTranscriptItem | null {
	const childSessionId = stringValue(subagent.child_session_id) ?? stringValue(subagent.childSessionId);
	const role = stringValue(subagent.role) ?? stringValue(subagent.agent_type) ?? stringValue(subagent.name);
	if (!childSessionId || !role) {
		return null;
	}
	const id = stringValue(subagent.thread_id)
		?? stringValue(subagent.threadId)
		?? stringValue(subagent.run_id)
		?? `subagent:${childSessionId}`;
	return {
		id,
		type: "subagent",
		text: stringValue(subagent.summary) ?? stringValue(subagent.report) ?? "",
		folded: true,
		metadata: subagent,
	};
}

function subagentFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellSubagent | null {
	const metadata = recordValue(item.metadata);
	const childSessionId = stringValue(metadata.child_session_id) ?? stringValue(metadata.childSessionId);
	const role = stringValue(metadata.role) ?? stringValue(metadata.agent_type) ?? stringValue(metadata.name);
	if (!childSessionId || !role) {
		return null;
	}
	const status = stringValue(metadata.status) ?? "completed";
	return {
		id: stringValue(metadata.thread_id) ?? stringValue(metadata.threadId)
			?? stringValue(metadata.run_id) ?? item.id,
		threadId: stringValue(metadata.thread_id) ?? stringValue(metadata.threadId) ?? undefined,
		rootThreadId: stringValue(metadata.root_thread_id) ?? stringValue(metadata.rootThreadId) ?? undefined,
		parentThreadId: stringValue(metadata.parent_thread_id) ?? stringValue(metadata.parentThreadId) ?? undefined,
		agentPath: stringValue(metadata.agent_path) ?? stringValue(metadata.agentPath) ?? undefined,
		taskName: stringValue(metadata.task_name) ?? stringValue(metadata.taskName) ?? undefined,
		nickname: stringValue(metadata.nickname) ?? undefined,
		lifecycleKind: stringValue(metadata.lifecycle_kind) ?? stringValue(metadata.lifecycleKind) ?? undefined,
		role,
		description: stringValue(metadata.description) ?? undefined,
		status,
		mode: stringValue(metadata.mode) ?? undefined,
		childSessionId,
		parentTurnId: stringValue(metadata.parent_turn_id) ?? stringValue(metadata.parentTurnId) ?? undefined,
		summary: (stringValue(metadata.summary) ?? stringValue(metadata.report) ?? item.text) || undefined,
		toolCalls: numberValue(metadata.tool_calls) ?? numberValue(metadata.toolCalls) ?? undefined,
		tokens: numberValue(metadata.total_tokens) ?? numberValue(metadata.tokens) ?? undefined,
		durationMs: numberValue(metadata.duration_ms) ?? durationSecondsToMs(metadata.duration_s),
		error: stringValue(metadata.error) ?? undefined,
		path: stringValue(metadata.path) ?? undefined,
		startedAt: stringValue(metadata.started_at) ?? stringValue(metadata.startedAt) ?? undefined,
		completedAt: stringValue(metadata.completed_at) ?? stringValue(metadata.completedAt) ?? undefined,
		progress: subagentProgressFromMetadata(metadata),
	};
}

function subagentProgressFromMetadata(metadata: Record<string, unknown>): MycliShellSubagent["progress"] {
	const raw = Array.isArray(metadata.progress) ? metadata.progress : [];
	return raw
		.map((item): NonNullable<MycliShellSubagent["progress"]>[number] | null => {
			const record = recordValue(item);
			const kind = stringValue(record.kind);
			if (!kind) {
				return null;
			}
			return {
				kind,
				toolName: stringValue(record.tool_name) ?? stringValue(record.toolName) ?? undefined,
				callId: stringValue(record.call_id) ?? stringValue(record.callId) ?? undefined,
				summary: stringValue(record.summary) ?? undefined,
				status: stringValue(record.status) ?? undefined,
			};
		})
		.filter((item): item is NonNullable<MycliShellSubagent["progress"]>[number] => item !== null);
}

function durationSecondsToMs(value: unknown): number | undefined {
	const seconds = numberValue(value);
	return seconds === null ? undefined : Math.round(seconds * 1000);
}

function contentPreviewForTool(name: string, metadata: Record<string, unknown>): string | undefined {
	if (!isWriteTool(name)) {
		return undefined;
	}
	return (
		stringValue(metadata.content_preview) ??
		stringValue(recordValue(metadata.arguments).content) ??
		stringValue(metadata.content) ??
		stringValue(recordValue(metadata.raw_payload).content) ??
		stringValue(recordValue(recordValue(metadata.raw_payload).arguments).content) ??
		undefined
	);
}

function diffPreviewForTool(metadata: Record<string, unknown>): string | undefined {
	return (
		stringValue(metadata.diff) ??
		stringValue(recordValue(metadata.raw_payload).diff) ??
		stringValue(recordValue(metadata.details).diff) ??
		stringValue(recordValue(recordValue(metadata.raw_payload).details).diff) ??
		undefined
	);
}

function outputPreviewForTool(
	name: string,
	status: MycliShellToolStatus,
	metadata: Record<string, unknown>,
	itemText: string,
	contentPreview: string | undefined,
	diffPreview: string | undefined,
): string | undefined {
	if (status === "success" && (contentPreview || diffPreview) && mutatingTool(name, metadata)) {
		return undefined;
	}
	if (isShellTool(name)) {
		return textValue(metadata.summary) ?? textValue(metadata.output_preview) ?? textValue(metadata.stdout) ?? textValue(metadata.stderr) ?? undefined;
	}
	return textValue(metadata.summary) ?? textValue(metadata.output_preview) ?? (status === "success" ? itemText : undefined);
}

function hiddenLineCountForTool(metadata: Record<string, unknown>, contentPreview: string | undefined): number | undefined {
	if (metadata.summary_truncated === true || metadata.error_truncated === true) {
		return 1;
	}
	if (!contentPreview) {
		return undefined;
	}
	const hidden = lineCount(contentPreview) - 10;
	return hidden > 0 ? hidden : undefined;
}

function isWriteTool(name: string): boolean {
	return name.toLowerCase() === "write" || name.toLowerCase() === "write_file";
}

function lineCount(text: string): number {
	const trimmed = text.replace(/\n+$/g, "");
	return trimmed ? trimmed.split("\n").length : 0;
}

function toolStatus(metadata: Record<string, unknown>): MycliShellToolStatus {
	if (metadata.status === "running") return "running";
	if (metadata.status === "failed" || metadata.success === false) return "error";
	if (metadata.success === true || metadata.status === "done") return "success";
	return "running";
}

function durationMs(metadata: Record<string, unknown>): number | undefined {
	const ms = numberValue(metadata.duration_ms);
	if (ms !== null) return ms;
	const seconds = numberValue(metadata.duration_s);
	return seconds === null ? undefined : seconds * 1000;
}

function mutatingTool(name: string, metadata: Record<string, unknown>): boolean {
	const lower = name.toLowerCase();
	return lower.includes("edit") || lower.includes("write") || lower.includes("patch") || Array.isArray(metadata.file_changes);
}

function isShellTool(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "bash" || lower === "shell" || lower === "run_shell";
}

function commandTargetPreview(name: string, target: string | null): string | null {
	if (!target || !isShellTool(name)) {
		return target;
	}
	const lines = target
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length <= 1) {
		return target;
	}
	const firstLine = lines[0] ?? "command";
	return `${firstLine} ... (${lines.length} lines)`;
}

function planStatus(metadata: unknown): "proposed" | "accepted" | "stale" {
	const status = stringValue(recordValue(metadata).status);
	return status === "accepted" || status === "stale" ? status : "proposed";
}

function planStepsFromPayload(value: unknown): MycliShellPlanStep[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item, index) => planStepFromString(String(item), index))
		.filter((item): item is MycliShellPlanStep => item !== null);
}

function planUpdateFromPayload(
	payload: Record<string, unknown>,
	id: string,
	text = "Updated Plan",
): RuntimeTranscriptItem | null {
	const plan = recordValue(payload.plan);
	const rawItems = Array.isArray(plan.items)
		? plan.items
		: Array.isArray(payload.items)
			? payload.items
			: null;
	const steps = rawItems !== null
		? rawItems
				.map((item, index) => planStepFromRecord(recordValue(item), index))
				.filter((item): item is MycliShellPlanStep => item !== null)
		: Array.isArray(payload.plan_steps)
			? planStepsFromPayload(payload.plan_steps)
			: null;
	if (steps === null || (rawItems !== null && steps.length !== rawItems.length)) {
		return null;
	}
	const completed = steps.filter((step) => step.status === "completed").length;
	return {
		id,
		type: "plan_update",
		text: text.trim() || "Updated Plan",
		folded: false,
		metadata: {
			source: stringValue(payload.source) ?? "Plan",
			...(stringValue(payload.explanation)
				? { explanation: stringValue(payload.explanation) }
				: {}),
			completed,
			total: steps.length,
			items: steps,
		},
	};
}

function planUpdateFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellPlanUpdate | null {
	const metadata = recordValue(item.metadata);
	const rawItems = metadata.items;
	if (!Array.isArray(rawItems)) return null;
	const steps = rawItems
		.map((entry, index) => planStepFromRecord(recordValue(entry), index))
		.filter((step): step is MycliShellPlanStep => step !== null);
	if (steps.length !== rawItems.length) return null;
	return {
		id: item.id,
		title: item.text.trim() || "Updated Plan",
		source: stringValue(metadata.source) ?? undefined,
		explanation: stringValue(metadata.explanation) ?? undefined,
		steps,
		completed: steps.filter((step) => step.status === "completed").length,
		total: steps.length,
	};
}

function taskProgressFromPlanUpdate(
	item: RuntimeTranscriptItem,
): { completed: number; total: number } | null {
	const update = planUpdateFromTranscriptItem(item);
	if (!update || update.total === 0) return null;
	return { completed: update.completed, total: update.total };
}

function planStepFromRecord(record: Record<string, unknown>, index: number): MycliShellPlanStep | null {
	const text = stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.step);
	if (!text) return null;
	const evidence = stringArrayValue(record.evidence);
	return {
		id: stringValue(record.id) ?? `step-${index + 1}`,
		status: planStepStatus(stringValue(record.status) ?? undefined),
		text,
		...(evidence.length > 0 ? { evidence } : {}),
	};
}

function planStepFromString(value: string, index: number): MycliShellPlanStep | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = /^(pending|in_progress|completed)\s*:\s*(.+)$/i.exec(trimmed);
	const status = planStepStatus(match?.[1]);
	const text = (match?.[2] ?? trimmed).trim();
	if (!text) return null;
	return {
		id: `step-${index + 1}`,
		status,
		text,
	};
}

function planStepStatus(value: string | undefined): MycliShellPlanStep["status"] {
	if (value === "completed" || value === "in_progress") return value;
	return "pending";
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

function reasoningForAssistant(
	item: RuntimeTranscriptItem,
	itemIndex: number,
	state: RuntimeShellState,
): string | undefined {
	if (item.id === state.activeAssistantItemId && state.liveReasoning?.text.trim()) {
		return state.liveReasoning.text;
	}
	return nearbyReasoningFor(itemIndex, state.transcript);
}

function nearbyReasoningFor(itemIndex: number, items: RuntimeTranscriptItem[]): string | undefined {
	for (let cursor = Math.max(0, itemIndex - 2); cursor < itemIndex; cursor += 1) {
		const candidate = items[cursor];
		if (candidate?.type === "reasoning" && candidate.text.trim()) {
			return candidate.text;
		}
	}
	return undefined;
}

function applyAssistantDelta(items: RuntimeTranscriptItem[], assistantId: string, text: string): RuntimeTranscriptItem[] {
	const lastIndex = items.length - 1;
	const last = items[lastIndex];
	if (last?.id === assistantId && last.type === "assistant_stream") {
		return items.with(lastIndex, { ...last, text: `${last.text}${text}` });
	}
	if (last?.id === assistantId && last.type === "assistant_final") {
		return items.with(lastIndex, {
			...last,
			type: "assistant_stream",
			text: `${last.text}${text}`,
		});
	}
	const streamIndex = items.findIndex(
		(item) => item.id === assistantId && item.type === "assistant_stream",
	);
	if (streamIndex >= 0) {
		const item = items[streamIndex]!;
		return items.with(streamIndex, { ...item, text: `${item.text}${text}` });
	}
	const finalIndex = items.findIndex(
		(item) => item.id === assistantId && item.type === "assistant_final",
	);
	if (finalIndex >= 0) {
		const item = items[finalIndex]!;
		return items.with(finalIndex, {
			...item,
			type: "assistant_stream",
			text: `${item.text}${text}`,
		});
	}
	return [...items, { id: assistantId, type: "assistant_stream", text, folded: false, metadata: {} }];
}

function rollbackActiveAssistantAttempt(state: RuntimeShellState): RuntimeShellState {
	const activeId = state.activeAssistantItemId;
	let start = activeId === null ? -1 : state.transcript.findIndex((item) => item.id === activeId);
	let end = start;
	if (start >= 0) {
		while (start > 0 && state.transcript[start - 1]?.type === "reasoning") start -= 1;
		while (end + 1 < state.transcript.length && state.transcript[end + 1]?.type === "reasoning") end += 1;
	} else {
		end = state.transcript.length - 1;
		start = end;
		while (start >= 0 && state.transcript[start]?.type === "reasoning") start -= 1;
		start += 1;
	}
	const transcript = (start >= 0 && end >= start
		? [...state.transcript.slice(0, start), ...state.transcript.slice(end + 1)]
		: state.transcript).filter((item) => !(
		item.type === "web_search"
		&& booleanValue(recordValue(item.metadata).transient) === true
	));
	return {
		...state,
		activeAssistantItemId: nextId("assistant"),
		liveReasoning: null,
		transcript,
	};
}

function commitCompletedWebSearchItems(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	let changed = false;
	const committed = items.map((item) => {
		const metadata = recordValue(item.metadata);
		if (item.type !== "web_search"
			|| (stringValue(item.status) ?? stringValue(metadata.status)) !== "completed"
			|| booleanValue(metadata.transient) !== true) return item;
		changed = true;
		return { ...item, metadata: { ...metadata, transient: false } };
	});
	return changed ? committed : items;
}

function finalizeTransientWebSearchItems(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	let changed = false;
	const finalized: RuntimeTranscriptItem[] = [];
	for (const item of items) {
		const metadata = recordValue(item.metadata);
		if (item.type !== "web_search" || booleanValue(metadata.transient) !== true) {
			finalized.push(item);
			continue;
		}
		changed = true;
		if ((stringValue(item.status) ?? stringValue(metadata.status)) !== "completed") continue;
		finalized.push({ ...item, metadata: { ...metadata, transient: false } });
	}
	return changed ? finalized : items;
}

function reconcileFinalAnswer(items: RuntimeTranscriptItem[], assistantId: string | null, answer: string): RuntimeTranscriptItem[] {
	const streamIndex =
		assistantId !== null
			? items.findIndex((item) => item.id === assistantId && item.type === "assistant_stream")
			: findLastIndex(items, (item) => item.type === "assistant_stream");
	if (!answer.trim()) {
		return streamIndex >= 0 ? [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)] : items;
	}
	const fallbackId = assistantId ?? nextId("assistant");
	const finalIndex = items.findIndex((item) => item.id === fallbackId && item.type === "assistant_final");
	const finalText = finalAnswerSuffix(items, streamIndex >= 0 ? streamIndex : finalIndex, answer);
	if (!finalText.trim()) {
		if (streamIndex >= 0) {
			return [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)];
		}
		return items;
	}
	const finalItem = {
		id: streamIndex >= 0 ? items[streamIndex]!.id : fallbackId,
		type: "assistant_final",
		text: finalText,
		folded: false,
		metadata: {},
	};
	if (finalIndex >= 0) {
		return [...items.slice(0, finalIndex), finalItem, ...items.slice(finalIndex + 1)];
	}
	return streamIndex >= 0 ? [...items.slice(0, streamIndex), finalItem, ...items.slice(streamIndex + 1)] : [...items, finalItem];
}

function sealAssistantStream(items: RuntimeTranscriptItem[], assistantId: string): RuntimeTranscriptItem[] {
	const streamIndex = items.findIndex((item) => item.id === assistantId && item.type === "assistant_stream");
	if (streamIndex < 0) {
		return items;
	}
	const item = items[streamIndex]!;
	if (!item.text.trim()) {
		return [...items.slice(0, streamIndex), ...items.slice(streamIndex + 1)];
	}
	return [
		...items.slice(0, streamIndex),
		{ ...item, type: "assistant_final", folded: false },
		...items.slice(streamIndex + 1),
	];
}

function sealActiveAssistantStream(items: RuntimeTranscriptItem[], assistantId: string | null): RuntimeTranscriptItem[] {
	return assistantId === null ? items : sealAssistantStream(items, assistantId);
}

function applyProposedPlan(items: RuntimeTranscriptItem[], params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const text = String(params.text ?? "").trim();
	if (!text) return items;
	const clientTurnId = stringValue(params.client_turn_id) ?? "turn";
	const id = `plan:${clientTurnId}`;
	const item = {
		id,
		type: "proposed_plan",
		text,
		folded: false,
		metadata: { ...params, status: stringValue(params.status) ?? "proposed" },
	};
	const existingIndex = items.findIndex((candidate) => candidate.id === id || candidate.type === "proposed_plan");
	if (existingIndex >= 0) {
		return [...items.slice(0, existingIndex), item, ...items.slice(existingIndex + 1)];
	}
	return [...items, item];
}

function finalAnswerSuffix(items: RuntimeTranscriptItem[], replaceIndex: number, answer: string): string {
	const turnStart = findLastIndex(items, (item) => item.type === "user");
	const end = replaceIndex >= 0 ? replaceIndex : items.length;
	const visiblePrefix = items
		.slice(turnStart + 1, end)
		.filter((item) => item.type === "assistant_stream" || item.type === "assistant_final")
		.map((item) => item.text)
		.join("");
	if (!visiblePrefix || !answer.startsWith(visiblePrefix)) {
		return answer;
	}
	return answer.slice(visiblePrefix.length);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (predicate(items[index]!)) {
			return index;
		}
	}
	return -1;
}

function applyReasoning(items: RuntimeTranscriptItem[], text: string, metadata: Record<string, unknown>): RuntimeTranscriptItem[] {
	const last = items.at(-1);
	const item = {
		id: last?.type === "reasoning" ? last.id : nextId("reasoning"),
		type: "reasoning",
		text,
		folded: true,
		metadata,
	};
	return last?.type === "reasoning" ? items.with(-1, item) : [...items, item];
}

const SHELL_OUTPUT_PREVIEW_BUDGET = 10_000;

function applyShellBootstrap(state: RuntimeShellState, value: unknown): RuntimeShellState {
	if (!Array.isArray(value)) return state;
	let nextState = state;
	for (const rawRow of value) {
		const row = recordValue(rawRow);
		const shellId = stringValue(row.shell_id);
		if (!shellId || nextState.shellEventSequences[shellId] !== undefined) continue;
		nextState = applyShellLifecycle(nextState, "shell.started", {
			...row,
			shell_id: shellId,
			sequence: 0,
			background: true,
			process_state: stringValue(row.process_state) ?? "running_background",
			output_delta: textValue(row.output) ?? "",
		});
	}
	return {
		...nextState,
		backgroundShellCount: Object.keys(nextState.backgroundShells).length,
	};
}

function applyShellLifecycle(
	state: RuntimeShellState,
	method: string,
	params: Record<string, unknown>,
): RuntimeShellState {
	const shellId = stringValue(params.shell_id);
	const sequence = numberValue(params.sequence);
	if (!shellId || sequence === null || !Number.isInteger(sequence)) return state;
	const previousSequence = state.shellEventSequences[shellId];
	if (previousSequence !== undefined && sequence <= previousSequence) return state;

	const shellEventSequences = { ...state.shellEventSequences, [shellId]: sequence };
	let lifecycleState = { ...state, shellEventSequences };
	let activeBackgroundCount: number | null = null;
	if (method === "shell.list.updated") {
		activeBackgroundCount = numberValue(params.active_background_count);
		lifecycleState = {
			...lifecycleState,
			backgroundShellCount:
				activeBackgroundCount !== null && Number.isInteger(activeBackgroundCount) && activeBackgroundCount >= 0
					? activeBackgroundCount
					: state.backgroundShellCount,
		};
		const updatesProcess = ["background", "process_state", "transport", "tty", "yielded"]
			.some((key) => Object.prototype.hasOwnProperty.call(params, key));
		if (!updatesProcess) return lifecycleState;
	}
	if (method === "shell.removed") {
		const backgroundShells = { ...lifecycleState.backgroundShells };
		delete backgroundShells[shellId];
		return { ...lifecycleState, backgroundShells };
	}

	const callId = stringValue(params.call_id) ?? undefined;
	const transcriptIndex = findShellTranscriptIndex(lifecycleState.transcript, shellId, callId);
	const existingItem = transcriptIndex >= 0 ? lifecycleState.transcript[transcriptIndex] : undefined;
	const existingMetadata = recordValue(existingItem?.metadata);
	const existingTerminalState = stringValue(existingMetadata.terminal_state);
	const incomingTerminalState = stringValue(params.terminal_state) ?? undefined;
	if (existingTerminalState && !incomingTerminalState) {
		return lifecycleState;
	}

	const existingProcess = lifecycleState.backgroundShells[shellId];
	const commandPreview =
		stringValue(params.command_preview) ??
		existingProcess?.commandPreview ??
		stringValue(existingMetadata.command_preview) ??
		stringValue(existingMetadata.command) ??
		"command";
	const description =
		stringValue(params.description)?.trim() ??
		existingProcess?.description ??
		stringValue(existingMetadata.description)?.trim() ??
		undefined;
	const background = booleanValue(params.background) ?? existingProcess?.background ?? false;
	const processState =
		stringValue(params.process_state) ??
		existingProcess?.processState ??
		(incomingTerminalState ? incomingTerminalState : background ? "running_background" : "running_foreground");
	const shellKind = stringValue(params.shell_kind) ?? existingProcess?.shellKind ?? stringValue(existingMetadata.shell_kind) ?? undefined;
	const shellEdition = stringValue(params.shell_edition) ?? existingProcess?.shellEdition ?? stringValue(existingMetadata.shell_edition) ?? undefined;
	const transport = stringValue(params.transport) ?? existingProcess?.transport ?? stringValue(existingMetadata.transport) ?? undefined;
	const tty = booleanValue(params.tty) ?? existingProcess?.tty ?? booleanValue(existingMetadata.tty) ?? undefined;
	const yielded = booleanValue(params.yielded) ?? existingProcess?.yielded ?? booleanValue(existingMetadata.yielded) ?? undefined;
	const existingOutput =
		existingProcess?.outputPreview ??
		textValue(existingMetadata.output_preview) ??
		textValue(existingMetadata.summary) ??
		"";
	const outputPreview = boundedShellOutput(
		existingOutput,
		textValue(params.output_delta) ?? "",
		numberValue(params.omitted_output_chars) ?? existingProcess?.omittedOutputChars ?? 0,
	);
	const process: RuntimeShellProcess = {
		shellId,
		...(callId ? { callId } : existingProcess?.callId ? { callId: existingProcess.callId } : {}),
		commandPreview,
		...(description ? { description } : {}),
		background,
		processState,
		...(transport ? { transport } : {}),
		...(tty !== undefined ? { tty } : {}),
		...(yielded !== undefined ? { yielded } : {}),
		...(incomingTerminalState ? { terminalState: incomingTerminalState } : {}),
		...(numberValue(params.exit_code) !== null ? { exitCode: numberValue(params.exit_code)! } : {}),
		sequence,
		...(stringValue(params.started_at) ? { startedAt: stringValue(params.started_at)! } : {}),
		...(stringValue(params.completed_at) ? { completedAt: stringValue(params.completed_at)! } : {}),
		outputPreview,
		nextCursor: numberValue(params.next_cursor) ?? existingProcess?.nextCursor ?? 0,
		outputChars: numberValue(params.output_chars) ?? existingProcess?.outputChars ?? outputPreview.length,
		omittedOutputChars: numberValue(params.omitted_output_chars) ?? existingProcess?.omittedOutputChars ?? 0,
		...(stringValue(params.cleanup_result) ? { cleanupResult: stringValue(params.cleanup_result)! } : {}),
		...(shellKind ? { shellKind } : {}),
		...(shellEdition ? { shellEdition } : {}),
	};

	const backgroundShells = { ...lifecycleState.backgroundShells };
	if (background && !incomingTerminalState) {
		backgroundShells[shellId] = process;
	} else {
		delete backgroundShells[shellId];
	}
	const successful = incomingTerminalState === "completed" && (process.exitCode === undefined || process.exitCode === 0);
	const metadata: Record<string, unknown> = {
		...existingMetadata,
		...params,
		tool_name: stringValue(existingMetadata.tool_name) ?? (shellKind ? "Shell" : "Bash"),
		call_id: callId ?? stringValue(existingMetadata.call_id),
		shell_id: shellId,
		command_preview: commandPreview,
		command: stringValue(existingMetadata.command) ?? commandPreview,
		description,
		background,
		process_state: processState,
		transport: process.transport,
		tty: process.tty,
		yielded: process.yielded,
		terminal_state: incomingTerminalState,
		exit_code: process.exitCode,
		shell_sequence: sequence,
		started_at: process.startedAt,
		completed_at: process.completedAt,
		output_chars: process.outputChars,
		omitted_output_chars: process.omittedOutputChars,
		cleanup_result: process.cleanupResult,
		shell_kind: process.shellKind,
		shell_edition: process.shellEdition,
		output_preview: outputPreview,
		summary: outputPreview || undefined,
		status: incomingTerminalState ? (successful ? "done" : "failed") : "running",
		success: incomingTerminalState ? successful : undefined,
	};
	metadata.display = shellDisplayEnvelope({
		metadata,
		shellId,
		commandPreview,
		outputPreview,
		terminalState: incomingTerminalState,
		exitCode: process.exitCode,
	});
	const item: RuntimeTranscriptItem = {
		id: existingItem?.id ?? nextId("shell"),
		type: "tool_summary",
		text: `${stringValue(metadata.tool_name) ?? "Shell"} ${commandPreview}`,
		folded: existingItem?.folded ?? true,
		metadata,
	};
	const transcript =
		transcriptIndex >= 0
			? [...lifecycleState.transcript.slice(0, transcriptIndex), item, ...lifecycleState.transcript.slice(transcriptIndex + 1)]
			: [...lifecycleState.transcript, item];
	return {
		...lifecycleState,
		transcript,
		backgroundShells,
		backgroundShellCount:
			activeBackgroundCount !== null && Number.isInteger(activeBackgroundCount) && activeBackgroundCount >= 0
				? activeBackgroundCount
				: Object.keys(backgroundShells).length,
		shellEventSequences,
	};
}

function findShellTranscriptIndex(
	items: RuntimeTranscriptItem[],
	shellId: string,
	callId: string | undefined,
): number {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.type !== "tool_summary" && item?.type !== "tool_detail") continue;
		const metadata = recordValue(item.metadata);
		const rawPayload = recordValue(metadata.raw_payload);
		if (callId && stringValue(metadata.call_id) === callId) return index;
		if (stringValue(metadata.shell_id) === shellId || stringValue(rawPayload.shell_id) === shellId) return index;
	}
	return -1;
}

function boundedShellOutput(existing: string, delta: string, omittedChars: number): string {
	const combined = `${existing}${delta}`;
	if (combined.length <= SHELL_OUTPUT_PREVIEW_BUDGET && omittedChars <= 0) return combined;
	const initiallyOmitted = Math.max(0, omittedChars);
	const marker = (count: number) => `\n... ${count} chars omitted ...\n`;
	let totalOmitted = initiallyOmitted;
	let markerText = marker(totalOmitted);
	let available = Math.max(0, SHELL_OUTPUT_PREVIEW_BUDGET - markerText.length);
	if (combined.length > available) totalOmitted += combined.length - available;
	markerText = marker(totalOmitted);
	available = Math.max(0, SHELL_OUTPUT_PREVIEW_BUDGET - markerText.length);
	if (combined.length <= available) return `${markerText}${combined}`;
	const headLength = Math.floor(available / 2);
	const tailLength = available - headLength;
	return `${combined.slice(0, headLength)}${markerText}${combined.slice(-tailLength)}`;
}

function applyToolLifecycle(items: RuntimeTranscriptItem[], method: string, params: Record<string, unknown>): RuntimeTranscriptItem[] {
	if (isShellOutputLifecycle(params) && method !== "tool.failed") {
		const withoutPollingItem = removeToolLifecycleItem(items, params);
		if (method !== "tool.complete") {
			return withoutPollingItem;
		}
		const merged = mergeShellOutputIntoExecution(withoutPollingItem, params);
		if (merged !== null) {
			return merged;
		}
		return withoutPollingItem;
	}
	const rawPayload = recordValue(params.raw_payload);
	const backgroundStillRunning =
		method === "tool.complete" &&
		isShellTool(stringValue(params.name) ?? stringValue(params.tool_name) ?? "") &&
		stringValue(rawPayload.status) === "running";
	const metadata = {
		...params,
		tool_name: stringValue(params.name) ?? stringValue(params.tool_name) ?? "Tool",
		status: method === "tool.failed" ? "failed" : method === "tool.complete" && !backgroundStillRunning ? "done" : "running",
	};
	const matchIndex = findToolIndex(items, metadata);
	const item = {
		id: matchIndex >= 0 ? items[matchIndex]!.id : nextId("tool"),
		type: "tool_summary",
		text: lifecycleToolText(metadata),
		folded: true,
		metadata: matchIndex >= 0 ? { ...recordValue(items[matchIndex]!.metadata), ...metadata } : metadata,
	};
	return matchIndex >= 0 ? [...items.slice(0, matchIndex), item, ...items.slice(matchIndex + 1)] : [...items, item];
}

function removeTransientApprovalItems(items: RuntimeTranscriptItem[], decisionId?: string): RuntimeTranscriptItem[] {
	return items.filter((item) => {
		if (item.type !== "approval") return true;
		if (!decisionId) return false;
		const metadata = recordValue(item.metadata);
		const itemDecisionId = stringValue(metadata.decision_id) ?? stringValue(metadata.decisionId);
		return itemDecisionId !== decisionId;
	});
}

function removeTransientClarificationItems(items: RuntimeTranscriptItem[], requestId?: string): RuntimeTranscriptItem[] {
	return items.filter((item) => {
		if (item.type !== "clarification") return true;
		if (!requestId) return false;
		const metadata = recordValue(item.metadata);
		const itemRequestId = stringValue(metadata.request_id) ?? stringValue(metadata.requestId);
		return itemRequestId !== requestId;
	});
}

function isShellOutputLifecycle(params: Record<string, unknown>): boolean {
	const name = stringValue(params.name) ?? stringValue(params.tool_name) ?? "";
	const normalized = name.trim().toLowerCase().replace(/[_-]/g, "");
	return normalized === "shelloutput" || normalized === "bashoutput" || normalized === "writestdin";
}

function isEmptyWriteStdinPoll(params: Record<string, unknown>): boolean {
	const name = stringValue(params.name) ?? stringValue(params.tool_name) ?? "";
	return name.trim().toLowerCase().replace(/[_-]/g, "") === "writestdin" && params.empty_poll === true;
}

function removeToolLifecycleItem(items: RuntimeTranscriptItem[], params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const index = findToolIndex(items, params);
	return index < 0 ? items : [...items.slice(0, index), ...items.slice(index + 1)];
}

function mergeShellOutputIntoExecution(
	items: RuntimeTranscriptItem[],
	params: Record<string, unknown>,
): RuntimeTranscriptItem[] | null {
	const rawPayload = recordValue(params.raw_payload);
	const incomingDisplay = recordValue(params.display);
	const incomingMetrics = recordValue(incomingDisplay.metrics);
	const shellId =
		stringValue(rawPayload.shell_id) ??
		stringValue(rawPayload.session_id) ??
		stringValue(rawPayload.bash_id) ??
		stringValue(params.shell_id) ??
		stringValue(params.session_id) ??
		stringValue(params.bash_id) ??
		stringValue(incomingMetrics.shell_id) ??
		stringValue(incomingMetrics.session_id);
	if (!shellId) return null;

	const index = findShellTranscriptIndex(items, shellId, undefined);
	if (index < 0) return null;
	const existing = items[index]!;
	const metadata = recordValue(existing.metadata);
	const existingDisplay = recordValue(metadata.display);
	const existingOutput =
		textValue(metadata.output_preview) ??
		textValue(existingDisplay.detail) ??
		"";
	const incomingOutput =
		textValue(incomingDisplay.detail) ??
		textValue(rawPayload.output) ??
		textValue(rawPayload.stdout) ??
		"";
	const outputPreview = mergeShellOutputText(existingOutput, incomingOutput);
	const terminalState =
		stringValue(rawPayload.terminal_state) ??
		stringValue(params.terminal_state) ??
		undefined;
	const exitCode = numberValue(rawPayload.exit_code) ?? numberValue(params.exit_code) ?? undefined;
	const effectiveTerminalState = terminalState ?? stringValue(metadata.terminal_state) ?? undefined;
	const effectiveExitCode = exitCode ?? numberValue(metadata.exit_code) ?? undefined;
	const commandPreview =
		stringValue(metadata.command_preview) ??
		stringValue(metadata.command) ??
		stringValue(existingDisplay.target) ??
		"command";
	const nextMetadata: Record<string, unknown> = {
		...metadata,
		shell_id: shellId,
		command_preview: commandPreview,
		command: stringValue(metadata.command) ?? commandPreview,
		transport:
			stringValue(rawPayload.transport) ??
			stringValue(params.transport) ??
			stringValue(incomingMetrics.transport) ??
			stringValue(metadata.transport),
		tty:
			booleanValue(rawPayload.tty) ??
			booleanValue(params.tty) ??
			booleanValue(incomingMetrics.tty) ??
			booleanValue(metadata.tty),
		background:
			booleanValue(rawPayload.background) ??
			booleanValue(params.background) ??
			booleanValue(metadata.background),
		process_state:
			stringValue(rawPayload.process_state) ??
			stringValue(params.process_state) ??
			stringValue(metadata.process_state),
		yielded:
			booleanValue(rawPayload.yielded) ??
			booleanValue(params.yielded) ??
			booleanValue(incomingMetrics.yielded) ??
			booleanValue(metadata.yielded),
		terminal_state: effectiveTerminalState,
		exit_code: effectiveExitCode,
		output_chars:
			numberValue(rawPayload.output_chars) ??
			numberValue(params.output_chars) ??
			numberValue(metadata.output_chars) ??
			undefined,
		omitted_output_chars:
			numberValue(rawPayload.omitted_output_chars) ??
			numberValue(params.omitted_output_chars) ??
			numberValue(metadata.omitted_output_chars) ??
			0,
		output_preview: outputPreview || undefined,
		status: effectiveTerminalState
			? (effectiveTerminalState === "completed" && (effectiveExitCode === undefined || effectiveExitCode === 0)
				? "done"
				: "failed")
			: "running",
		success: effectiveTerminalState
			? effectiveTerminalState === "completed" && (effectiveExitCode === undefined || effectiveExitCode === 0)
			: undefined,
	};
	nextMetadata.display = shellDisplayEnvelope({
		metadata: { ...nextMetadata, display: { ...existingDisplay, ...incomingDisplay, target: existingDisplay.target } },
		shellId,
		commandPreview,
		outputPreview,
		terminalState: effectiveTerminalState,
		exitCode: effectiveExitCode,
	});
	const merged: RuntimeTranscriptItem = {
		...existing,
		metadata: nextMetadata,
	};
	return [...items.slice(0, index), merged, ...items.slice(index + 1)];
}

function mergeShellOutputText(existing: string, incoming: string): string {
	if (!incoming) return existing;
	if (!existing) return incoming;
	if (existing.includes(incoming)) return existing;
	if (incoming.includes(existing)) return incoming;
	return `${existing}${incoming}`;
}

function shellDisplayEnvelope(options: {
	metadata: Record<string, unknown>;
	shellId: string;
	commandPreview: string;
	outputPreview: string;
	terminalState?: string;
	exitCode?: number;
}): Record<string, unknown> {
	const existing = recordValue(options.metadata.display);
	const metrics = recordValue(existing.metrics);
	const successful =
		options.terminalState === "completed" &&
		(options.exitCode === undefined || options.exitCode === 0);
	const status = options.terminalState ? (successful ? "success" : "error") : "running";
	const summary = options.terminalState
		? options.exitCode === undefined
			? options.terminalState
			: `Exit ${options.exitCode}`
		: "Running";
	return {
		...existing,
		target: options.commandPreview,
		status,
		summary,
		...(options.outputPreview ? { detail: options.outputPreview } : {}),
		presentation: "shell",
		metrics: {
			...metrics,
			shell_id: options.shellId,
			...(options.exitCode === undefined ? {} : { exit_code: options.exitCode }),
		},
	};
}

function applyCompactionLifecycle(items: RuntimeTranscriptItem[], method: string, params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const metadata = {
		...params,
		tool_id: compactionId(params),
		call_id: compactionId(params),
		tool_name: "Compact",
		name: "Compact",
		status:
			method === "compaction.started"
				? "running"
				: stringValue(params.status) === "failed"
					? "failed"
					: "done",
		summary: compactionSummary(method, params),
		context: stringValue(params.source) ?? "context",
	};
	const matchIndex = findToolIndex(items, metadata);
	const item = {
		id: matchIndex >= 0 ? items[matchIndex]!.id : nextId("compaction"),
		type: "tool_summary",
		text: compactionSummary(method, params),
		folded: true,
		metadata: matchIndex >= 0 ? { ...recordValue(items[matchIndex]!.metadata), ...metadata } : metadata,
	};
	return matchIndex >= 0 ? [...items.slice(0, matchIndex), item, ...items.slice(matchIndex + 1)] : [...items, item];
}

function upsertSubagentTranscriptItem(items: RuntimeTranscriptItem[], item: RuntimeTranscriptItem): RuntimeTranscriptItem[] {
	const existingIndex = items.findIndex((candidate) => candidate.id === item.id);
	if (existingIndex < 0) {
		return [...items, item];
	}
	const existing = items[existingIndex]!;
	const existingMetadata = recordValue(existing.metadata);
	const nextMetadata = recordValue(item.metadata);
	const progress = uniqueSubagentProgress([
		...(Array.isArray(existingMetadata.progress) ? existingMetadata.progress : []),
		...(Array.isArray(nextMetadata.progress) ? nextMetadata.progress : []),
	]).slice(-40);
	const merged: RuntimeTranscriptItem = {
		...existing,
		...item,
		text: item.text || existing.text,
		metadata: {
			...existingMetadata,
			...nextMetadata,
			progress,
		},
	};
	return [...items.slice(0, existingIndex), merged, ...items.slice(existingIndex + 1)];
}

function uniqueSubagentProgress(items: readonly unknown[]): readonly unknown[] {
	const seen = new Set<string>();
	const unique: unknown[] = [];
	for (const item of items) {
		const record = recordValue(item);
		const identity = JSON.stringify([
			record.kind,
			record.call_id ?? record.callId,
			record.summary,
			record.status,
		]);
		if (seen.has(identity)) continue;
		seen.add(identity);
		unique.push(item);
	}
	return unique;
}

function findToolIndex(items: RuntimeTranscriptItem[], metadata: Record<string, unknown>): number {
	const toolId = stringValue(metadata.tool_id);
	const callId = stringValue(metadata.call_id);
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.type !== "tool_summary") continue;
		const itemMetadata = recordValue(item.metadata);
		if (toolId && stringValue(itemMetadata.tool_id) === toolId) return index;
		if (callId && stringValue(itemMetadata.call_id) === callId) return index;
	}
	return -1;
}

function hasMatchingFileMutationProposal(
	items: RuntimeTranscriptItem[],
	approval: Record<string, unknown>,
): boolean {
	const callId = stringValue(approval.call_id)
		?? stringValue(approval.callId)
		?? stringValue(approval.decision_id)
		?? stringValue(approval.decisionId);
	if (!callId) return false;
	return items.some((item) => {
		if (item.type !== "tool_summary") return false;
		const metadata = recordValue(item.metadata);
		return metadata.file_mutation_proposal === true
			&& stringValue(metadata.call_id) === callId;
	});
}

function fileMutationTargetPreview(preview: string, toolName: string): string {
	const prefix = `${toolName} `;
	return preview.toLowerCase().startsWith(prefix.toLowerCase())
		? preview.slice(prefix.length).trim() || toolName
		: preview;
}

function compactionId(params: Record<string, unknown>): string {
	return [
		"compaction",
		stringValue(params.client_turn_id) ?? "turn",
		stringValue(params.source) ?? "context",
	].join(":");
}

function compactionSummary(method: string, params: Record<string, unknown>): string {
	const before = numberValue(params.before_tokens);
	const after = numberValue(params.after_tokens);
	const duration = numberValue(params.duration_s);
	if (method === "compaction.started") {
		return before === null ? "Compressing context" : `Compressing context · ${formatTokens(before)} tokens`;
	}
	const durationText = duration === null ? "" : ` for ${formatSeconds(duration)}`;
	if (stringValue(params.status) === "failed") {
		return `Context compression failed${durationText}`;
	}
	if (stringValue(params.status) === "skipped") {
		return `Context compression skipped${durationText}`;
	}
	if (before !== null && after !== null) {
		return `Context compressed${durationText} · ${formatTokens(before)} -> ${formatTokens(after)} tokens`;
	}
	return `Context compressed${durationText}`;
}

function formatTokens(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatSeconds(value: number): string {
	const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
	return `${rounded} s`;
}

function lifecycleToolText(metadata: Record<string, unknown>): string {
	const name = stringValue(metadata.tool_name) ?? "Tool";
	const target =
		stringValue(metadata.path) ??
		stringValue(metadata.query) ??
		stringValue(metadata.command) ??
		stringValue(metadata.context) ??
		stringValue(metadata.summary) ??
		stringValue(metadata.args_preview);
	return target ? `${name} ${target}` : name;
}

function reasoningText(params: Record<string, unknown>): string {
	const format = stringValue(params.format) ?? stringValue(params.encoding);
	if (format && ["encrypted", "opaque", "binary"].includes(format.toLowerCase())) {
		const bytes = typeof params.bytes === "number" ? ` · ${params.bytes} bytes` : "";
		return `reasoning · ${format.toLowerCase()}${bytes}`;
	}
	return String(params.text ?? "reasoning · opaque");
}

function trustFromPayload(payload: unknown, workspace: string): RuntimeShellState["trust"] {
	const record = recordValue(payload);
	return {
		state: stringValue(record.state) ?? "unknown",
		workspace: stringValue(record.workspace) ?? workspace,
	};
}

export function runtimeStateWithModelCatalog(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	const models = modelCatalogFromPayload(payload);
	const nextState = models === null ? state : { ...state, models };
	return runtimeStateWithCredentialReadiness(nextState, payload);
}

export function runtimeStateWithCredentialReadiness(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	const readiness = credentialReadinessFromUnknown(payload.auth_status);
	return readiness ? { ...state, authReadiness: readiness } : state;
}

function modelCatalogFromPayload(payload: Record<string, unknown>): MycliShellModel[] | null {
	const raw = Array.isArray(payload.models)
		? payload.models
		: Array.isArray(payload.available_models)
			? payload.available_models
			: null;
	if (raw === null) return null;
	return raw.map(modelFromUnknown).filter((item): item is MycliShellModel => item !== null);
}

export function permissionStateFromUnknown(value: unknown): MycliShellPermissionState | null {
	const record = recordValue(value);
	const active = permissionProfileId(record.active);
	const profiles = Array.isArray(record.profiles)
		? record.profiles.map(permissionProfileFromUnknown).filter((profile): profile is MycliShellPermissionProfile => profile !== null)
		: [];
	if (!active || profiles.length === 0) return null;
	return {
		active,
		profiles,
		commandAllowanceCount: Math.max(0, numberValue(record.command_allowance_count) ?? numberValue(record.commandAllowanceCount) ?? 0),
		...(permissionEffectiveFromUnknown(record.effective) ?? {}),
		...(sandboxReadinessFromUnknown(record.sandbox_readiness ?? record.sandboxReadiness) ?? {}),
	};
}

function permissionEffectiveFromUnknown(
	value: unknown,
): Pick<MycliShellPermissionState, "effective"> | null {
	const record = recordValue(value);
	const trusted = booleanValue(record.trusted);
	const valid = booleanValue(record.valid);
	const sandboxMode = sandboxModeValue(record.sandbox_mode ?? record.sandboxMode);
	const filesystem = filesystemPolicyValue(record.filesystem);
	const network = networkPolicyValue(record.network);
	const approvalBehavior = approvalBehaviorValue(record.approval_behavior ?? record.approvalBehavior);
	const source = policySourceValue(record.source);
	const constrained = booleanValue(record.constrained);
	if (trusted === null || valid === null || !sandboxMode || !filesystem || !network
		|| !approvalBehavior || !source || constrained === null) return null;
	return {
		effective: {
			trusted,
			valid,
			sandboxMode,
			filesystem,
			network,
			approvalBehavior,
			source,
			constrained,
			constraintsSource: constraintsSourceValue(
				record.constraints_source ?? record.constraintsSource,
			) ?? undefined,
			readableRoots: nonNegativeCount(record.readable_roots ?? record.readableRoots),
			writableRoots: nonNegativeCount(record.writable_roots ?? record.writableRoots),
			networkDomains: nonNegativeCount(record.network_domains ?? record.networkDomains),
			sessionGrant: booleanValue(record.session_grant ?? record.sessionGrant) ?? false,
			turnGrant: booleanValue(record.turn_grant ?? record.turnGrant) ?? false,
		},
	};
}

function sandboxReadinessFromUnknown(
	value: unknown,
): Pick<MycliShellPermissionState, "sandboxReadiness"> | null {
	const record = recordValue(value);
	const state = sandboxReadinessStateValue(record.state);
	const code = sandboxReadinessCodeValue(record.code);
	const platform = stringValue(record.platform);
	const isolation = sandboxIsolationValue(record.isolation);
	if (!state || !code || !platform || !isolation) return null;
	return { sandboxReadiness: { state, code, platform, isolation } };
}

function permissionProfileFromUnknown(value: unknown): MycliShellPermissionProfile | null {
	const record = recordValue(value);
	const id = permissionProfileId(record.id);
	const label = stringValue(record.label);
	const description = stringValue(record.description);
	if (!id || !label || !description) return null;
	return {
		id,
		label,
		description,
		current: record.current === true,
		disabledReason: stringValue(record.disabled_reason) ?? stringValue(record.disabledReason) ?? undefined,
		sandboxMode: sandboxModeValue(record.sandbox_mode ?? record.sandboxMode) ?? undefined,
		filesystem: filesystemPolicyValue(record.filesystem) ?? undefined,
		network: networkPolicyValue(record.network) ?? undefined,
		approvalBehavior: approvalBehaviorValue(
			record.approval_behavior ?? record.approvalBehavior,
		) ?? undefined,
	};
}

function sandboxModeValue(value: unknown): NonNullable<MycliShellPermissionProfile["sandboxMode"]> | null {
	return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
		? value
		: null;
}

function filesystemPolicyValue(value: unknown): NonNullable<MycliShellPermissionProfile["filesystem"]> | null {
	return value === "read_only" || value === "workspace_write" || value === "unrestricted"
		? value
		: null;
}

function networkPolicyValue(value: unknown): NonNullable<MycliShellPermissionProfile["network"]> | null {
	return value === "disabled" || value === "enabled" ? value : null;
}

function approvalBehaviorValue(value: unknown): NonNullable<MycliShellPermissionProfile["approvalBehavior"]> | null {
	return value === "on-request" || value === "never" ? value : null;
}

function policySourceValue(value: unknown): NonNullable<MycliShellPermissionState["effective"]>["source"] | null {
	return value === "default" || value === "user" || value === "project"
		|| value === "session" || value === "managed" ? value : null;
}

function constraintsSourceValue(value: unknown): "managed" | "runtime" | null {
	return value === "managed" || value === "runtime" ? value : null;
}

function sandboxReadinessStateValue(value: unknown): NonNullable<MycliShellPermissionState["sandboxReadiness"]>["state"] | null {
	return value === "ready" || value === "setup_required" || value === "unavailable"
		|| value === "not_required" ? value : null;
}

function sandboxReadinessCodeValue(value: unknown): NonNullable<MycliShellPermissionState["sandboxReadiness"]>["code"] | null {
	return value === "ready" || value === "setup_incomplete" || value === "helper_missing"
		|| value === "handshake_failed" || value === "enforcement_unavailable"
		|| value === "unsupported_platform" || value === "not_required" ? value : null;
}

function sandboxIsolationValue(value: unknown): NonNullable<MycliShellPermissionState["sandboxReadiness"]>["isolation"] | null {
	return value === "macos_seatbelt" || value === "linux_bubblewrap"
		|| value === "windows_restricted_token" || value === "none" ? value : null;
}

function nonNegativeCount(value: unknown): number {
	const count = numberValue(value);
	return count === null ? 0 : Math.max(0, Math.floor(count));
}

function permissionProfileId(value: unknown): MycliShellPermissionProfile["id"] | null {
	return value === "read-only" || value === "workspace" || value === "full-access" ? value : null;
}

function modelFromUnknown(value: unknown): MycliShellModel | null {
	const record = recordValue(value);
	const model = stringValue(record.model);
	if (!model) return null;
	const contextWindowTokens = numberValue(
		record.context_window_tokens ?? record.contextWindowTokens,
	);
	const maxOutputTokens = numberValue(record.max_output_tokens ?? record.maxOutputTokens);
	return {
		model,
		provider: stringValue(record.provider) ?? "",
		protocol: stringValue(record.protocol) ?? undefined,
		name: stringValue(record.name) ?? undefined,
		description: stringValue(record.description) ?? undefined,
		baseUrl: stringValue(record.base_url) ?? stringValue(record.baseUrl) ?? undefined,
		supportedReasoningEfforts: stringArrayValue(
			record.supported_reasoning_efforts ?? record.supportedReasoningEfforts,
		),
		defaultReasoningEffort:
			stringValue(record.default_reasoning_effort) ?? stringValue(record.defaultReasoningEffort) ?? undefined,
		...(contextWindowTokens === null ? {} : { contextWindowTokens }),
		...(maxOutputTokens === null ? {} : { maxOutputTokens }),
		current: booleanValue(record.current) ?? undefined,
		default: booleanValue(record.default) ?? undefined,
	};
}

function authProvidersFromUnknown(value: unknown): MycliShellAuthProvider[] {
	if (!Array.isArray(value)) return [];
	return value.map(authProviderFromUnknown).filter((item): item is MycliShellAuthProvider => item !== null);
}

function authProviderFromUnknown(value: unknown): MycliShellAuthProvider | null {
	const record = recordValue(value);
	const id = stringValue(record.id) ?? stringValue(record.provider_id);
	if (!id) return null;
	return {
		id,
		name: stringValue(record.name) ?? id,
		configured: typeof record.configured === "boolean" ? record.configured : undefined,
		defaultModel: stringValue(record.default_model) ?? stringValue(record.defaultModel) ?? undefined,
		authRef: stringValue(record.auth_ref) ?? stringValue(record.authRef) ?? undefined,
		credentialSource: credentialSourceValue(
			record.credential_source ?? record.credentialSource,
		) ?? undefined,
	};
}

function credentialReadinessFromUnknown(value: unknown): MycliShellCredentialReadiness | null {
	const record = recordValue(value);
	const providerId = stringValue(record.provider_id) ?? stringValue(record.providerId);
	const authRef = stringValue(record.auth_ref) ?? stringValue(record.authRef);
	const source = credentialSourceValue(record.source);
	if (!providerId || !authRef || !source || typeof record.ready !== "boolean") return null;
	return { ready: record.ready, providerId, authRef, source };
}

function credentialSourceValue(value: unknown): MycliShellCredentialSource | null {
	return value === "environment"
		|| value === "stored"
		|| value === "legacy_config"
		|| value === "missing"
		? value
		: null;
}

function resourceFromUnknown(value: unknown): MycliShellResource | null {
	const record = recordValue(value);
	const id = stringValue(record.id);
	const type = resourceTypeValue(record.type);
	const name = stringValue(record.name);
	if (!id || !type || !name) return null;
	return {
		id,
		type,
		name,
		source: resourceSourceValue(record.source) ?? undefined,
		enabled: booleanValue(record.enabled) ?? undefined,
		status: stringValue(record.status) ?? undefined,
		detail: stringValue(record.detail) ?? undefined,
		command: stringValue(record.command) ?? undefined,
	};
}

function currentModel(provider: string, model: string, thinkingLevel?: string): MycliShellModel {
	const [providerId = provider, protocol] = provider.split("/", 2);
	return {
		provider: providerId,
		...(protocol ? { protocol } : {}),
		model: model || "no-model",
		supportedReasoningEfforts: thinkingLevel ? [thinkingLevel] : [],
		current: true,
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

function reasoningLevelFromStatus(status: Record<string, unknown>): string | undefined {
	return stringValue(status.thinking_effort) ?? stringValue(status.reasoning_effort) ?? undefined;
}

function usageFooterData(status: Record<string, unknown>): Partial<MycliShellState["footer"]> {
	const nestedContext = recordValue(status.context);
	const canonicalContext = recordValue(status.context_window);
	const context = Object.keys(nestedContext).length > 0
		? nestedContext
		: Object.keys(canonicalContext).length > 0
			? canonicalContext
			: status;
	const nestedUsage = recordValue(status.usage);
	const usage = Object.keys(nestedUsage).length > 0 ? nestedUsage : status;
	const rawUsedTokens = numberValue(context.used_tokens);
	const rawMaxTokens = numberValue(context.max_tokens);
	const usedTokens = rawUsedTokens === null ? null : Math.max(0, rawUsedTokens);
	const maxTokens = rawMaxTokens === null ? null : Math.max(0, rawMaxTokens);
	const rawContextWindow = numberValue(context.context_window);
	const explicitPercent = numberValue(context.context_percent) ?? numberValue(context.percent);
	const usageRatio = numberValue(context.usage_ratio);
	const derivedPercent = explicitPercent
		?? (usageRatio === null ? null : usageRatio * 100)
		?? (usedTokens !== null && maxTokens !== null && maxTokens > 0
			? usedTokens / maxTokens * 100
			: null);
	return {
		contextPercent: derivedPercent === null
			? undefined
			: Math.min(100, Math.max(0, derivedPercent)),
		contextWindow: rawContextWindow === null
			? maxTokens ?? undefined
			: Math.max(0, rawContextWindow),
		contextUsedTokens: usedTokens ?? undefined,
		contextSource: stringValue(context.source) ?? undefined,
		totalInputTokens: numberValue(usage.input_tokens) ?? undefined,
		totalOutputTokens: numberValue(usage.output_tokens) ?? undefined,
		cacheReadTokens: numberValue(usage.cache_read_tokens) ?? undefined,
		cacheWriteTokens: numberValue(usage.cache_write_tokens) ?? undefined,
		costUsd: numberValue(usage.cost_usd) ?? undefined,
	};
}

function compactTarget(value: string | null, workspace: string): string | null {
	if (!value) return null;
	const normalizedWorkspace = workspace.replaceAll("\\", "/").replace(/\/+$/, "");
	const normalizedValue = value.replaceAll("\\", "/");
	if (normalizedWorkspace && normalizedValue.startsWith(`${normalizedWorkspace}/`)) {
		return normalizedValue.slice(normalizedWorkspace.length + 1);
	}
	return normalizedValue;
}

function isTranscriptItem(value: unknown): value is RuntimeTranscriptItem {
	const record = recordValue(value);
	return Boolean(stringValue(record.id) && stringValue(record.type) && typeof record.text === "string");
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function defaultVisualSettings(): Required<MycliShellVisualSettings> {
	return {
		statusbarMode: "full",
		viewMode: "default",
		theme: "dark",
		hideThinking: true,
		toolDetailsDefault: "collapsed",
		hardwareCursor: false,
		clearOnShrink: true,
		terminalProgress: true,
		subagentDensity: "normal",
	};
}

function normalizeVisualSettings(
	settings: MycliShellVisualSettings,
	fallback: MycliShellVisualSettings = defaultVisualSettings(),
): MycliShellVisualSettings {
	const raw = settings as Record<string, unknown>;
	return {
		statusbarMode: statusbarModeValue(raw.statusbarMode ?? raw.statusbar_mode) ?? fallback.statusbarMode ?? "full",
		viewMode: viewModeValue(raw.viewMode ?? raw.view_mode) ?? fallback.viewMode ?? "default",
		theme: stringValue(raw.theme) ?? fallback.theme ?? "dark",
		hideThinking: booleanValue(raw.hideThinking ?? raw.hide_thinking) ?? fallback.hideThinking ?? true,
		toolDetailsDefault:
			toolDetailsDefaultValue(raw.toolDetailsDefault ?? raw.tool_details_default) ?? fallback.toolDetailsDefault ?? "collapsed",
		hardwareCursor: booleanValue(raw.hardwareCursor ?? raw.hardware_cursor) ?? fallback.hardwareCursor ?? false,
		clearOnShrink: booleanValue(raw.clearOnShrink ?? raw.clear_on_shrink) ?? fallback.clearOnShrink ?? true,
		terminalProgress: booleanValue(raw.terminalProgress ?? raw.terminal_progress) ?? fallback.terminalProgress ?? true,
		subagentDensity: subagentDensityValue(raw.subagentDensity ?? raw.subagent_density) ?? fallback.subagentDensity ?? "normal",
	};
}

function statusbarModeValue(value: unknown): MycliShellVisualSettings["statusbarMode"] | null {
	return value === "off" || value === "compact" || value === "full" ? value : null;
}

function viewModeValue(value: unknown): MycliShellVisualSettings["viewMode"] | null {
	return value === "default" || value === "verbose" || value === "focus" ? value : null;
}

function toolDetailsDefaultValue(value: unknown): MycliShellVisualSettings["toolDetailsDefault"] | null {
	return value === "collapsed" || value === "expanded" ? value : null;
}

function subagentDensityValue(value: unknown): MycliShellVisualSettings["subagentDensity"] | null {
	return value === "compact" || value === "normal" || value === "detailed" ? value : null;
}

function resourceTypeValue(value: unknown): MycliShellResource["type"] | null {
	return value === "hook" || value === "plugin" || value === "skill" || value === "prompt" || value === "theme" ? value : null;
}

function resourceSourceValue(value: unknown): MycliShellResource["source"] | null {
	return value === "user" || value === "repo" || value === "builtin" || value === "package" || value === "runtime" || value === "unknown"
		? value
		: null;
}

function collaborationModeValue(value: unknown): RuntimeShellState["collaborationMode"] | null {
	return value === "default" || value === "plan" ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function turnDurationMsValue(value: unknown): number | undefined {
	const durationMs = numberValue(value);
	if (durationMs === null || durationMs < 0) return undefined;
	return Math.min(86_400_000, Math.round(durationMs));
}

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let nextItemId = 1;

function nextId(prefix: string): string {
	return `${prefix}_${nextItemId++}`;
}
