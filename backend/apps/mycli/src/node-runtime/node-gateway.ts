import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
	gatewayContractCatalog,
	isModelSelectionScope,
	parseGatewayEvent,
	parseJsonRpcMessage,
	runtimeErrorPublicMessage,
	runtimeRetryStatusText,
	sanitizeRuntimeErrorDetail,
} from "@mycli/contracts";
import {
	CachedUpdateError,
	shellSettingDescriptor,
	type CachedUpdateStatus,
	type UpdateRefreshResult,
	type WorkspaceTrustState,
} from "@mycli/config";
import type {
	ModelSelectionScope,
	RuntimeErrorCode,
	RuntimeTurnRecord,
} from "@mycli/contracts";
import {
	type QueueMutation,
	type QueueSnapshot,
	type CanonicalMessage,
	type ProviderUsage,
	type QueuedInput,
	type RuntimeEvent,
	type ReasoningEffort,
	type ShellLifecycleEvent,
	type WebSearchAction,
} from "@mycli/core";
import type {
	PendingSessionApproval,
	PendingSessionClarification,
	ExecutionPolicySnapshot,
	QueueCoordinator,
	ResolveApprovalInput,
	ResolveClarificationInput,
	SessionCoordinator,
	SessionExecutionClaim,
	SessionGenerationContext,
	SubmitTurnOptions,
	ForceInterruptInput,
	TurnSubmission,
} from "@mycli/runtime";
import {
	projectMutationMetadata,
	sanitizeShellSnapshotPayload,
	SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
} from "@mycli/storage";
import type {
	LoadShellOutputPageInput,
	ShellOutputPage,
	TranscriptItem,
	TurnReservation,
} from "@mycli/storage";
import {
	permissionRequestJson,
	sandboxNotRequired,
	type PermissionProfile,
	type SandboxReadiness,
	type ShellSessionSnapshot,
} from "@mycli/tools";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";
import {
	builtinCommandNames,
	commandDiscoveryManifest,
	commandManifest,
	resolveSlashCommand,
	SlashCommandError,
	type SlashCommandSurface,
} from "./node-slash-command-registry.ts";
import { buildNodeSettingsCatalog } from "./node-settings-catalog.ts";
import {
	diagnosticCommandResult,
	errorCommandResult,
	listCommandResult,
	noticeCommandResult,
	preformattedCommandResult,
	statusCommandResult,
} from "./node-slash-command-results.ts";
import type { AgentInteractiveRequestGateway } from "./agent-interactive-requests.ts";
import {
	approvalPreviewDetails,
	approvalPreviewPayload,
	fileMutationChangesPayload,
} from "./approval-preview.ts";
import {
	extractProposedPlan,
	ProposedPlanStreamFilter,
} from "./proposed-plan.ts";
import {
	GatewayFailure,
	gatewayFailure,
	gatewayFailureDiagnostic,
	gatewayRequestOccurrenceId,
} from "./node-gateway-errors.ts";
import type { SessionPreferences } from "./session-preferences.ts";
import type {
	ApplyResumeRepairInput,
	ApplyResumeRepairResult,
	ResumeRepairPreview,
	ResumeRepairAction,
	SessionQuery,
	SessionSummary,
} from "./session-service.ts";
import { MYCLI_VERSION } from "../version.ts";

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

const GRACEFUL_INTERRUPT_TIMEOUT_MS = 100;

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

export interface NodeGateway {
	readonly transport: GatewayTransport;
	readonly completion: Promise<number>;
	publishRecoveredInterrupt(record: RuntimeTurnRecord, options?: {
		readonly inputRolledBack?: boolean;
	}): void;
	close(): Promise<void>;
	kill(): void;
	diagnostic(): string;
}

interface ActiveTurn {
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly controller: AbortController;
	readonly context: SessionGenerationContext;
	readonly runtime: NodeGatewayRuntime;
	readonly executionClaim?: SessionExecutionClaim;
	readonly collaborationMode: "default" | "plan";
	readonly planStreamFilter?: ProposedPlanStreamFilter;
	turnId?: string;
	terminalEmitted: boolean;
	terminalState?: "completed" | "failed" | "interrupted";
	visibleAgentOutput?: boolean;
	pendingProposedPlan?: string;
	inputRolledBack?: boolean;
	interruptionFinalizedLogged?: boolean;
	resubmitPendingSteersAfterInterrupt?: boolean;
	interruptedSteerClientIds?: readonly string[];
	failedSteersPrepared?: boolean;
	interruptPromise?: Promise<JsonObject>;
	forceInterruptPromise?: Promise<RuntimeTurnRecord>;
	contextWindow?: Readonly<{
		readonly usedTokens: number;
		readonly maxTokens: number;
		readonly source: "provider_live" | "runtime_estimate";
	}>;
}

interface RpcRequest {
	readonly id: string | number;
	readonly method: string;
	readonly params: JsonObject;
}

type InteractiveRequestMethod = "approval.request" | "clarify.request";
type InteractiveResponseMethod = "approval.respond" | "clarify.respond";

interface QueuedInteractiveRequest {
	readonly method: InteractiveRequestMethod;
	readonly params: JsonObject;
	readonly identity: string;
}

class InProcessNodeGateway implements NodeGateway {
	readonly transport: GatewayTransport;
	readonly completion: Promise<number>;
	readonly #options: CreateNodeGatewayOptions;
	readonly #clientInput = new PassThrough();
	readonly #clientOutput = new PassThrough();
	readonly #clock: () => number;
	readonly #resolveCompletion: (code: number) => void;
	#activeTurn: ActiveTurn | null = null;
	#activeTurnTask: Promise<void> | null = null;
	#turnAdmissionPending = false;
	#sessionTransitionActive = false;
	#sessionControlActive = false;
	#sequence = 0;
	#closed = false;
	#closePromise: Promise<void> | null = null;
	#unsubscribeQueue: (() => void) | null = null;
	#unsubscribeShell: (() => void) | null = null;
	#unsubscribeSubagents: (() => void) | null = null;
	#unsubscribeExtensions: (() => void) | null = null;
	#unsubscribeAgentInteractiveRequests: (() => void) | null = null;
	readonly #interactiveRequests: QueuedInteractiveRequest[] = [];
	readonly #closeAfterResponses = new WeakSet<JsonObject>();
	#trustState: WorkspaceTrustState;
	#permissionProfile: PermissionProfile = "workspace";
	#provider: string;
	#model: string;
	#reasoningEffort: ReasoningEffort | undefined;
	#visibleUpdateStatus: CachedUpdateStatus | undefined;
	#collaborationMode: "default" | "plan" = "default";
	readonly #collaborationModeByTurn = new Map<string, "default" | "plan">();

	constructor(options: CreateNodeGatewayOptions) {
		this.#options = options;
		this.#clock = options.clock ?? (() => Date.now() / 1000);
		this.#trustState = options.workspaceTrust?.initialState ?? "unknown";
		this.#provider = options.provider;
		this.#model = options.model;
		this.#reasoningEffort = options.reasoningEffort;
		this.#visibleUpdateStatus = options.updateStatus;
		this.#applySessionPreferences(options.runtime.sessionPreferences?.(), options.runtime);
		this.#configureExecutionPolicy();
		let resolveCompletion!: (code: number) => void;
		this.completion = new Promise<number>((resolve) => { resolveCompletion = resolve; });
		this.#resolveCompletion = resolveCompletion;
		this.transport = {
			input: this.#clientInput,
			output: this.#clientOutput,
			close: () => this.close(),
		};
		const lines = createInterface({ input: this.#clientOutput, crlfDelay: Infinity });
		lines.on("line", (line) => { this.#handleLine(line); });
		lines.on("error", () => { void this.close(); });
		this.#clientOutput.on("error", () => { void this.close(); });
		this.#bindQueue();
		this.#bindShellLifecycle();
		this.#bindSubagents();
		this.#bindExtensions();
		this.#bindAgentInteractiveRequests();
		this.#emitDirect("runtime.ready", { session_id: this.#sessionId() });
		this.#requestNextQueuedTurn();
	}

	close(): Promise<void> {
		this.#closePromise ??= (async () => {
			if (this.#closed) return;
			this.#closed = true;
			this.#unsubscribeQueue?.();
			this.#unsubscribeQueue = null;
			this.#unsubscribeShell?.();
			this.#unsubscribeShell = null;
				this.#unsubscribeSubagents?.();
				this.#unsubscribeSubagents = null;
				this.#unsubscribeExtensions?.();
				this.#unsubscribeExtensions = null;
			this.#unsubscribeAgentInteractiveRequests?.();
			this.#unsubscribeAgentInteractiveRequests = null;
			this.#interactiveRequests.length = 0;
			this.#activeTurn?.controller.abort();
			let exitCode = 0;
			try {
				await this.#activeTurnTask;
				await this.#options.close();
			} catch {
				exitCode = 1;
			} finally {
				this.#clientInput.end();
				this.#clientOutput.end();
				this.#resolveCompletion(exitCode);
			}
		})();
		return this.#closePromise;
	}

	kill(): void {
		void this.close();
	}

	diagnostic(): string {
		return "";
	}

	publishRecoveredInterrupt(record: RuntimeTurnRecord, options: {
		readonly inputRolledBack?: boolean;
	} = {}): void {
		if (record.session_id !== this.#sessionId() || record.status !== "interrupted") {
			throw new Error("invalid_recovered_interrupt");
		}
		this.#emitRuntime("turn.interrupted", {
			client_turn_id: record.client_turn_id,
			turn_id: record.turn_id,
			code: "interrupted",
			requested: false,
			message: "Turn interrupted",
			input_rolled_back: options.inputRolledBack === true,
		});
		this.#emitRuntime("turn.status", {
			state: "interrupted",
			kind: "interrupted",
			text: "Interrupted",
			terminal: true,
			client_turn_id: record.client_turn_id,
			turn_id: record.turn_id,
			message: "Turn interrupted",
		});
		this.#emitRuntime(
			"status.update",
			{
				...statusPayload("interrupted", record.client_turn_id, "Turn interrupted"),
				turn_id: record.turn_id,
			},
		);
		this.#emitRuntime("status.changed", this.#status());
	}

	#handleLine(line: string): void {
		if (this.#closed) return;
		let request: RpcRequest;
		try {
			const parsed = parseJsonRpcMessage(JSON.parse(line) as unknown);
			if (!("id" in parsed) || !("method" in parsed) || typeof parsed.method !== "string") {
				return;
			}
			request = {
				id: parsed.id as string | number,
				method: parsed.method,
				params: isObject(parsed.params) ? parsed.params : {},
			};
		} catch {
			this.#writeError(null, "invalid_params", "Invalid JSON-RPC request.");
			return;
		}
		try {
			const result = this.#handleRequest(request);
			if (result instanceof Promise) {
				void result.then(
					(value) => { this.#completeRequest(request, value); },
					(error: unknown) => { this.#failRequest(request, error); },
				);
			} else {
				this.#completeRequest(request, result);
			}
		} catch (error) {
			this.#failRequest(request, error);
		}
	}

	#handleRequest(request: RpcRequest): JsonObject | Promise<JsonObject> {
		switch (request.method) {
			case "initialize":
				return this.#bootstrap(
					{ protocol_version: request.params.protocol_version ?? 1 },
					false,
				);
			case "status.get":
			case "status.inspect":
				return this.#status();
			case "workspace.trust.status":
				return this.#trustStatus();
			case "workspace.trust.set":
				return this.#setWorkspaceTrust(request.params);
			case "permissions.list":
				return this.#permissions();
			case "permissions.update":
				return this.#updatePermissions(request.params);
			case "extension.manifest":
				return extensionManifest(
					this.#options.integrations?.toolNames?.() ?? this.#options.toolNames ?? [],
					integrationToolManifest(this.#options.integrations),
				);
			case "resource.list":
				return this.#resourceList();
			case "session.bootstrap":
				return this.#bootstrap(request.params, true);
			case "transcript.load":
				return this.#transcript(request.params);
			case "command.list":
				return this.#commandList(request.params);
			case "command.run":
				return this.#commandRun(request.params);
			case "completion.slash":
				return this.#completeSlash(request.params);
			case "completion.path":
				return this.#completePath(request.params);
			case "auth.api_key.save":
				return this.#saveApiKey(request.params);
			case "provider.list":
				return this.#providerList();
			case "model.list":
				return this.#modelList(request.params);
			case "model.select":
				return this.#selectModel(request.params);
			case "provider.connectivity.validate":
				return this.#validateConnectivity();
			case "settings.load":
				return this.#loadSettings();
			case "settings.keymap.reset":
				return this.#resetKeymap();
			case "settings.save":
				return this.#saveSettings(request.params);
			case "update.status":
				return this.#updateStatus();
			case "update.dismiss":
				return this.#updateDismiss(request.params);
			case "trace.export":
				return this.#traceExport(request.params);
			case "session.list":
				return this.#sessionList(request.params);
			case "session.resume.preview":
				return this.#sessionResumePreview(request.params);
			case "session.new":
				return this.#sessionNew();
			case "session.resume":
				return this.#sessionResume(request.params);
			case "session.tree":
				return this.#sessionTree(request.params);
			case "shell.list":
				return this.#shellList();
			case "shell.output.load":
				return this.#shellOutput(request.params);
			case "shell.stop":
				return this.#shellStop(request.params);
			case "shell.stop_all":
				return this.#shellStopAll();
			case "turn.submit":
				return this.#submit(request.params);
			case "approval.respond":
			case "decision.resolve":
				return this.#approvalRespond(request.params);
			case "clarify.respond":
				return this.#clarificationRespond(request.params);
			case "turn.steer":
				return this.#steer(request.params);
			case "turn.follow_up":
				return this.#followUp(request.params);
			case "turn.queue.pop":
				return this.#queuePop(request.params);
			case "turn.queue.clear":
				return this.#queueClear(request.params);
			case "turn.queue.restore.ack":
				return this.#queueRestoreAck(request.params);
			case "turn.queue.migration.ack":
				return this.#queueMigrationAck(request.params);
			case "turn.interrupt":
				return this.#interrupt(request.params);
			case "shutdown":
				return { ok: true };
			default:
				throw new GatewayFailure("method_not_found", "Unknown gateway method.");
		}
	}

	#completeRequest(request: RpcRequest, result: JsonObject): void {
		this.#writeResult(request.id, result);
		if (request.method === "shutdown" || this.#closeAfterResponses.has(result)) {
			queueMicrotask(() => { void this.close(); });
		}
	}

	#failRequest(request: RpcRequest, error: unknown): void {
		const failure = gatewayFailure(error);
		const occurrenceId = gatewayRequestOccurrenceId();
		const diagnostic = gatewayFailureDiagnostic(failure.code);
		const data = {
			...failure.data,
			occurrence_id: occurrenceId,
			category: diagnostic.category,
			...(diagnostic.recoveryActions.length > 0
				? { recovery_actions: diagnostic.recoveryActions }
				: {}),
		};
		this.#writeError(request.id, failure.code, failure.message, data);
		if (failure.code === "auth_required") return;
		this.#emitRuntime("gateway.error", {
			code: failure.code === "persistence_error" ? "internal_error" : failure.code,
			message: failure.message,
			method: request.method,
			occurrence_id: occurrenceId,
			category: diagnostic.category,
			...(diagnostic.recoveryActions.length > 0
				? { recovery_actions: diagnostic.recoveryActions }
				: {}),
		});
	}

	async #bootstrap(params: JsonObject, reemitPendingState: boolean): Promise<JsonObject> {
		if (params.protocol_version !== 1) {
			throw new GatewayFailure("incompatible_protocol", "Unsupported gateway protocol version.");
		}
		const [authProviders, authStatus] = await Promise.all([
			this.#authProviders(),
			this.#credentialReadiness(),
		]);
		const payload: JsonObject = {
			protocol_version: 1,
			session_id: this.#sessionId(),
			workspace: this.#workspaceRoot(),
			provider: this.#provider,
			model: this.#model,
			status: this.#status(),
			background_shells: this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, this.#sessionContext())),
			auth_providers: authProviders,
			...(authStatus ? { auth_status: credentialReadinessPayload(authStatus) } : {}),
			permissions: this.#permissions(),
			...(this.#visibleUpdateStatus ? {
				update: cachedUpdateStatusPayload(this.#visibleUpdateStatus),
			} : {}),
			welcome: {
				startup_mark: { text: "mycli" },
				workspace: this.#workspaceRoot(),
			},
		};
		const migration = this.#queueCoordinator()?.legacyMigration();
		if (migration) payload.legacy_user_queue_migration = {
			token: migration.token,
			records: migration.records.map(legacyMigrationRecord),
		};
		const session = this.#options.sessionCoordinator?.snapshot();
		if (reemitPendingState && session?.pendingApproval) {
			this.#emitRuntime(
				"approval.request",
				approvalRequest(session.pendingApproval, session.generation),
			);
		}
		if (reemitPendingState && session?.pendingClarification) {
			this.#emitRuntime(
				"clarify.request",
				clarificationRequest(session.pendingClarification, session.generation),
			);
		}
		return payload;
	}

	async #transcript(params: JsonObject): Promise<JsonObject> {
		const sessionId = optionalString(params.session_id) ?? this.#sessionId();
		const before = optionalString(params.before);
		const limit = transcriptPageLimit(params.limit);
		if (sessionId === this.#sessionId()
			&& this.#options.loadTranscriptPage
			&& (!before || before.startsWith("v1."))) {
			try {
				const page = this.#options.loadTranscriptPage(sessionId, {
					...(before ? { before } : {}),
					limit,
				});
				if (!before && !page.hasCanonicalHistory && this.#options.loadTranscript) {
					return paginatedTranscript(
						sessionId,
						this.#options.loadTranscript(sessionId).flatMap(gatewayTranscriptItems),
						params,
					);
				}
				return {
					session_id: sessionId,
					items: page.items.flatMap(gatewayTranscriptItems),
					next_before: page.nextBefore,
					read_only: false,
				};
			} catch (error) {
				if (error instanceof RangeError) {
					throw new GatewayFailure("invalid_params", "Transcript cursor or limit is invalid.");
				}
				throw error;
			}
		}
		if (sessionId === this.#sessionId() && this.#options.loadTranscript) {
			return paginatedTranscript(
				sessionId,
				this.#options.loadTranscript(sessionId).flatMap(gatewayTranscriptItems),
				params,
			);
		}
		if (this.#options.sessionCoordinator) {
			const prepared = await this.#options.sessionCoordinator.inspect(sessionId);
			if (!prepared.readOnly
				&& this.#options.loadTranscriptPage
				&& (!before || before.startsWith("v1."))) {
				try {
					const page = this.#options.loadTranscriptPage(sessionId, {
						...(before ? { before } : {}),
						limit,
					});
					if (!before && !page.hasCanonicalHistory && this.#options.loadTranscript) {
						return paginatedTranscript(
							sessionId,
							this.#options.loadTranscript(sessionId).flatMap(gatewayTranscriptItems),
							params,
							false,
						);
					}
					return {
						session_id: sessionId,
						items: page.items.flatMap(gatewayTranscriptItems),
						next_before: page.nextBefore,
						read_only: false,
					};
				} catch (error) {
					if (error instanceof RangeError) {
						throw new GatewayFailure("invalid_params", "Transcript cursor or limit is invalid.");
					}
					throw error;
				}
			}
			return paginatedTranscript(
				sessionId,
				(prepared.readOnly || !this.#options.loadTranscript
					? prepared.transcript
					: this.#options.loadTranscript(sessionId)).flatMap(gatewayTranscriptItems),
				params,
				prepared.readOnly,
			);
		}
		if (sessionId !== this.#sessionId()) {
			throw new GatewayFailure("invalid_params", "Unknown session.");
		}
		const items = this.#options.loadConversation(sessionId).map((message, index) => ({
			id: `${sessionId}:message:${index + 1}`,
			type: message.role === "user" ? "user" : "assistant_final",
			text: message.content,
			folded: false,
			metadata: {},
		}));
		return { session_id: sessionId, items, next_before: null };
	}

	#shellOutput(params: JsonObject): JsonObject {
		const load = this.#options.loadShellOutput;
		if (!load) {
			throw new GatewayFailure("unavailable_feature", "Full Shell transcript output is unavailable.");
		}
		const sessionId = optionalString(params.session_id) ?? this.#sessionId();
		const callId = optionalString(params.call_id);
		const page = load({
			sessionId,
			shellId: requiredString(params.shell_id, "shell_id"),
			...(callId ? { callId } : {}),
			...(params.after_sequence === undefined ? {} : {
				afterSequence: optionalNonNegativeInteger(params.after_sequence, "after_sequence"),
			}),
			...(params.limit_chars === undefined ? {} : {
				limitChars: positiveIntegerParameter(params.limit_chars, "limit_chars"),
			}),
		});
		return shellOutputPagePayload(page);
	}

	#commandList(params: JsonObject): JsonObject {
		const surface = slashCommandSurface(params.surface);
		const builtInNames = builtinCommandNames();
		const integrationCommands = (this.#options.integrations?.commands?.list() ?? [])
			.filter((command) =>
				typeof command.name === "string" && !builtInNames.has(command.name.trim()));
		const commands = [
			...commandDiscoveryManifest(surface).map((command) => {
				const unavailableReason = this.#commandUnavailableReason(command.id);
				return {
					...command,
					available: unavailableReason === undefined,
					...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
				};
			}),
			...integrationCommands,
			];
		return {
			commands,
			routing_names: [
				...builtinCommandNames(),
				...integrationCommands.flatMap((command) =>
					typeof command.name === "string" ? [command.name.trim()] : []),
			],
		};
	}

	#commandUnavailableReason(id: string): string | undefined {
		if (["login", "model", "settings"].includes(id) && !this.#options.controlCommands) {
			return "Runtime configuration controls are unavailable";
		}
		if (id === "memory" && !this.#options.memoryCommands) return "Session memory is unavailable";
		if (["fork", "resume", "session_maintenance", "session_search"].includes(id)
			&& !this.#options.sessionCommands) {
			return "Session storage controls are unavailable";
		}
		if (id === "trace" && !this.#options.traceCommands) return "Runtime trace export is unavailable";
		if (id === "update" && !this.#options.updateCommands) return "Update status is unavailable";
		if (["changes", "undo"].includes(id) && !this.#options.fileHistoryCommands) {
			return "File history is unavailable";
		}
		if (["ps", "stop"].includes(id) && !this.#options.shellManager) {
			return "Background terminals are unavailable";
		}
		if (id === "resources" && !this.#options.integrations?.listResources) {
			return "Integration resources are unavailable";
		}
		return undefined;
	}

	#completeSlash(params: JsonObject): JsonObject {
		const prefix = optionalString(params.prefix) ?? "/";
		const surface = params.surface === undefined ? "tui" : slashCommandSurface(params.surface);
		const commands = this.#commandList({ surface }).commands;
		return {
			items: Array.isArray(commands) ? commands.flatMap((value) => {
				if (
					!isObject(value)
					|| value.search_only === true
					|| typeof value.name !== "string"
					|| !value.name.startsWith(prefix)
				) {
					return [];
				}
				return [{
					value: value.name,
					description: typeof value.description === "string" ? value.description : "",
				}];
			}) : [],
		};
	}

	async #completePath(params: JsonObject): Promise<JsonObject> {
		const prefix = optionalString(params.prefix) ?? "@";
		const items = await this.#options.controlCommands?.completePath(prefix) ?? [];
		return { items };
	}

	async #saveApiKey(params: JsonObject): Promise<JsonObject> {
		const release = this.#claimSessionControlOperation(
			"Wait for the current session operation before saving credentials.",
		);
		try {
			const providerId = requiredString(params.provider_id, "provider_id").trim();
			const apiKey = requiredString(params.api_key, "api_key").trim();
			const authRef = optionalBoundedIdentity(params.auth_ref, "auth_ref");
			const commands = this.#options.controlCommands;
			if (!commands) {
				throw new GatewayFailure("internal_error", "Credential storage is unavailable.");
			}
			const saved = await commands.saveApiKey(providerId, apiKey, authRef);
			const readiness = await this.#credentialReadiness();
			return {
				...saved,
				...(readiness ? { auth_status: credentialReadinessPayload(readiness) } : {}),
			};
		} finally {
			release();
		}
	}

	async #authProviders(): Promise<readonly JsonObject[]> {
		return await this.#options.controlCommands?.authProviders() ?? [];
	}

	async #credentialReadiness(): Promise<NodeGatewayCredentialReadiness | null> {
		return await this.#options.controlCommands?.credentialReadiness?.() ?? null;
	}

	async #providers(): Promise<readonly JsonObject[]> {
		return await this.#options.controlCommands?.providers() ?? [];
	}

	async #models(provider: string): Promise<readonly JsonObject[]> {
		return await this.#options.controlCommands?.models(provider) ?? [];
	}

	async #providerList(): Promise<JsonObject> {
		return { providers: await this.#providers() };
	}

	async #modelList(params: JsonObject): Promise<JsonObject> {
		const provider = requiredString(params.provider, "provider").trim();
		return { provider, models: await this.#models(provider) };
	}

	async #selectModel(params: JsonObject): Promise<JsonObject> {
		const release = this.#claimSessionControlOperation(
			"Wait for the current turn to finish before changing models.",
		);
		try {
			const effort = reasoningEffort(params.reasoning_effort);
			const scope = modelSelectionScope(params.scope);
			const selection: JsonObject = {
				provider: requiredString(params.provider, "provider").trim(),
				protocol: requiredString(params.protocol, "protocol").trim(),
				model: requiredString(params.model, "model").trim(),
				base_url: requiredString(params.base_url, "base_url").trim(),
				collaboration_mode: this.#collaborationMode,
				scope,
				...(effort ? { reasoning_effort: effort } : {}),
			};
			const commands = this.#options.controlCommands;
			if (!commands) throw new GatewayFailure("internal_error", "Model selection is unavailable.");
			const selected = await commands.selectModel(selection);
			const persisted = this.#runtime().sessionPreferences?.();
			if (persisted) {
				this.#applySessionPreferences(persisted);
			} else {
				this.#provider = String(selected.provider ?? selection.provider);
				this.#model = String(selected.model ?? selection.model);
				this.#reasoningEffort = reasoningEffort(selected.reasoning_effort ?? effort);
			}
			const status = this.#status();
			this.#emitRuntime("status.changed", status);
			const selectedProvider = String(selected.provider ?? selection.provider);
			const models = await this.#models(selectedProvider);
			const authStatus = await this.#credentialReadiness();
			return {
				selected,
				provider: selectedProvider,
				scope,
				status,
				models: models.map((entry) => ({
					...entry,
					current: sameModelCatalogIdentity(entry, selected),
				})),
				...(authStatus ? { auth_status: credentialReadinessPayload(authStatus) } : {}),
			};
		} finally {
			release();
		}
	}

	async #validateConnectivity(): Promise<JsonObject> {
		const release = this.#claimSessionControlOperation(
			"Wait for the current turn to finish before testing provider connectivity.",
		);
		try {
			const validate = this.#options.controlCommands?.validateConnectivity;
			if (!validate) {
				return { ok: false, message: "Connection testing is unavailable." };
			}
			return await validate();
		} finally {
			release();
		}
	}

	async #loadSettings(): Promise<JsonObject> {
		const loaded = await this.#options.controlCommands?.loadSettings();
		const snapshot = settingsSnapshot(loaded);
		return this.#settingsPayload(snapshot);
	}

	async #resetKeymap(): Promise<JsonObject> {
		const release = this.#claimSessionControlOperation(
			"Wait for the current session operation before resetting the keymap.",
		);
		try {
			const resetKeymap = this.#options.controlCommands?.resetKeymap;
			if (!resetKeymap) {
				throw new GatewayFailure("internal_error", "Keymap storage is unavailable.");
			}
			const snapshot = settingsSnapshot(await resetKeymap());
			return {
				ok: true,
				message: "Reset TUI keymap.",
				...await this.#settingsPayload(snapshot),
			};
		} finally {
			release();
		}
	}

	async #saveSettings(params: JsonObject): Promise<JsonObject> {
		const release = this.#claimSessionControlOperation(
			"Wait for the current session operation before saving settings.",
		);
		try {
			const commands = this.#options.controlCommands;
			if (!commands) throw new GatewayFailure("internal_error", "Settings storage is unavailable.");
			if ("setting_id" in params || "value" in params) {
				const mutation = shellSettingMutation(params);
				if (!commands.saveSetting) {
					throw new GatewayFailure("internal_error", "Settings storage is unavailable.");
				}
				const saved = settingsSnapshot(await commands.saveSetting(mutation.settingId, mutation.value));
				return {
					ok: true,
					message: "Saved TUI setting.",
					...await this.#settingsPayload({
						...saved,
						sources: authoritativeSettingsSources(saved),
					}),
				};
			}
			if (!isObject(params.settings)) {
				throw new GatewayFailure("invalid_params", "settings is required.");
			}
			const settings = await commands.saveSettings(params.settings);
			const saved = settingsSnapshot(settings);
			return {
				ok: true,
				message: "Saved TUI settings.",
				...await this.#settingsPayload({
					...saved,
					sources: authoritativeSettingsSources(saved),
				}),
			};
		} finally {
			release();
		}
	}

	async #settingsPayload(snapshot: SettingsSnapshot): Promise<JsonObject> {
		const credential = await this.#credentialReadiness();
		return {
			settings: snapshot.settings,
			sources: snapshot.sources,
			keymap: snapshot.keymap,
			terminal_capabilities: snapshot.terminalCapabilities,
			source: Object.values(snapshot.sources).some((value) => value === "user")
				? "user_config"
				: "defaults",
			catalog: buildNodeSettingsCatalog({
				settings: snapshot.settings,
				sources: settingsSources(snapshot.sources),
				keymap: snapshot.keymap,
				terminalCapabilities: snapshot.terminalCapabilities,
				provider: this.#provider,
				model: this.#model,
				...(this.#reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
				...(credential ? {
					credential: { ready: credential.ready, source: credential.source },
				} : {}),
				permissions: this.#permissions(),
				trust: this.#trustStatus(),
				context: this.#contextWindow(),
				integrationsAvailable: this.#options.integrations?.listResources !== undefined,
				...(this.#visibleUpdateStatus ? { update: this.#visibleUpdateStatus } : {}),
			}),
		};
	}

	async #updateStatus(): Promise<JsonObject> {
		const commands = this.#requiredUpdateCommands();
		this.#visibleUpdateStatus = await commands.status();
		return { update: cachedUpdateStatusPayload(this.#visibleUpdateStatus) };
	}

	async #updateDismiss(params: JsonObject): Promise<JsonObject> {
		const version = requiredString(params.version, "version").trim();
		try {
			this.#visibleUpdateStatus = await this.#requiredUpdateCommands().dismiss(version);
		} catch (error) {
			throw updateGatewayFailure(error);
		}
		return {
			ok: true,
			dismissed_version: version,
			update: cachedUpdateStatusPayload(this.#visibleUpdateStatus),
		};
	}

	async #updateCommand(
		invocation: ReturnType<typeof resolveSlashCommand>,
	): Promise<JsonObject> {
		const commands = this.#requiredUpdateCommands();
		const args = invocation.args.trim();
		if (!args || args === "status") {
			this.#visibleUpdateStatus = await commands.status();
			return diagnosticCommandResult(
				invocation,
				"Updates",
				updateCommandFields(this.#visibleUpdateStatus),
			);
		}
		if (args === "check") {
			const checked = await commands.check();
			this.#visibleUpdateStatus = checked.status;
			return diagnosticCommandResult(invocation, "Updates", [
				{ label: "Check", value: checked.outcome },
				...updateCommandFields(checked.status),
			]);
		}
		const dismissMatch = /^dismiss\s+(\S+)$/u.exec(args);
		if (dismissMatch) {
			const version = dismissMatch[1]!;
			try {
				this.#visibleUpdateStatus = await commands.dismiss(version);
			} catch (error) {
				if (error instanceof CachedUpdateError) {
					return errorCommandResult(
						invocation,
						updateErrorMessage(error.code),
						"/update dismiss <version>",
					);
				}
				throw error;
			}
			return noticeCommandResult(invocation, "Updates", `Dismissed update ${version}.`, {
				extra: {
					dismissed_update_version: version,
					update_status: cachedUpdateStatusPayload(this.#visibleUpdateStatus),
				},
			});
		}
		return errorCommandResult(
			invocation,
			"Unsupported update action",
			"/update [check|dismiss <version>]",
		);
	}

	#requiredUpdateCommands(): NodeGatewayUpdateCommands {
		const commands = this.#options.updateCommands;
		if (!commands) throw new GatewayFailure("unavailable_feature", "Update status is unavailable.");
		return commands;
	}

	#traceExport(params: JsonObject): JsonObject {
		const trace = this.#options.traceCommands;
		if (!trace) throw new GatewayFailure("internal_error", "Trace export is unavailable.");
		const tail = params.tail === undefined ? 50 : positiveInteger(params.tail);
		if (tail === undefined) throw new GatewayFailure("invalid_params", "tail must be a positive integer.");
		return {
			session_id: this.#sessionId(),
			format: "jsonl",
			rows: trace.export(this.#sessionId()).slice(-tail),
		};
	}

	async #commandRun(params: JsonObject): Promise<JsonObject> {
		const command = requiredString(params.command, "command").trim();
		const surface = slashCommandSurface(params.surface);
		let invocation;
		try {
			invocation = resolveSlashCommand({
				text: command,
				surface,
				turnRunning: this.#activeTurn !== null,
			});
		} catch (error) {
			if (!(error instanceof SlashCommandError && error.code === "unknown_command")) {
				throw error;
			}
			const integrationResult = await this.#options.integrations?.commands?.run(
				command,
				new AbortController().signal,
			);
			if (integrationResult) return integrationResult;
			throw error;
		}
		if (invocation.owner === "tui") {
			return {
				execution: "tui",
				command_id: invocation.commandId,
				client_action: invocation.clientAction ?? "",
				args: invocation.args,
				presentation: invocation.presentation,
			};
		}
		if (invocation.commandId === "ps") {
			if (invocation.args === "stop-all") {
				const stopped = await this.#shellStopAll();
				return shellStopCommandResult(stopped);
			}
			const context = this.#sessionContext();
			const processes = this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, context));
			return shellPsCommandResult(processes);
		}
		if (invocation.commandId === "stop") {
			const stopped = await this.#shellStopAll();
			return shellStopCommandResult(stopped);
		}
		const coreResult = await this.#coreCommand(invocation);
		if (coreResult) return coreResult;
		throw new GatewayFailure("method_not_found", "Unknown command.");
	}

	async #coreCommand(invocation: ReturnType<typeof resolveSlashCommand>): Promise<JsonObject | undefined> {
		if (invocation.commandId === "new") {
			const created = await this.#sessionNew();
			return noticeCommandResult(invocation, "New session", `session=${created.session_id}`, {
				extra: { mutated_session: true, session_id: created.session_id },
			});
		}
		if (invocation.commandId === "status") {
			const status = this.#status();
			const permissions = isObject(status.permissions) ? status.permissions : {};
			const effective = isObject(permissions.effective) ? permissions.effective : {};
			const sandboxReadiness = isObject(permissions.sandbox_readiness)
				? permissions.sandbox_readiness
				: {};
			const contextWindow = isObject(status.context_window) ? status.context_window : {};
			const usedTokens = typeof contextWindow.used_tokens === "number" ? contextWindow.used_tokens : 0;
			const maxTokens = typeof contextWindow.max_tokens === "number" ? contextWindow.max_tokens : 0;
			return statusCommandResult(invocation, [
				{ label: "Session", value: String(status.session_id ?? this.#sessionId()) },
				{ label: "Model", value: this.#model },
				{ label: "Provider", value: this.#provider },
				{ label: "Directory", value: this.#workspaceRoot() },
				{
					label: "Context",
					value: maxTokens > 0
						? `${Math.round(usedTokens / maxTokens * 100)}% (${usedTokens}/${maxTokens})`
						: "unknown",
				},
				{ label: "Pending", value: status.pending_decision ? "yes" : "no" },
				{ label: "Suspended", value: status.suspended_turn ? "yes" : "no" },
				{ label: "Session state", value: String(status.session_lifecycle_status ?? "active") },
				{ label: "Session lock", value: String(status.session_lock_state ?? "unlocked") },
				{ label: "Recovery", value: String(status.session_pending_state ?? "none") },
				{ label: "Permissions", value: String(permissions.active ?? this.#permissionProfile) },
				{ label: "Sandbox", value: String(effective.sandbox_mode ?? "unknown") },
				{ label: "Filesystem", value: String(effective.filesystem ?? "unknown") },
				{ label: "Network", value: String(effective.network ?? "unknown") },
				{ label: "Approval", value: String(effective.approval_behavior ?? "unknown") },
				{ label: "Policy source", value: String(effective.source ?? "unknown") },
				{ label: "Sandbox readiness", value: String(sandboxReadiness.state ?? "unknown") },
				{ label: "State", value: String(status.state ?? "idle") },
			]);
		}
		if (invocation.commandId === "update") {
			return this.#updateCommand(invocation);
		}
		if (invocation.commandId === "usage") {
			const usage = aggregateUsage(this.#options.loadTurnRollouts?.(this.#sessionId()) ?? []);
			return diagnosticCommandResult(
				invocation,
				"Usage",
				Object.entries(usage).map(([key, value]) => ({
					label: humanize(key),
					value: String(value),
				})),
			);
		}
		if (invocation.commandId === "context") {
			const contextWindow = this.#status().context_window;
			const context = isObject(contextWindow) ? contextWindow : {};
			const used = typeof context.used_tokens === "number" ? context.used_tokens : 0;
			const maximum = typeof context.max_tokens === "number" ? context.max_tokens : 0;
			const source = typeof context.source === "string" ? context.source : "unknown";
			return diagnosticCommandResult(invocation, "Context", [
				{ label: "Used tokens", value: String(used) },
				{ label: "Max tokens", value: String(maximum) },
				{
					label: "Usage ratio",
					value: maximum > 0 ? `${Math.round(used / maximum * 100)}%` : "unknown",
				},
				{ label: "Source", value: source },
			]);
		}
		if (invocation.commandId === "stats") {
			const rollouts = this.#options.loadTurnRollouts?.(this.#sessionId()) ?? [];
			const transcript = this.#options.loadTranscript?.(this.#sessionId()) ?? [];
			return diagnosticCommandResult(invocation, "Runtime stats", [
				{ label: "Turns", value: String(rollouts.length) },
				{ label: "Transcript items", value: String(transcript.length) },
				{ label: "Tool calls", value: String(transcript.filter((item) => item.type === "tool").length) },
			]);
		}
		if (invocation.commandId === "tools") {
			const manifest = integrationToolManifest(this.#options.integrations);
			const tools = isObject(manifest) && Array.isArray(manifest.tools) ? manifest.tools : [];
			const toolRows = tools.flatMap((value, index) => {
				if (!isObject(value)) return [];
				return [{
					key: `tool:${index}`,
					label: String(value.name ?? value.id ?? "Tool"),
					values: [String(value.source ?? "runtime"), String(value.toolset ?? "")].filter(Boolean),
				}];
			});
			if (!invocation.args || invocation.args === "list") {
				return listCommandResult(invocation, "Tools", toolRows);
			}
			if (invocation.args === "sets") {
				const toolsets = isObject(manifest) && Array.isArray(manifest.toolsets)
					? manifest.toolsets
					: [];
				return listCommandResult(invocation, "Tool sets", toolsets.flatMap((value, index) => {
					if (!isObject(value)) return [];
					return [{
						key: `toolset:${index}`,
						label: String(value.id ?? "Tool set"),
						values: [`tools=${String(value.tool_count ?? 0)}`],
					}];
				}));
			}
			if (invocation.args === "hooks") {
				const diagnostics = integrationDiagnostics(this.#options.integrations);
				const hooks = diagnostics.filter((value) =>
					String(value.source ?? value.type ?? value.kind ?? "").toLocaleLowerCase().includes("hook"));
				return listCommandResult(invocation, "Hooks", hooks.map((value, index) => ({
					key: `hook:${index}`,
					label: String(value.name ?? value.id ?? "Hook"),
					values: [String(value.source ?? "runtime")],
					status: String(value.status ?? "configured"),
					...(typeof value.detail === "string" ? { detail: value.detail } : {}),
				})));
			}
			if (invocation.args === "extensions") {
				return listCommandResult(
					invocation,
					"Extensions",
					toolRows.filter((row) => !row.values.includes("builtin")),
				);
			}
			if (invocation.args === "plugins") {
				const resources = await this.#options.integrations?.listResources?.() ?? [];
				const resourceRows = resources.filter((value) => value.type === "plugin")
					.map((value, index) => ({
						key: `plugin-resource:${index}`,
						label: String(value.name ?? value.id ?? "Plugin"),
						values: [String(value.source ?? "runtime")],
						status: String(value.status ?? "available"),
						...(typeof value.detail === "string" ? { detail: value.detail } : {}),
					}));
				const commandRows = (this.#options.integrations?.commands?.list() ?? [])
					.filter((value) => typeof value.name === "string" && value.name.startsWith("/plugin"))
					.map((value, index) => ({
						key: `plugin-command:${index}`,
						label: String(value.name),
						values: ["command"],
						...(typeof value.description === "string" ? { detail: value.description } : {}),
					}));
				return listCommandResult(invocation, "Plugins", [...resourceRows, ...commandRows]);
			}
			if (invocation.args.startsWith("plugins ")) {
				const match = /^plugins\s+(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/u.exec(invocation.args);
				if (!match) {
					return errorCommandResult(
						invocation,
						"Plugin ID and command name are required",
						"/tools plugins <plugin-id> <command-name> [json-args]",
					);
				}
				const [, pluginId, commandName, rawArguments = ""] = match;
				const route = `/plugin:${pluginId}:${commandName}${rawArguments ? ` ${rawArguments}` : ""}`;
				let result: JsonObject | undefined;
				try {
					result = await this.#options.integrations?.commands?.run(
						route,
						new AbortController().signal,
					);
				} catch {
					return errorCommandResult(
						invocation,
						"Invalid plugin command arguments",
						"/tools plugins <plugin-id> <command-name> [json-args]",
					);
				}
				if (!result) {
					return errorCommandResult(invocation, "Plugin command was not found");
				}
				const lines = Array.isArray(result.lines)
					? result.lines.filter((line): line is string => typeof line === "string")
					: [];
				return preformattedCommandResult(invocation, "Plugin output", lines, {
					presentation: "transcript",
					extra: {
						...(typeof result.ok === "boolean" ? { ok: result.ok } : {}),
						...(typeof result.error === "string" ? { error: result.error } : {}),
					},
				});
			}
			return errorCommandResult(
				invocation,
				"Unsupported tools action",
				"/tools [list|sets|hooks|extensions|plugins]",
			);
		}
		if (invocation.commandId === "skills") {
			const resources = await this.#options.integrations?.listResources?.() ?? [];
			return listCommandResult(invocation, "Skills", resources.flatMap((value, index) =>
				value.type === "skill" ? [{
					key: `skill:${index}`,
					label: String(value.name ?? "Skill"),
					values: [String(value.source ?? "runtime")],
					status: String(value.status ?? "available"),
					detail: typeof value.detail === "string" ? value.detail : undefined,
				}] : []));
		}
		if (invocation.commandId === "agents") {
			const tasks = this.#options.backgroundTaskCommands;
			const args = invocation.args === "agents"
				? ""
				: invocation.args.startsWith("agents ")
					? invocation.args.slice("agents ".length).trim()
					: invocation.args;
			if (args.startsWith("kill ")) {
				if (!tasks) throw new GatewayFailure("method_not_found", "Background task controls are unavailable.");
				const childSessionId = args.slice("kill ".length).trim();
				if (!childSessionId) {
					return errorCommandResult(invocation, "Child session ID is required", "/agents kill <child-session-id>");
				}
				const interrupted = await tasks.interrupt(this.#sessionId(), childSessionId);
				return noticeCommandResult(
					invocation,
					"Background agent",
					interrupted ? `interrupted=${childSessionId}` : `not_found=${childSessionId}`,
					{ extra: { interrupted } },
				);
			}
			if (args === "kill-all" || args === "kill-agents") {
				if (!tasks) throw new GatewayFailure("method_not_found", "Background task controls are unavailable.");
				const interrupted = await tasks.interruptAll(this.#sessionId());
				return noticeCommandResult(invocation, "Background agents", `interrupted=${interrupted}`, {
					extra: { interrupted },
				});
			}
			if (!args || !args.includes(" ")) {
				const requested = args;
				const records = tasks?.list(this.#sessionId()) ?? [];
				const selected = requested
					? records.filter((record) => record.childSessionId === requested)
					: records;
				return listCommandResult(invocation, "Background agents", selected.map((record, index) => ({
					key: String(record.taskId ?? `task:${index}`),
					label: String(record.childSessionId ?? "Background agent"),
					values: [String(record.taskName ?? "agent")],
					status: String(record.status ?? "unknown"),
					detail: isObject(record.payload) && typeof record.payload.progressSummary === "string"
						? record.payload.progressSummary
						: undefined,
				})));
			}
			return errorCommandResult(
				invocation,
				"Unsupported agents action",
				"/agents [child-session-id|kill <child-session-id>|kill-all]",
			);
		}
		if (invocation.commandId === "memory") {
			const memory = this.#options.memoryCommands;
			if (!memory) throw new GatewayFailure("method_not_found", "Memory commands are unavailable.");
			const args = invocation.args;
			if (!args || args === "list") {
				return listCommandResult(invocation, "Memory", memoryRows(await memory.scan()));
			}
			if (args === "path") {
				return diagnosticCommandResult(invocation, "Memory", [{
					label: "Path",
					value: await memory.directory(),
				}]);
			}
			if (args.startsWith("search ")) {
				const query = args.slice("search ".length).trim().toLocaleLowerCase();
				if (!query) return errorCommandResult(invocation, "Search query is required", "/memory search <query>");
				const matches = (await memory.scan()).filter((item) =>
					[item.filename, item.name, item.description, item.content].some((value) =>
						typeof value === "string" && value.toLocaleLowerCase().includes(query)));
				return listCommandResult(invocation, "Memory", memoryRows(matches));
			}
			if (args.startsWith("add ")) {
				const parsed = parseMemoryAdd(args.slice("add ".length));
				const saved = await memory.remember(parsed);
				return noticeCommandResult(
					invocation,
					"Memory updated",
					`memory_saved=${String(saved.filename ?? parsed.name)}`,
					{ presentation: "transcript" },
				);
			}
			if (args.startsWith("forget ")) {
				const query = args.slice("forget ".length).trim();
				if (!query) return errorCommandResult(invocation, "Memory name is required", "/memory forget <name>");
				const removed = await memory.forget(query);
				return noticeCommandResult(
					invocation,
					"Memory updated",
					removed.length ? `memory_forgot=${removed.length}` : "memory_forget_no_match",
					{ presentation: "transcript" },
				);
			}
			return errorCommandResult(
				invocation,
				"Unsupported memory action",
				"/memory [list|path|search|add|forget]",
			);
		}
		if (invocation.commandId === "changes") {
			const history = this.#options.fileHistoryCommands;
			if (!history) throw new GatewayFailure("method_not_found", "File history is unavailable.");
			const snapshots = await history.list(this.#sessionId());
			return listCommandResult(invocation, "File changes", snapshots.map((snapshot) => ({
				key: snapshot.snapshotId,
				label: snapshot.path,
				values: [snapshot.turnId, snapshot.toolName],
			})));
		}
		if (invocation.commandId === "undo") {
			const history = this.#options.fileHistoryCommands;
			if (!history) throw new GatewayFailure("method_not_found", "File history is unavailable.");
			let result;
			try {
				result = await history.undo(this.#sessionId());
			} catch {
				return noticeCommandResult(
					invocation,
					"Undo incomplete",
					"File history is unavailable.",
					{ severity: "warning" },
				);
			}
			const changes = [
				...result.restoredPaths.map((path) => `restored ${path}`),
				...result.deletedPaths.map((path) => `deleted ${path}`),
			];
			return noticeCommandResult(
				invocation,
				result.error ? "Undo incomplete" : "Undo complete",
				result.error ?? (changes.join(", ") || "No file changes found."),
				{
					severity: result.error ? "warning" : "success",
					extra: {
						...(result.snapshotId ? { snapshot_id: result.snapshotId } : {}),
						restored_count: result.restoredPaths.length,
						deleted_count: result.deletedPaths.length,
					},
				},
			);
		}
		if (invocation.commandId === "fork") {
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session fork is unavailable.");
			let parsed;
			try {
				parsed = parseForkArguments(invocation.args, this.#sessionId());
			} catch {
				return errorCommandResult(
					invocation,
					"Invalid fork arguments",
					"/fork [source] [new-session] [message-index]",
				);
			}
			let result;
			try {
				result = sessions.fork(parsed);
			} catch {
				return errorCommandResult(invocation, "Unable to fork session");
			}
			const resumed = await this.#sessionResume({ session_id: result.targetSessionId });
			return noticeCommandResult(
				invocation,
				"Session forked",
				`forked=${result.sourceSessionId}->${result.targetSessionId}; fork_point=${result.forkPoint}; messages=${result.messageCount}`,
				{
					extra: {
						mutated_session: true,
						session_id: resumed.session_id,
						fork_point: result.forkPoint,
						message_count: result.messageCount,
					},
				},
			);
		}
		if (invocation.commandId === "session_search") {
			if (!invocation.args) {
				return errorCommandResult(invocation, "Search query is required", "/session search <query>");
			}
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session search is unavailable.");
			const matches = sessions.search(invocation.args, this.#workspaceRoot());
			return listCommandResult(invocation, "Session search", matches.map((match, index) => ({
				key: `search:${index}:${match.sessionId}:${match.messageIndex}`,
				label: `${match.sessionId}:${match.messageIndex}`,
				values: [match.role],
				detail: match.snippet,
			})));
		}
		if (invocation.commandId === "session_maintenance") {
			const action = sessionMaintenanceAction(invocation.args);
			if (!action) {
				return errorCommandResult(
					invocation,
					"Unsupported session maintenance action",
					"/session maintenance [--apply-empty|--apply-payloads|--apply-orphans|--apply-vacuum|--apply-transcript-normalization|--apply-content-blobs|--apply-content-blob-gc]",
				);
			}
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session maintenance is unavailable.");
			const result = await sessions.maintenance(action, this.#workspaceRoot());
			if (action === "report") {
				return listCommandResult(invocation, "Session maintenance", commandObjectRows(result));
			}
			const response = noticeCommandResult(
				invocation,
				"Session maintenance",
				commandObjectSummary(result),
				{
					severity: result.status === "failed" ? "error" : "success",
					extra: action === "transcript_normalization"
						|| action === "content_blobs" || action === "content_blob_gc"
						? { ...result }
						: undefined,
				},
			);
			if ((action === "transcript_normalization" || action === "content_blobs")
				&& result.backend_restart_required === true) {
				this.#closeAfterResponses.add(response);
			}
			return response;
		}
		if (invocation.commandId === "trace") {
			const trace = this.#options.traceCommands;
			if (!trace) throw new GatewayFailure("method_not_found", "Trace commands are unavailable.");
			if (!invocation.args) {
				return listCommandResult(invocation, "Trace", trace.inspect(this.#sessionId()).map(
					(value, index) => ({
						key: `trace:${index}`,
						label: String(value.kind ?? "event"),
						values: [String(value.turnId ?? value.turn_id ?? "")].filter(Boolean),
						status: typeof value.status === "string" ? value.status : undefined,
					}),
				));
			}
			if (invocation.args === "export") {
				return preformattedCommandResult(
					invocation,
					"Trace export",
					trace.export(this.#sessionId()),
					{ presentation: "transcript" },
				);
			}
			if (invocation.args === "logs") {
				return preformattedCommandResult(invocation, "Trace logs", trace.logs());
			}
			return errorCommandResult(invocation, "Unsupported trace action", "/trace [export|logs]");
		}
		if (invocation.commandId === "help") {
			return listCommandResult(invocation, "Commands", commandManifest("cli").map((command) => ({
				key: `command:${command.id}`,
				label: command.name,
				detail: command.description,
			})));
		}
		if (invocation.commandId === "model") {
			const selection = parseModelSelection(invocation.args);
			const selectedModel = selection.model ?? (selection.reasoningEffort ? this.#model : undefined);
			if (selectedModel) {
				const catalog = await this.#models(this.#provider);
				const entry = catalog.find((candidate) => candidate.model === selectedModel);
				if (!entry) {
					return errorCommandResult(
						invocation,
						`Model '${selectedModel}' is not available`,
						"/model [model] [--thinking-effort level]",
					);
				}
				const provider = typeof entry.provider === "string" ? entry.provider : "";
				const protocol = typeof entry.protocol === "string" ? entry.protocol : "";
				const baseUrl = typeof entry.base_url === "string" ? entry.base_url : "";
				if (!provider || !protocol || !baseUrl) {
					throw new GatewayFailure("internal_error", "Model catalog entry is incomplete.");
				}
				try {
					await this.#selectModel({
						provider,
						protocol,
						model: selectedModel,
						base_url: baseUrl,
						...(selection.reasoningEffort
							? { reasoning_effort: selection.reasoningEffort }
							: {}),
					});
				} catch (error) {
					const failure = gatewayFailure(error);
					return errorCommandResult(
						invocation,
						failure.message,
						"/model [model] [--thinking-effort level]",
					);
				}
			}
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Model updated", [
				`model=${this.#model}`,
				...(this.#reasoningEffort ? [`thinking_effort=${this.#reasoningEffort}`] : []),
			].join("; "), {
				extra: {
					mutated_model: true,
					model: this.#model,
					...(this.#reasoningEffort ? { thinking_effort: this.#reasoningEffort } : {}),
				},
			});
		}
		if (invocation.commandId === "plan" || invocation.commandId === "mode") {
			const requested = invocation.commandId === "plan" ? "plan" : invocation.args || this.#collaborationMode;
			if (requested !== "default" && requested !== "plan") {
				return errorCommandResult(invocation, "Unsupported collaboration mode", "/mode [default|plan]");
			}
			this.#ensureSessionPreferences(requested);
			const mutated = requested !== this.#collaborationMode || invocation.commandId === "plan";
			this.#collaborationMode = requested;
			this.#runtime().configureRuntimeContext?.({ collaborationMode: requested });
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Collaboration mode", `collaboration_mode=${requested}`, {
				extra: {
					mutated_mode: mutated,
					collaboration_mode: requested,
				},
			});
		}
		if (invocation.commandId === "sandbox") {
			const sandbox = requestedSandboxMode(invocation.args, this.#permissionProfile);
			this.#permissionProfile = permissionForSandbox(sandbox);
			this.#ensureSessionPreferences(this.#collaborationMode);
			this.#configureExecutionPolicy();
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Sandbox", `sandbox=${sandbox}`, {
				extra: { mutated_mode: Boolean(invocation.args), sandbox_mode: sandbox },
			});
		}
		if (invocation.commandId === "permissions") {
			const runtime = this.#runtime();
			if (!invocation.args) {
				const allowances = runtime.listCommandAllowances?.() ?? [];
				const permissions = this.#permissions();
				const effective = isObject(permissions.effective) ? permissions.effective : {};
				const readiness = isObject(permissions.sandbox_readiness)
					? permissions.sandbox_readiness
					: {};
				return listCommandResult(invocation, "Permissions", [
					{
						key: "permissions:profile",
						label: "Profile",
						values: [this.#permissionProfile],
					},
					{
						key: "permissions:sandbox",
						label: "Sandbox",
						values: [String(effective.sandbox_mode ?? sandboxForPermission(this.#permissionProfile))],
					},
					{
						key: "permissions:filesystem",
						label: "Filesystem",
						values: [String(effective.filesystem ?? "unknown")],
					},
					{
						key: "permissions:network",
						label: "Network",
						values: [String(effective.network ?? "unknown")],
					},
					{
						key: "permissions:source",
						label: "Policy source",
						values: [String(effective.source ?? "unknown")],
					},
					{
						key: "permissions:readiness",
						label: "Sandbox readiness",
						values: [String(readiness.state ?? "unknown")],
					},
					{
						key: "permissions:allowances",
						label: "Session allowances",
						values: [String(allowances.length)],
					},
					...allowances.map((allowance, index) => ({
						key: `permissions:allowance:${index}`,
						label: allowance.join(" "),
						values: ["allow_session"],
					})),
				]);
			}
			let summary: string;
			let cleared: number | undefined;
			if (invocation.args.startsWith("allow ")) {
				const pattern = requiredCommandPattern(invocation.args.slice("allow ".length));
				if (!runtime.addCommandAllowance) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				runtime.addCommandAllowance(pattern);
				summary = `allowed=${pattern}`;
			} else if (invocation.args.startsWith("revoke ")) {
				const pattern = requiredCommandPattern(invocation.args.slice("revoke ".length));
				if (!runtime.removeCommandAllowance) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				runtime.removeCommandAllowance(pattern);
				summary = `revoked=${pattern}`;
			} else if (invocation.args === "clear") {
				if (!runtime.clearCommandAllowances) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				cleared = runtime.clearCommandAllowances();
				summary = `cleared=${cleared}`;
			} else {
				return errorCommandResult(
					invocation,
					"Unsupported permissions action",
					"/permissions [allow <pattern>|revoke <pattern>|clear]",
				);
			}
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Permissions updated", summary, {
				presentation: "transcript",
				extra: { ...(cleared === undefined ? {} : { cleared }) },
			});
		}
		if (invocation.commandId === "compact") {
			const compact = this.#runtime().compact;
			if (!compact) throw new GatewayFailure("method_not_found", "Manual compaction is unavailable.");
			const result = await compact({
				modelOverride: this.#model,
				signal: new AbortController().signal,
			});
			const presentation = compactionCommandPresentation(result);
			return noticeCommandResult(
				invocation,
				presentation.title,
				presentation.summary,
				{
					severity: presentation.severity,
					extra: {
						command_kind: "compact",
						compaction_status: result.status,
						tokens: { before: result.beforeTokens, after: result.afterTokens },
					},
				},
			);
		}
		if (invocation.commandId === "resume") {
			if (!invocation.args) {
				return errorCommandResult(invocation, "Session ID is required", "/resume [session-id]");
			}
			const resumed = await this.#sessionResume({ session_id: invocation.args });
			return noticeCommandResult(invocation, "Session resumed", `session=${resumed.session_id}`, {
				extra: { mutated_session: true, session_id: resumed.session_id },
			});
		}
		if (invocation.commandId === "quit") {
			return noticeCommandResult(invocation, "Exit", "Bye.", {
				extra: { exit_requested: true },
			});
		}
		return undefined;
	}

	async #resourceList(): Promise<JsonObject> {
		const resources = await this.#options.integrations?.listResources?.() ?? [];
		return { resources: resources.map(boundedResource).filter(isObject) };
	}

	#sessionList(params: JsonObject = {}): JsonObject {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) {
			return {
				sessions: [{
					id: this.#sessionId(),
					workspace: this.#workspaceRoot(),
					cwd: this.#workspaceRoot(),
					current: true,
				}],
			};
		}
		const activeSessionId = coordinator.snapshot().sessionId;
		const serviceSessions = this.#options.sessionCommands?.list?.(sessionQueryFromParams(params));
		const sessions: JsonObject[] = serviceSessions
			? serviceSessions.map((item) => sessionSummaryPayload(item, activeSessionId))
			: coordinator.listSessions({ limit: 20 }).map((item) => ({
				id: item.sessionId,
				workspace: item.workspaceRoot,
				cwd: item.workspaceRoot,
				created: item.createdAt,
				updated: item.updatedAt,
				last_active: item.lastActiveAt,
				modified: item.lastActiveAt,
				message_count: item.messageCount,
				current: item.sessionId === activeSessionId,
			}));
		if (!serviceSessions && !sessions.some((item) => item.id === activeSessionId)) {
			sessions.unshift({
				id: activeSessionId,
				workspace: coordinator.snapshot().workspaceRoot,
				cwd: coordinator.snapshot().workspaceRoot,
				current: true,
			});
		}
		return {
			sessions,
		};
	}

	async #sessionNew(): Promise<JsonObject> {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) throw new GatewayFailure("method_not_found", "New session creation is unavailable.");
		this.#assertSessionTransitionAvailable(coordinator);
		this.#sessionTransitionActive = true;
		let activated = false;
		try {
			const snapshot = await coordinator.startNew();
			await this.#activateSession(snapshot);
			activated = true;
			return await this.#sessionTransitionPayload(snapshot);
		} finally {
			this.#sessionTransitionActive = false;
			if (activated) this.#requestNextQueuedTurn();
		}
	}

	async #sessionResume(params: JsonObject): Promise<JsonObject> {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) throw new GatewayFailure("method_not_found", "Session resume is unavailable.");
		this.#assertSessionTransitionAvailable(coordinator);
		this.#sessionTransitionActive = true;
		let activated = false;
		try {
			let sessionId = requiredString(params.session_id, "session_id");
			const previewResume = this.#options.sessionCommands?.previewResume;
			if (previewResume) {
				let preview: ResumeRepairPreview | undefined;
				try {
					preview = await previewResume(sessionId);
				} catch (error) {
					if (gatewayFailure(error).code !== "session_not_found") throw error;
				}
				if (preview && !preview.ready) {
					const action = optionalString(params.repair_action);
					const revision = integerValue(params.metadata_revision);
					const applyRepair = this.#options.sessionCommands?.applyResumeRepair;
					if (!action || revision === undefined || !applyRepair) {
						throw new GatewayFailure(
							"session_repair_required",
							"Review the session recovery options before resuming.",
							{ preview: resumeRepairPreviewPayload(preview) },
						);
					}
					if (!isResumeRepairAction(action)) {
						throw new GatewayFailure("invalid_params", "Unknown session repair action.");
					}
					const repaired = await applyRepair({
						sessionId,
						expectedMetadataRevision: revision,
						action,
					});
					sessionId = repaired.sessionId;
					const repairedPreview = resumePreviewAfterConfirmedAction(
						await previewResume(sessionId),
						action,
					);
					if (!repairedPreview.ready) {
						throw new GatewayFailure(
							"session_repair_required",
							"Review the remaining session recovery options before resuming.",
							{ preview: resumeRepairPreviewPayload(repairedPreview) },
						);
					}
				}
			}
			const snapshot = await coordinator.resume(sessionId);
			await this.#activateSession(snapshot);
			activated = true;
			return await this.#sessionTransitionPayload(snapshot);
		} finally {
			this.#sessionTransitionActive = false;
			if (activated) this.#requestNextQueuedTurn();
		}
	}

	async #sessionResumePreview(params: JsonObject): Promise<JsonObject> {
		const previewResume = this.#options.sessionCommands?.previewResume;
		if (!previewResume) {
			throw new GatewayFailure("method_not_found", "Session recovery preview is unavailable.");
		}
		return resumeRepairPreviewPayload(await previewResume(
			requiredString(params.session_id, "session_id"),
		));
	}

	#assertSessionTransitionAvailable(coordinator: SessionCoordinator<NodeGatewayRuntime>): void {
		if (
			this.#sessionTransitionActive
			|| this.#sessionControlActive
			|| this.#turnAdmissionPending
			|| this.#activeTurn !== null
			|| coordinator.executing()
		) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		if (coordinator.snapshot().pendingApproval || coordinator.snapshot().pendingClarification) {
			throw new GatewayFailure("turn_in_progress", "A pending continuation owns the session.");
		}
		if ((this.#options.agentInteractiveRequests?.pending().length ?? 0) > 0
			|| this.#interactiveRequests.length > 0) {
			throw new GatewayFailure("turn_in_progress", "A pending agent request owns the terminal.");
		}
	}

	#claimSessionControlOperation(message: string): () => void {
		const coordinator = this.#options.sessionCoordinator;
		if (
			this.#sessionControlActive
			|| this.#sessionTransitionActive
			|| this.#turnAdmissionPending
			|| this.#activeTurn !== null
			|| coordinator?.executing()
		) {
			throw new GatewayFailure("turn_in_progress", message);
		}
		this.#sessionControlActive = true;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#sessionControlActive = false;
			this.#requestNextQueuedTurn();
		};
	}

	async #activateSession(snapshot: ReturnType<SessionCoordinator<NodeGatewayRuntime>["snapshot"]>): Promise<void> {
		const trustState = await this.#loadWorkspaceTrust(snapshot.workspaceRoot);
		await this.#options.workspaceTrust?.reload?.(snapshot.workspaceRoot, trustState);
		this.#trustState = trustState;
		const storedPreferences = snapshot.binding.sessionPreferences?.();
		const preferences = await this.#options.controlCommands?.activateSessionPreferences?.(
			storedPreferences,
		) ?? storedPreferences;
		this.#applySessionPreferences(preferences, snapshot.binding);
		this.#configureExecutionPolicy(snapshot.binding);
		const queue = snapshot.binding.queueCoordinator;
		if (queue) {
			const released = queue.releaseRestorationClaims();
			this.#options.sessionCoordinator?.updateQueue({
				sessionId: snapshot.sessionId,
				generation: snapshot.generation,
			}, released);
		}
		this.#bindQueue();
		this.#emitDirect("session.changed", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
		});
		this.#emitRuntime("status.changed", this.#status());
		if (snapshot.pendingApproval) {
			this.#emitRuntime("approval.request", approvalRequest(snapshot.pendingApproval, snapshot.generation));
		}
		if (snapshot.pendingClarification) {
			this.#emitRuntime(
				"clarify.request",
				clarificationRequest(snapshot.pendingClarification, snapshot.generation),
			);
		}
	}

	async #sessionTransitionPayload(
		snapshot: ReturnType<SessionCoordinator<NodeGatewayRuntime>["snapshot"]>,
	): Promise<JsonObject> {
		const [authProviders, authStatus] = await Promise.all([
			this.#authProviders(),
			this.#credentialReadiness(),
		]);
		return {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			...(authProviders.length > 0 ? { auth_providers: authProviders } : {}),
			...(authStatus ? { auth_status: credentialReadinessPayload(authStatus) } : {}),
			read_only: snapshot.readOnly,
			lines: [],
			background_shells: this.#activeShells().map((shell) =>
				shellSnapshotPayload(shell, this.#sessionContext())),
		};
	}

	#shellList(): JsonObject {
		return {
			session_id: this.#sessionId(),
			generation: this.#sessionContext().generation,
			shells: this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, this.#sessionContext())),
		};
	}

	async #shellStop(params: JsonObject): Promise<JsonObject> {
		const manager = this.#requiredShellManager();
		const context = this.#sessionContext();
		const snapshot = await manager.terminate(
			context.sessionId,
			requiredString(params.shell_id, "shell_id"),
		);
		return shellSnapshotPayload(snapshot, context);
	}

	async #shellStopAll(): Promise<JsonObject> {
		const manager = this.#requiredShellManager();
		const context = this.#sessionContext();
		const snapshots = await manager.terminateOwner(context.sessionId);
		return {
			session_id: context.sessionId,
			generation: context.generation,
			stopped: snapshots.length,
			shells: snapshots.map((snapshot) => shellSnapshotPayload(snapshot, context)),
		};
	}

	#sessionTree(params: JsonObject): JsonObject {
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) throw new GatewayFailure("method_not_found", "Session tree is unavailable.");
		const active = coordinator.snapshot();
		const requested = optionalString(params.session_id) ?? active.sessionId;
		coordinator.loadSessionLineage(requested);
		const activePath = coordinator.loadSessionLineage(active.sessionId)
			.map((item) => item.sessionId);
		const nodes = coordinator.listSessions({ limit: positiveInteger(params.limit) ?? 100 })
			.map((item) => {
				const lineage = coordinator.loadSessionLineage(item.sessionId);
				const own = lineage.at(-1);
				return {
					id: `session:${item.sessionId}`,
					kind: "session",
					session_id: item.sessionId,
					parent_id: own?.parentId ? `session:${own.parentId}` : null,
					depth: Math.max(0, lineage.length - 1),
					role: "session",
					summary: item.sessionId,
					timestamp: item.lastActiveAt,
					label: "",
					message_index: null,
					tool_name: "",
					active: item.sessionId === active.sessionId,
					on_active_path: activePath.includes(item.sessionId),
					message_count: item.messageCount,
					preview: "",
				};
			});
		return { session_id: active.sessionId, active_path: activePath, nodes };
	}

	async #submit(params: JsonObject): Promise<JsonObject> {
		if (
			this.#activeTurn !== null
			|| this.#turnAdmissionPending
			|| this.#sessionTransitionActive
			|| this.#sessionControlActive
		) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		const context = this.#assertSessionMutationContext(params);
		if (this.#options.sessionCoordinator?.snapshot().pendingApproval
			|| this.#options.sessionCoordinator?.snapshot().pendingClarification) {
			throw new GatewayFailure("turn_in_progress", "A pending continuation owns the session.");
		}
		if (this.#options.sessionCoordinator?.snapshot().readOnly) {
			throw new GatewayFailure(
				"session_state_invalid",
				"Session is available for read-only replay only.",
			);
		}
		const message = requiredString(params.message, "message");
		const clientTurnId = requiredString(params.client_turn_id, "client_turn_id");
		const clientUserMessageId = requiredString(
			params.client_user_message_id,
			"client_user_message_id",
		);
		const localImages = stringArray(params.local_images, "local_images");
		const collaborationMode = collaborationModeParameter(params.collaboration_mode)
			?? this.#collaborationMode;
		const runtime = this.#runtime();
		const coordinator = this.#options.sessionCoordinator;
		this.#turnAdmissionPending = true;
		const executionClaim = coordinator?.claimExecution(context);
		if (coordinator && !executionClaim) {
			this.#turnAdmissionPending = false;
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		let activeInstalled = false;
		try {
			const readiness = await this.#credentialReadiness();
			if (readiness && !readiness.ready) {
				throw new GatewayFailure(
					"auth_required",
					"Provider credentials are required before starting a turn.",
					credentialReadinessPayload(readiness),
				);
			}
			this.#ensureSessionPreferences(collaborationMode);
			const submission: TurnSubmission = {
				clientTurnId,
				clientUserMessageId,
				turnId: this.#options.createTurnId?.()
					?? `turn_${randomUUID().replaceAll("-", "")}`,
				message,
				localImages,
				modelOverride: this.#model,
				...(this.#reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
			};
			const reservation = runtime.reserve(submission);
			const turnId = reservation.turn.turn_id;
			const collaborationModeChanged = collaborationMode !== this.#collaborationMode;
			if (collaborationModeChanged) {
				this.#collaborationMode = collaborationMode;
				runtime.configureRuntimeContext?.({ collaborationMode });
			}
			this.#collaborationModeByTurn.set(turnId, collaborationMode);
			runtime.configureRuntimeContext?.({ collaborationMode, turnId });
			const active: ActiveTurn = {
				clientTurnId,
				clientUserMessageId,
				controller: new AbortController(),
				context,
				runtime,
				...(executionClaim ? { executionClaim } : {}),
				collaborationMode,
				...(collaborationMode === "plan" ? { planStreamFilter: new ProposedPlanStreamFilter() } : {}),
				turnId,
				terminalEmitted: false,
			};
			this.#emitUserMessageLifecycle(active, message, "submit");
			this.#activeTurn = active;
			activeInstalled = true;
			if (collaborationModeChanged) this.#emitRuntime("status.changed", this.#status());
			this.#activeTurnTask = new Promise<void>((resolve) => {
				queueMicrotask(() => {
					void this.#runTurn(active, submission, reservation).then(resolve);
				});
			});
			return {
				accepted: true,
				client_turn_id: clientTurnId,
				client_user_message_id: clientUserMessageId,
				turn_id: turnId,
			};
		} catch (error) {
			if (!activeInstalled && executionClaim) coordinator?.releaseExecution(executionClaim);
			throw error;
		} finally {
			this.#turnAdmissionPending = false;
		}
	}

	#ensureSessionPreferences(
		collaborationMode: "default" | "plan",
	): void {
		const preferences = this.#runtime().ensureSessionPreferences?.({
			provider: this.#provider,
			model: this.#model,
			...(this.#reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
			collaborationMode,
			permissionProfile: this.#permissionProfile,
		});
		if (preferences) this.#applySessionPreferences(preferences);
	}

	#applySessionPreferences(
		preferences: SessionPreferences | undefined,
		runtime: NodeGatewayRuntime = this.#runtime(),
	): void {
		if (!preferences) return;
		this.#provider = preferences.provider;
		this.#model = preferences.model;
		this.#reasoningEffort = preferences.reasoningEffort;
		this.#collaborationMode = preferences.collaborationMode;
		if (preferences.permissionProfile) this.#permissionProfile = preferences.permissionProfile;
		runtime.configureRuntimeContext?.({
			collaborationMode: preferences.collaborationMode,
		});
	}

	#approvalRespond(params: JsonObject): JsonObject {
		const childResponse = this.#options.agentInteractiveRequests?.respondApproval(params);
		if (childResponse) return childResponse;
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) {
			throw new GatewayFailure("approval_not_pending", "No pending approval is available.");
		}
		if (this.#activeTurn !== null) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		const snapshot = coordinator.snapshot();
		const pending = snapshot.pendingApproval;
		if (!pending) {
			throw new GatewayFailure("approval_not_pending", "No pending approval is available.");
		}
		const choice = requiredString(params.choice, "choice");
		if (!isApprovalChoice(choice) || !pending.options.includes(choice)) {
			throw new GatewayFailure("invalid_params", "Unsupported approval choice.");
		}
		const decisionId = requiredString(params.decision_id, "decision_id");
		const requestedSessionId = optionalString(params.session_id);
		const requestedGeneration = params.generation === undefined
			? snapshot.generation
			: positiveInteger(params.generation);
		if (requestedGeneration === undefined) {
			throw new GatewayFailure("invalid_params", "generation must be a positive integer.");
		}
		if (decisionId !== pending.decisionId
			|| requestedSessionId !== undefined && requestedSessionId !== snapshot.sessionId
			|| requestedGeneration !== snapshot.generation) {
			throw new GatewayFailure("approval_not_pending", "No pending approval matches the request.");
		}
		const context = coordinator.context();
		const executionClaim = coordinator.claimExecution(context);
		if (!executionClaim) {
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		const collaborationMode = this.#collaborationModeByTurn.get(pending.turnId)
			?? this.#collaborationMode;
		try {
			snapshot.binding.configureRuntimeContext?.({ collaborationMode, turnId: pending.turnId });
		} catch (error) {
			coordinator.releaseExecution(executionClaim);
			throw error;
		}
		const active: ActiveTurn = {
			clientTurnId: pending.clientTurnId,
			clientUserMessageId: pending.clientTurnId,
			controller: new AbortController(),
			context,
			runtime: snapshot.binding,
			executionClaim,
			collaborationMode,
			...(collaborationMode === "plan" ? { planStreamFilter: new ProposedPlanStreamFilter() } : {}),
			turnId: pending.turnId,
			terminalEmitted: false,
		};
		this.#activeTurn = active;
		coordinator.updatePendingApproval(context, undefined);
		this.#emitRuntime("approval.respond", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			decision_id: pending.decisionId,
			choice,
		});
		this.#emitRuntime("status.update", statusPayload("running", pending.clientTurnId));
		this.#activeTurnTask = new Promise<void>((resolve) => {
			queueMicrotask(() => {
				void this.#runApproval(active, { decisionId, choice }, pending).then(resolve);
			});
		});
		return {
			accepted: true,
			decision_id: pending.decisionId,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
		};
	}

	#clarificationRespond(params: JsonObject): JsonObject {
		const childResponse = this.#options.agentInteractiveRequests?.respondClarification(params);
		if (childResponse) return childResponse;
		const coordinator = this.#options.sessionCoordinator;
		if (!coordinator) {
			throw new GatewayFailure(
				"clarification_not_pending",
				"No pending clarification is available.",
			);
		}
		if (this.#activeTurn !== null) {
			throw new GatewayFailure("turn_in_progress", "A turn is already running.");
		}
		const snapshot = coordinator.snapshot();
		const pending = snapshot.pendingClarification;
		if (!pending) {
			throw new GatewayFailure(
				"clarification_not_pending",
				"No pending clarification is available.",
			);
		}
		const requestId = requiredString(params.request_id, "request_id").trim();
		const response = requiredString(params.response, "response").trim();
		const requestedSessionId = optionalString(params.session_id);
		const requestedGeneration = params.generation === undefined
			? snapshot.generation
			: positiveInteger(params.generation);
		if (requestedGeneration === undefined) {
			throw new GatewayFailure("invalid_params", "generation must be a positive integer.");
		}
		if (response.length > 4_096) {
			throw new GatewayFailure("invalid_params", "response exceeds 4096 characters.");
		}
		if (
			requestId !== pending.requestId
			|| requestedSessionId !== undefined && requestedSessionId !== snapshot.sessionId
			|| requestedGeneration !== snapshot.generation
		) {
			throw new GatewayFailure(
				"clarification_not_pending",
				"No pending clarification matches the request.",
			);
		}
		const context = coordinator.context();
		const executionClaim = coordinator.claimExecution(context);
		if (!executionClaim) {
			throw new GatewayFailure("turn_in_progress", "A session transition is in progress.");
		}
		const collaborationMode = this.#collaborationModeByTurn.get(pending.turnId)
			?? this.#collaborationMode;
		try {
			snapshot.binding.configureRuntimeContext?.({ collaborationMode, turnId: pending.turnId });
		} catch (error) {
			coordinator.releaseExecution(executionClaim);
			throw error;
		}
		const active: ActiveTurn = {
			clientTurnId: pending.clientTurnId,
			clientUserMessageId: pending.clientUserMessageId,
			controller: new AbortController(),
			context,
			runtime: snapshot.binding,
			executionClaim,
			collaborationMode,
			...(collaborationMode === "plan" ? { planStreamFilter: new ProposedPlanStreamFilter() } : {}),
			turnId: pending.turnId,
			terminalEmitted: false,
		};
		this.#activeTurn = active;
		coordinator.updatePendingClarification(context, undefined);
		this.#emitRuntime("turn.started", {
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
		});
		this.#emitRuntime("status.update", statusPayload("running", pending.clientTurnId));
		this.#emitRuntime("clarify.respond", {
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			request_id: pending.requestId,
			header: pending.header,
			question: pending.question,
			response: boundedString(response, 4_096),
			multi_select: pending.multiSelect,
		});
		this.#activeTurnTask = new Promise<void>((resolve) => {
			queueMicrotask(() => {
				void this.#runClarification(active, { requestId, response }, pending).then(resolve);
			});
		});
		return {
			accepted: true,
			request_id: pending.requestId,
			client_turn_id: pending.clientTurnId,
			turn_id: pending.turnId,
			session_id: snapshot.sessionId,
			generation: snapshot.generation,
		};
	}

	#steer(params: JsonObject): JsonObject {
		const context = this.#assertSessionMutationContext(params);
		const queue = this.#requiredQueueCoordinator();
		const expectedTurnId = requiredString(params.expected_turn_id, "expected_turn_id");
		const active = this.#activeTurn;
		const mutation = queue.enqueueSteer({
			sessionId: context.sessionId,
			clientTurnId: queueClientTurnId(params, "steer"),
			expectedTurnId,
			activeTurnId: active?.turnId ?? null,
			steerable: active !== null && !active.controller.signal.aborted,
			text: requiredString(params.message, "message"),
			imagePaths: localImagePaths(params.local_images),
			source: "user",
		});
		if (this.#activeTurn === null) this.#requestNextQueuedTurn();
		return queueMutationResponse(mutation, context);
	}

	#followUp(params: JsonObject): JsonObject {
		const context = this.#assertSessionMutationContext(params);
		const mutation = this.#requiredQueueCoordinator().enqueueFollowUp({
			sessionId: context.sessionId,
			clientTurnId: queueClientTurnId(params, "follow"),
			text: requiredString(params.message, "message"),
			imagePaths: localImagePaths(params.local_images),
			source: "user",
		});
		if (this.#activeTurn === null) this.#requestNextQueuedTurn();
		return queueMutationResponse(mutation, context);
	}

	#queuePop(params: JsonObject): JsonObject {
		const context = this.#assertSessionMutationContext(params);
		const removal = this.#requiredQueueCoordinator().popLastFollowUp();
		return {
			session_id: context.sessionId,
			generation: context.generation,
			...queueProjection(removal.snapshot),
			item: removal.record ? gatewayQueueItem(removal.record) : null,
		};
	}

	#queueClear(params: JsonObject): JsonObject {
		const context = this.#assertSessionMutationContext(params);
		const token = optionalBoundedIdentity(params.restore_token, "restore_token")
			?? `restore_${randomUUID().replaceAll("-", "")}`;
		const result = this.#requiredQueueCoordinator().claimForRestoration(token);
		const steering = result.records.filter((record) => record.kind === "pending_steer");
		const followUps = result.records.filter((record) => record.kind !== "pending_steer");
		return {
			session_id: context.sessionId,
			generation: context.generation,
			restore_token: result.token,
			...queueProjection(result.snapshot),
			steering: steering.map((record) => record.text),
			follow_up: followUps.map((record) => record.text),
			steering_items: steering.map(legacyQueueItem),
			follow_up_items: followUps.map(legacyQueueItem),
		};
	}

	#queueRestoreAck(params: JsonObject): JsonObject {
		const context = this.#assertSessionMutationContext(params);
		const token = requiredString(params.restore_token, "restore_token");
		const snapshot = this.#requiredQueueCoordinator().acknowledgeRestoration(token);
		return {
			acknowledged: true,
			restore_token: token,
			session_id: context.sessionId,
			generation: context.generation,
			...queueProjection(snapshot),
		};
	}

	#queueMigrationAck(params: JsonObject): JsonObject {
		const token = requiredString(params.token, "token");
		const snapshot = this.#requiredQueueCoordinator().acknowledgeLegacyMigration(token);
		return { acknowledged: true, token, ...queueProjection(snapshot) };
	}

	async #runTurn(
		active: ActiveTurn,
		submission: TurnSubmission,
		reservation: TurnReservation,
	): Promise<void> {
		let terminalFinalized = false;
		try {
			const record = await active.runtime.submit(
				submission,
				(event) => { this.#acceptRuntimeEvent(active, event); },
				{ signal: active.controller.signal, reservation },
			);
			if (record.status === "interrupted") this.#recordInterruptFinalized(active);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			terminalFinalized = record.status !== "in_progress";
		} catch {
			if (active.controller.signal.aborted && !active.terminalEmitted) {
				try {
					const record = await this.#forceInterruptActive(active);
					this.#projectForcedInterrupt(active, record);
					terminalFinalized = record.status !== "in_progress";
				} catch {
					if (!active.terminalEmitted) {
						this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
					}
				}
			} else if (!active.terminalEmitted) {
				this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
			}
		} finally {
			this.#releaseActiveExecution(active, terminalFinalized);
		}
	}

	async #runApproval(
		active: ActiveTurn,
		input: ResolveApprovalInput,
		pending: PendingSessionApproval,
	): Promise<void> {
		let terminalFinalized = false;
		try {
			const record = await active.runtime.resolveApproval(
				input,
				(event) => { this.#acceptRuntimeEvent(active, event); },
				{ signal: active.controller.signal },
			);
			if (record.status === "interrupted") this.#recordInterruptFinalized(active);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			terminalFinalized = record.status !== "in_progress";
		} catch (error) {
			if (active.controller.signal.aborted) {
				try {
					const record = await this.#forceInterruptActive(active);
					this.#projectForcedInterrupt(active, record);
					terminalFinalized = record.status !== "in_progress";
				} catch {
					if (!active.terminalEmitted && this.#isCurrent(active)) {
						this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
					}
				}
			} else {
				const restored = this.#options.sessionCoordinator
					?.updatePendingApproval(active.context, pending);
				if (restored === false || active.terminalEmitted || !this.#isCurrent(active)) return;
				const failure = gatewayFailure(error);
				this.#emitRuntime("gateway.error", {
					code: failure.code === "persistence_error" ? "internal_error" : failure.code,
					message: failure.message,
					method: "approval.respond",
				});
				this.#emitRuntime(
					"approval.request",
					approvalRequest(pending, active.context.generation),
				);
				this.#emitRuntime(
					"status.update",
					statusPayload("waiting_approval", active.clientTurnId),
				);
			}
		} finally {
			this.#releaseActiveExecution(active, terminalFinalized);
		}
	}

	async #runClarification(
		active: ActiveTurn,
		input: ResolveClarificationInput,
		pending: PendingSessionClarification,
	): Promise<void> {
		let terminalFinalized = false;
		try {
			const record = await active.runtime.resolveClarification(
				input,
				(event) => { this.#acceptRuntimeEvent(active, event); },
				{ signal: active.controller.signal },
			);
			if (record.status === "interrupted") this.#recordInterruptFinalized(active);
			if (!active.terminalEmitted && this.#isCurrent(active)) {
				this.#projectStoredTerminal(active, record);
			}
			terminalFinalized = record.status !== "in_progress";
		} catch (error) {
			if (active.controller.signal.aborted) {
				try {
					const record = await this.#forceInterruptActive(active);
					this.#projectForcedInterrupt(active, record);
					terminalFinalized = record.status !== "in_progress";
				} catch {
					if (!active.terminalEmitted && this.#isCurrent(active)) {
						this.#emitTurnFailure(active, "persistence_error", "Session persistence failed.");
					}
				}
			} else {
				const restored = this.#options.sessionCoordinator
					?.updatePendingClarification(active.context, pending);
				if (restored === false || active.terminalEmitted || !this.#isCurrent(active)) return;
				const failure = gatewayFailure(error);
				this.#emitRuntime("gateway.error", {
					code: failure.code === "persistence_error" ? "internal_error" : failure.code,
					message: failure.message,
					method: "clarify.respond",
				});
				this.#emitRuntime(
					"clarify.request",
					clarificationRequest(pending, active.context.generation),
				);
				this.#emitRuntime(
					"turn.status",
					waitingStatus("waiting_clarification", active, "Waiting clarification"),
				);
				this.#emitRuntime(
					"status.update",
					statusPayload("waiting_clarification", active.clientTurnId),
				);
			}
		} finally {
			this.#releaseActiveExecution(active, terminalFinalized);
		}
	}

	#releaseActiveExecution(active: ActiveTurn, terminalFinalized: boolean): void {
		if (this.#activeTurn !== active) return;
		if (active.executionClaim) {
			this.#options.sessionCoordinator?.releaseExecution(active.executionClaim);
		}
		this.#activeTurn = null;
		this.#activeTurnTask = null;
		if (this.#closed || !this.#isCurrent(active)) return;
		this.#emitRuntime("status.changed", this.#status());
		this.#emitPendingProposedPlan(active);
		if (
			terminalFinalized
			&& (active.terminalState !== "interrupted"
				|| active.resubmitPendingSteersAfterInterrupt === undefined
				|| (active.interruptedSteerClientIds?.length ?? 0) > 0)
		) {
			this.#scheduleNextQueuedTurn();
		}
	}

	#requestNextQueuedTurn(): void {
		queueMicrotask(() => {
			if (!this.#closed) this.#scheduleNextQueuedTurn();
		});
	}

	#scheduleNextQueuedTurn(): void {
		if (
			this.#activeTurn !== null
			|| this.#turnAdmissionPending
			|| this.#sessionTransitionActive
			|| this.#sessionControlActive
		) return;
		const queue = this.#queueCoordinator();
		const record = queue?.next();
		if (!queue || !record) return;
		const context = this.#sessionContext();
		const runtime = this.#runtime();
		const coordinator = this.#options.sessionCoordinator;
		const session = coordinator?.snapshot();
		if (session?.pendingApproval || session?.pendingClarification || session?.suspendedTurn) return;
		const executionClaim = coordinator?.claimExecution(context);
		if (coordinator && !executionClaim) return;
		let reservedTurnId: string;
		try {
			reservedTurnId = this.#options.createTurnId?.()
				?? `turn_${randomUUID().replaceAll("-", "")}`;
		} catch {
			if (executionClaim) coordinator?.releaseExecution(executionClaim);
			this.#emitQueueWorkerStartFailed();
			return;
		}
		const proposed: TurnSubmission = {
			clientTurnId: record.clientTurnId,
			clientUserMessageId: record.clientTurnId,
			queueId: record.queueId,
			inputSource: record.kind === "rejected_steer" ? "steer" : "submit",
			turnId: reservedTurnId,
			message: record.text,
			localImages: record.imagePaths,
			modelOverride: this.#model,
			...(this.#reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
		};
		let reservation: TurnReservation;
		let claimed = false;
		try {
			queue.claim(record.queueId, reservedTurnId);
			claimed = true;
			reservation = runtime.reserve(proposed);
			if (reservation.kind === "existing") {
				const reconciliation = queue.reconcileClaim(record.queueId, reservedTurnId);
				claimed = false;
				if (executionClaim) coordinator?.releaseExecution(executionClaim);
				if (reconciliation.committed) this.#requestNextQueuedTurn();
				else this.#emitQueueWorkerStartFailed();
				return;
			}
			runtime.configureRuntimeContext?.({
				collaborationMode: this.#collaborationMode,
				turnId: reservation.turn.turn_id,
			});
			try {
				queue.retireClaim(record.queueId, reservedTurnId);
				claimed = false;
			} catch {
				const reconciliation = queue.reconcileClaim(record.queueId, reservedTurnId);
				claimed = false;
				if (!reconciliation.committed) {
					throw new Error("queued turn reservation was not committed");
				}
			}
		} catch {
			if (claimed) {
				try {
					queue.reconcileClaim(record.queueId, reservedTurnId);
				} catch {
					// The durable claim remains recoverable on the next runtime load.
				}
			}
			if (executionClaim) coordinator?.releaseExecution(executionClaim);
			this.#emitQueueWorkerStartFailed();
			return;
		}
		const submission: TurnSubmission = {
			...proposed,
			turnId: reservation.turn.turn_id,
		};
		const collaborationMode = this.#collaborationMode;
		this.#collaborationModeByTurn.set(reservation.turn.turn_id, collaborationMode);
		const active: ActiveTurn = {
			clientTurnId: submission.clientTurnId,
			clientUserMessageId: submission.clientTurnId,
			controller: new AbortController(),
			context,
			runtime,
			...(executionClaim ? { executionClaim } : {}),
			collaborationMode,
			...(collaborationMode === "plan" ? { planStreamFilter: new ProposedPlanStreamFilter() } : {}),
			turnId: reservation.turn.turn_id,
			terminalEmitted: false,
		};
		this.#emitUserMessageLifecycle(
			active,
			record.text,
			record.kind === "rejected_steer" ? "steer" : "submit",
			`${reservation.turn.turn_id}:queue:${record.queueId}`,
		);
		this.#activeTurn = active;
		this.#activeTurnTask = new Promise<void>((resolve) => {
			queueMicrotask(() => {
				void this.#runTurn(active, submission, reservation).then(resolve);
			});
		});
	}

	#emitQueueWorkerStartFailed(): void {
		this.#emitRuntime("gateway.error", {
			code: "queue_worker_start_failed",
			message: "Queued turn could not be reserved.",
			method: "turn.submit",
		});
	}

	#interrupt(params: JsonObject): JsonObject | Promise<JsonObject> {
		this.#assertSessionMutationContext(params);
		let active = this.#activeTurn;
		const coordinator = this.#options.sessionCoordinator;
		const pendingClarification = active
			? undefined
			: coordinator?.snapshot().pendingClarification;
		let actualTurnId: string;
		if (active) {
			actualTurnId = active.turnId ?? active.clientTurnId;
		} else if (pendingClarification) {
			actualTurnId = pendingClarification.turnId;
		} else {
			return { accepted: false, requested: false, ...this.#status() };
		}
		const expectedTurnId = requiredString(params.turn_id, "turn_id");
		if (expectedTurnId !== actualTurnId) {
			throw new GatewayFailure(
				"turn_id_mismatch",
				"The active turn changed before interruption.",
				{ actual_turn_id: actualTurnId },
			);
		}
		if (!active) {
			if (pendingClarification && coordinator) {
				const context = this.#sessionContext();
				const executionClaim = coordinator.claimExecution(context);
				if (!executionClaim) {
					return { accepted: false, requested: false, ...this.#status() };
				}
				const runtime = this.#runtime();
				const collaborationMode = this.#collaborationModeByTurn.get(pendingClarification.turnId)
					?? this.#collaborationMode;
				try {
					runtime.configureRuntimeContext?.({
						collaborationMode,
						turnId: pendingClarification.turnId,
					});
				} catch (error) {
					coordinator.releaseExecution(executionClaim);
					throw error;
				}
				active = {
					clientTurnId: pendingClarification.clientTurnId,
					clientUserMessageId: pendingClarification.clientUserMessageId,
					controller: new AbortController(),
					context,
					runtime,
					executionClaim,
					collaborationMode,
					turnId: pendingClarification.turnId,
					terminalEmitted: false,
					visibleAgentOutput: true,
				};
				this.#activeTurn = active;
			}
		}
		if (!active) return { accepted: false, requested: false, ...this.#status() };
		if (active.interruptPromise) return active.interruptPromise;
		active.resubmitPendingSteersAfterInterrupt = this.#queueCoordinator()
			?.snapshot()
			.pendingSteers.some(
				(record) => record.targetTurnId === actualTurnId && record.source === "user",
			) === true;
		active.inputRolledBack = params.rollback_user_input === true
			&& active.visibleAgentOutput !== true;
		this.#appendInterruptTrace("turn_interrupt_requested", active, {
			requested: true,
			input_rolled_back: active.inputRolledBack === true,
		});
		active.controller.abort();
		active.interruptPromise = this.#awaitInterrupt(active);
		return active.interruptPromise;
	}

	async #awaitInterrupt(active: ActiveTurn): Promise<JsonObject> {
		const task = this.#activeTurnTask;
		const settledGracefully = task
			? await settlesWithin(task, GRACEFUL_INTERRUPT_TIMEOUT_MS)
			: active.terminalEmitted;
		if (!settledGracefully && this.#ownsActiveTurn(active) && !active.terminalEmitted) {
			const record = await this.#forceInterruptActive(active);
			this.#projectForcedInterrupt(active, record);
			const pendingClarification = this.#options.sessionCoordinator?.snapshot().pendingClarification;
			if (pendingClarification?.turnId === active.turnId) {
				this.#options.sessionCoordinator?.updatePendingClarification(active.context, undefined);
			}
			this.#releaseActiveExecution(active, record.status !== "in_progress");
		}
		const interrupted = active.terminalState === "interrupted";
		return {
			accepted: interrupted,
			requested: interrupted,
			client_turn_id: active.clientTurnId,
			turn_id: active.turnId ?? active.clientTurnId,
			input_rolled_back: interrupted && active.inputRolledBack === true,
			...(active.interruptedSteerClientIds?.length
				? {
					pending_steers_resubmitted: true,
					resubmitted_client_user_message_ids: [...active.interruptedSteerClientIds],
				}
				: {}),
			...(!interrupted ? this.#status() : {}),
		};
	}

	#forceInterruptActive(active: ActiveTurn): Promise<RuntimeTurnRecord> {
		active.forceInterruptPromise ??= active.runtime.forceInterrupt(
			{
				clientTurnId: active.clientTurnId,
				turnId: active.turnId ?? active.clientTurnId,
			},
			(event) => {
				if (this.#ownsActiveTurn(active)) this.#projectRuntimeEvent(active, event);
			},
		);
		return active.forceInterruptPromise;
	}

	#projectForcedInterrupt(active: ActiveTurn, record: RuntimeTurnRecord): void {
		if (record.status === "interrupted") this.#recordInterruptFinalized(active);
		if (!active.terminalEmitted && this.#ownsActiveTurn(active)) {
			this.#projectStoredTerminal(active, record);
		}
	}

	#projectRuntimeEvent(active: ActiveTurn, event: RuntimeEvent): void {
		switch (event.type) {
			case "turn_started":
				active.turnId = event.turnId;
				this.#emitRuntime("turn.started", {
					client_turn_id: event.clientTurnId,
					turn_id: event.turnId,
				});
				this.#emitRuntime("status.update", statusPayload("running", active.clientTurnId));
				this.#emitRuntime("status.changed", this.#status());
				break;
			case "user_message_started":
			case "user_message_completed":
				this.#emitRuntime(
					event.type === "user_message_started" ? "item.started" : "item.completed",
					{
						client_turn_id: active.clientTurnId,
						turn_id: event.turnId,
						item: {
							id: event.itemId,
							type: "user_message",
							client_user_message_id: event.clientUserMessageId,
							content: event.content,
							source: event.source,
						},
					},
				);
				break;
			case "compaction_started":
				active.contextWindow = Object.freeze({
					usedTokens: event.beforeTokens,
					maxTokens: event.maxTokens,
					source: "runtime_estimate",
				});
				this.#emitRuntime("compaction.started", {
					client_turn_id: event.clientTurnId,
					source: event.source,
					before_tokens: event.beforeTokens,
					max_tokens: event.maxTokens,
				});
				this.#emitRuntime("status.changed", this.#status());
				break;
			case "compaction_completed":
				active.contextWindow = Object.freeze({
					usedTokens: event.afterTokens,
					maxTokens: event.maxTokens,
					source: "runtime_estimate",
				});
				this.#emitRuntime("compaction.completed", {
					client_turn_id: event.clientTurnId,
					source: event.source,
					status: event.status,
					before_tokens: event.beforeTokens,
					after_tokens: event.afterTokens,
					max_tokens: event.maxTokens,
					duration_s: event.durationSeconds,
				});
				this.#emitRuntime("status.changed", this.#status());
				break;
			case "text_delta":
				if (event.text.length > 0) active.visibleAgentOutput = true;
				this.#emitAssistantDelta(
					active,
					active.planStreamFilter?.push(event.text) ?? event.text,
				);
				break;
			case "reasoning_delta": {
				if (event.text.length > 0) active.visibleAgentOutput = true;
				const payload = { client_turn_id: active.clientTurnId, text: event.text };
				this.#emitRuntime("reasoning.delta", payload);
				this.#emitRuntime("thinking.delta", payload);
				this.#emitTurnEvent(active, "reasoning", "reasoning", event.text);
				break;
			}
			case "provider_usage":
				active.contextWindow = contextWindowFromUsage(
					event.usage,
					this.#configuredMaxPromptTokens(),
					"provider_live",
				);
				this.#emitRuntime("status.changed", this.#status());
				break;
			case "stream_retrying":
				if (event.resetOutput) {
					active.planStreamFilter?.reset();
					this.#emitRuntime("message.reset", {
						client_turn_id: active.clientTurnId,
					});
				}
				this.#emitRuntime("stream.retrying", {
					client_turn_id: active.clientTurnId,
						text: runtimeRetryStatusText(event.failureKind, event.attempt, event.maxRetries),
					attempt: event.attempt,
					max_retries: Math.max(event.maxRetries, event.attempt),
					delay_seconds: event.delayMs / 1000,
					recovery_kind: event.recoveryKind,
					failure_kind: event.failureKind,
					additional_details: sanitizeRuntimeErrorDetail(event.additionalDetails)
						?? runtimeErrorPublicMessage(event.failureKind),
				});
				break;
			case "stream_recovered":
				this.#emitRuntime("stream.recovered", { client_turn_id: active.clientTurnId });
				break;
			case "message_complete":
				this.#emitAssistantDelta(active, active.planStreamFilter?.finishSegment() ?? "");
				this.#emitRuntime("message.complete", { client_turn_id: active.clientTurnId });
				this.#emitTurnEvent(active, "model_completed", "completed", "", {
					...(event.responseId ? { response_id: event.responseId } : {}),
				});
				break;
			case "web_search_started": {
				active.visibleAgentOutput = true;
				const callId = boundedString(event.callId, 256);
				this.#emitRuntime("item.started", {
					client_turn_id: active.clientTurnId,
					turn_id: active.turnId ?? active.clientTurnId,
					item: {
						id: webSearchLifecycleId(callId),
						type: "web_search",
						call_id: callId,
					},
					});
					this.#emitRuntime("status.update", statusPayload("running", active.clientTurnId));
					break;
				}
			case "web_search_completed": {
				active.visibleAgentOutput = true;
				const callId = boundedString(event.call.callId, 256);
				this.#emitRuntime("item.completed", {
					client_turn_id: active.clientTurnId,
					turn_id: active.turnId ?? active.clientTurnId,
					item: {
						id: webSearchLifecycleId(callId),
						type: "web_search",
						call_id: callId,
						status: "completed",
						action: event.call.action,
						detail: webSearchActionDetail(event.call.action),
					},
				});
				this.#emitRuntime("status.update", statusPayload("running", active.clientTurnId));
				break;
			}
			case "tool_call_accepted":
				break;
			case "file_mutation_started": {
				active.visibleAgentOutput = true;
				const callId = boundedString(event.callId, 256);
				const toolName = boundedString(event.toolName, 128) || "Tool";
				this.#emitRuntime("item.started", {
					client_turn_id: event.clientTurnId,
					turn_id: event.turnId,
					item: {
						id: toolLifecycleId(callId, toolName),
						type: "file_change",
						call_id: callId,
						name: toolName,
						preview: boundedString(event.preview, 512) || toolName,
						...approvalPreviewPayload(event),
						...fileMutationChangesPayload(event.fileChanges),
					},
				});
				break;
			}
			case "approval_requested": {
				active.visibleAgentOutput = true;
				const approval: PendingSessionApproval = {
					sessionId: active.context.sessionId,
					clientTurnId: event.clientTurnId,
					turnId: event.turnId,
					decisionId: event.decisionId,
					callId: event.callId,
					toolName: event.toolName,
					preview: event.preview,
					reason: event.reason,
					options: event.options,
					...(event.permissionRequest ? {
						permissionRequest: event.permissionRequest,
					} : {}),
					...approvalPreviewDetails(event),
				};
				if (this.#options.sessionCoordinator?.updatePendingApproval(active.context, approval) === false) {
					break;
				}
				this.#emitRuntime("approval.request", approvalRequest(
					approval,
					active.context.generation,
				));
				this.#emitRuntime(
					"status.update",
					statusPayload("waiting_approval", active.clientTurnId),
				);
				break;
			}
			case "clarification_requested": {
				active.visibleAgentOutput = true;
				const clarification: PendingSessionClarification = {
					sessionId: active.context.sessionId,
					clientTurnId: event.clientTurnId,
					clientUserMessageId: active.clientUserMessageId,
					turnId: event.turnId,
					requestId: event.requestId,
					callId: event.callId,
					toolName: event.toolName,
					question: event.question,
					options: event.options,
					header: event.header,
					multiSelect: event.multiSelect,
				};
				if (this.#options.sessionCoordinator
					?.updatePendingClarification(active.context, clarification) === false) {
					break;
				}
				this.#emitRuntime(
					"clarify.request",
					clarificationRequest(clarification, active.context.generation),
				);
				this.#emitRuntime(
					"turn.status",
					waitingStatus("waiting_clarification", active, "Waiting clarification"),
				);
				this.#emitRuntime(
					"status.update",
					statusPayload("waiting_clarification", active.clientTurnId),
				);
				break;
			}
			case "tool_execution_started": {
				active.visibleAgentOutput = true;
				const callId = boundedString(event.callId, 256);
				const toolName = boundedString(event.toolName, 128) || "Tool";
				this.#emitRuntime("tool.start", {
					client_turn_id: active.clientTurnId,
					tool_id: toolLifecycleId(callId, toolName),
					call_id: callId,
					name: toolName,
					context: `Executing ${toolName}`,
				});
				this.#emitTurnEvent(active, "tool_execution", "tool_start", "", {
					call_id: callId,
				}, toolName);
				break;
			}
			case "tool_execution_completed":
				this.#emitToolFinished(active, event, true);
				break;
			case "tool_execution_failed":
				this.#emitToolFinished(active, event, false);
				break;
			case "plan_updated": {
				const completed = event.items.filter((item) => item.status === "completed").length;
				this.#emitRuntime("plan.updated", {
					client_turn_id: active.clientTurnId,
					plan_steps: event.items.map((item) => `${item.status}: ${item.text}`),
					plan: { items: event.items },
					source: "update_plan",
					completed,
					total: event.items.length,
					...(event.explanation ? { explanation: event.explanation } : {}),
				});
				break;
			}
			case "turn_completed":
				if (active.terminalEmitted) {
					if (active.controller.signal.aborted) {
						this.#emitRuntime("turn.completion_suppressed", {
							client_turn_id: active.clientTurnId,
							reason: "interrupt_requested",
							suppressed_state: "completed",
						});
					}
					break;
				}
				active.terminalEmitted = true;
				if (active.controller.signal.aborted) {
					this.#emitRuntime("turn.completion_suppressed", {
						client_turn_id: active.clientTurnId,
						reason: "interrupt_requested",
						suppressed_state: "completed",
					});
					this.#emitInterrupted(active);
				} else {
					this.#emitCompleted(active, event.assistantText, event.usage, event.durationMs);
				}
				break;
			case "turn_failed":
				if (active.terminalEmitted) break;
				active.terminalEmitted = true;
				this.#emitTurnFailure(
					active,
					event.code,
					event.message,
					event.additionalDetails,
				);
				break;
			case "turn_interrupted":
				this.#recordInterruptFinalized(active);
				if (active.terminalEmitted) break;
				active.terminalEmitted = true;
				this.#emitInterrupted(active);
				break;
		}
	}

	#emitAssistantDelta(active: ActiveTurn, text: string): void {
		if (!text) return;
		this.#emitRuntime("message.delta", {
			client_turn_id: active.clientTurnId,
			text,
		});
		this.#emitTurnEvent(active, "assistant_delta", "text_delta", text);
	}

	#emitToolFinished(
		active: ActiveTurn,
		event: Extract<RuntimeEvent, {
			readonly type: "tool_execution_completed" | "tool_execution_failed";
		}>,
		success: boolean,
	): void {
		const callId = boundedString(event.callId, 256);
		const toolName = boundedString(event.toolName, 128) || "Tool";
		const summary = boundedString(event.summary, 512);
		const errorKind = event.type === "tool_execution_failed"
			? boundedString(event.errorKind ?? "", 128)
			: "";
		const durationMs = boundedDurationMs(event.durationMs);
		const durationSeconds = durationMs / 1000;
		const method = success ? "tool.complete" : "tool.failed";
		const metadata = safeToolMetadata(event.metadata, success);
		this.#emitRuntime(method, {
			client_turn_id: active.clientTurnId,
			tool_id: toolLifecycleId(callId, toolName),
			call_id: callId,
			name: toolName,
			duration_s: durationSeconds,
			summary,
			summary_chars: summary.length,
			summary_truncated: false,
			success,
			...metadata,
			...(errorKind
				? {
					error_kind: errorKind,
					error: errorKind,
					error_chars: errorKind.length,
					error_truncated: false,
				}
				: {}),
		});
		this.#emitTurnEvent(
			active,
			"tool_execution",
			success ? "tool_complete" : "tool_failed",
			summary,
			{
				call_id: callId,
				duration_ms: durationMs,
				success,
				...metadata,
				...(errorKind ? { error_kind: errorKind } : {}),
			},
			toolName,
		);
	}

	#projectStoredTerminal(active: ActiveTurn, record: RuntimeTurnRecord): void {
		active.terminalEmitted = true;
		active.turnId ??= record.turn_id;
		if (record.status === "completed") {
			const result = isObject(record.result) ? record.result : {};
			this.#emitCompleted(
				active,
				typeof result.assistant_text === "string" ? result.assistant_text : "",
				isObject(result.usage) ? numberRecord(result.usage) : {},
				completedTurnDurationMs(record),
			);
		} else if (record.status === "interrupted") {
			this.#emitInterrupted(active);
		} else if (record.status === "failed") {
			const result = isObject(record.result) ? record.result : {};
			this.#emitTurnFailure(
				active,
				record.error_code ?? "provider_error",
				typeof result.message === "string" ? result.message : "Turn failed.",
				typeof result.additional_details === "string" ? result.additional_details : undefined,
			);
		}
	}

	#emitCompleted(
		active: ActiveTurn,
		assistantText: string,
		usage: Readonly<Record<string, number>>,
		durationMs?: number,
	): void {
		active.terminalState = "completed";
		const turnId = active.turnId ?? active.clientTurnId;
		this.#emitAssistantDelta(active, active.planStreamFilter?.finishSegment() ?? "");
		const proposedPlan = active.collaborationMode === "plan"
			? extractProposedPlan(assistantText)
			: undefined;
		const visibleAssistantText = proposedPlan?.assistantText ?? assistantText;
		this.#emitRuntime("turn.completed", {
			client_turn_id: active.clientTurnId,
			turn_id: turnId,
			assistant_message: visibleAssistantText,
			activity_events: [],
			progress_updates: [],
			plan_steps: [],
			pending_decision: false,
			turn_state: "completed",
			usage,
			...(durationMs === undefined ? {} : { duration_ms: boundedDurationMs(durationMs) }),
		});
		this.#emitRuntime("turn.status", terminalStatus("completed", active, "Completed"));
		this.#emitRuntime("message.complete", {
			client_turn_id: active.clientTurnId,
			text: visibleAssistantText,
			final: true,
			source: "turn_response",
		});
		if (proposedPlan) {
			active.visibleAgentOutput = true;
			active.pendingProposedPlan = proposedPlan.planText;
		}
		this.#collaborationModeByTurn.delete(turnId);
		this.#emitRuntime("status.update", statusPayload("completed", active.clientTurnId));
	}

	#emitPendingProposedPlan(active: ActiveTurn): void {
		const text = active.pendingProposedPlan;
		if (!text) return;
		delete active.pendingProposedPlan;
		this.#emitRuntime("plan.proposed", {
			client_turn_id: active.clientTurnId,
			text,
			source: "assistant_message",
		});
	}

	#emitTurnFailure(
		active: ActiveTurn,
		code: RuntimeErrorCode,
		message: string,
		additionalDetails?: string,
	): void {
		this.#prepareFailedSteers(active);
		active.terminalState = "failed";
		this.#collaborationModeByTurn.delete(active.turnId ?? active.clientTurnId);
		const safeAdditionalDetails = sanitizeRuntimeErrorDetail(additionalDetails);
		this.#emitRuntime("turn.failed", {
			client_turn_id: active.clientTurnId,
			turn_id: active.turnId ?? active.clientTurnId,
			code,
			message,
			...(safeAdditionalDetails ? { additional_details: safeAdditionalDetails } : {}),
		});
		this.#emitRuntime("turn.status", terminalStatus("failed", active, "Failed"));
		this.#emitRuntime("status.update", statusPayload("failed", active.clientTurnId));
	}

	#emitInterrupted(active: ActiveTurn): void {
		active.terminalState = "interrupted";
		this.#prepareInterruptedSteers(active);
		this.#collaborationModeByTurn.delete(active.turnId ?? active.clientTurnId);
		this.#emitRuntime("turn.interrupted", {
			client_turn_id: active.clientTurnId,
			turn_id: active.turnId ?? active.clientTurnId,
			code: "interrupted",
			requested: false,
			message: "Turn interrupted",
			input_rolled_back: active.inputRolledBack === true,
		});
		this.#emitRuntime(
			"turn.status",
			terminalStatus("interrupted", active, "Interrupted", "Turn interrupted"),
		);
		this.#emitRuntime(
			"status.update",
			statusPayload("interrupted", active.clientTurnId, "Turn interrupted"),
		);
	}

	#prepareInterruptedSteers(active: ActiveTurn): void {
		if (active.interruptedSteerClientIds !== undefined) return;
		active.interruptedSteerClientIds = Object.freeze([]);
		if (!active.resubmitPendingSteersAfterInterrupt || !active.turnId) return;
		try {
			const result = this.#queueCoordinator()?.prepareInterruptedSteers(active.turnId);
			active.interruptedSteerClientIds = Object.freeze(
				(result?.records ?? []).map((record) => record.clientTurnId),
			);
		} catch {
			this.#emitRuntime("gateway.error", {
				code: "queue_worker_start_failed",
				message: "Queued steer could not be prepared after interruption.",
				method: "turn.interrupt",
			});
		}
	}

	#prepareFailedSteers(active: ActiveTurn): void {
		if (active.failedSteersPrepared || !active.turnId) return;
		active.failedSteersPrepared = true;
		try {
			this.#queueCoordinator()?.rejectPending(active.turnId);
		} catch {
			this.#emitRuntime("gateway.error", {
				code: "queue_worker_start_failed",
				message: "Queued steer could not be deferred after turn failure.",
				method: "turn.submit",
			});
		}
	}

	#appendInterruptTrace(
		kind: "turn_interrupt_requested" | "turn_interrupted",
		active: ActiveTurn,
		payload: JsonObject,
	): void {
		try {
			this.#options.traceCommands?.append?.(this.#sessionId(), {
				kind,
				turn_id: active.turnId ?? active.clientTurnId,
				payload: {
					client_turn_id: active.clientTurnId,
					...payload,
				},
			});
		} catch {
			// Diagnostics must not block interruption.
		}
	}

	#recordInterruptFinalized(active: ActiveTurn): void {
		if (active.interruptionFinalizedLogged) return;
		active.interruptionFinalizedLogged = true;
		this.#appendInterruptTrace("turn_interrupted", active, { status: "interrupted" });
	}

	#status(): JsonObject {
		const session = this.#options.sessionCoordinator?.snapshot();
		const summary = this.#options.sessionCommands?.inspect?.(this.#sessionId());
		const queue = this.#queueCoordinator()?.snapshot() ?? session?.queue;
		const steering = queue?.pendingSteers ?? [];
		const rejectedSteers = queue?.rejectedSteers ?? [];
		const followUps = queue?.followUps ?? [];
		const deferredInputs = [...rejectedSteers, ...followUps];
		const pendingInputCount = steering.length + deferredInputs.length;
		return {
			session_id: this.#sessionId(),
			...(session ? { generation: session.generation } : {}),
			workspace: this.#workspaceRoot(),
			provider: this.#provider,
			model: this.#model,
			...(this.#reasoningEffort ? { thinking_effort: this.#reasoningEffort } : {}),
			collaboration_mode: this.#collaborationMode,
			...(summary ? {
				session_lifecycle_status: summary.lifecycleStatus,
				session_lock_state: summary.leaseState,
				session_pending_state: summary.pendingState,
				session_metadata_revision: summary.metadataRevision,
				...(summary.parentId ? { parent_session_id: summary.parentId } : {}),
				...(summary.forkPoint === undefined ? {} : { fork_point: summary.forkPoint }),
			} : {}),
			context_window: this.#contextWindow(),
			pending_decision: session?.pendingApproval !== undefined,
			pending_clarification: session?.pendingClarification !== undefined,
			suspended_turn: session?.pendingApproval !== undefined
				|| session?.pendingClarification !== undefined
				|| session?.suspendedTurn === true,
			turn_running: this.#activeTurn !== null,
			turn_id: this.#activeTurn?.turnId ?? null,
			queued_steering: steering.map((item) => item.text),
			queued_follow_up: deferredInputs.map((item) => item.text),
			has_pending_input: pendingInputCount > 0,
			queue_activity: {
				kind: pendingInputCount > 0 ? "pending_input" : "idle",
				has_pending_input: pendingInputCount > 0,
				steering_count: steering.length,
				follow_up_count: deferredInputs.length,
			},
			queue_revision: queue?.revision ?? 0,
			queue_items: {
				pending_steers: queue?.pendingSteers.map(gatewayQueueItem) ?? [],
				rejected_steers: rejectedSteers.map(gatewayQueueItem),
				follow_ups: followUps.map(gatewayQueueItem),
			},
			background_shells: this.#activeShells().map((snapshot) =>
				shellSnapshotPayload(snapshot, this.#sessionContext())),
			trust: this.#trustStatus(),
			permissions: this.#permissions(),
		};
	}

	#contextWindow(): JsonObject {
		const live = this.#activeTurn?.contextWindow;
		if (live) {
			return contextWindowPayload(live.usedTokens, live.maxTokens, live.source);
		}
		const rollouts = this.#options.loadTurnRollouts?.(this.#sessionId()) ?? [];
		let usage: JsonObject | undefined;
		let source = "unknown";
		for (let index = rollouts.length - 1; index >= 0; index -= 1) {
			const rollout = rollouts[index];
			const continuation = rollout && isObject(rollout.continuation_state)
				? rollout.continuation_state
				: undefined;
			if (!continuation) continue;
			if (isObject(continuation.last_token_usage)) {
				usage = continuation.last_token_usage;
				source = this.#activeTurn ? "provider_previous" : "provider";
				break;
			}
			if (!isObject(continuation.usage)) continue;
			usage = continuation.usage;
			source = this.#activeTurn ? "provider_previous" : "provider_aggregate";
			break;
		}
		const inputTokens = nonNegativeMetric(usage?.input_tokens);
		const totalTokens = nonNegativeMetric(usage?.total_tokens);
		const usedTokens = inputTokens > 0 ? inputTokens : totalTokens;
		return contextWindowPayload(usedTokens, this.#configuredMaxPromptTokens(), source);
	}

	#configuredMaxPromptTokens(): number {
		const configured = typeof this.#options.maxPromptTokens === "function"
			? this.#options.maxPromptTokens()
			: this.#options.maxPromptTokens;
		return nonNegativeMetric(configured);
	}

	#trustStatus(): JsonObject {
		return {
			state: this.#trustState,
			workspace: this.#workspaceRoot(),
			source: this.#options.workspaceTrust ? "user_store" : "runtime",
			enforced: this.#runtime().configureExecutionPolicy !== undefined,
		};
	}

	async #setWorkspaceTrust(params: JsonObject): Promise<JsonObject> {
		const release = this.#claimSessionControlOperation(
			"Wait for the current turn to finish before changing workspace trust.",
		);
		try {
			const state = workspaceTrustState(params.state);
			const workspaceRoot = this.#workspaceRoot();
			const trust = this.#options.workspaceTrust;
			const previousState = this.#trustState;
			let nextPreferences: SessionPreferences | void = undefined;
			if (trust && state === "trusted") {
				await trust.save(workspaceRoot, state);
				try {
					nextPreferences = await trust.reload?.(workspaceRoot, state);
				} catch {
					try {
						await trust.save(workspaceRoot, previousState);
						const restored = await trust.reload?.(workspaceRoot, previousState);
						if (restored) this.#applySessionPreferences(restored);
					} catch {
						this.#trustState = "unknown";
						this.#configureExecutionPolicy();
						await trust.reload?.(workspaceRoot, "unknown").catch(() => undefined);
					}
					throw new GatewayFailure(
						"internal_error",
						"Workspace trust could not be applied.",
					);
				}
			} else if (trust) {
				try {
					nextPreferences = await trust.reload?.(workspaceRoot, state);
				} catch {
					throw new GatewayFailure(
						"internal_error",
						"Workspace trust could not be applied.",
					);
				}
				try {
					await trust.save(workspaceRoot, state);
				} catch {
					this.#trustState = "unknown";
					this.#configureExecutionPolicy();
					if (nextPreferences) this.#applySessionPreferences(nextPreferences);
					throw new GatewayFailure(
						"internal_error",
						"Workspace trust could not be saved.",
					);
				}
			}
			if (nextPreferences) this.#applySessionPreferences(nextPreferences);
			this.#trustState = state;
			this.#configureExecutionPolicy();
			const payload = this.#trustStatus();
			this.#emitRuntime("workspace.trust.changed", payload);
			this.#emitRuntime("status.changed", this.#status());
			return payload;
		} finally {
			release();
		}
	}

	#permissions(): JsonObject {
		return permissionPayload(
			this.#permissionProfile,
			this.#runtime().listCommandAllowances?.().length ?? 0,
			this.#runtime().executionPolicySnapshot?.(),
			this.#options.sandboxReadiness,
		);
	}

	#updatePermissions(params: JsonObject): JsonObject {
		this.#permissionProfile = permissionProfile(params.profile);
		this.#ensureSessionPreferences(this.#collaborationMode);
		this.#configureExecutionPolicy();
		const permissions = this.#permissions();
		const status = this.#status();
		this.#emitRuntime("status.changed", status);
		return { permissions, status };
	}

	#configureExecutionPolicy(runtime: NodeGatewayRuntime = this.#runtime()): void {
		runtime.configureExecutionPolicy?.({
			trust: this.#trustState,
			permission: this.#permissionProfile,
		});
		runtime.configureRuntimeContext?.({ collaborationMode: this.#collaborationMode });
	}

	async #loadWorkspaceTrust(workspaceRoot: string): Promise<WorkspaceTrustState> {
		try {
			return await this.#options.workspaceTrust?.load(workspaceRoot) ?? "unknown";
		} catch {
			return "unknown";
		}
	}

	#sessionId(): string {
		return this.#options.sessionCoordinator?.snapshot().sessionId ?? this.#options.sessionId;
	}

	#workspaceRoot(): string {
		return this.#options.sessionCoordinator?.snapshot().workspaceRoot
			?? this.#options.workspaceRoot;
	}

	#runtime(): NodeGatewayRuntime {
		return this.#options.sessionCoordinator?.snapshot().binding ?? this.#options.runtime;
	}

	#queueCoordinator(): QueueCoordinator | undefined {
		return this.#runtime().queueCoordinator;
	}

	#requiredQueueCoordinator(): QueueCoordinator {
		const queue = this.#queueCoordinator();
		if (!queue) throw new GatewayFailure("method_not_found", "Queue operations are unavailable.");
		return queue;
	}

	#requiredShellManager(): NonNullable<CreateNodeGatewayOptions["shellManager"]> {
		const manager = this.#options.shellManager;
		if (!manager) throw new GatewayFailure("method_not_found", "Shell operations are unavailable.");
		return manager;
	}

	#activeShells(): readonly ShellSessionSnapshot[] {
		const ownerSessionId = this.#sessionId();
		return this.#options.shellManager?.list(ownerSessionId).filter((snapshot) =>
			snapshot.ownerSessionId === ownerSessionId
				&& snapshot.background
				&& snapshot.status === "running"
				&& snapshot.processState === "running_background") ?? [];
	}

	#bindQueue(): void {
		this.#unsubscribeQueue?.();
		this.#unsubscribeQueue = null;
		const queue = this.#queueCoordinator();
		if (!queue) return;
		const context = this.#sessionContext();
		this.#unsubscribeQueue = queue.subscribe((snapshot) => {
			if (this.#closed) return;
			const sessions = this.#options.sessionCoordinator;
			if (sessions) {
				if (!sessions.updateQueue(context, snapshot)) return;
			} else if (snapshot.sessionId !== context.sessionId) {
				return;
			}
			this.#emitRuntime("turn.queue.updated", queueEventPayload(snapshot, context));
		});
	}

	#bindShellLifecycle(): void {
		this.#unsubscribeShell?.();
		this.#unsubscribeShell = this.#options.shellLifecycle?.subscribe((event) => {
			if (this.#closed) return;
			const context = this.#sessionContext();
			if (event.ownerSessionId !== context.sessionId) return;
			this.#emitRuntime(event.kind, shellLifecyclePayload(event, context.generation));
		}) ?? null;
	}

	#bindSubagents(): void {
		this.#unsubscribeSubagents = this.#options.integrations?.subscribeSubagents?.((value) => {
			const parentSessionId = boundedRequiredValue(value.parent_session_id, 256);
			if (parentSessionId && parentSessionId !== this.#sessionContext().sessionId) return;
			const subagent = boundedSubagent(value);
			if (subagent) this.#emitRuntime("subagent.updated", { subagent });
		}) ?? null;
	}

	#bindExtensions(): void {
		this.#unsubscribeExtensions = this.#options.integrations?.subscribeExtensions?.((version) => {
			if (this.#closed) return;
			this.#emitDirect("extension.updated", { version });
		}) ?? null;
	}

	#bindAgentInteractiveRequests(): void {
		this.#unsubscribeAgentInteractiveRequests = this.#options.agentInteractiveRequests?.subscribe(
			(notification) => {
				if (this.#closed) return;
				if (notification.method === "interactive.cancelled") {
					this.#cancelInteractiveRequest(notification.params);
					return;
				}
				this.#emitRuntime(notification.method, { ...notification.params });
			},
		) ?? null;
	}

	#sessionContext(): SessionGenerationContext {
		return this.#options.sessionCoordinator?.context()
			?? Object.freeze({ sessionId: this.#options.sessionId, generation: 1 });
	}

	#assertSessionMutationContext(params: JsonObject): SessionGenerationContext {
		const context = this.#sessionContext();
		const requestedSessionId = optionalBoundedIdentity(params.session_id, "session_id")
			?? context.sessionId;
		const requestedGeneration = params.generation === undefined
			? context.generation
			: positiveInteger(params.generation);
		if (requestedGeneration === undefined) {
			throw new GatewayFailure("invalid_params", "generation must be a positive integer.");
		}
		if (
			this.#sessionTransitionActive
			|| requestedSessionId !== context.sessionId
			|| requestedGeneration !== context.generation
		) {
			throw new GatewayFailure(
				"session_changed",
				"The active session changed before queued input could be updated.",
				{
					active_session_id: context.sessionId,
					active_generation: context.generation,
				},
			);
		}
		return context;
	}

	#isCurrent(active: ActiveTurn): boolean {
		return this.#options.sessionCoordinator?.isCurrent(active.context) ?? true;
	}

	#ownsActiveTurn(active: ActiveTurn): boolean {
		return this.#activeTurn === active && this.#isCurrent(active);
	}

	#acceptRuntimeEvent(active: ActiveTurn, event: RuntimeEvent): void {
		if (this.#ownsActiveTurn(active)) {
			this.#projectRuntimeEvent(active, event);
			return;
		}
		if (
			active.terminalState === "interrupted"
			&& event.type === "turn_completed"
			&& this.#isCurrent(active)
		) {
			this.#emitRuntime("turn.completion_suppressed", {
				client_turn_id: active.clientTurnId,
				reason: "interrupt_requested",
				suppressed_state: "completed",
			});
		}
	}

	#emitTurnEvent(
		active: ActiveTurn,
		phase: string,
		kind: string,
		text: string,
		metadata: JsonObject = {},
		toolName: string | null = null,
	): void {
		this.#emitRuntime("turn.event", {
			client_turn_id: active.clientTurnId,
			phase,
			kind,
			text,
			tool_name: toolName,
			metadata,
		});
	}

	#emitUserMessageLifecycle(
		active: ActiveTurn,
		content: string,
		source: "submit" | "steer",
		itemId?: string,
	): void {
		const turnId = active.turnId ?? active.clientTurnId;
		const params = {
			client_turn_id: active.clientTurnId,
			turn_id: turnId,
			item: {
				id: itemId ?? `${turnId}:user:${active.clientUserMessageId}`,
				type: "user_message",
				client_user_message_id: active.clientUserMessageId,
				content,
				source,
			},
		};
		this.#emitRuntime("item.started", params);
		this.#emitRuntime("item.completed", params);
	}

	#emitRuntime(method: string, params: JsonObject): void {
		if (isInteractiveRequestMethod(method)) {
			this.#enqueueInteractiveRequest(method, params);
			return;
		}
		if (isInteractiveResponseMethod(method)) {
			this.#resolveInteractiveRequest(method, params);
			return;
		}
		this.#emitRuntimeNow(method, params);
	}

	#enqueueInteractiveRequest(method: InteractiveRequestMethod, params: JsonObject): void {
		const identity = interactiveRequestIdentity(method, params);
		if (this.#interactiveRequests.some((request) => request.identity === identity)) return;
		this.#interactiveRequests.push({ method, params: { ...params }, identity });
		if (this.#interactiveRequests.length === 1) this.#publishNextInteractiveRequest();
	}

	#resolveInteractiveRequest(method: InteractiveResponseMethod, params: JsonObject): void {
		const requestMethod = method === "approval.respond" ? "approval.request" : "clarify.request";
		const index = this.#interactiveRequests.findIndex((request) => (
			request.method === requestMethod && interactiveResponseMatchesRequest(request.params, params)
		));
		const wasVisible = index === 0;
		if (index >= 0) this.#interactiveRequests.splice(index, 1);
		this.#emitRuntimeNow(method, params);
		if (wasVisible) this.#publishNextInteractiveRequest();
	}

	#cancelInteractiveRequest(params: JsonObject): void {
		const index = this.#interactiveRequests.findIndex((request) =>
			interactiveResponseMatchesRequest(request.params, params));
		if (index < 0) return;
		const wasVisible = index === 0;
		this.#interactiveRequests.splice(index, 1);
		if (wasVisible) this.#publishNextInteractiveRequest();
	}

	#publishNextInteractiveRequest(): void {
		const next = this.#interactiveRequests[0];
		if (next) this.#emitRuntimeNow(next.method, next.params);
	}

	#emitRuntimeNow(method: string, params: JsonObject): void {
		const ownedParams = this.#ownedRuntimeParams(method, params);
		this.#emitDirect(method, ownedParams);
		this.#sequence += 1;
		this.#emitDirect("runtime.event", {
			version: 1,
			sequence: this.#sequence,
			type: method,
			payload: ownedParams,
			timestamp: this.#clock(),
		});
	}

	#ownedRuntimeParams(method: string, params: JsonObject): JsonObject {
		if (!isTurnOwnershipEvent(method)) return params;
		const context = this.#sessionContext();
		const active = this.#activeTurn;
		return {
			...params,
			session_id: context.sessionId,
			generation: context.generation,
			...(method === "status.update" && active?.turnId && params.turn_id === undefined
				? { turn_id: active.turnId }
				: {}),
		};
	}

	#emitDirect(method: string, params: JsonObject): void {
		const notification = { jsonrpc: "2.0" as const, method, params };
		parseGatewayEvent(notification);
		this.#write(notification);
	}

	#writeResult(id: RpcId, result: JsonObject): void {
		this.#write({ jsonrpc: "2.0", id, result });
	}

	#writeError(id: RpcId, code: string, message: string, data: JsonObject = {}): void {
		this.#write({
			jsonrpc: "2.0",
			id,
			error: { code, message, ...(Object.keys(data).length > 0 ? { data } : {}) },
		});
	}

	#write(message: object): void {
		if (!this.#closed) this.#clientInput.write(`${JSON.stringify(message)}\n`);
	}
}

export interface NodeGatewayCompactionResult {
	readonly status: "compressed" | "skipped" | "not_needed" | "failed" | "interrupted";
	readonly beforeTokens: number;
	readonly afterTokens: number;
}

interface CompactionCommandPresentation {
	readonly title: string;
	readonly summary: string;
	readonly severity: "info" | "success" | "warning" | "error";
}

function compactionCommandPresentation(
	result: NodeGatewayCompactionResult,
): CompactionCommandPresentation {
	switch (result.status) {
		case "compressed":
			return {
				title: "Context compacted",
				summary: `Context compacted: ${result.beforeTokens} -> ${result.afterTokens} tokens.`,
				severity: "success",
			};
		case "not_needed":
			return {
				title: "Nothing to compact",
				summary: "Nothing to compact. Only base context and retained recent turns remain.",
				severity: "info",
			};
		case "skipped":
			return {
				title: "Compaction skipped",
				summary: `Compaction skipped. Context remains at ${result.beforeTokens} tokens.`,
				severity: "warning",
			};
		case "failed":
			return {
				title: "Compaction failed",
				summary: `Compaction failed. Context remains at ${result.beforeTokens} tokens.`,
				severity: "error",
			};
		case "interrupted":
			return {
				title: "Compaction interrupted",
				summary: `Compaction interrupted. Context remains at ${result.beforeTokens} tokens.`,
				severity: "warning",
			};
	}
}

function cachedUpdateStatusPayload(status: CachedUpdateStatus): JsonObject {
	return {
		schema_version: status.schemaVersion,
		package_name: status.packageName,
		current_version: status.currentVersion,
		check_on_startup: status.checkOnStartup,
		availability: status.availability,
		cache_state: status.cacheState,
		install: {
			method: status.install.method,
			command: status.install.command,
			fallback: status.install.fallback,
		},
		...(status.latestVersion ? { latest_version: status.latestVersion } : {}),
		...(status.lastCheckedAt ? { last_checked_at: status.lastCheckedAt } : {}),
		...(status.dismissedVersion ? { dismissed_version: status.dismissedVersion } : {}),
	};
}

function updateCommandFields(status: CachedUpdateStatus): readonly {
	readonly label: string;
	readonly value: string;
}[] {
	return [
		{ label: "Current", value: status.currentVersion },
		{ label: "Latest", value: status.latestVersion ?? "unknown" },
		{ label: "Status", value: status.availability },
		{ label: "Cache", value: status.cacheState },
		{ label: "Install", value: status.install.command },
	];
}

function updateGatewayFailure(error: unknown): GatewayFailure {
	if (!(error instanceof CachedUpdateError)) {
		return new GatewayFailure("internal_error", "Update operation failed.");
	}
	const code = error.code === "update_cache_write_failed" ? "internal_error" : "invalid_params";
	return new GatewayFailure(code, updateErrorMessage(error.code));
}

function updateErrorMessage(code: CachedUpdateError["code"]): string {
	if (code === "invalid_update_version") return "Update version must be a stable semantic version.";
	if (code === "update_version_unavailable") return "That update version is not currently advertised.";
	return "Update dismissal could not be saved.";
}

export function createNodeGateway(options: CreateNodeGatewayOptions): NodeGateway {
	return new InProcessNodeGateway(options);
}

function shellPsCommandResult(processes: readonly JsonObject[]): JsonObject {
	const lines = processes.length === 0
		? ["no background shells"]
		: processes.map((process) => [
			String(process.shell_id ?? "shell"),
			String(process.process_state ?? "running"),
			String(process.command_preview ?? "[redacted command]"),
		].join(" "));
	return {
		result_id: `command:${randomUUID().replaceAll("-", "")}`,
		presentation: "transcript",
		command_kind: "background_shells",
		processes,
		lines,
		display: shellCommandDisplay({
			kind: "list",
			command: "/ps",
			title: "Background terminals",
			severity: "info",
			rows: processes.map((process) => ({
				key: String(process.shell_id ?? "shell"),
				label: `shell ${String(process.shell_id ?? "unknown")}`,
				values: [String(process.command_preview ?? "[redacted command]")],
				status: String(process.process_state ?? "running"),
			})),
			totalRows: processes.length,
		}),
	};
}

function shellStopCommandResult(stopped: JsonObject): JsonObject {
	return {
		result_id: `command:${randomUUID().replaceAll("-", "")}`,
		presentation: "none",
		command_kind: "shell_stop",
		lines: ["Stopping all background terminals."],
		stopped: stopped.stopped ?? 0,
		display: shellCommandDisplay({
			kind: "notice",
			command: "/stop",
			title: "Background terminals",
			severity: "success",
			summary: "Stopping all background terminals.",
		}),
	};
}

function shellCommandDisplay(input: {
	readonly kind: "list" | "notice";
	readonly command: string;
	readonly title: string;
	readonly severity: "info" | "success";
	readonly summary?: string;
	readonly rows?: readonly JsonObject[];
	readonly totalRows?: number;
}): JsonObject {
	return {
		version: 1,
		kind: input.kind,
		command: input.command,
		title: input.title,
		severity: input.severity,
		...(input.summary ? { summary: input.summary } : {}),
		fields: [],
		rows: input.rows ?? [],
		sections: [],
		suggestions: [],
		...(input.totalRows === undefined ? {} : { total_rows: input.totalRows }),
		omitted_rows: 0,
		omitted_chars: 0,
	};
}

function shellSnapshotPayload(
	snapshot: ShellSessionSnapshot,
	context: SessionGenerationContext,
): JsonObject {
	const metadata = sanitizeShellSnapshotPayload({
		...(snapshot.commandPreview ? { command_preview: snapshot.commandPreview } : {}),
		process_state: snapshot.processState,
		...(snapshot.terminalState ? { terminal_state: snapshot.terminalState } : {}),
		...(snapshot.transport ? { transport: snapshot.transport } : {}),
		...(snapshot.cleanupResult ? { cleanup_result: snapshot.cleanupResult } : {}),
		...(snapshot.startedAt ? { started_at: snapshot.startedAt } : {}),
		...(snapshot.completedAt ? { completed_at: snapshot.completedAt } : {}),
		...(snapshot.shellKind ? { shell_kind: snapshot.shellKind } : {}),
		...(snapshot.shellEdition ? { shell_edition: snapshot.shellEdition } : {}),
	}, snapshot.shellId);
	const discardedOutputChars = Math.max(
		0,
		snapshot.output.length - SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	);
	const output = discardedOutputChars > 0
		? snapshot.output.slice(-SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS)
		: snapshot.output;
	return {
		shell_id: snapshot.shellId,
		session_id: context.sessionId,
		generation: context.generation,
		...(snapshot.callId ? { call_id: snapshot.callId } : {}),
		...(metadata.command_preview ? { command_preview: metadata.command_preview } : {}),
		...(snapshot.description ? { description: snapshot.description } : {}),
		background: snapshot.background,
		status: snapshot.status,
		process_state: metadata.process_state ?? snapshot.processState,
		...(metadata.terminal_state ? { terminal_state: metadata.terminal_state } : {}),
		...(snapshot.exitCode === undefined ? {} : { exit_code: snapshot.exitCode }),
		output,
		next_cursor: snapshot.nextCursor,
		output_chars: snapshot.outputChars,
		omitted_output_chars: snapshot.omittedOutputChars + discardedOutputChars,
		...(metadata.transport ? { transport: metadata.transport } : {}),
		tty: snapshot.tty,
		yielded: snapshot.yielded,
		...(metadata.cleanup_result ? { cleanup_result: metadata.cleanup_result } : {}),
		...(metadata.started_at ? { started_at: metadata.started_at } : {}),
		...(metadata.completed_at ? { completed_at: metadata.completed_at } : {}),
		...(metadata.shell_kind ? { shell_kind: metadata.shell_kind } : {}),
		...(metadata.shell_edition ? { shell_edition: metadata.shell_edition } : {}),
		...(snapshot.errorKind ? { error_kind: snapshot.errorKind } : {}),
		...(snapshot.error ? { error: snapshot.error.slice(0, 512) } : {}),
	};
}

function shellLifecyclePayload(
	event: ShellLifecycleEvent,
	generation: number,
): JsonObject {
	const metadata = sanitizeShellSnapshotPayload({
		command_preview: event.commandPreview,
		process_state: event.processState,
		...(event.terminalState ? { terminal_state: event.terminalState } : {}),
		...(event.transport ? { transport: event.transport } : {}),
		...(event.cleanupResult ? { cleanup_result: event.cleanupResult } : {}),
		...(event.startedAt ? { started_at: event.startedAt } : {}),
		...(event.completedAt ? { completed_at: event.completedAt } : {}),
		...(event.shellKind ? { shell_kind: event.shellKind } : {}),
		...(event.shellEdition ? { shell_edition: event.shellEdition } : {}),
	}, event.shellId);
	const outputDelta = event.outputDelta === undefined
		? undefined
		: event.outputDelta.slice(-10_000);
	const discardedOutputChars = event.outputDelta === undefined
		? 0
		: Math.max(0, event.outputDelta.length - (outputDelta?.length ?? 0));
	return {
		shell_id: event.shellId,
		session_id: event.ownerSessionId,
		generation,
		call_id: event.callId,
		sequence: event.sequence,
		command_preview: metadata.command_preview ?? "[redacted command]",
		...(event.description ? { description: event.description } : {}),
		background: event.background,
		process_state: metadata.process_state ?? event.processState,
		...(metadata.transport ? { transport: metadata.transport } : {}),
		tty: event.tty,
		yielded: event.yielded,
		...(metadata.terminal_state ? { terminal_state: metadata.terminal_state } : {}),
		...(event.exitCode === undefined ? {} : { exit_code: event.exitCode }),
		...(outputDelta === undefined ? {} : { output_delta: outputDelta }),
		...(event.nextCursor === undefined ? {} : { next_cursor: event.nextCursor }),
		...(event.outputChars === undefined ? {} : { output_chars: event.outputChars }),
		...((event.omittedOutputChars ?? 0) + discardedOutputChars > 0
			? { omitted_output_chars: (event.omittedOutputChars ?? 0) + discardedOutputChars }
			: {}),
		...(metadata.cleanup_result ? { cleanup_result: metadata.cleanup_result } : {}),
		...(metadata.started_at ? { started_at: metadata.started_at } : {}),
		...(metadata.completed_at ? { completed_at: metadata.completed_at } : {}),
		...(event.activeBackgroundCount === undefined
			? {}
			: { active_background_count: event.activeBackgroundCount }),
		...(metadata.shell_kind ? { shell_kind: metadata.shell_kind } : {}),
		...(metadata.shell_edition ? { shell_edition: metadata.shell_edition } : {}),
	};
}

function gatewayTranscriptItem(item: TranscriptItem): JsonObject {
	const type = {
		user_message: "user",
		assistant_message: "assistant_final",
		turn_completed: "turn_completed",
		clarification: "clarification",
		reasoning_summary: "reasoning",
		tool: "tool_summary",
		error: "error",
		warning: "warning",
		status: "system_notice",
		file_change: "system_notice",
		plan_update: "plan_update",
		web_search: "web_search",
	}[item.type];
	const metadata: JsonObject = { ...(item.metadata ?? {}) };
	if (item.type === "turn_completed" && item.duration_ms !== undefined) {
		metadata.duration_ms = item.duration_ms;
	}
	if (item.type === "tool") {
		if (item.tool_name) metadata.tool_name = item.tool_name;
		if (item.call_id) metadata.call_id = item.call_id;
		if (item.command) metadata.command = item.command;
		if (item.exit_code !== undefined) metadata.exit_code = item.exit_code;
		if (item.duration_ms !== undefined) metadata.duration_ms = item.duration_ms;
		if (item.truncated) metadata.truncated = true;
		if (item.omitted_chars !== undefined) metadata.omitted_chars = item.omitted_chars;
		if (item.status) {
			metadata.status = item.status === "completed" ? "done" : item.status;
			if (item.status === "completed" && metadata.success === undefined) metadata.success = true;
		}
		if (item.output) metadata.output_preview = item.output;
	}
	if (item.type === "web_search") {
		if (item.call_id) metadata.call_id = item.call_id;
		if (item.status) metadata.status = item.status;
	}
	return {
		id: item.id,
		type,
		text: item.text ?? (item.type === "tool" ? item.tool_name ?? "Tool" : ""),
		created_at: item.created_at ?? "",
		folded: false,
		metadata,
	};
}

function gatewayTranscriptItems(item: TranscriptItem): readonly JsonObject[] {
	const projected = gatewayTranscriptItem(item);
	if (item.type !== "assistant_message") return [projected];
	const proposedPlan = extractProposedPlan(item.text ?? "");
	if (!proposedPlan) return [projected];

	const plan: JsonObject = {
		id: `${item.id}:proposed-plan`,
		type: "proposed_plan",
		text: proposedPlan.planText,
		created_at: item.created_at ?? "",
		folded: false,
		metadata: {
			status: "proposed",
			source: "assistant_message",
		},
	};
	return proposedPlan.assistantText
		? [{ ...projected, text: proposedPlan.assistantText }, plan]
		: [plan];
}

function paginatedTranscript(
	sessionId: string,
	projected: readonly JsonObject[],
	params: JsonObject,
	readOnly = false,
): JsonObject {
	const before = optionalString(params.before);
	const beforeIndex = before
		? projected.findIndex((item) => item.id === before)
		: projected.length;
	const end = beforeIndex < 0 ? projected.length : beforeIndex;
	const limit = positiveInteger(params.limit);
	const selected = limit === undefined
		? projected.slice(0, end)
		: projected.slice(Math.max(0, end - limit), end);
	return {
		session_id: sessionId,
		items: selected,
		next_before: selected.length < end ? selected[0]?.id ?? null : null,
		read_only: readOnly,
	};
}

function shellOutputPagePayload(page: ShellOutputPage): JsonObject {
	return {
		session_id: page.sessionId,
		shell_id: page.shellId,
		...(page.callId ? { call_id: page.callId } : {}),
		chunks: page.chunks.map((chunk) => ({
			sequence: chunk.sequence,
			cursor_start: chunk.cursorStart,
			cursor_end: chunk.cursorEnd,
			omitted_before: chunk.omittedBefore,
			output: chunk.output,
		})),
		next_after_sequence: page.nextAfterSequence,
		available: page.available,
		complete: page.complete,
		omitted_chars: page.omittedChars,
		captured_chars: page.capturedChars,
		output_chars: page.outputChars,
	};
}

function approvalRequest(
	approval: PendingSessionApproval,
	generation: number,
): JsonObject {
	return {
		session_id: approval.sessionId,
		generation,
		client_turn_id: approval.clientTurnId,
		turn_id: approval.turnId,
		decision_id: approval.decisionId,
		call_id: approval.callId,
		preview: approval.preview,
		reason: approval.reason,
		tool_name: approval.toolName,
		action: approval.toolName,
		...approvalPreviewPayload(approval),
		options: approval.options.map((choice) => ({
			choice,
			label: approvalChoiceLabel(choice),
		})),
		...(approval.permissionRequest ? {
			permission_request: permissionRequestJson(approval.permissionRequest),
		} : {}),
	};
}

function clarificationRequest(
	clarification: PendingSessionClarification,
	generation: number,
): JsonObject {
	return {
		session_id: clarification.sessionId,
		generation,
		client_turn_id: clarification.clientTurnId,
		turn_id: clarification.turnId,
		request_id: clarification.requestId,
		tool_id: clarification.callId,
		call_id: clarification.callId,
		tool_name: clarification.toolName,
		question: clarification.question,
		options: clarification.options.map((option) => ({ ...option })),
		header: clarification.header,
		multi_select: clarification.multiSelect,
	};
}

function approvalChoiceLabel(choice: PendingSessionApproval["options"][number]): string {
	return {
		approve_once: "Approve once",
		reject: "Reject",
		allow_session: "Allow for session",
		always_allow: "Always allow",
	}[choice];
}

function isApprovalChoice(value: string): value is PendingSessionApproval["options"][number] {
	return value === "approve_once"
		|| value === "reject"
		|| value === "allow_session"
		|| value === "always_allow";
}

function gatewayQueueItem(item: QueuedInput): JsonObject {
	return {
		queue_id: item.queueId,
		session_id: item.sessionId,
		client_turn_id: item.clientTurnId,
		target_turn_id: item.targetTurnId,
		kind: item.kind,
		state: item.state,
		claim_turn_id: item.claimTurnId ?? null,
		message: item.text,
		text: item.text,
		source: item.source,
		created_at: item.createdAt,
		updated_at: item.updatedAt,
		...(item.imagePaths.length > 0 ? {
			local_images: item.imagePaths.map((path, index) => ({
				path,
				placeholder: `[image #${index + 1}]`,
			})),
		} : {}),
	};
}

function queueMutationResponse(
	mutation: QueueMutation,
	context: SessionGenerationContext,
): JsonObject {
	return {
		accepted: true,
		session_id: context.sessionId,
		generation: context.generation,
		disposition: mutation.disposition,
		record: gatewayQueueItem(mutation.record),
		...queueProjection(mutation.snapshot),
	};
}

function queueEventPayload(
	snapshot: QueueSnapshot,
	context: SessionGenerationContext,
): JsonObject {
	return {
		session_id: snapshot.sessionId,
		generation: context.generation,
		revision: snapshot.revision,
		...queueProjection(snapshot),
	};
}

function queueProjection(snapshot: QueueSnapshot): JsonObject {
	const pending = snapshot.pendingSteers.filter(isVisibleQueueItem);
	const deferred = [...snapshot.rejectedSteers, ...snapshot.followUps].filter(isVisibleQueueItem);
	const hasPendingInput = pending.length + deferred.length > 0;
	return {
		queue_revision: snapshot.revision,
		queue_items: {
			pending_steers: snapshot.pendingSteers.map(gatewayQueueItem),
			rejected_steers: snapshot.rejectedSteers.map(gatewayQueueItem),
			follow_ups: snapshot.followUps.map(gatewayQueueItem),
		},
		steering: pending.map((item) => item.text),
		follow_up: deferred.map((item) => item.text),
		steering_items: pending.map(legacyQueueItem),
		follow_up_items: deferred.map(legacyQueueItem),
		has_pending_input: hasPendingInput,
		steering_count: pending.length,
		follow_up_count: deferred.length,
		activity: {
			kind: hasPendingInput ? "pending_input" : "idle",
			has_pending_input: hasPendingInput,
			steering_count: pending.length,
			follow_up_count: deferred.length,
		},
	};
}

function legacyQueueItem(item: QueuedInput): JsonObject {
	return {
		client_turn_id: item.clientTurnId,
		kind: item.kind === "pending_steer" ? "steering" : item.kind,
		message: item.text,
		text: item.text,
		source: item.source,
		...(item.imagePaths.length > 0 ? {
			local_images: item.imagePaths.map((path, index) => ({
				path,
				placeholder: `[image #${index + 1}]`,
			})),
		} : {}),
	};
}

function legacyMigrationRecord(item: QueuedInput): JsonObject {
	return {
		queue_id: item.queueId,
		kind: item.kind,
		text: item.text,
		...(item.imagePaths.length > 0 ? {
			local_images: item.imagePaths.map((path, index) => ({
				path,
				placeholder: `[image #${index + 1}]`,
			})),
		} : {}),
	};
}

function isVisibleQueueItem(item: QueuedInput): boolean {
	return item.source !== "task_notification" && item.source !== "agent_mailbox";
}

function queueClientTurnId(params: JsonObject, prefix: string): string {
	return optionalString(params.client_turn_id)
		?? optionalString(params.client_user_message_id)
		?? `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function localImagePaths(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new GatewayFailure("invalid_params", "local_images must be an array.");
	}
	return value.map((item) => {
		if (typeof item === "string" && item.trim()) return item;
		if (isObject(item) && typeof item.path === "string" && item.path.trim()) return item.path;
		throw new GatewayFailure("invalid_params", "local_images contains an invalid path.");
	});
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value > 0
		? value
		: undefined;
}

function transcriptPageLimit(value: unknown): number {
	if (value === undefined || value === null) return 500;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 500) {
		throw new GatewayFailure("invalid_params", "limit must be an integer between 1 and 500.");
	}
	return value;
}

function optionalNonNegativeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new GatewayFailure("invalid_params", `${name} must be a non-negative safe integer.`);
	}
	return value;
}

function positiveIntegerParameter(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new GatewayFailure("invalid_params", `${name} must be a positive safe integer.`);
	}
	return value;
}

function permissionProfile(value: unknown): PermissionProfile {
	if (value === "read-only" || value === "workspace" || value === "full-access") {
		return value;
	}
	throw new GatewayFailure("invalid_params", "Unsupported permission profile.");
}

function permissionPayload(
	active: PermissionProfile,
	commandAllowanceCount = 0,
	snapshot?: ExecutionPolicySnapshot,
	readiness?: SandboxReadiness,
): JsonObject {
	const profile = snapshot?.profile ?? nominalExecutionPolicy(active);
	const resolution = snapshot?.resolution;
	const sandboxReadiness = processSandboxRequired(profile)
		? readiness
		: sandboxNotRequired(readiness?.platform);
	return {
		active,
		command_allowance_count: commandAllowanceCount,
		effective: {
			trusted: snapshot?.trusted ?? false,
			valid: snapshot?.valid ?? false,
			sandbox_mode: profile.mode,
			filesystem: profile.filesystem,
			network: profile.network,
			approval_behavior: profile.filesystem === "unrestricted" ? "never" : "on-request",
			source: resolution?.configurationSource ?? "session",
			constrained: resolution?.constraintsSource !== undefined,
			...(resolution?.constraintsSource ? {
				constraints_source: resolution.constraintsSource,
			} : {}),
			readable_roots: profile.readableRoots?.length ?? 0,
			writable_roots: profile.writableRoots.length,
			network_domains: profile.networkDomains?.length ?? 0,
			session_grant: resolution?.sessionGrant !== undefined,
			turn_grant: resolution?.turnGrant !== undefined,
		},
		...(sandboxReadiness ? {
			sandbox_readiness: {
				state: sandboxReadiness.state,
				code: sandboxReadiness.code,
				platform: sandboxReadiness.platform,
				isolation: sandboxReadiness.isolation,
			},
		} : {}),
		profiles: [
			permissionProfileRow(
				"workspace",
				"Ask for approval",
				"Read and edit the current workspace; ask before network or outside access.",
				active,
			),
			permissionProfileRow(
				"full-access",
				"Full Access",
				"Access files and network without approval.",
				active,
			),
			permissionProfileRow(
				"read-only",
				"Read Only",
				"Read workspace files; ask before edits or network.",
				active,
			),
		],
	};
}

function permissionProfileRow(
	id: PermissionProfile,
	label: string,
	description: string,
	active: PermissionProfile,
): JsonObject {
	const policy = nominalExecutionPolicy(id);
	return {
		id,
		label,
		description,
		current: active === id,
		sandbox_mode: policy.mode,
		filesystem: policy.filesystem,
		network: policy.network,
		approval_behavior: policy.filesystem === "unrestricted" ? "never" : "on-request",
	};
}

function nominalExecutionPolicy(active: PermissionProfile): ExecutionPolicySnapshot["profile"] {
	if (active === "read-only") {
		return { mode: "read-only", filesystem: "read_only", network: "disabled", writableRoots: [] };
	}
	if (active === "workspace") {
		return { mode: "workspace-write", filesystem: "workspace_write", network: "disabled", writableRoots: [] };
	}
	return { mode: "danger-full-access", filesystem: "unrestricted", network: "enabled", writableRoots: [] };
}

function processSandboxRequired(profile: ExecutionPolicySnapshot["profile"]): boolean {
	return profile.mode !== "danger-full-access"
		|| profile.network !== "enabled"
		|| profile.networkDomains !== undefined;
}

function extensionManifest(toolNames: readonly string[], toolManifest?: JsonObject): JsonObject {
	return {
		schema_version: 1,
		agent: { name: "mycli", version: MYCLI_VERSION, runtime: "node" },
		rpc_methods: gatewayContractCatalog.rpcMethods.map((name) => ({ name })),
		event_streams: gatewayContractCatalog.eventStreams.map((name) => ({ name })),
		capabilities: {
			no_tool_turns: true,
			tools: toolNames.length > 0,
			tool_names: toolNames,
		},
		...(toolManifest ? { tool_manifest: toolManifest } : {}),
	};
}

function integrationToolManifest(
	integrations: NodeGatewayIntegrations | undefined,
): JsonObject | undefined {
	return typeof integrations?.toolManifest === "function"
		? integrations.toolManifest()
		: integrations?.toolManifest;
}

function integrationDiagnostics(
	integrations: NodeGatewayIntegrations | undefined,
): readonly JsonObject[] {
	return typeof integrations?.diagnostics === "function"
		? integrations.diagnostics()
		: integrations?.diagnostics ?? [];
}

function boundedResource(value: JsonObject): JsonObject {
	const resource: JsonObject = {};
	for (const key of ["id", "type", "name", "source", "status", "detail", "command"] as const) {
		const item = value[key];
		if (typeof item === "string" && item.trim()) {
			resource[key] = boundedString(item.trim(), key === "detail" ? 512 : 256);
		}
	}
	if (typeof value.enabled === "boolean") resource.enabled = value.enabled;
	return resource;
}

interface SettingsSnapshot {
	readonly settings: JsonObject;
	readonly sources: JsonObject;
	readonly keymap: JsonObject;
	readonly terminalCapabilities: JsonObject;
}

function settingsSnapshot(value: JsonObject | undefined): SettingsSnapshot {
	if (!value) {
		return { settings: {}, sources: {}, keymap: {}, terminalCapabilities: {} };
	}
	if (isObject(value.settings)) {
		return {
			settings: { ...value.settings },
			sources: isObject(value.sources) ? { ...value.sources } : {},
			keymap: isObject(value.keymap) ? { ...value.keymap } : {},
			terminalCapabilities: isObject(value.terminal_capabilities)
				? { ...value.terminal_capabilities }
				: {},
		};
	}
	return {
		settings: { ...value },
		sources: {},
		keymap: {},
		terminalCapabilities: {},
	};
}

function userSettingsSources(settings: JsonObject): JsonObject {
	return Object.freeze(Object.fromEntries(Object.keys(settings).map((key) => [key, "user"])));
}

function authoritativeSettingsSources(snapshot: {
	readonly settings: JsonObject;
	readonly sources: JsonObject;
}): JsonObject {
	return Object.keys(snapshot.sources).length > 0
		? snapshot.sources
		: userSettingsSources(snapshot.settings);
}

function shellSettingMutation(params: JsonObject): {
	readonly settingId: string;
	readonly value: string | boolean;
} {
	const settingId = typeof params.setting_id === "string" ? params.setting_id.trim() : "";
	const item = shellSettingDescriptor(settingId);
	if (!item) {
		throw new GatewayFailure("invalid_params", "A supported TUI setting is required.");
	}
	let value = params.value;
	if (item.valueKind === "boolean" && typeof value === "string") {
		value = value === "true" ? true : value === "false" ? false : value;
	}
	if ((typeof value !== "string" && typeof value !== "boolean")
		|| !item.allowedValues.includes(value)) {
		throw new GatewayFailure("invalid_params", "A supported TUI setting value is required.");
	}
	return { settingId: item.key, value };
}

function settingsSources(value: JsonObject): Record<string, "default" | "user"> {
	return Object.fromEntries(Object.entries(value).flatMap(([key, source]) =>
		source === "user" || source === "default" ? [[key, source]] : []));
}

function boundedSubagent(
	value: Readonly<Record<string, unknown>>,
): JsonObject | undefined {
	const runId = boundedRequiredValue(value.run_id, 256);
	const childSessionId = boundedRequiredValue(value.child_session_id, 256);
	const role = boundedRequiredValue(value.role, 64);
	const status = boundedRequiredValue(value.status, 32);
	const summary = boundedRequiredValue(value.summary, 512);
	if (!runId || !childSessionId || !role || !status || !summary) return undefined;
	const progress = Array.isArray(value.progress)
		? value.progress.slice(0, 32).flatMap((item) => {
			if (!isObject(item)) return [];
			const kind = boundedRequiredValue(item.kind, 64);
			if (!kind) return [];
			return [{
				kind,
				...(boundedOptionalValue(item.tool_name, 128) ? {
					tool_name: boundedOptionalValue(item.tool_name, 128),
				} : {}),
					...(boundedOptionalValue(item.summary, 512) ? {
						summary: boundedOptionalValue(item.summary, 512),
					} : {}),
					...(boundedOptionalValue(item.call_id, 256) ? {
						call_id: boundedOptionalValue(item.call_id, 256),
					} : {}),
					...(boundedOptionalValue(item.status, 32) ? {
						status: boundedOptionalValue(item.status, 32),
					} : {}),
				}];
		})
		: [];
	return {
		run_id: runId,
		child_session_id: childSessionId,
		role,
		status,
		summary,
		progress,
		...boundedSubagentStrings(value),
		...(boundedNonNegativeInteger(value.tool_calls) === undefined ? {} : {
			tool_calls: boundedNonNegativeInteger(value.tool_calls),
		}),
		...(boundedNonNegativeInteger(value.total_tokens) === undefined ? {} : {
			total_tokens: boundedNonNegativeInteger(value.total_tokens),
		}),
		...(boundedNonNegativeInteger(value.duration_ms) === undefined ? {} : {
			duration_ms: boundedNonNegativeInteger(value.duration_ms),
		}),
	};
}

function boundedSubagentStrings(value: Readonly<Record<string, unknown>>): JsonObject {
	const result: JsonObject = {};
	for (const [key, limit] of [
		["parent_turn_id", 256],
		["thread_id", 256],
		["root_thread_id", 256],
		["parent_thread_id", 256],
		["agent_path", 512],
		["task_name", 64],
		["nickname", 64],
		["lifecycle_kind", 64],
		["description", 2_048],
		["mode", 32],
		["error", 4_096],
		["started_at", 64],
		["completed_at", 64],
		["path", 256],
	] as const) {
		const bounded = boundedOptionalValue(value[key], limit);
		if (bounded) result[key] = bounded;
	}
	return result;
}

function boundedNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function boundedRequiredValue(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value.trim()
		? boundedString(value.trim(), limit)
		: undefined;
}

function boundedOptionalValue(value: unknown, limit: number): string | undefined {
	return boundedRequiredValue(value, limit);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new GatewayFailure("invalid_params", `${name} is required.`);
	}
	return value;
}

function slashCommandSurface(value: unknown): SlashCommandSurface {
	if (value === "cli" || value === "tui") return value;
	throw new GatewayFailure("invalid_params", "surface must be cli or tui.");
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalBoundedIdentity(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") {
		throw new GatewayFailure("invalid_params", `${name} must be a string.`);
	}
	const normalized = value.trim();
	if (!normalized || normalized.length > 512 || /[\r\n\0]/u.test(normalized)) {
		throw new GatewayFailure("invalid_params", `${name} is invalid.`);
	}
	return normalized;
}

function sessionQueryFromParams(params: JsonObject): SessionQuery {
	const workspaceRoot = optionalBoundedIdentity(params.workspace_root, "workspace_root");
	const search = optionalBoundedIdentity(params.search, "search");
	const model = optionalBoundedIdentity(params.model, "model");
	const collaborationMode = collaborationModeParameter(params.collaboration_mode);
	const permission = params.permission_profile === undefined
		? undefined
		: permissionProfile(params.permission_profile);
	const lifecycleStatus = optionalSessionLifecycleStatus(params.status);
	const limit = params.limit === undefined ? 50 : integerValue(params.limit);
	if (limit === undefined || limit < 1 || limit > 200) {
		throw new GatewayFailure("invalid_params", "session list limit must be between 1 and 200.");
	}
	return Object.freeze({
		...(workspaceRoot ? { workspaceRoot } : {}),
		...(search ? { search } : {}),
		...(model ? { model } : {}),
		...(collaborationMode ? { collaborationMode } : {}),
		...(permission ? { permissionProfile: permission } : {}),
		...(lifecycleStatus ? { lifecycleStatus } : {}),
		includeArchived: params.include_archived === true,
		includeDeleted: params.include_deleted === true,
		limit,
	});
}

function sessionSummaryPayload(summary: SessionSummary, activeSessionId?: string): JsonObject {
	return {
		version: summary.version,
		id: summary.id,
		...(summary.title ? { title: summary.title } : {}),
		workspace: summary.cwd,
		workspace_root: summary.cwd,
		cwd: summary.cwd,
		created: summary.createdAt,
		created_at: summary.createdAt,
		updated: summary.updatedAt,
		updated_at: summary.updatedAt,
		last_active: summary.lastActiveAt,
		modified: summary.lastActiveAt,
		model: summary.model,
		provider: summary.provider,
		reasoning_effort: summary.reasoningEffort,
		collaboration_mode: summary.collaborationMode,
		permission_profile: summary.permissionProfile,
		status: summary.lifecycleStatus,
		storage_status: summary.storageStatus,
		lock_state: summary.leaseState,
		pending_state: summary.pendingState,
		message_count: summary.messageCount,
		summary_count: summary.summaryCount,
		metadata_revision: summary.metadataRevision,
		...(summary.parentId ? { parent_session_id: summary.parentId } : {}),
		...(summary.forkPoint === undefined ? {} : { fork_point: summary.forkPoint }),
		...(summary.preferenceIssue ? { preference_issue: summary.preferenceIssue } : {}),
		...(summary.metadataIssue ? { metadata_issue: summary.metadataIssue } : {}),
		...(activeSessionId ? { current: summary.id === activeSessionId } : {}),
	};
}

function resumeRepairPreviewPayload(preview: ResumeRepairPreview): JsonObject {
	return {
		version: preview.version,
		session: sessionSummaryPayload(preview.session),
		ready: preview.ready,
		requires_confirmation: preview.requiresConfirmation,
		issues: preview.issues.map((item) => ({
			code: item.code,
			blocking: item.blocking,
			message: item.message,
			...(item.action ? { action: item.action } : {}),
		})),
		actions: [...preview.actions],
	};
}

function resumePreviewAfterConfirmedAction(
	preview: ResumeRepairPreview,
	action: ResumeRepairAction,
): ResumeRepairPreview {
	if (action !== "takeover_stale_owner") return preview;
	const issues = preview.issues.filter((item) => item.code !== "stale_owner");
	return Object.freeze({
		...preview,
		ready: !issues.some((item) => item.blocking),
		requiresConfirmation: issues.some((item) => item.blocking && item.action !== undefined),
		issues: Object.freeze(issues),
		actions: Object.freeze(preview.actions.filter((item) => item !== action)),
	});
}

function optionalSessionLifecycleStatus(value: unknown): SessionQuery["lifecycleStatus"] {
	if (value === undefined || value === null || value === "") return undefined;
	if (value === "active" || value === "archived" || value === "deleted"
		|| value === "waiting_approval" || value === "waiting_clarification"
		|| value === "interrupted") return value;
	throw new GatewayFailure("invalid_params", "session status is invalid.");
}

function isResumeRepairAction(value: string): value is ResumeRepairAction {
	return value === "takeover_stale_owner"
		|| value === "unarchive"
		|| value === "fork_with_current_settings";
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function credentialReadinessPayload(
	readiness: NodeGatewayCredentialReadiness,
): JsonObject {
	return {
		ready: readiness.ready,
		provider_id: boundedString(readiness.providerId.replace(/[\r\n\0]/gu, ""), 256),
		auth_ref: boundedString(readiness.authRef.replace(/[\r\n\0]/gu, ""), 512),
		source: readiness.source,
	};
}

function collaborationModeParameter(value: unknown): "default" | "plan" | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (value === "default" || value === "plan") return value;
	throw new GatewayFailure(
		"invalid_params",
		"collaboration_mode must be default or plan.",
	);
}

function isInteractiveRequestMethod(method: string): method is InteractiveRequestMethod {
	return method === "approval.request" || method === "clarify.request";
}

function isInteractiveResponseMethod(method: string): method is InteractiveResponseMethod {
	return method === "approval.respond" || method === "clarify.respond";
}

function interactiveRequestIdentity(method: InteractiveRequestMethod, params: JsonObject): string {
	const requestId = method === "approval.request"
		? optionalString(params.decision_id)
		: optionalString(params.request_id);
	const sessionId = optionalString(params.session_id)
		?? optionalString(params.child_session_id)
		?? "";
	const generation = positiveInteger(params.generation) ?? 0;
	return `${method}\u0000${sessionId}\u0000${generation}\u0000${requestId ?? ""}`;
}

function interactiveResponseMatchesRequest(request: JsonObject, response: JsonObject): boolean {
	const requestId = optionalString(request.decision_id) ?? optionalString(request.request_id);
	const responseId = optionalString(response.decision_id) ?? optionalString(response.request_id);
	if (!requestId || requestId !== responseId) return false;
	const requestSessionId = optionalString(request.session_id) ?? optionalString(request.child_session_id);
	const responseSessionId = optionalString(response.session_id) ?? optionalString(response.child_session_id);
	if (requestSessionId && responseSessionId && requestSessionId !== responseSessionId) return false;
	const requestGeneration = positiveInteger(request.generation);
	const responseGeneration = positiveInteger(response.generation);
	return requestGeneration === undefined
		|| responseGeneration === undefined
		|| requestGeneration === responseGeneration;
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (
		value === "none"
		|| value === "minimal"
		|| value === "low"
		|| value === "medium"
		|| value === "high"
		|| value === "xhigh"
		|| value === "max"
		|| value === "ultra"
	) {
		return value;
	}
	throw new GatewayFailure("invalid_params", "Unsupported reasoning_effort.");
}

function workspaceTrustState(value: unknown): WorkspaceTrustState {
	if (value === "trusted" || value === "untrusted" || value === "unknown") {
		return value;
	}
	throw new GatewayFailure(
		"invalid_params",
		"state must be trusted, untrusted, or unknown.",
	);
}

function stringArray(value: unknown, name: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new GatewayFailure("invalid_params", `${name} must be an array of strings.`);
	}
	return value;
}

function statusPayload(state: string, clientTurnId: string, message?: string): JsonObject {
	return {
		state,
		kind: state,
		text: state === "running"
			? "Running"
			: state === "waiting_approval"
				? "Waiting approval"
				: state === "waiting_clarification"
					? "Waiting clarification"
				: state === "completed"
					? "Completed"
					: state === "interrupted"
						? "Interrupted"
						: "Failed",
		client_turn_id: clientTurnId,
		...(message ? { message } : {}),
	};
}

function isTurnOwnershipEvent(method: string): boolean {
	return method === "turn.started"
		|| method === "turn.completed"
		|| method === "turn.failed"
		|| method === "turn.interrupted"
		|| method === "turn.status"
		|| method === "status.update";
}

function aggregateUsage(rollouts: readonly JsonObject[]): Readonly<Record<string, number>> {
	const totals: Record<string, number> = { turns: rollouts.length };
	for (const rollout of rollouts) {
		const continuation = isObject(rollout.continuation_state)
			? rollout.continuation_state
			: undefined;
		const usage = continuation && isObject(continuation.usage) ? continuation.usage : undefined;
		if (!usage) continue;
		for (const [key, value] of Object.entries(usage)) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
			totals[key.slice(0, 64)] = (totals[key.slice(0, 64)] ?? 0) + value;
		}
	}
	return totals;
}

function nonNegativeMetric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function contextWindowFromUsage(
	usage: ProviderUsage,
	maxTokens: number,
	source: "provider_live",
): NonNullable<ActiveTurn["contextWindow"]> {
	const inputTokens = nonNegativeMetric(usage.input_tokens ?? usage.inputTokens);
	const totalTokens = nonNegativeMetric(usage.total_tokens ?? usage.totalTokens);
	return Object.freeze({
		usedTokens: inputTokens > 0 ? inputTokens : totalTokens,
		maxTokens,
		source,
	});
}

function contextWindowPayload(usedTokens: number, maxTokens: number, source: string): JsonObject {
	return {
		used_tokens: usedTokens,
		max_tokens: maxTokens,
		usage_ratio: maxTokens > 0 ? usedTokens / maxTokens : 0,
		source,
	};
}

function humanize(value: string): string {
	const normalized = value.replaceAll(/[-_]+/gu, " ").trim();
	return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Value";
}

function parseForkArguments(args: string, currentSessionId: string): {
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly forkPoint?: number;
} {
	const parts = shellWords(args);
	if (parts.length > 3) throw new Error("too many fork arguments");
	const sourceSessionId = parts.length >= 2 ? parts[0]! : currentSessionId;
	const targetSessionId = parts.length === 0
		? `${currentSessionId}-fork`
		: parts.length === 1
			? parts[0]!
			: parts[1]!;
	if ([sourceSessionId, targetSessionId].some((value) =>
		!value || value.length > 256 || value.includes("\0"))) {
		throw new Error("invalid session id");
	}
	if (parts.length < 3) return { sourceSessionId, targetSessionId };
	const forkPoint = Number(parts[2]);
	if (!Number.isSafeInteger(forkPoint) || forkPoint < 0 || String(forkPoint) !== parts[2]) {
		throw new Error("invalid fork point");
	}
	return { sourceSessionId, targetSessionId, forkPoint };
}

function shellWords(value: string): readonly string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of value.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (escaped || quote) throw new Error("unterminated shell word");
	if (current) words.push(current);
	return words;
}

function sessionMaintenanceAction(
	value: string,
): "report" | "empty" | "payloads" | "orphans" | "vacuum" | "transcript_normalization"
	| "content_blobs" | "content_blob_gc" | undefined {
	return {
		"": "report" as const,
		"--apply-empty": "empty" as const,
		"--apply-payloads": "payloads" as const,
		"--apply-orphans": "orphans" as const,
		"--apply-vacuum": "vacuum" as const,
		"--apply-transcript-normalization": "transcript_normalization" as const,
		"--apply-content-blobs": "content_blobs" as const,
		"--apply-content-blob-gc": "content_blob_gc" as const,
	}[value];
}

function commandObjectRows(value: JsonObject): readonly {
	readonly key: string;
	readonly label: string;
	readonly values: readonly string[];
}[] {
	return Object.entries(value).slice(0, 100).map(([key, item]) => ({
		key,
		label: humanize(key),
		values: [commandPrimitiveValue(item)],
	}));
}

function commandObjectSummary(value: JsonObject): string {
	return Object.entries(value).slice(0, 20)
		.map(([key, item]) => `${key}=${commandPrimitiveValue(item)}`)
		.join("; ") || "completed";
}

function commandPrimitiveValue(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 512);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	if (Array.isArray(value)) return `items:${value.length}`;
	if (isObject(value)) return `fields:${Object.keys(value).length}`;
	return "unknown";
}

function parseModelSelection(args: string): {
	readonly model?: string;
	readonly reasoningEffort?: ReasoningEffort;
} {
	const parts = args.trim() ? args.trim().split(/\s+/u) : [];
	let model: string | undefined;
	let reasoningEffort: ReasoningEffort | undefined;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index]!;
		if (part === "--thinking-effort") {
			const value = parts[index + 1];
			if (!value) throw new GatewayFailure("invalid_arguments", "--thinking-effort requires a value.");
			reasoningEffort = reasoningEffortValue(value);
			index += 1;
			continue;
		}
		if (part.startsWith("--thinking-effort=")) {
			reasoningEffort = reasoningEffortValue(part.slice("--thinking-effort=".length));
			continue;
		}
		if (part.startsWith("--")) {
			throw new GatewayFailure("invalid_arguments", `Unsupported model option: ${part}`);
		}
		if (model) throw new GatewayFailure("invalid_arguments", "Only one model may be selected.");
		model = part.slice(0, 256);
	}
	return {
		...(model ? { model } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
	};
}

function reasoningEffortValue(value: string): ReasoningEffort {
	if (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)) {
		return value as ReasoningEffort;
	}
	throw new GatewayFailure("invalid_arguments", "Unsupported thinking effort.");
}

function modelSelectionScope(value: unknown): ModelSelectionScope {
	if (value === undefined) return "session";
	if (isModelSelectionScope(value)) return value;
	throw new GatewayFailure("invalid_params", "Model selection scope is not supported.");
}

function sameModelCatalogIdentity(left: JsonObject, right: JsonObject): boolean {
	return left.provider === right.provider
		&& left.protocol === right.protocol
		&& left.model === right.model
		&& left.base_url === right.base_url;
}

function requestedSandboxMode(
	value: string,
	currentPermission: PermissionProfile,
): "read-only" | "workspace-write" | "danger-full-access" {
	const current = sandboxForPermission(currentPermission);
	if (!value) return current;
	if (value === "next") {
		return current === "read-only"
			? "workspace-write"
			: current === "workspace-write"
				? "danger-full-access"
				: "read-only";
	}
	if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
		return value;
	}
	throw new GatewayFailure("invalid_arguments", "Unsupported sandbox mode.");
}

function sandboxForPermission(
	value: PermissionProfile,
): "read-only" | "workspace-write" | "danger-full-access" {
	return value === "read-only"
		? "read-only"
		: value === "workspace"
			? "workspace-write"
			: "danger-full-access";
}

function permissionForSandbox(
	value: "read-only" | "workspace-write" | "danger-full-access",
): PermissionProfile {
	return value === "read-only" ? "read-only" : value === "workspace-write" ? "workspace" : "full-access";
}

function memoryRows(memories: readonly JsonObject[]): readonly {
	readonly key: string;
	readonly label: string;
	readonly values: readonly string[];
	readonly status?: string;
	readonly detail?: string;
}[] {
	return memories.slice(0, 100).map((memory, index) => ({
		key: `memory:${index}:${String(memory.filename ?? "entry")}`,
		label: String(memory.name ?? memory.filename ?? "Memory"),
		values: [String(memory.filename ?? "")].filter(Boolean),
		...(typeof memory.kind === "string" ? { status: memory.kind } : {}),
		...(typeof memory.description === "string" && memory.description
			? { detail: memory.description }
			: {}),
	}));
}

function parseMemoryAdd(value: string): {
	readonly kind: "user" | "feedback" | "project" | "reference";
	readonly name: string;
	readonly description: string;
	readonly content: string;
} {
	const separator = value.indexOf("::");
	if (separator < 0) {
		throw new GatewayFailure("invalid_arguments", "Use /memory add <type> <name> :: <content>.");
	}
	const header = value.slice(0, separator).trim();
	const content = value.slice(separator + 2).trim();
	const [rawKind, ...nameParts] = header.split(/\s+/u);
	const name = nameParts.join(" ").trim();
	if (!isMemoryKind(rawKind) || !name || !content) {
		throw new GatewayFailure("invalid_arguments", "Use /memory add <type> <name> :: <content>.");
	}
	return { kind: rawKind, name, description: name, content };
}

function isMemoryKind(value: string | undefined): value is "user" | "feedback" | "project" | "reference" {
	return value === "user" || value === "feedback" || value === "project" || value === "reference";
}

function requiredCommandPattern(value: string): string {
	const pattern = value.trim();
	if (!pattern || pattern.length > 512 || pattern.includes("\0")) {
		throw new GatewayFailure("invalid_arguments", "Command pattern is invalid.");
	}
	return pattern;
}

function terminalStatus(
	state: "completed" | "failed" | "interrupted",
	active: ActiveTurn,
	text: string,
	message?: string,
): JsonObject {
	return {
		state,
		kind: state,
		text,
		terminal: true,
		client_turn_id: active.clientTurnId,
		turn_id: active.turnId ?? active.clientTurnId,
		...(message ? { message } : {}),
	};
}

function waitingStatus(
	state: "waiting_approval" | "waiting_clarification",
	active: ActiveTurn,
	text: string,
): JsonObject {
	return {
		state,
		kind: state,
		text,
		terminal: false,
		client_turn_id: active.clientTurnId,
		turn_id: active.turnId ?? active.clientTurnId,
	};
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberRecord(value: JsonObject): Readonly<Record<string, number>> {
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
	);
}

const SAFE_TOOL_METADATA_KEYS = new Set([
	"actualEndLine",
	"actualStartLine",
	"columns",
	"dedup",
	"effectiveLimit",
	"limitClamped",
	"nextOffset",
	"offset",
	"requestedLimit",
	"rows",
	"shownLines",
	"totalLines",
	"truncated",
]);

function safeToolMetadata(
	metadata: Readonly<Record<string, unknown>>,
	success: boolean,
): JsonObject {
	const safe: JsonObject = {};
	const skillName = skillNameFromMetadata(metadata);
	if (skillName) safe.skill_name = skillName;
	const mutation = projectMutationMetadata(metadata, success);
	if (mutation.path) safe.path = mutation.path;
	if (mutation.status) safe.status = mutation.status;
	if (mutation.matches !== undefined) safe.matches = mutation.matches;
	if (mutation.file_changes) safe.file_changes = mutation.file_changes;
	for (const [key, value] of Object.entries(metadata)) {
		if (key === "path" || key === "status" || key === "matches") continue;
		if (!SAFE_TOOL_METADATA_KEYS.has(key)) continue;
		if (typeof value === "boolean") safe[key] = value;
		if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
	}
	return safe;
}

function skillNameFromMetadata(metadata: Readonly<Record<string, unknown>>): string | undefined {
	if (!isObject(metadata.skillInvocationArtifact)) return undefined;
	const name = metadata.skillInvocationArtifact.name;
	return typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name)
		? name
		: undefined;
}

function toolLifecycleId(callId: string, toolName: string): string {
	return callId || `builtin:${toolName}`.slice(0, 256);
}

function webSearchLifecycleId(callId: string): string {
	return `web-search:${callId}`;
}

function webSearchActionDetail(action: WebSearchAction): string {
	switch (action.type) {
		case "search": {
			const query = action.query ?? action.queries?.[0] ?? "";
			return !action.query && (action.queries?.length ?? 0) > 1 && query
				? `${query} ...`
				: query;
		}
		case "open_page":
			return action.url ?? "";
		case "find_in_page":
			return action.pattern && action.url
				? `'${action.pattern}' in ${action.url}`
				: action.pattern
					? `'${action.pattern}'`
					: action.url ?? "";
		case "other":
			return "";
	}
}

function boundedDurationMs(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(86_400_000, Math.max(0, Math.round(value)));
}

function completedTurnDurationMs(turn: RuntimeTurnRecord): number | undefined {
	if (turn.completed_at === null) return undefined;
	const startedAt = Date.parse(turn.started_at);
	const completedAt = Date.parse(turn.completed_at);
	if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
		return undefined;
	}
	return boundedDurationMs(completedAt - startedAt);
}

async function settlesWithin(task: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			task.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function boundedString(value: string, limit: number): string {
	return value.slice(0, limit);
}
