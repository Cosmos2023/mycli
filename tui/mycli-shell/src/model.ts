import type {
	DiagnosticCategory,
	DiagnosticRecoveryAction,
	TuiKeymapActionId,
} from "@mycli/contracts";

export type MycliShellNoticeDiagnostic = {
	hint?: string;
	source?: string;
	method?: string;
	code?: string;
	details?: string;
	category?: DiagnosticCategory;
	recoveryActions?: readonly DiagnosticRecoveryAction[];
	occurrenceId?: string;
};

export type MycliShellMessage =
	| { id: string; role: "user"; text: string }
	| { id: string; role: "assistant"; text: string; thinking?: string; thinkingHidden?: boolean }
	| {
		id: string;
		role: "system" | "error" | "warning";
		text: string;
		diagnostic?: MycliShellNoticeDiagnostic;
	};

export type MycliShellPlan = {
	id: string;
	text: string;
	status?: "proposed" | "accepted" | "stale";
};

export type MycliShellPlanStepStatus = "pending" | "in_progress" | "completed";

export type MycliShellPlanStep = {
	id: string;
	text: string;
	status: MycliShellPlanStepStatus;
	evidence?: string[];
};

export type MycliShellPlanUpdate = {
	id: string;
	title: string;
	source?: string;
	explanation?: string;
	steps: MycliShellPlanStep[];
	completed: number;
	total: number;
};

type MycliShellTaskProgress = {
	completed: number;
	total: number;
};

export type MycliShellToolStatus = "running" | "success" | "error" | "cancelled";

export type MycliShellTool = {
	id: string;
	name: string;
	args?: string;
	status: MycliShellToolStatus;
	durationMs?: number;
	mutating?: boolean;
	contentPreview?: string;
	contentLineCount?: number;
	diffPreview?: string;
	summaryPreview?: string;
	detailPreview?: string;
	outputPreview?: string;
	errorPreview?: string;
	presentation?: string;
	displayTruncated?: boolean;
	displayOmittedChars?: number;
	hiddenLineCount?: number;
	hidden?: boolean;
	expanded?: boolean;
};

export type MycliShellFileChangeEntry = {
	version: 1;
	kind: "add" | "update" | "delete" | "rename";
	path: string;
	previousPath?: string;
	diff: string;
	addedLines: number;
	removedLines: number;
	truncated: boolean;
	omittedChars: number;
	language?: string;
};

export type MycliShellFileChange = {
	id: string;
	callId?: string;
	status: "success" | "error" | "unchanged";
	summary: string;
	target?: string;
	files: MycliShellFileChangeEntry[];
	error?: string;
};

export type MycliShellBash = {
	id: string;
	toolName?: "Shell" | "Bash" | string;
	command: string;
	description?: string;
	status: MycliShellToolStatus;
	shellId?: string;
	callId?: string;
	background?: boolean;
	processState?: string;
	transport?: string;
	tty?: boolean;
	yielded?: boolean;
	terminalState?: string;
	exitCode?: number;
	sequence?: number;
	startedAt?: string;
	completedAt?: string;
	outputChars?: number;
	omittedOutputChars?: number;
	cleanupResult?: string;
	shellKind?: string;
	shellEdition?: string;
	outputPreview?: string;
	hiddenLineCount?: number;
	expanded?: boolean;
};

export type MycliShellTranscriptOutputRequest = {
	sessionId: string;
	shellId: string;
	callId?: string;
};

export type MycliShellTranscriptOutput = MycliShellTranscriptOutputRequest & {
	output: string;
	available: boolean;
	complete: boolean;
	omittedChars: number;
	capturedChars: number;
	outputChars: number;
};

type MycliShellSubagentStatus = "running" | "completed" | "failed" | "cancelled" | "max_tool_calls" | string;

export type MycliShellSubagent = {
	id: string;
	threadId?: string;
	rootThreadId?: string;
	parentThreadId?: string;
	agentPath?: string;
	taskName?: string;
	nickname?: string;
	lifecycleKind?: string;
	role: string;
	description?: string;
	status: MycliShellSubagentStatus;
	mode?: "sync" | "background" | string;
	childSessionId: string;
	parentTurnId?: string;
	summary?: string;
	toolCalls?: number;
	tokens?: number;
	durationMs?: number;
	error?: string;
	path?: string;
	startedAt?: string;
	completedAt?: string;
	progress?: MycliShellSubagentProgress[];
};

type MycliShellSubagentProgress = {
	kind: string;
	toolName?: string;
	callId?: string;
	summary?: string;
	status?: string;
};

export type MycliShellDiagnosticMetric = {
	label: string;
	value: string;
	accent?: "success" | "warning" | "error" | "accent" | "muted";
};

export type MycliShellDiagnosticSection = {
	title: string;
	rows: MycliShellDiagnosticMetric[];
};

export type MycliShellCommandDiagnostic = {
	id: string;
	command: string;
	title: string;
	kind: "usage" | "context" | "generic";
	metrics: MycliShellDiagnosticMetric[];
	sections: MycliShellDiagnosticSection[];
	rawLines?: string[];
};

export type MycliShellCommandField = {
	label: string;
	value: string;
	tone?: string;
};

export type MycliShellCommandRow = {
	key: string;
	label: string;
	values: string[];
	status?: string;
	detail?: string;
};

export type MycliShellCommandSection = {
	title: string;
	fields: MycliShellCommandField[];
	rows: MycliShellCommandRow[];
};

export type MycliShellCommandDisplay = {
	version: 1;
	kind: "status" | "diagnostic" | "list" | "notice" | "error" | "preformatted";
	command: string;
	title: string;
	severity: "info" | "success" | "warning" | "error";
	summary?: string;
	fields: MycliShellCommandField[];
	rows: MycliShellCommandRow[];
	sections: MycliShellCommandSection[];
	usage?: string;
	suggestions: string[];
	preformatted?: string;
	totalRows?: number;
	omittedRows: number;
	omittedChars: number;
};

export type MycliShellCommandResult = {
	id: string;
	display: MycliShellCommandDisplay;
	fallbackLines: string[];
	folded: boolean;
};

export type MycliShellBackgroundProcess = {
	shellId: string;
	commandPreview: string;
	recentOutput: string[];
};

export type MycliShellBackgroundTerminals = {
	id: string;
	processes: MycliShellBackgroundProcess[];
};

export type MycliShellClarificationResponse = {
	id: string;
	requestId: string;
	header?: string;
	question: string;
	response: string;
	multiSelect: boolean;
};

export type MycliShellTurnCompleted = {
	id: string;
	durationMs: number;
};

export type MycliShellWebSearch = {
	id: string;
	callId: string;
	status: "running" | "completed";
	action: "search" | "open_page" | "find_in_page" | "other";
	detail?: string;
};

export type MycliShellTranscriptBlock =
	| { id: string; kind: "message"; message: MycliShellMessage }
	| { id: string; kind: "turn_completed"; turnCompleted: MycliShellTurnCompleted }
	| { id: string; kind: "web_search"; webSearch: MycliShellWebSearch }
	| { id: string; kind: "clarification"; clarification: MycliShellClarificationResponse }
	| { id: string; kind: "plan"; plan: MycliShellPlan }
	| { id: string; kind: "plan_update"; planUpdate: MycliShellPlanUpdate }
	| { id: string; kind: "tool"; tool: MycliShellTool }
	| { id: string; kind: "file_change"; fileChange: MycliShellFileChange; message: MycliShellMessage }
	| { id: string; kind: "bash"; bash: MycliShellBash }
	| { id: string; kind: "subagent"; subagent: MycliShellSubagent }
	| { id: string; kind: "background_terminals"; backgroundTerminals: MycliShellBackgroundTerminals }
	| { id: string; kind: "diagnostic"; diagnostic: MycliShellCommandDiagnostic }
	| { id: string; kind: "command_result"; commandResult: MycliShellCommandResult };

export type MycliShellFooterData = {
	cwd: string;
	gitBranch?: string;
	sessionName?: string;
	provider?: string;
	model?: string;
	reasoningLevel?: string;
	contextPercent?: number;
	contextWindow?: number;
	contextUsedTokens?: number;
	contextSource?: string;
	totalInputTokens?: number;
	totalOutputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cacheHitRate?: number;
	costUsd?: number;
	usingSubscription?: boolean;
	autoCompact?: boolean;
	queueCount?: number;
	steeringQueueCount?: number;
	followUpQueueCount?: number;
	hasPendingInput?: boolean;
	queueActivity?: string;
	trust?: string;
	collaborationMode?: "default" | "plan";
	liveState?: string;
	liveStateKind?: string;
	liveStateDetail?: string;
	turnDurationMs?: number;
	turnRunning?: boolean;
	backgroundShellCount?: number;
	taskProgress?: MycliShellTaskProgress;
	extensionStatuses?: string[];
};

export type MycliShellQueuedInputPreview = {
	text: string;
	hasImages: boolean;
};

export type MycliShellLocalImageAttachment = {
	path: string;
	placeholder: string;
};

export type MycliShellPendingInput = {
	pendingSteers: MycliShellQueuedInputPreview[];
	rejectedSteers: MycliShellQueuedInputPreview[];
	followUps: MycliShellQueuedInputPreview[];
};

export type MycliShellModel = {
	provider: string;
	protocol?: string;
	model: string;
	name?: string;
	description?: string;
	baseUrl?: string;
	supportedReasoningEfforts?: string[];
	defaultReasoningEffort?: string;
	contextWindowTokens?: number;
	maxOutputTokens?: number;
	current?: boolean;
	default?: boolean;
	thinkingLevel?: string;
	scoped?: boolean;
};

export type MycliShellAuthProvider = {
	id: string;
	name: string;
	configured?: boolean;
	defaultModel?: string;
	authRef?: string;
	credentialSource?: MycliShellCredentialSource;
};

export type MycliShellCredentialSource =
	| "environment"
	| "stored"
	| "legacy_config"
	| "missing";

export type MycliShellCredentialReadiness = {
	ready: boolean;
	providerId: string;
	authRef: string;
	source: MycliShellCredentialSource;
};

export type MycliShellVisualSettings = {
	statusbarMode?: "off" | "compact" | "full";
	viewMode?: "default" | "verbose" | "focus";
	theme?: string;
	hideThinking?: boolean;
	toolDetailsDefault?: "collapsed" | "expanded";
	hardwareCursor?: boolean;
	clearOnShrink?: boolean;
	terminalProgress?: boolean;
	subagentDensity?: "compact" | "normal" | "detailed";
	colorMode?: "auto" | "truecolor" | "256" | "16" | "none";
	reducedMotion?: boolean;
	glyphMode?: "auto" | "unicode" | "ascii";
	highContrast?: boolean;
};

export type MycliShellEffectiveKeymap = {
	version: 1;
	bindings: Record<TuiKeymapActionId, string[]>;
	sources: Record<TuiKeymapActionId, string>;
	overridden: Record<TuiKeymapActionId, string[]>;
};

export type MycliShellTerminalCapabilities = {
	version: 1;
	colorMode: "truecolor" | "256" | "16" | "none";
	colorForcedOff: boolean;
	glyphMode: "unicode" | "ascii";
	terminalKind: "dumb" | "standard" | "windows_terminal";
	progressVisible: boolean;
	progressAnimated: boolean;
	reducedMotion: boolean;
	highContrast: boolean;
	guidance: string[];
};

export type MycliShellSettingsCategoryId =
	| "appearance"
	| "diagnostics"
	| "integrations"
	| "model"
	| "permissions"
	| "providers"
	| "sessions";

export type MycliShellSettingsCategory = {
	id: MycliShellSettingsCategoryId;
	label: string;
	description: string;
};

export type MycliShellSettingsItem = {
	id: string;
	category: MycliShellSettingsCategoryId;
	kind: "action" | "choice" | "status";
	label: string;
	description: string;
	value: string;
	source: string;
	scope: string;
	allowedValues: string[];
	clientKey?: keyof MycliShellVisualSettings;
	configKey?: string;
	action?: string;
	actionArgs?: string;
	command?: string;
	locked: boolean;
	lockReason?: string;
	restartRequired: boolean;
	searchTerms: string[];
};

export type MycliShellSettingsCatalog = {
	version: 1;
	categories: MycliShellSettingsCategory[];
	items: MycliShellSettingsItem[];
};

export type MycliShellSettingsSnapshot = {
	settings: MycliShellVisualSettings;
	catalog?: MycliShellSettingsCatalog;
	keymap?: MycliShellEffectiveKeymap;
	terminalCapabilities?: MycliShellTerminalCapabilities;
};

export type MycliShellSettingChange = {
	settingId: string;
	value: string | boolean;
};

export type MycliShellSession = {
	id: string;
	title?: string;
	cwd?: string;
	workspace?: string;
	modified?: string;
	created?: string;
	updated?: string;
	lastActive?: string;
	messageCount?: number;
	firstMessage?: string;
	allMessagesText?: string;
	parentSessionId?: string;
	parentSessionPath?: string;
	model?: string;
	provider?: string;
	reasoningEffort?: string;
	collaborationMode?: "default" | "plan";
	permissionProfile?: "read-only" | "workspace" | "full-access";
	lifecycleStatus?: "active" | "archived" | "deleted" | "waiting_approval" | "waiting_clarification" | "interrupted";
	storageStatus?: string;
	lockState?: "unlocked" | "owned" | "active" | "stale";
	pendingState?: "none" | "approval" | "clarification" | "interrupted";
	metadataRevision?: number;
	forkPoint?: number;
	preferenceIssue?: string;
	metadataIssue?: string;
	named?: boolean;
	current?: boolean;
};

export type MycliShellResumeRepairAction =
	| "takeover_stale_owner"
	| "unarchive"
	| "fork_with_current_settings";

export type MycliShellResumeRepairIssue = {
	code: string;
	blocking: boolean;
	message: string;
	action?: MycliShellResumeRepairAction;
};

export type MycliShellResumeRepairPreview = {
	version: 1;
	session: MycliShellSession;
	ready: boolean;
	requiresConfirmation: boolean;
	issues: MycliShellResumeRepairIssue[];
	actions: MycliShellResumeRepairAction[];
};

type MycliShellSessionTreeNodeKind = "session" | "message";

export type MycliShellSessionTreeNode = {
	id: string;
	kind: MycliShellSessionTreeNodeKind;
	sessionId: string;
	parentId?: string;
	depth: number;
	role: string;
	summary: string;
	timestamp?: string;
	label?: string;
	messageIndex?: number;
	anchorId?: string;
	toolName?: string;
	active?: boolean;
	onActivePath?: boolean;
	messageCount?: number;
	preview?: string;
};

export type MycliShellSessionTree = {
	sessionId: string;
	activePath: string[];
	nodes: MycliShellSessionTreeNode[];
};

export type MycliShellResource = {
	id: string;
	type: "hook" | "plugin" | "skill" | "prompt" | "theme";
	name: string;
	source?: "user" | "repo" | "builtin" | "package" | "runtime" | "unknown";
	enabled?: boolean;
	status?: string;
	detail?: string;
	command?: string;
};

type MycliShellApprovalOption = {
	choice: string;
	label: string;
};

export type MycliShellPermissionRequest = {
	network: boolean;
	readPaths: string[];
	writePaths: string[];
};

export type MycliShellPendingApproval = {
	decisionId: string;
	sessionId?: string;
	generation?: number;
	preview: string;
	reason?: string;
	toolName?: string;
	workerName?: string;
	workerColor?: string;
	childSessionId?: string;
	agentPath?: string;
	options: MycliShellApprovalOption[];
	risk?: string;
	riskReason?: string;
	persistentRulePreview?: string;
	permissionRequest?: MycliShellPermissionRequest;
	contentPreview?: string;
	contentLineCount?: number;
	diffPreview?: string;
};

type MycliShellClarificationOption = {
	label: string;
	description?: string;
};

export type MycliShellPendingClarification = {
	requestId: string;
	turnId?: string;
	sessionId?: string;
	generation?: number;
	question: string;
	workerName?: string;
	childSessionId?: string;
	agentPath?: string;
	header?: string;
	options: MycliShellClarificationOption[];
	multiSelect: boolean;
};

export type MycliShellPermissionProfile = {
	id: "read-only" | "workspace" | "full-access";
	label: string;
	description: string;
	current: boolean;
	disabledReason?: string;
	sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
	filesystem?: "read_only" | "workspace_write" | "unrestricted";
	network?: "disabled" | "enabled";
	approvalBehavior?: "on-request" | "never";
};

export type MycliShellEffectivePermission = {
	trusted: boolean;
	valid: boolean;
	sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
	filesystem: "read_only" | "workspace_write" | "unrestricted";
	network: "disabled" | "enabled";
	approvalBehavior: "on-request" | "never";
	source: "default" | "user" | "project" | "session" | "managed";
	constrained: boolean;
	constraintsSource?: "managed" | "runtime";
	readableRoots: number;
	writableRoots: number;
	networkDomains: number;
	sessionGrant: boolean;
	turnGrant: boolean;
};

export type MycliShellSandboxReadiness = {
	state: "ready" | "setup_required" | "unavailable" | "not_required";
	code: "ready" | "setup_incomplete" | "helper_missing" | "handshake_failed"
		| "enforcement_unavailable" | "unsupported_platform" | "not_required";
	platform: string;
	isolation: "macos_seatbelt" | "linux_bubblewrap" | "windows_restricted_token" | "none";
};

export type MycliShellPermissionState = {
	active: MycliShellPermissionProfile["id"];
	profiles: MycliShellPermissionProfile[];
	commandAllowanceCount: number;
	effective?: MycliShellEffectivePermission;
	sandboxReadiness?: MycliShellSandboxReadiness;
};

export type MycliShellState = {
	sessionId?: string;
	title?: string;
	messages: MycliShellMessage[];
	tools: MycliShellTool[];
	bash: MycliShellBash[];
	transcript?: MycliShellTranscriptBlock[];
	transcriptNextBefore?: string | null;
	footer: MycliShellFooterData;
	pendingInput?: MycliShellPendingInput;
	pendingNotice?: string;
	pendingApproval?: MycliShellPendingApproval;
	pendingClarification?: MycliShellPendingClarification;
	models?: MycliShellModel[];
	authProviders?: MycliShellAuthProvider[];
	authReadiness?: MycliShellCredentialReadiness;
	currentModel?: MycliShellModel;
	settings?: MycliShellVisualSettings;
	settingsCatalog?: MycliShellSettingsCatalog;
	keymap?: MycliShellEffectiveKeymap;
	terminalCapabilities?: MycliShellTerminalCapabilities;
	sessions?: MycliShellSession[];
	resources?: MycliShellResource[];
	permissions?: MycliShellPermissionState;
};

export type MycliShellCommandSpec = {
	id: string;
	name: string;
	description: string;
	argumentHint?: string;
	argumentPolicy: "none" | "optional" | "required";
	availableDuringTurn: boolean;
	aliases?: string[];
	category?: "diagnostics" | "interface" | "model" | "safety" | "session" | "tools";
	searchOnly?: boolean;
	available?: boolean;
	unavailableReason?: string;
};

export type MycliShellClientAction = {
	action: string;
	args: string;
	commandId: string;
};
