import type {
	RuntimeTurnRecord,
} from "@mycli/contracts";
import type {
	CachedUpdateStatus,
	UpdateRefreshResult,
	WorkspaceTrustState,
} from "@mycli/config";
import type {
	CanonicalMessage,
	ReasoningEffort,
	RuntimeEvent,
	ShellLifecycleEvent,
} from "@mycli/core";
import type {
	ExecutionPolicySnapshot,
	ForceInterruptInput,
	QueueCoordinator,
	ResolveApprovalInput,
	ResolveClarificationInput,
	RunExecutionSnapshot,
	SessionCoordinator,
	SubmitTurnOptions,
	TurnSubmission,
} from "@mycli/runtime";
import type {
	LoadShellOutputPageInput,
	ShellOutputPage,
	TranscriptItem,
	TurnReservation,
} from "@mycli/storage";
import type {
	PermissionProfile,
	SandboxReadiness,
	ShellSessionSnapshot,
} from "@mycli/tools";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";
import type { AgentInteractiveRequestGateway } from "./agent-interactive-requests.ts";
import type { SessionPreferences } from "./session-preferences.ts";
import type {
	ApplyResumeRepairInput,
	ApplyResumeRepairResult,
	ResumeRepairPreview,
	SessionQuery,
	SessionSummary,
} from "./session-service.ts";

type JsonObject = Record<string, unknown>;

export type CredentialReadinessSource =
	| "environment"
	| "stored"
	| "legacy_config"
	| "missing";

export interface NodeGatewayCredentialReadiness {
	readonly ready: boolean;
	readonly providerId: string;
	readonly authRef: string;
	readonly source: CredentialReadinessSource;
}

export interface NodeGatewayCompactionResult {
	readonly status: "compressed" | "skipped" | "not_needed" | "failed" | "interrupted";
	readonly beforeTokens: number;
	readonly afterTokens: number;
	readonly durationSeconds?: number;
	readonly reason?: string;
}

export interface NodeGatewayRuntime {
	readonly queueCoordinator?: QueueCoordinator;
	sessionPreferences?(): SessionPreferences | undefined;
	setSessionPreferences?(preferences: SessionPreferences): void;
	ensureSessionPreferences?(input: {
		readonly provider: string;
		readonly model: string;
		readonly reasoningEffort?: ReasoningEffort;
		readonly collaborationMode: "default" | "plan";
		readonly permissionProfile?: PermissionProfile;
	}): SessionPreferences;
	executionPolicySnapshot?(): ExecutionPolicySnapshot | undefined;
	runExecutionSnapshot?(turnId: string): RunExecutionSnapshot | undefined;
	listCommandAllowances?(): readonly (readonly string[])[];
	addCommandAllowance?(pattern: string): readonly (readonly string[])[];
	removeCommandAllowance?(pattern: string): readonly (readonly string[])[];
	clearCommandAllowances?(): number;
	compact?(input: {
		readonly modelOverride?: string;
		readonly signal: AbortSignal;
	}): Promise<NodeGatewayCompactionResult>;
	configureExecutionPolicy?(input: {
		readonly trust: WorkspaceTrustState;
		readonly permission: PermissionProfile;
	}): void;
	configureRuntimeContext?(input: {
		readonly collaborationMode: string;
		readonly turnId?: string;
	}): void;
	refreshExtensions?(): void;
	reserve(submission: TurnSubmission): TurnReservation;
	resolveApproval(
		input: ResolveApprovalInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord>;
	resolveClarification(
		input: ResolveClarificationInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord>;
	submit(
		submission: TurnSubmission,
		emit: (event: RuntimeEvent) => void,
		options: SubmitTurnOptions,
	): Promise<RuntimeTurnRecord>;
	forceInterrupt(
		input: ForceInterruptInput,
		emit: (event: RuntimeEvent) => void,
	): Promise<RuntimeTurnRecord>;
}

export interface NodeGatewayMemoryCommands {
	directory(): Promise<string>;
	scan(): Promise<readonly JsonObject[]>;
	remember(input: {
		readonly kind: "user" | "feedback" | "project" | "reference";
		readonly name: string;
		readonly description: string;
		readonly content: string;
	}): Promise<JsonObject>;
	forget(query: string): Promise<readonly JsonObject[]>;
}

export interface NodeGatewayBackgroundTaskCommands {
	list(parentSessionId: string): readonly JsonObject[];
	interrupt(parentSessionId: string, childSessionId: string): Promise<boolean>;
	interruptAll(parentSessionId: string): Promise<number>;
}

export interface NodeGatewaySessionCommands {
	list?(query: SessionQuery): readonly SessionSummary[];
	inspect?(sessionId: string): SessionSummary | undefined;
	previewResume?(sessionId: string): Promise<ResumeRepairPreview>;
	applyResumeRepair?(input: ApplyResumeRepairInput): Promise<ApplyResumeRepairResult>;
	fork(input: {
		readonly sourceSessionId: string;
		readonly targetSessionId: string;
		readonly forkPoint?: number;
	}): {
		readonly sourceSessionId: string;
		readonly targetSessionId: string;
		readonly forkPoint: number;
		readonly messageCount: number;
	};
	search(query: string, workspaceRoot: string): readonly {
		readonly sessionId: string;
		readonly messageIndex: number;
		readonly role: string;
		readonly snippet: string;
	}[];
	maintenance(
		action: "report" | "empty" | "payloads" | "orphans" | "vacuum"
			| "transcript_normalization" | "content_blobs" | "content_blob_gc",
		workspaceRoot: string,
	): JsonObject | Promise<JsonObject>;
}

export interface NodeGatewayTraceCommands {
	inspect(sessionId: string): readonly JsonObject[];
	export(sessionId: string): readonly string[];
	logs(): readonly string[];
	append?(sessionId: string, event: JsonObject): void;
}

export interface NodeGatewayFileHistoryCommands {
	list(sessionId: string): Promise<readonly {
		readonly snapshotId: string;
		readonly turnId: string;
		readonly toolName: string;
		readonly path: string;
	}[]>;
	undo(sessionId: string): Promise<{
		readonly snapshotId?: string;
		readonly restoredPaths: readonly string[];
		readonly deletedPaths: readonly string[];
		readonly error?: string;
	}>;
}

export interface NodeGatewayControlCommands {
	authProviders(): Promise<readonly JsonObject[]>;
	credentialReadiness?(): Promise<NodeGatewayCredentialReadiness>;
	saveApiKey(providerId: string, apiKey: string, authRef?: string): Promise<JsonObject>;
	providers(): Promise<readonly JsonObject[]>;
	models(provider: string): Promise<readonly JsonObject[]>;
	selectModel(input: JsonObject): Promise<JsonObject>;
	validateConnectivity?(): Promise<JsonObject>;
	activateSessionPreferences?(
		preferences: SessionPreferences | undefined,
	): Promise<SessionPreferences>;
	loadSettings(): Promise<JsonObject>;
	resetKeymap?(): Promise<JsonObject>;
	saveSetting?(settingId: string, value: string | boolean): Promise<JsonObject>;
	saveSettings(settings: JsonObject): Promise<JsonObject>;
	completePath(prefix: string): Promise<readonly JsonObject[]>;
}

export interface NodeGatewayUpdateCommands {
	status(): Promise<CachedUpdateStatus>;
	check(): Promise<UpdateRefreshResult>;
	dismiss(version: string): Promise<CachedUpdateStatus>;
}

export interface NodeGatewayIntegrationCommands {
	list(): readonly JsonObject[];
	run(command: string, signal: AbortSignal): Promise<JsonObject | undefined>;
}

export interface NodeGatewayIntegrations {
	readonly toolManifest?: JsonObject | (() => JsonObject | undefined);
	readonly diagnostics?: readonly JsonObject[] | (() => readonly JsonObject[]);
	toolNames?(): readonly string[];
	listResources?(): readonly JsonObject[] | Promise<readonly JsonObject[]>;
	readonly commands?: NodeGatewayIntegrationCommands;
	subscribeSubagents?(
		listener: (subagent: Readonly<Record<string, unknown>>) => void,
	): () => void;
	subscribeExtensions?(listener: (version: number) => void): () => void;
}

export interface CreateNodeGatewayOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly toolNames?: readonly string[];
	readonly maxPromptTokens?: number | (() => number);
	readonly sandboxReadiness?: SandboxReadiness;
	readonly runtime: NodeGatewayRuntime;
	readonly loadConversation: (sessionId: string) => readonly CanonicalMessage[];
	readonly loadTranscript?: (sessionId: string) => readonly TranscriptItem[];
	readonly loadTranscriptPage?: (
		sessionId: string,
		input: { readonly before?: string; readonly limit?: number },
	) => {
		readonly hasCanonicalHistory: boolean;
		readonly items: readonly TranscriptItem[];
		readonly nextBefore: string | null;
	};
	readonly loadShellOutput?: (input: LoadShellOutputPageInput) => ShellOutputPage;
	readonly loadTurnRollouts?: (sessionId: string) => readonly JsonObject[];
	readonly memoryCommands?: NodeGatewayMemoryCommands;
	readonly backgroundTaskCommands?: NodeGatewayBackgroundTaskCommands;
	readonly sessionCommands?: NodeGatewaySessionCommands;
	readonly traceCommands?: NodeGatewayTraceCommands;
	readonly fileHistoryCommands?: NodeGatewayFileHistoryCommands;
	readonly controlCommands?: NodeGatewayControlCommands;
	readonly updateStatus?: CachedUpdateStatus;
	readonly updateCommands?: NodeGatewayUpdateCommands;
	readonly sessionCoordinator?: SessionCoordinator<NodeGatewayRuntime>;
	readonly shellManager?: {
		list(ownerSessionId: string): readonly ShellSessionSnapshot[];
		terminate(ownerSessionId: string, shellId: string): Promise<ShellSessionSnapshot>;
		terminateOwner(ownerSessionId: string): Promise<readonly ShellSessionSnapshot[]>;
	};
	readonly shellLifecycle?: {
		subscribe(listener: (event: ShellLifecycleEvent) => void): () => void;
	};
	readonly workspaceTrust?: {
		readonly initialState: WorkspaceTrustState;
		load(workspaceRoot: string): Promise<WorkspaceTrustState>;
		save(workspaceRoot: string, state: WorkspaceTrustState): Promise<void>;
		reload?(
			workspaceRoot: string,
			state: WorkspaceTrustState,
		): Promise<SessionPreferences | void>;
	};
	readonly agentInteractiveRequests?: AgentInteractiveRequestGateway;
	readonly integrations?: NodeGatewayIntegrations;
	readonly close: () => void | Promise<void>;
	readonly createTurnId?: () => string;
	readonly clock?: () => number;
}

export interface NodeGateway {
	readonly transport: GatewayTransport;
	readonly completion: Promise<number>;
	publishRecoveredInterrupt(
		record: RuntimeTurnRecord,
		options?: { readonly inputRolledBack?: boolean },
	): void;
	close(): Promise<void>;
	kill(): void;
	diagnostic(): string;
}
