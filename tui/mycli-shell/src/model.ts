export type MycliShellMessage =
	| { id: string; role: "user"; text: string }
	| { id: string; role: "assistant"; text: string; thinking?: string; thinkingHidden?: boolean }
	| { id: string; role: "system" | "error" | "warning"; text: string };

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
	outputPreview?: string;
	errorPreview?: string;
	hiddenLineCount?: number;
	hidden?: boolean;
	expanded?: boolean;
};

export type MycliShellBash = {
	id: string;
	toolName?: "Shell" | "Bash" | string;
	command: string;
	status: MycliShellToolStatus;
	shellId?: string;
	callId?: string;
	background?: boolean;
	processState?: string;
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

export type MycliShellSubagentStatus = "running" | "completed" | "failed" | "cancelled" | "max_tool_calls" | string;

export type MycliShellSubagent = {
	id: string;
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

export type MycliShellSubagentProgress = {
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

export type MycliShellBackgroundProcess = {
	shellId: string;
	commandPreview: string;
	recentOutput: string[];
};

export type MycliShellBackgroundTerminals = {
	id: string;
	processes: MycliShellBackgroundProcess[];
};

export type MycliShellTranscriptBlock =
	| { id: string; kind: "message"; message: MycliShellMessage }
	| { id: string; kind: "plan"; plan: MycliShellPlan }
	| { id: string; kind: "tool"; tool: MycliShellTool }
	| { id: string; kind: "bash"; bash: MycliShellBash }
	| { id: string; kind: "subagent"; subagent: MycliShellSubagent }
	| { id: string; kind: "background_terminals"; backgroundTerminals: MycliShellBackgroundTerminals }
	| { id: string; kind: "diagnostic"; diagnostic: MycliShellCommandDiagnostic };

export type MycliShellFooterData = {
	cwd: string;
	gitBranch?: string;
	sessionName?: string;
	provider?: string;
	model?: string;
	reasoningLevel?: string;
	contextPercent?: number;
	contextWindow?: number;
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
	backgroundShellCount?: number;
	extensionStatuses?: string[];
};

export type MycliShellQueuedInputPreview = {
	text: string;
	hasImages: boolean;
};

export type MycliShellPendingInput = {
	steering: MycliShellQueuedInputPreview[];
	followUps: MycliShellQueuedInputPreview[];
};

export type MycliShellModel = {
	provider: string;
	id: string;
	name?: string;
	thinkingLevel?: string;
	scoped?: boolean;
};

export type MycliShellAuthProvider = {
	id: string;
	name: string;
	configured?: boolean;
	defaultModel?: string;
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
	named?: boolean;
	current?: boolean;
};

export type MycliShellSessionTreeNodeKind = "session" | "message";

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

export type MycliShellApprovalOption = {
	choice: string;
	label: string;
};

export type MycliShellPendingApproval = {
	decisionId: string;
	preview: string;
	reason?: string;
	toolName?: string;
	workerName?: string;
	workerColor?: string;
	childSessionId?: string;
	options: MycliShellApprovalOption[];
	risk?: string;
	riskReason?: string;
	contentPreview?: string;
	contentLineCount?: number;
	diffPreview?: string;
};

export type MycliShellState = {
	title?: string;
	messages: MycliShellMessage[];
	tools: MycliShellTool[];
	bash: MycliShellBash[];
	transcript?: MycliShellTranscriptBlock[];
	activePlan?: MycliShellPlanStep[];
	footer: MycliShellFooterData;
	pendingInput?: MycliShellPendingInput;
	pendingNotice?: string;
	pendingApproval?: MycliShellPendingApproval;
	models?: MycliShellModel[];
	authProviders?: MycliShellAuthProvider[];
	currentModel?: MycliShellModel;
	settings?: MycliShellVisualSettings;
	sessions?: MycliShellSession[];
	resources?: MycliShellResource[];
};

export type MycliShellCommand = {
	id: string;
	label: string;
	description?: string;
	run: () => void | Promise<void>;
};
