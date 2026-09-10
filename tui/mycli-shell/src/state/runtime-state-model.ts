import type {
	MycliShellAuthProvider,
	MycliShellCredentialReadiness,
	MycliShellEffectiveKeymap,
	MycliShellLocalImageAttachment,
	MycliShellModel,
	MycliShellPermissionState,
	MycliShellProviderRoute,
	MycliShellResource,
	MycliShellSettingsCatalog,
	MycliShellTerminalCapabilities,
	MycliShellVisualSettings,
} from "../model.ts";

import type { GatewayTranscriptItem, ProviderAttemptRecord } from "@mycli/contracts";

export type RuntimeTranscriptItem = Pick<GatewayTranscriptItem, "id" | "type" | "text">
& Partial<Pick<GatewayTranscriptItem, "folded" | "metadata" | "tool_record" | "turn_id">> & {
	created_at?: string;
	providerAttempts?: readonly ProviderAttemptRecord[];
	call_id?: string;
	status?: string;
};

export type RuntimeShellProcess = {
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

export type RuntimeQueuedInputPreview = {
	queueId?: string;
	clientUserMessageId?: string;
	sessionId?: string;
	targetTurnId?: string;
	claimTurnId?: string;
	kind?: "pending_steer" | "rejected_steer" | "follow_up";
	state?: string;
	message: string;
	attachments: MycliShellLocalImageAttachment[];
	source?: string;
};

export type RuntimeLocalUserInput = {
	clientUserMessageId: string;
	message: string;
	attachments: MycliShellLocalImageAttachment[];
};

export type RuntimeSessionLocalInputs = {
	localPendingSteers: RuntimeLocalUserInput[];
	localRejectedSteers: RuntimeLocalUserInput[];
	localFollowUps: RuntimeLocalUserInput[];
	localSubmittingMessages: RuntimeLocalUserInput[];
};

export type RuntimeLiveStatus = {
	state: string;
	text: string;
	callId?: string;
	kind?: string;
	message?: string;
	durationMs?: number;
	retryAt?: string;
};

export type RuntimeShellState = {
	sessionId: string | null;
	sessionGeneration: number | null;
	sessionTitle: string | null;
	workspace: string;
	model: string;
	collaborationMode: "default" | "plan";
	provider: string;
	trust: { state?: string; workspace?: string };
	trustGateDismissed: boolean;
	status: Record<string, unknown>;
	models: MycliShellModel[] | null;
	modelsProvider: string | null;
	providerRoutes: MycliShellProviderRoute[];
	transcript: RuntimeTranscriptItem[];
	transcriptNextBefore: string | null;
	providerAttemptsNextBefore: string | null;
	turnRunning: boolean;
	activeTurnId: string | null;
	activeClientTurnId: string | null;
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
	sessionLocalInputs: Record<string, RuntimeSessionLocalInputs>;
	hasPendingInput: boolean;
	queueActivity: { kind: string; steeringCount: number; followUpCount: number } | null;
	liveStatus: RuntimeLiveStatus | null;
	retryRestoreStatus: RuntimeLiveStatus | null;
	liveReasoning: { text: string; kind: string } | null;
	viewMode: "default" | "verbose" | "focus";
	statusbarMode: "off" | "compact" | "full";
	settings: MycliShellVisualSettings;
	settingsCatalog: MycliShellSettingsCatalog | null;
	keymap: MycliShellEffectiveKeymap | null;
	terminalCapabilities: MycliShellTerminalCapabilities | null;
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
	const workspace = process.cwd();
	return {
		sessionId: null,
		sessionGeneration: null,
		sessionTitle: null,
		workspace,
		model: "",
		collaborationMode: "default",
		provider: "",
		trust: { state: "unknown", workspace },
		trustGateDismissed: false,
		status: {},
		models: null,
		modelsProvider: null,
		providerRoutes: [],
		transcript: [],
		transcriptNextBefore: null,
		providerAttemptsNextBefore: null,
		turnRunning: false,
		activeTurnId: null,
		activeClientTurnId: null,
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
		sessionLocalInputs: {},
		hasPendingInput: false,
		queueActivity: null,
		liveStatus: null,
		retryRestoreStatus: null,
		liveReasoning: null,
		viewMode: "default",
		statusbarMode: "full",
		settings: defaultVisualSettings(),
		settingsCatalog: null,
		keymap: null,
		terminalCapabilities: null,
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

export function defaultVisualSettings(): Required<MycliShellVisualSettings> {
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
		colorMode: "auto",
		reducedMotion: false,
		glyphMode: "auto",
		highContrast: false,
	};
}
