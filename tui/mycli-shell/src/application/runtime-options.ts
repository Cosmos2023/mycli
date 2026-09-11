import type { ModelSelectionScope } from "@mycli/contracts";
import type { ProjectTrustDecision } from "../components/selectors/trust-selector.ts";
import type { PlanImplementationAction } from "../interaction/plan-implementation.ts";
import type { MycliUiActionDispatcher } from "../interaction/ui-actions.ts";
import type {
	MycliShellCommandSpec,
	MycliShellLoginResult,
	MycliShellModel,
	MycliShellPendingApproval,
	MycliShellPendingClarification,
	MycliShellPermissionProfile,
	MycliShellPermissionState,
	MycliShellProviderRoute,
	MycliShellResource,
	MycliShellResumeRepairAction,
	MycliShellResumeRepairPreview,
	MycliShellSession,
	MycliShellSessionTree,
	MycliShellSessionTreeNode,
	MycliShellSettingChange,
	MycliShellSettingsSnapshot,
	MycliShellState,
	MycliShellVisualSettings,
	TranscriptUpdateKind,
} from "../model.ts";
import type { Terminal } from "../tui-core/terminal.ts";

export type MycliShellRuntimeOptions = {
	initialState: MycliShellState;
	terminal?: Terminal;
	requireTrust?: boolean;
	trustSavedDecision?: ProjectTrustDecision;
	projectTrusted?: boolean;
	onTrustSelect?: (trusted: boolean) => void | Promise<void>;
	actions?: MycliUiActionDispatcher;
	onSubmit?: (text: string, attachments?: MycliShellSubmitAttachments) => void | Promise<void>;
	onFollowUp?: (text: string, attachments?: MycliShellSubmitAttachments) => void | Promise<void>;
	onInterrupt?: (options: { rollbackUserInput: boolean }) => boolean | void | Promise<boolean | void>;
	onInterruptExit?: () => void | Promise<void>;
	onDequeueQueuedInput?: () => MycliShellQueuedInput | string | null | Promise<MycliShellQueuedInput | string | null>;
	onCommandSubmit?: (command: string) => void | Promise<void>;
	onExit?: () => void | Promise<void>;
	onSuspend?: () => boolean;
	onFatalError?: (error: unknown) => void;
	onModelSelect?: (
		model: MycliShellModel,
		scope: ModelSelectionScope,
	) => void | MycliShellModel | Promise<void | MycliShellModel>;
	onProviderLoad?: () => Promise<MycliShellProviderRoute[]>;
	onModelLoad?: (providerId: string) => Promise<MycliShellModel[]>;
	onProviderRoutesChange?: (providers: MycliShellProviderRoute[]) => void;
	onModelCatalogChange?: (providerId: string, models: MycliShellModel[]) => void;
	onPermissionSelect?: (profile: MycliShellPermissionProfile) => void | MycliShellPermissionState | Promise<void | MycliShellPermissionState>;
	onPermissionClearAllowances?: () => void | MycliShellPermissionState | Promise<void | MycliShellPermissionState>;
	onApiKeyLogin?: (
		providerId: string,
		apiKey: string,
		authRef?: string,
	) => void | MycliShellLoginResult | Promise<void | MycliShellLoginResult>;
	onConnectivityValidate?: () =>
		| void
		| { ok: boolean; message?: string }
		| Promise<void | { ok: boolean; message?: string }>;
	onSessionResumePreview?: (
		sessionId: string,
	) => MycliShellResumeRepairPreview | Promise<MycliShellResumeRepairPreview>;
	onSessionLoad?: () => Promise<MycliShellSession[]>;
	onSessionSelect?: (
		sessionId: string,
		repair?: {
			readonly action: MycliShellResumeRepairAction;
			readonly metadataRevision: number;
		},
	) => void | string | MycliShellResumeRepairPreview
		| Promise<void | string | MycliShellResumeRepairPreview>;
	onSessionTreeLoad?: () => MycliShellSessionTree | Promise<MycliShellSessionTree>;
	onSessionTreeSelect?: (node: MycliShellSessionTreeNode) => void | Promise<void>;
	onSettingsLoad?: () => MycliShellSettingsSnapshot | undefined | Promise<MycliShellSettingsSnapshot | undefined>;
	onSettingsChange?: (
		change: MycliShellSettingChange,
	) => MycliShellVisualSettings | MycliShellSettingsSnapshot | Promise<MycliShellVisualSettings | MycliShellSettingsSnapshot>;
	onSettingsKeymapReset?: () => MycliShellSettingsSnapshot | Promise<MycliShellSettingsSnapshot>;
	onResourceLoad?: () => MycliShellResource[] | Promise<MycliShellResource[]>;
	onTranscriptHistoryLoad?: (before: string) => void | Promise<void>;
	onApprovalRespond?: (
		decisionId: string,
		choice: string,
		approval: MycliShellPendingApproval,
	) => void | Promise<void>;
	onClarificationRespond?: (
		requestId: string,
		response: string,
		clarification: MycliShellPendingClarification,
	) => void | Promise<void>;
	onPlanImplementation?: (
		action: PlanImplementationAction,
		planMarkdown: string,
	) => void | Promise<void>;
	commands?: MycliShellCommandSpec[];
	commandNames?: string[];
	now?: () => number;
	transcriptReplayMaxRows?: number;
};

export type MycliShellStateUpdateOptions = {
	transcriptUpdate?: TranscriptUpdateKind;
	eventType?: string;
};

export type MycliShellLocalImageAttachment = {
	path: string;
	placeholder: string;
};

export type MycliShellSubmitAttachments = {
	localImages?: MycliShellLocalImageAttachment[];
};

export type MycliShellQueuedInput = {
	text: string;
	localImages?: MycliShellLocalImageAttachment[];
};
