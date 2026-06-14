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
	diffPreview?: string;
	outputPreview?: string;
	errorPreview?: string;
	hiddenLineCount?: number;
	hidden?: boolean;
	expanded?: boolean;
};

export type MycliShellBash = {
	id: string;
	command: string;
	status: MycliShellToolStatus;
	exitCode?: number;
	outputPreview?: string;
	hiddenLineCount?: number;
	expanded?: boolean;
};

export type MycliShellTranscriptBlock =
	| { id: string; kind: "message"; message: MycliShellMessage }
	| { id: string; kind: "plan"; plan: MycliShellPlan }
	| { id: string; kind: "tool"; tool: MycliShellTool }
	| { id: string; kind: "bash"; bash: MycliShellBash };

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
	trust?: string;
	collaborationMode?: "default" | "plan";
	liveState?: string;
	extensionStatuses?: string[];
};

export type MycliShellModel = {
	provider: string;
	id: string;
	name?: string;
	thinkingLevel?: string;
	scoped?: boolean;
};

export type MycliShellVisualSettings = {
	statusbarMode?: "off" | "compact" | "full";
	viewMode?: "default" | "verbose" | "focus";
	theme?: string;
	hideThinking?: boolean;
};

export type MycliShellSession = {
	id: string;
	title?: string;
	cwd?: string;
	modified?: string;
};

export type MycliShellState = {
	title?: string;
	messages: MycliShellMessage[];
	tools: MycliShellTool[];
	bash: MycliShellBash[];
	transcript?: MycliShellTranscriptBlock[];
	activePlan?: MycliShellPlanStep[];
	footer: MycliShellFooterData;
	pendingNotice?: string;
	models?: MycliShellModel[];
	currentModel?: MycliShellModel;
	settings?: MycliShellVisualSettings;
	sessions?: MycliShellSession[];
};

export type MycliShellCommand = {
	id: string;
	label: string;
	description?: string;
	run: () => void | Promise<void>;
};
