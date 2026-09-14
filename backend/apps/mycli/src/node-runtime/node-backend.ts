import { GatewayFailure } from "./node-gateway-errors.ts";
import { loadGitWorkspaceDiff, repositoryInitPrompt, prepareInteractiveReview, workspaceWorkflowFailure } from "./workspace-slash-workflows.ts";
import { SelectedSkillContext } from "./selected-skill-context.ts";
import { randomUUID } from "node:crypto";
import { PluginCatalogService } from "@mycli/integrations";
import { McpElicitationBroker } from "./mcp-elicitation-broker.ts";
import type { GatewayTransport, JsonObject } from "@mycli/gateway";
import { GitReviewReadTool } from "../review/git-read-tool.ts";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	isModelSelectionScope,
	type ModelSelectionScope,
	type RuntimeTurnRecord,
} from "@mycli/contracts";
import {
	CachedUpdateService,
	detectTerminalCapabilities,
	ExecPolicyStore,
	loadManagedExecutionPolicy,
	modelInputTokenLimit,
	parseConfigProfileName,
	parseProtocol,
	readApiKey,
	readProviderCredential,
	resolveConfig,
	resolveProviderProfile,
	resolveShellSettingsState,
	resolveTerminalCapabilities,
	resetTuiKeymap,
	saveShellSetting,
	saveShellSettings,
	writeApiKey,
	writeUserProviderConfig,
	WorkspaceTrustStore,
} from "@mycli/config";
import type {
	ConfigProfileName,
	DetectedTerminalCapabilities,
	LoadedShellSettings,
	NodeRuntimeConfig,
	ResolveConfigOptions,
	WorkspaceTrustState,
} from "@mycli/config";
import type {
	AgentBudget,
	AgentBudgetExhaustionKind,
	AgentCanonicalEvent,
	AgentExecutionPolicySnapshot,
	AgentProviderSnapshot,
	QueueSnapshot,
	ReasoningEffort,
	ProviderRequest,
	RuntimeEvent,
	ShellLifecycleEvent,
} from "@mycli/core";
import {
	agentThreadId,
	isProviderId,
	modelInputSha256,
	narrowAgentExecutionPolicy,
	parseProviderRouteId,
	rootAgentPath,
} from "@mycli/core";
import {
	IntegrationToolApprovalStore,
	skillInvocationArtifactFromMetadata,
	ListMcpResourcesTool,
	ReadMcpResourceTool,
	ListMcpResourceTemplatesTool,
	type IntegrationRegistration,
	type ChildRuntimeCreateInput,
	type ChildRuntimeEvent,
	type ChildRuntimeFactory,
	type ChildRuntimeHandle,
	type WaitAgentActivityContract,
	type WaitAgentActivityInput,
} from "@mycli/integrations";
import {
	ProviderRegistry,
	captureProviderNativeEnvironment,
	resolveProviderNativeTransport,
	type ProviderRouteDescriptor,
} from "@mycli/providers";
import {
	ApprovalContinuationCoordinator,
	ParallelApprovalCoordinator,
	AgentActivityBus,
	AgentMailbox,
	AgentSupervisor,
	AgentWorkerPool,
	ClarificationContinuationCoordinator,
	CompactionCoordinator,
	ContextItemCoordinator,
	ExecutionPolicyCoordinator,
	MemoryContextService,
	MemoryStore,
	NodeTurnRuntime,
	planExtensionToolExposure,
	resolveAgentExecutionAdapters,
	loadWorkspaceInstructions,
	ProviderContinuationCoordinator,
	QueueCoordinator,
	SessionCoordinator,
	SessionTransitionError,
	ShellLifecycleProjector,
	summarizeCompactionWithProvider,
	CompactionModelJournal,
	TokenCounter,
	toolExposureForSnapshot,
	WorkerLeasedAgentThreadRuntimeFactory,
	WorkerLeasedRootTurnRuntime,
} from "@mycli/runtime";
import type {
	ExecutionPolicyConstraints,
	ExecutionPolicySnapshot,
	NodeTurnRuntimeOptions,
	PreparedSession,
	RunExecutionSnapshot,
} from "@mycli/runtime";
import {
	SessionArtifactStore,
	SnapshotStateError,
	openRuntimeSessionStore,
	TranscriptSnapshotStore,
} from "@mycli/storage";
import type {
	AgentThreadRecord,
	SubagentTaskRecord,
} from "@mycli/storage";
import {
	ApprovalPolicy,
	AskUserQuestionTool,
	BashOutputTool,
	BashTool,
	builtinToolManifest,
	createToolSearchDefinition,
	EditTool,
	FileHistoryStore,
	FileMutationRuntime,
	FileSnapshotStore,
	inspectSandboxReadiness,
	PatchTool,
	planToolExposure,
	parseShellCommand,
	ReadTool,
	RequestPermissionsTool,
	resolveShellProfile,
	ShellOutputTool,
	ShellSessionManager,
	ShellTool,
	startNodePtyTransport,
	startPipeTransport,
	ToolRouter,
	ExtensionToolCatalog,
	type ExtensionCatalogTool,
	ToolSearchTool,
	ViewImageTool,
	KillShellTool,
	type BuiltInToolManifest,
	type CombinedToolManifest,
	type DeferredToolCandidate,
	type PermissionProfile,
	type ToolAdapter,
	UpdatePlanTool,
	WebFetchTool,
	loadLocalImages,
	WriteStdinTool,
	WriteTool,
} from "@mycli/tools";
import type { ToolDefinition } from "@mycli/core";
import { loadRuntimeIntegrationConfiguration } from "./integration-configuration.ts";
import { captureChildIntegrationAuthority, inheritedIntegrationRegistrations } from "./child-integration-authority.ts";
import { createRuntimeSubagentServices } from "./runtime-subagent-services.ts";
import {
	createRuntimeIntegrationComposition,
	partitionRuntimeToolRegistrations,
	type IntegrationCommandService,
	type RuntimeIntegrationComposition,
	type CreateRuntimeIntegrationCompositionOptions,
} from "./integration-composition.ts";
import {
	createNodeGateway,
	type NodeGatewayCredentialReadiness,
	type NodeGatewayIntegrationCommands,
	type NodeGatewayIntegrations,
	type NodeGatewayRuntime,
} from "./node-gateway.ts";
import { AgentInteractiveRequestBroker } from "./agent-interactive-requests.ts";
import { resolveSessionInstructionSnapshot } from "./instruction-snapshot.ts";
import {
	StartupProfiler,
	startupProfileEnabled,
	type StartupProfileSnapshot,
} from "./startup-profile.ts";
import { packagedSystemPrompt } from "./system-prompt.ts";
import { resolveAgentWorkerSettings } from "./agent-worker-settings.ts";
import {
	projectReadableSessionTranscriptPage,
} from "./readable-session-transcript.ts";
import {
	cutoverTranscriptNormalization,
	prepareTranscriptNormalization,
	transcriptNormalizationFailure,
	transcriptNormalizationReport,
} from "./transcript-normalization-maintenance.ts";
import {
	contentBlobMigrationFailure,
	contentBlobMigrationReport,
	cutoverContentBlobMigration,
	prepareContentBlobMigration,
} from "./content-blob-maintenance.ts";
import {
	loadSessionPreferences,
	sameSessionPreferences,
	saveSessionPreferences,
	sessionPreferencesFromConfig,
	type SessionPreferences,
} from "./session-preferences.ts";
import { SessionService } from "./session-service.ts";
import {
	applyProviderScopedModelConfig,
	findProviderScopedModelEntry,
	providerScopedModelPayload,
	ProviderModelDirectory,
	type ProviderModelDirectorySnapshot,
} from "./provider-model-directory.ts";
import { authProviderPayload, providerCredentialReadiness } from "./provider-credentials.ts";
import { MYCLI_PACKAGE_NAME, MYCLI_VERSION } from "../version.ts";
import { NodeRuntimeRegistry } from "./node-runtime-registry.ts";
import {
	NodeBackendResourceOwner,
	SerializedSessionArtifactQueue,
} from "./node-runtime-resources.ts";
import {
	appendNodeTrace,
	elapsedIsoMs,
	elapsedMonotonicMs,
	nodeLogRows,
	nodeTraceRows,
	runtimeDiagnosticTraceEvent,
	tryAppendNodeTrace,
} from "./node-runtime-trace.ts";
import {
	canonicalSnapshot,
	canonicalTranscript,
	emptyQueue,
	hasCode,
	isTerminalSubagentStatus,
	listSessionsWithVirtualInitial,
	loadApprovalState,
	loadQueue,
	loadResponsesContinuation,
	prepareStoredSession,
	projectCanonicalAgentEvent,
	publishCanonicalSubagentEvent,
	terminalSubagentOutput,
	virtualSession,
} from "./node-session-bootstrap.ts";

export interface NodeBackend {
	readonly transport: GatewayTransport;
	readonly completion: Promise<number>;
	close(): Promise<void>;
	kill(): void;
	diagnostic(): string;
	startupProfile?(): StartupProfileSnapshot | undefined;
}

interface RecoverInterruptedTurnOptions {
	readonly sessionId: string;
	readonly turnId: string;
	readonly inputRolledBack?: boolean;
	readonly userInitiated: boolean;
}

export interface StartNodeBackendOptions {
	readonly signal?: AbortSignal;
	readonly approvalMode?: "live" | "suspend";
	readonly executionMode?: "review";
	readonly reviewRevision?: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly args: readonly string[];
	readonly sessionOwnerId?: string;
	readonly maxOutputTokens?: number;
	readonly recoverInterruptedTurns?: readonly RecoverInterruptedTurnOptions[];
	readonly updateFetch?: typeof fetch;
	readonly agentWorkerReadProcessRssBytes?: () => number;
}

type ComposedNodeRuntime = NodeGatewayRuntime & Pick<
	NodeTurnRuntime,
	"bindProviderStepExecutor"
> & {
	readonly integrations: RuntimeIntegrationComposition;
	readonly workspaceRoot: string;
	toolNames(): readonly string[];
	closeExtensions(): Promise<void>;
};

const DEFAULT_AGENT_MAX_RESIDENTS = 4;
const DEFAULT_AGENT_MAX_DEPTH = 1;
const DEFAULT_AGENT_WORKER_INTERRUPT_TIMEOUT_MS = 12_000;
const DEFAULT_PERMISSION_PROFILE: PermissionProfile = "workspace";
const PROVIDER_CONNECTIVITY_TIMEOUT_MS = 15_000;
const MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS = 4_096;

export async function startNodeBackend(options: StartNodeBackendOptions): Promise<NodeBackend> {
	const startupProfiler = new StartupProfiler({
		enabled: startupProfileEnabled(options.env),
		scope: "backend",
		origin: 0,
	});
	startupProfiler.mark("runtime_entered");
	const runtimeArguments = parseRuntimeArguments(options.args);
	const overrides = runtimeArguments.overrides;
	const profileInput = runtimeArguments.configProfile
		? { configProfile: runtimeArguments.configProfile }
		: {};
	const agentExecutionAdapters = resolveAgentExecutionAdapters(options.env);
	const agentWorkerSettings = resolveAgentWorkerSettings(options.env);
	const detectedTerminalCapabilities = detectTerminalCapabilities(options.env);
	const homeDir = runtimeHome(options.env);
	const managedExecutionPolicy = await loadManagedExecutionPolicy({ homeDir });
	const sandboxReadinessPromise = inspectSandboxReadiness();
	const workspaceTrustStore = new WorkspaceTrustStore({ homeDir });
	const providerModelDirectory = new ProviderModelDirectory({ homeDir });
	const resolveWorkspaceModelRuntimeConfig = async (
		input: ResolveConfigOptions,
		workspaceTrust?: WorkspaceTrustState,
	): Promise<NodeRuntimeConfig> => resolveConfig({
		...input,
		...profileInput,
		workspaceTrust: workspaceTrust ?? await workspaceTrustStore.load(input.workspaceRoot),
	});
	const resolveWorkspaceShellSettings = async (workspaceRoot: string) => (
		resolveShellSettingsState({
			homeDir,
			workspaceRoot,
			env: options.env,
			...profileInput,
			workspaceTrust: await workspaceTrustStore.load(workspaceRoot),
		})
	);
	let startupTrustState = await workspaceTrustStore.load(options.cwd);
	let config = await resolveWorkspaceModelRuntimeConfig({
		homeDir,
		workspaceRoot: options.cwd,
		env: options.env,
		overrides,
		...profileInput,
	}, startupTrustState);
	for (const recovery of options.recoverInterruptedTurns ?? []) {
		if (recovery.sessionId !== config.sessionId) {
			throw new Error("recovered_interrupt_session_mismatch");
		}
	}
	const store = openRuntimeSessionStore({
		dbPath: config.sessionsDbPath,
		...(options.sessionOwnerId ? { ownerId: options.sessionOwnerId } : {}),
	});
	let recoveredInterrupts: readonly {
		readonly record: RuntimeTurnRecord;
		readonly inputRolledBack: boolean;
	}[];
	try {
		store.acquireSessionLease(config.sessionId);
		const persisted = store.loadSession(config.sessionId);
		if (persisted && persisted.workspaceRoot !== config.workspaceRoot) {
			startupTrustState = await workspaceTrustStore.load(persisted.workspaceRoot);
			config = await resolveWorkspaceModelRuntimeConfig({
				homeDir,
				workspaceRoot: persisted.workspaceRoot,
				env: options.env,
				overrides,
				...profileInput,
			}, startupTrustState);
		}
		recoveredInterrupts = (options.recoverInterruptedTurns ?? []).flatMap((recovery) => {
			const record = store.recoverInterruptedTurn(
				recovery.sessionId,
				recovery.turnId,
				recovery.userInitiated,
			);
			return record?.status === "interrupted"
					? [{
						record,
						inputRolledBack: recovery.inputRolledBack === true,
					}]
				: [];
		});
	} catch (error) {
		store.close();
		throw error;
	}
	let defaultPreferences = sessionPreferencesFromConfig(
		config,
		"default",
		DEFAULT_PERMISSION_PROFILE,
	);
	const updateCache = new CachedUpdateService({
		homeDir,
		packageName: MYCLI_PACKAGE_NAME,
		currentVersion: MYCLI_VERSION,
		env: options.env,
		executablePath: process.argv[1],
		...(options.updateFetch ? { fetch: options.updateFetch } : {}),
	});
	const startupUpdateStatus = await updateCache.status(config.updatesCheckOnStartup);
	startupProfiler.mark("config_ready");
	startupProfiler.mark("storage_ready");
	const productSystemPrompt = packagedSystemPrompt();
	const registry = new ProviderRegistry();
	const providerRoutesByConfig = new WeakMap<NodeRuntimeConfig, ProviderRouteDescriptor>();
	const captureProviderRoute = async (
		resolved: NodeRuntimeConfig,
		resolveWithModelLimit?: (inputTokenLimit: number) => Promise<NodeRuntimeConfig>,
		environment: Readonly<NodeJS.ProcessEnv> = options.env,
	): Promise<NodeRuntimeConfig> => {
		const snapshot = await providerModelDirectory.load(resolved);
		const route = snapshot.route(resolved.provider);
		if (!route || route.activation !== "active") {
			throw new Error("provider_model_directory_error: active provider route is unavailable");
		}
		const entry = findProviderScopedModelEntry(snapshot, {
			provider: resolved.provider,
			protocol: resolved.protocol,
			model: resolved.model,
			baseUrl: resolved.apiBaseUrl,
		});
		const inputTokenLimit = entry === undefined ? undefined : modelInputTokenLimit(entry);
		const modelAwareConfig = inputTokenLimit === undefined || resolveWithModelLimit === undefined
			? resolved
			: await resolveWithModelLimit(inputTokenLimit);
		const selected = entry === undefined
			? modelAwareConfig
			: applyProviderScopedModelConfig(modelAwareConfig, entry);
		const nativeTransport = route.source === "pi_ai_builtin" && route.catalogProviderId
			? await resolveProviderNativeTransport({
				catalogProviderId: route.catalogProviderId,
				modelId: selected.model,
				protocol: selected.protocol,
				apiBaseUrl: selected.apiBaseUrl,
				allowDeclaredModel: entry?.origin !== "pi_ai_catalog",
				environment,
			})
			: undefined;
		const providerEnv = nativeTransport ? await captureProviderNativeEnvironment({
			catalogProviderId: nativeTransport.catalogProviderId,
			environment,
			...(selected.apiKey ? { apiKey: selected.apiKey } : {}),
		}) : undefined;
		const effective = nativeTransport ? Object.freeze({ ...selected, nativeTransport, providerEnv }) : selected;
		providerRoutesByConfig.set(effective, nativeTransport ? Object.freeze({ ...route, nativeTransport }) : route);
		return effective;
	};
	const resolveCapturedProviderModelConfig = async (
		input: ResolveConfigOptions,
		workspaceTrust?: WorkspaceTrustState,
	): Promise<NodeRuntimeConfig> => {
		const preliminary = await resolveWorkspaceModelRuntimeConfig(input, workspaceTrust);
		return captureProviderRoute(preliminary, (inputTokenLimit) => (
			resolveWorkspaceModelRuntimeConfig({
				...input,
				overrides: {
					...input.overrides,
					provider: preliminary.provider,
					protocol: preliminary.protocol,
					model: preliminary.model,
					apiBaseUrl: preliminary.apiBaseUrl,
					...(preliminary.allowAmbientAuth === false ? { authRef: preliminary.authRef } : {}),
				},
				defaultMaxPromptTokens: inputTokenLimit,
				maxPromptTokensCeiling: inputTokenLimit,
			}, workspaceTrust)
		), input.env);
	};
	const providerRouteForConfig = (resolved: NodeRuntimeConfig): ProviderRouteDescriptor => {
		const route = providerRoutesByConfig.get(resolved);
		if (!route) {
			throw new Error("provider_model_directory_error: provider route snapshot was not captured");
		}
		return route;
	};
	const agentWorkerPool = Object.values(agentExecutionAdapters).includes("worker")
		? new AgentWorkerPool({
			...agentWorkerSettings,
			...(options.agentWorkerReadProcessRssBytes
				? { readProcessRssBytes: options.agentWorkerReadProcessRssBytes }
				: {}),
		})
		: undefined;
	let controlConfig = config;
	const toolManifest = builtinToolManifest();
	const requestPermissionsToolEnabled = config.requestPermissionsToolEnabled;
	const shellManager = new ShellSessionManager({
		transportFactory: (request) => request.tty
			? startNodePtyTransport(request)
			: startPipeTransport(request),
	});
	const sessionArtifacts = new SessionArtifactStore({ homeDir });
	const artifactQueue = new SerializedSessionArtifactQueue();
	const shellLifecycle = new ShellLifecycleProjector({
		store,
		projectTaskOutput: (input) => artifactQueue.run(async () => {
			await sessionArtifacts.writeTaskOutput(input);
		}),
	});
	const publishLifecycle: (event: ShellLifecycleEvent) => void = (event) => {
		shellLifecycle.enqueue(event);
	};
	const transcriptSnapshots = new TranscriptSnapshotStore({ homeDir });
	const tokenCounter = new TokenCounter();
	const resourceOwner = new NodeBackendResourceOwner({
		closeUpdateCache: () => updateCache.close(),
		...(agentWorkerPool ? { closeAgentWorkers: () => agentWorkerPool.close() } : {}),
		closeShellManager: async () => { await shellManager.close(); },
		drainShellLifecycle: () => shellLifecycle.drain(),
		drainArtifacts: () => artifactQueue.close(),
		closeStore: () => { store.close(); },
	});
	const childRuntimeFactoryDelegate: {
		create?: (input: ChildRuntimeCreateInput) => Promise<ChildRuntimeHandle>;
	} = {};
	const inProcessChildRuntimeFactory: ChildRuntimeFactory = {
		create: async (input) => {
			const create = childRuntimeFactoryDelegate.create;
			if (!create) throw new Error("child_runtime_unavailable");
			return create(input);
		},
	};
	const childRuntimeFactory: ChildRuntimeFactory = agentWorkerPool
		&& agentExecutionAdapters.subagent === "worker"
		? new WorkerLeasedAgentThreadRuntimeFactory({
			pool: agentWorkerPool,
			delegate: inProcessChildRuntimeFactory,
		})
		: inProcessChildRuntimeFactory;
	const runtimeRegistry = new NodeRuntimeRegistry<ComposedNodeRuntime>();
	const agentInteractiveRequests = new AgentInteractiveRequestBroker();
	const mcpElicitations = new McpElicitationBroker();
	const agentActivityBus = new AgentActivityBus();
	let agentSupervisor: AgentSupervisor | undefined;
	let publishSubagentProjection: (value: Readonly<Record<string, unknown>>) => void = () => undefined;
	let deliverTerminalProjection: (
		task: SubagentTaskRecord,
		thread: AgentThreadRecord,
	) => Promise<void> = async () => undefined;
	const consumeAgentEvent = (event: AgentCanonicalEvent): Promise<void> => {
		if (event.type === "agent_lifecycle"
			&& event.task
			&& ["started", "completed", "failed", "interrupted"].includes(event.kind)) {
			const thread = store.agentThreads.get(event.threadId);
			tryAppendNodeTrace(homeDir, event.task.parentSessionId, {
				kind: "subagent_lifecycle",
				turn_id: event.task.parentTurnId,
				payload: {
					thread_id: event.threadId,
					status: event.kind,
					...(thread ? {
						duration_ms: elapsedIsoMs(thread.createdAt, event.occurredAt),
					} : {}),
				},
			});
		}
		if (event.type === "agent_lifecycle"
			&& !["completed", "failed", "interrupted"].includes(event.kind)) {
			agentActivityBus.publish({
				kind: "lifecycle",
				rootThreadId: event.rootThreadId,
				threadId: event.threadId,
				occurredAt: event.occurredAt,
			});
		}
		const terminalEvent = event.type === "agent_lifecycle"
			&& ["completed", "failed", "interrupted"].includes(event.kind);
		const terminalDelivery = terminalEvent
			&& event.task
			? (() => {
				const task = store.subagentTasks.get(event.task.taskId);
				const thread = store.agentThreads.get(event.threadId);
				return task && thread
					? deliverTerminalProjection(task, thread).catch(() => undefined)
					: Promise.resolve();
			})()
			: Promise.resolve();
		const gatewayProjection = terminalDelivery.then(() => {
			publishCanonicalSubagentEvent(event, store, publishSubagentProjection);
		});
		const artifactProjection = gatewayProjection.then(() => artifactQueue.run(async () => {
			await projectCanonicalAgentEvent({
				event,
				store,
				transcriptSnapshots,
				artifacts: sessionArtifacts,
			});
		}));
		void artifactProjection.catch(() => undefined);
		return terminalEvent
			? gatewayProjection
			: Promise.resolve();
	};
	const agentMailbox = new AgentMailbox({
		store: store.agentMailbox,
		threadStore: store.agentThreads,
		queueForSession: (sessionId) => runtimeRegistry.get(sessionId)?.queueCoordinator,
		committedQueueIds: (sessionId) => store.loadCommittedQueueIds(sessionId),
		triggerReceiver: async (receiver, item) => {
			await agentSupervisor?.followUp(
				receiver.threadId,
				item.sourceCallId ?? item.messageId,
				item.payload.kind === "message" ? item.payload.text : "Agent follow-up",
			);
		},
		onEvent: consumeAgentEvent,
	});
	const resolveAgentRouteContext = (sessionId: string) => {
		const overview = store.loadSession(sessionId);
		const threadId = overview?.threadId ?? sessionId;
		const agent = store.agentThreads.get(threadId);
		if (!overview && !agent && sessionId !== config.sessionId) return undefined;
		const sender = Object.freeze({
			threadId: agentThreadId(threadId),
			rootThreadId: agent?.rootThreadId ?? agentThreadId(threadId),
			path: agent?.path ?? rootAgentPath(),
			sessionId,
		});
		const rootSessionId = sender.threadId === sender.rootThreadId
			? sessionId
			: store.listSessions({ limit: 10_000 }).find(
				(candidate) => candidate.threadId === sender.rootThreadId,
			)?.sessionId ?? sender.rootThreadId;
		return Object.freeze({
			sender,
			root: Object.freeze({
				threadId: sender.rootThreadId,
				rootThreadId: sender.rootThreadId,
				path: rootAgentPath(),
				sessionId: rootSessionId,
			}),
		});
	};
	const deliverAgentCompletion = async (
		task: SubagentTaskRecord,
		thread = store.agentThreads.get(task.childSessionId),
	): Promise<void> => {
		if (!thread || !thread.spawnConfig || !isTerminalSubagentStatus(task.status)) return;
		const context = resolveAgentRouteContext(task.parentSessionId);
		if (!context) return;
		await agentMailbox.send({
			sender: Object.freeze({
				threadId: thread.threadId,
				rootThreadId: thread.rootThreadId,
				path: thread.path,
				sessionId: task.childSessionId,
			}),
			root: context.root,
			target: context.sender.path,
			triggerMode: "queue_only",
			logicalId: task.taskId,
			sourceCallId: task.taskId,
			payload: Object.freeze({
				kind: "completion",
				status: task.status,
				report: terminalSubagentOutput(task).slice(0, 32_768),
				...(task.payload.outputReference ? {
					outputReference: task.payload.outputReference.slice(0, 4_096),
				} : {}),
			}),
		});
	};
	deliverTerminalProjection = deliverAgentCompletion;
	const repairAgentCompletions = async (parentSessionId: string): Promise<void> => {
		for (const task of store.subagentTasks.list(parentSessionId, 1_000)) {
			await deliverAgentCompletion(task);
		}
	};
	const agentActivity: WaitAgentActivityContract = Object.freeze({
		wait: async (input: WaitAgentActivityInput) => {
			const queue = runtimeRegistry.get(input.parentSessionId)?.queueCoordinator;
			const route = resolveAgentRouteContext(input.parentSessionId);
			if (!queue || !route) return Object.freeze({ kind: "unavailable" as const });
			const controller = new AbortController();
			const forwardAbort = (): void => { controller.abort(); };
			input.signal.addEventListener("abort", forwardAbort, { once: true });
			if (input.signal.aborted) controller.abort();
			try {
				return await Promise.race([
					queue.waitForActivity({
						turnId: input.parentTurnId,
						timeoutMs: input.timeoutMs,
						signal: controller.signal,
					}),
					agentActivityBus.wait({
						rootThreadId: route.root.threadId,
						timeoutMs: input.timeoutMs,
						signal: controller.signal,
					}).then((result) => result.kind === "timeout"
						? result
						: Object.freeze({
							kind: "activity" as const,
							activity: result.event.kind === "mailbox"
								? "agent_message" as const
								: result.event.kind,
							pendingCount: 1,
						})),
				]);
			} finally {
				controller.abort();
				input.signal.removeEventListener("abort", forwardAbort);
			}
		},
	});
	startupProfiler.mark("runtime_components_ready");
	const integrationOptions: CreateRuntimeIntegrationCompositionOptions = {
		onMcpElicitation: mcpElicitations.request,
		disabled: options.executionMode === "review",
		...(managedExecutionPolicy ? { managedExecutionPolicy } : {}),
		builtinManifest: toolManifest,
		workspaceRoot: config.workspaceRoot,
		homeDir,
		env: options.env,
		projectConfigurationEnabled: startupTrustState === "trusted",
		parentSessionId: config.sessionId,
		parentTurnId: () => "parent-turn-unavailable",
		parentTools: ({ parentSessionId, parentTurnId }) => {
			const runSnapshot = runtimeRegistry.get(parentSessionId)
				?.runExecutionSnapshot?.(parentTurnId);
			return runSnapshot
				? toolExposureForSnapshot(
					runSnapshot.toolCatalog,
					store.loadToolActivations(parentSessionId, parentTurnId),
				).map((tool) => tool.name)
				: Object.freeze([]);
		},
		createSubagentSupervisor: (supervisorOptions) => {
				agentSupervisor = new AgentSupervisor({
					lifecycleStore: store.agentLifecycle,
					threadStore: store.agentThreads,
				taskStore: store.subagentTasks,
				runtimeFactory: childRuntimeFactory,
				maxResidents: DEFAULT_AGENT_MAX_RESIDENTS,
				maxDepth: DEFAULT_AGENT_MAX_DEPTH,
				onEvent: consumeAgentEvent,
				...supervisorOptions,
				...(agentExecutionAdapters.subagent === "worker"
					&& supervisorOptions.shutdownTimeoutMs === undefined
					? { shutdownTimeoutMs: DEFAULT_AGENT_WORKER_INTERRUPT_TIMEOUT_MS }
					: {}),
			});
			return agentSupervisor;
		},
		maxAgentDepth: DEFAULT_AGENT_MAX_DEPTH,
		resolveSubagentSpawnContext: async (input) => {
			const overview = store.loadSession(input.parentSessionId);
			const parentThreadId = overview?.threadId ?? input.parentSessionId;
			const parentAgent = store.agentThreads.get(parentThreadId);
			const workspaceRoot = overview?.workspaceRoot ?? config.workspaceRoot;
			const parentRuntime = runtimeRegistry.get(input.parentSessionId);
			const parentRunSnapshot = parentRuntime
				?.runExecutionSnapshot?.(input.parentTurnId);
			const parentPreferences = parentRuntime?.sessionPreferences?.();
			const resolved = await resolveWorkspaceModelRuntimeConfig({
				homeDir,
				workspaceRoot,
				env: options.env,
				overrides: sessionPreferenceOverrides(
					input.childSessionId,
					parentPreferences ?? defaultPreferences,
				),
			});
			const executionPolicy = narrowAgentExecutionPolicy(
				agentExecutionPolicyForRun(parentRunSnapshot),
			);
			const integrationAuthority = captureChildIntegrationAuthority(parentRuntime?.integrations, parentRunSnapshot, input.tools);
			return Object.freeze({
				parentThreadId,
				rootThreadId: parentAgent?.rootThreadId ?? parentThreadId,
				parentPath: parentAgent?.path ?? rootAgentPath(),
				config: Object.freeze({
					workspaceRoot,
					cwd: workspaceRoot,
					environment: agentEnvironmentSnapshot(options.env),
					executionPolicy,
					provider: Object.freeze({
						provider: resolved.provider,
						protocol: resolved.protocol,
						model: resolved.model,
						reasoningEffort: resolved.thinkingEnabled
							? resolved.reasoningEffort
							: "none",
					}),
					instructions: Object.freeze({
						project: productSystemPrompt.content,
					}),
					tools: Object.freeze([...input.tools]),
					...(integrationAuthority ? { integrationAuthority } : {}),
					forkTurns: "none" as const,
				}),
			});
		},
		agentActivity,
			agentMailbox,
		resolveAgentRouteContext,
		onStartupStage: (stage) => { startupProfiler.mark(stage); },
	};
	let sharedSubagents: ReturnType<typeof createRuntimeSubagentServices> | undefined;
	try {
		sharedSubagents = options.executionMode === "review" ? undefined : createRuntimeSubagentServices({
			createSupervisor: integrationOptions.createSubagentSupervisor,
			parentSessionId: config.sessionId,
			parentTurnId: integrationOptions.parentTurnId,
			parentTools: integrationOptions.parentTools,
			resolveSpawnContext: integrationOptions.resolveSubagentSpawnContext,
			agentActivity, mailbox: agentMailbox, resolveAgentRouteContext,
			maxAgentDepth: DEFAULT_AGENT_MAX_DEPTH,
		});
	} catch (error) {
		await agentSupervisor?.close().catch(() => undefined);
		await resourceOwner.close().catch(() => undefined);
		throw error;
	}
	const extensionListeners = new Set<(sessionId: string, version: number) => void>();
	publishSubagentProjection = (value) => { sharedSubagents?.publish(value); };
	resourceOwner.bindIntegration(async () => {
		runtimeRegistry.stop();
		extensionListeners.clear();
		try { await sharedSubagents?.close(); }
		finally { await runtimeRegistry.close(); }
	});
	const contextItemCoordinator = new ContextItemCoordinator({
		extractArtifact: skillInvocationArtifactFromMetadata,
	});
	const createRuntime = (
		sessionId: string,
		workspaceRoot: string,
		threadId: string,
		initialQueue: QueueSnapshot,
		initialContinuation?: unknown,
		runtimeOptions: {
			readonly allowedTools?: readonly string[];
			readonly registryId?: string;
			readonly review?: { readonly workspaceRoot: string; readonly revision?: string };
			readonly queueCoordinator?: QueueCoordinator;
			readonly instructions?: string;
			readonly developerInstructions?: readonly string[];
			readonly subagentContext?: ChildRuntimeCreateInput;
			readonly agentBudget?: AgentBudget;
			readonly executionPolicy?: AgentExecutionPolicySnapshot;
				readonly provider?: AgentProviderSnapshot;
				readonly environment?: Readonly<Record<string, string>>;
				readonly agentCheckpoint?: NodeTurnRuntimeOptions["agentCheckpoint"];
				readonly isMutatingTool?: NodeTurnRuntimeOptions["isMutatingTool"];
			} = {},
		): Promise<ComposedNodeRuntime> => runtimeRegistry.getOrCreate(runtimeOptions.registryId ?? sessionId, async (signal) => {
			const reviewMode = options.executionMode === "review" || runtimeOptions.review !== undefined;
			const reviewRevision = runtimeOptions.review?.revision ?? options.reviewRevision;
			const readRoot = runtimeOptions.review?.workspaceRoot ?? workspaceRoot;
			const allowedTools = reviewMode ? ["Read"] : runtimeOptions.allowedTools;
			let sessionPreferences = runtimeOptions.subagentContext
				? undefined
				: loadSessionPreferences(store, sessionId);
			const runtimeEnvironment: Readonly<NodeJS.ProcessEnv> = runtimeOptions.environment
				? Object.freeze({ ...runtimeOptions.environment })
				: options.env;
			const resolveRuntimeConfig = async (
				modelOverride?: string,
			): Promise<NodeRuntimeConfig> => {
				const preferences = runtimeOptions.provider
					? undefined
					: sessionPreferences ?? defaultPreferences;
				const configInput: ResolveConfigOptions = {
					homeDir,
					workspaceRoot,
					env: options.env,
					overrides: {
						session: sessionId,
						...(preferences ? {
							provider: preferences.provider,
							protocol: preferences.protocol,
							apiBaseUrl: preferences.apiBaseUrl,
							...(preferences.authRef !== preferences.provider || config.allowAmbientAuth === false
								? { authRef: preferences.authRef } : {}),
							reasoningEffort: preferences.reasoningEffort,
							thinkingEnabled: preferences.reasoningEffort !== "none",
						} : {}),
						model: runtimeOptions.provider?.model
							?? modelOverride
							?? preferences?.model
							?? defaultPreferences.model,
					},
				};
				const resolveEffective = async (inputTokenLimit?: number): Promise<NodeRuntimeConfig> => {
					const rawResolved = await resolveWorkspaceModelRuntimeConfig({
						...configInput,
						...(inputTokenLimit === undefined
							? {}
							: {
								defaultMaxPromptTokens: inputTokenLimit,
								maxPromptTokensCeiling: inputTokenLimit,
							}),
					});
					const resolved: NodeRuntimeConfig = reviewMode ? Object.freeze({ ...rawResolved, webSearchMode: "disabled" }) : rawResolved;
					return !runtimeOptions.provider ? resolved : Object.freeze({
						...resolved,
						provider: runtimeOptions.provider.provider,
						protocol: runtimeOptions.provider.protocol,
						model: runtimeOptions.provider.model,
						reasoningEffort: runtimeOptions.provider.reasoningEffort ?? "none",
						thinkingEnabled: (runtimeOptions.provider.reasoningEffort ?? "none") !== "none",
					});
				};
				return captureProviderRoute(await resolveEffective(), resolveEffective, runtimeEnvironment);
			};
			const fileSnapshots = new FileSnapshotStore();
			const fileHistory = new FileHistoryStore({ homeDir, workspaceRoot });
			const executionPolicyConstraints = runtimeOptions.executionPolicy
				? inheritedAgentExecutionPolicyConstraints(runtimeOptions.executionPolicy)
				: managedExecutionPolicy;
			const projectConfigurationEnabled = (!runtimeOptions.executionPolicy || runtimeOptions.executionPolicy.trusted)
				&& await workspaceTrustStore.load(workspaceRoot) === "trusted";
			const childContext = runtimeOptions.subagentContext;
			const inheritedAuthority = childContext?.config.integrationAuthority;
			const parentConfiguration = childContext && projectConfigurationEnabled
				? runtimeRegistry.get(childContext.parentSessionId)?.integrations.configuration : undefined;
			const childConfiguration = childContext
				? parentConfiguration?.fingerprint === inheritedAuthority?.configurationFingerprint && parentConfiguration
					? parentConfiguration
					: await loadRuntimeIntegrationConfiguration({ workspaceRoot, homeDir, env: runtimeEnvironment,
						includeRepository: projectConfigurationEnabled })
				: undefined;
			const integrationAuthorized = !childContext || (inheritedAuthority !== undefined
				&& inheritedAuthority.configurationFingerprint === childConfiguration?.fingerprint);
			const integrationComposition = await createRuntimeIntegrationComposition({
				...integrationOptions,
				workspaceRoot, env: runtimeEnvironment, signal,
				managedExecutionPolicy: executionPolicyConstraints,
				projectConfigurationEnabled,
				disabled: integrationOptions.disabled || reviewMode || !integrationAuthorized,
				configuration: childConfiguration,
				pinConfiguration: childContext !== undefined,
				subagentServices: sharedSubagents,
				onStartupStage: sessionId === config.sessionId ? integrationOptions.onStartupStage : undefined,
			});
			let unsubscribeExtensions: (() => void) | undefined;
			try {
			const currentRegistrations = () => childContext
				? inheritedIntegrationRegistrations(integrationComposition, inheritedAuthority) : integrationComposition.registrations;
			const currentSkillCatalog = (): string => currentRegistrations().some((registration) => registration.source === "skill")
				? integrationComposition.skillCatalog : "";
			const directExtensionRegistrations = partitionRuntimeToolRegistrations(currentRegistrations()).direct;
			const directExtensionDefinitions = Object.freeze(directExtensionRegistrations.map((registration) => registration.definition));
			const currentDeferredRegistrations = () => partitionRuntimeToolRegistrations(currentRegistrations()).deferred;
			const currentToolExposure = (): readonly ToolDefinition[] => filterToolDefinitions(runtimeToolExposure(
				toolManifest, directExtensionDefinitions, currentDeferredRegistrations(), requestPermissionsToolEnabled), allowedTools);
			let allToolExposure = currentToolExposure();
			const mutatingAgentTools = mutatingTools(integrationComposition.manifest);
			const executionPolicyCoordinator = new ExecutionPolicyCoordinator({
				workspaceRoot,
				...(executionPolicyConstraints ? { constraints: executionPolicyConstraints } : {}),
			});
			const mutationRuntime = new FileMutationRuntime({
				workspaceRoot,
				snapshots: fileSnapshots,
				sessionId,
				history: fileHistory,
			});
		const shellProfile = resolveShellProfile({ env: runtimeEnvironment });
		const execPolicyStore = new ExecPolicyStore({ homeDir, workspaceRoot });
		const integrationApprovals = new IntegrationToolApprovalStore(homeDir);
		const approvalPolicy = new ApprovalPolicy({
			workspaceRoot,
			autoApproveMedium: true,
			shellKind: shellProfile.kind,
			extensionTools: currentRegistrations().map((registration) => ({
				name: registration.definition.name,
				...(registration.approvalScope ? { approvalScope: registration.approvalScope } : {}),
				approvalPolicy: registration.approvalPolicy ?? (registration.source === "skill" || registration.source === "subagent"
					? "auto_allow" as const
					: "request" as const),
			})),
		});
		let loadExecPolicy: Promise<void> | undefined;
		let loadedExecPolicyTrustState: Awaited<ReturnType<WorkspaceTrustStore["load"]>> | undefined;
		const ensureExecPolicyLoaded = async (): Promise<void> => {
			const trustState = await workspaceTrustStore.load(workspaceRoot);
			if (loadExecPolicy && loadedExecPolicyTrustState === trustState) {
				return loadExecPolicy;
			}
			loadedExecPolicyTrustState = trustState;
			loadExecPolicy = (trustState === "trusted"
				? execPolicyStore.load()
				: execPolicyStore.loadUserRules()).then((rules) => {
				approvalPolicy.replaceExecPolicyRules(rules);
			});
			return loadExecPolicy;
		};
			const shellTool = new ShellTool({
			workspaceRoot,
			manager: shellManager,
			env: runtimeEnvironment,
			profile: shellProfile,
		});
			const allowedDeferredRegistrations = () => {
				const allowedNames = allowedTools
					? new Set(allowedTools)
					: undefined;
				return currentDeferredRegistrations().filter(
					(registration) => !allowedNames || allowedNames.has(registration.definition.name),
				);
			};
			const toolSearch = new ToolSearchTool(deferredCandidates(allowedDeferredRegistrations()));
			const staticAdapters = [
				new ViewImageTool({ workspaceRoot, homeDir }),
				new ListMcpResourcesTool(integrationComposition.mcpResourceService),
				new ListMcpResourceTemplatesTool(integrationComposition.mcpResourceService),
				new ReadMcpResourceTool(integrationComposition.mcpResourceService),
				reviewMode && reviewRevision
					? new GitReviewReadTool(readRoot, reviewRevision)
					: new ReadTool({ workspaceRoot: readRoot, snapshots: fileSnapshots }),
			new EditTool(mutationRuntime),
			new PatchTool(mutationRuntime),
			new WriteTool({ runtime: mutationRuntime }),
			new AskUserQuestionTool(),
			new RequestPermissionsTool({ workspaceRoot }),
			new UpdatePlanTool(),
			new WebFetchTool(),
				toolSearch,
			shellTool,
			new WriteStdinTool({ manager: shellManager }),
			new BashTool({ shell: shellTool }),
			new ShellOutputTool({ manager: shellManager }),
			new BashOutputTool({ manager: shellManager }),
			new KillShellTool({ manager: shellManager }),
				...directExtensionRegistrations
					.map((registration) => registration.adapter),
			];
			const adapterByName = new Map<string, ToolAdapter>(
				staticAdapters.map((adapter) => [adapter.definition.name, adapter]),
		);
		for (const tool of toolManifest.tools) {
			if ((adapterByName.get(tool.name)?.supportsParallelToolCalls === true)
				!== tool.supports_parallel_tool_calls) {
				throw new Error("tool_parallel_capability_mismatch");
			}
		}
			const plannedTools = (
				capabilities: {
					readonly shell: boolean;
					readonly collaborationMode: string;
				},
				deferred: readonly DeferredToolCandidate[] = deferredCandidates(allowedDeferredRegistrations()),
				sources: readonly DeferredToolCandidate[] = deferred,
			): readonly ToolDefinition[] => Object.freeze(filterToolDefinitions(
				[
					...planToolExposure(toolManifest, {
						...capabilities,
						requestPermissionsTool: requestPermissionsToolEnabled,
					}),
					...directExtensionDefinitions,
				],
				allowedTools,
			).filter((definition) => definition.name !== "tool_search" || deferred.length > 0)
			.map((definition) => definition.name === "tool_search"
				? createToolSearchDefinition(sources)
				: definition));
				const toolRouter = new ToolRouter({
					adapters: staticAdapters,
					exposure: plannedTools({ shell: true, collaborationMode: "plan" }),
			});
			const extensionCatalog = new ExtensionToolCatalog(toolRouter, toolSearch, approvalPolicy);
			const refreshExtensions = (): void => {
				allToolExposure = currentToolExposure();
				for (const name of mutatingTools(integrationComposition.manifest)) mutatingAgentTools.add(name);
				const deferred = allowedDeferredRegistrations();
				extensionCatalog.replace({ version: integrationComposition.version, tools: deferredCandidates(deferred),
					skillCatalog: currentSkillCatalog() }, currentRegistrations().map(
					(registration) => ({
						name: registration.definition.name,
						...(registration.approvalScope ? { approvalScope: registration.approvalScope } : {}),
						approvalPolicy: registration.approvalPolicy ?? (registration.source === "skill" || registration.source === "subagent"
							? "auto_allow" as const
							: "request" as const),
					}),
				));
			};
			refreshExtensions();
			unsubscribeExtensions = integrationComposition.subscribeExtensions((version) => {
				refreshExtensions();
				for (const listener of extensionListeners) listener(sessionId, version);
			});
		const approvalCoordinator = new ApprovalContinuationCoordinator({
			sessionId,
			workspaceRoot,
			threadId,
			store,
			toolRouter,
			publishLifecycle,
			clock: () => new Date().toISOString(),
			ruleStore: execPolicyStore,
			publishExecPolicyRules: (rules) => {
				approvalPolicy.replaceExecPolicyRules(rules);
				loadExecPolicy = Promise.resolve();
			},
			allowSession: (pattern) => { approvalPolicy.allowSession(pattern); },
			validateExtensionApproval: (scope, name, turnId) => approvalPolicy.matchesExtensionApproval(scope, name, turnId),
			allowExtensionSession: (scope) => { approvalPolicy.allowExtensionSession(scope); },
			rememberExtension: async (scope) => {
				await integrationApprovals.allow(scope);
				approvalPolicy.replaceRememberedExtensions(await integrationApprovals.load());
			},
			grantPermissions: (input) => executionPolicyCoordinator.grant(input),
		});
		const parallelApprovals = new ParallelApprovalCoordinator({
			sessionId, workspaceRoot, threadId, store, approval: approvalCoordinator,
		});
		parallelApprovals.recover();
		approvalCoordinator.recover();
			const clarificationCoordinator = new ClarificationContinuationCoordinator({
			sessionId,
			workspaceRoot,
			threadId,
			store,
			clock: () => new Date().toISOString(),
			});
			const loadRuntimeImages = (paths: readonly string[]) => loadLocalImages(paths, {
				cwd: workspaceRoot,
				homeDir,
			});
			const queueCoordinator = runtimeOptions.queueCoordinator ?? new QueueCoordinator({
			initial: initialQueue,
			store: {
				loadCommittedQueueIds: () => store.loadCommittedQueueIds(sessionId),
				saveSnapshot: (snapshot) => {
					store.saveQueueSnapshot({ sessionId, workspaceRoot, threadId, snapshot });
				},
					commitPending: (turnId, records, imagesByQueueId) => store.commitQueuedInputs({
						sessionId,
						turnId,
						records,
						...(imagesByQueueId ? { imagesByQueueId } : {}),
					}),
			},
			activeTurnId: null,
			createQueueId: randomUUID,
				clock: () => new Date().toISOString(),
				loadLocalImages: loadRuntimeImages,
			onCommitted: (records) => { agentMailbox.markQueueRecordsCommitted(records); },
		});
		const systemPrompt = runtimeOptions.instructions
			&& runtimeOptions.instructions !== productSystemPrompt.content
			? Object.freeze({
				...productSystemPrompt,
				version: "runtime-override-v1",
				source: "runtime-override",
				content: runtimeOptions.instructions,
				contentSha256: modelInputSha256(runtimeOptions.instructions),
			})
			: productSystemPrompt;
		const runtimeInstructions = systemPrompt.content;
		const developerInstructions = Object.freeze([
			...(runtimeOptions.developerInstructions ?? []),
			...(runtimeOptions.subagentContext ? [subagentDeveloperContext(
				runtimeOptions.subagentContext,
					plannedTools({
						shell: runtimeOptions.executionPolicy?.trusted === true,
						collaborationMode: "default",
					})
					.map((tool) => tool.name),
			)] : []),
		]);
		const providerContinuation = new ProviderContinuationCoordinator({
			sessionId,
			...(initialContinuation === undefined ? {} : { initialState: initialContinuation }),
			persist: (state) => {
				store.saveState({
					sessionId,
					workspaceRoot,
					threadId,
					key: "responses_continuation_state",
					payload: state,
				});
			},
		});
			const memoryContextService = new MemoryContextService({
				store: new MemoryStore({ homeDir, workspaceRoot }),
				sessionStore: store,
				tokenCounter,
			});
			const createCompactionCoordinator = (
				resolved: NodeRuntimeConfig,
				runSnapshot?: RunExecutionSnapshot,
			): CompactionCoordinator => {
				const journal = new CompactionModelJournal({ sessionId, store, clock: () => new Date().toISOString() });
				const compactionThreshold = compactionThresholdForModel(resolved);
				const compactTools = (): readonly ToolDefinition[] => runSnapshot
					? toolExposureForSnapshot(
						runSnapshot.toolCatalog,
						store.loadToolActivations(sessionId, runSnapshot.turnId),
					)
					: allToolExposure;
				return new CompactionCoordinator({
					sessionId,
					workspaceRoot,
					threadId,
					store,
					tokenCounter,
					baseContext: () => [
						runtimeInstructions,
						...developerInstructions,
						JSON.stringify(compactTools()),
					].join("\n"),
					tokenLimit: totalCompactionBudget(
						compactionThreshold,
						resolved.compactionReservedOutputTokens,
					),
					reservedOutputTokens: resolved.compactionReservedOutputTokens,
					triggerRatio: 1,
					tailTurns: resolved.compactionTailTurns,
					tailMaxTokens: resolved.compactionTailMaxTokens,
					minSavingsRatio: resolved.compactionMinSavingsRatio,
					summaryMaxTokens: compactionSummaryOutputTokens(resolved),
					summaryModel: resolved.compactionSummarizerModel ?? resolved.model,
					rehydrationMaxFiles: resolved.compactionRehydrationMaxFiles,
					rehydrationMaxItemTokens: resolved.compactionRehydrationFileMaxItemTokens,
					rehydrationMaxTotalTokens: resolved.compactionRehydrationFileMaxTotalTokens,
					summarize: async (input) => {
						const summaryConfig = await captureProviderRoute({
							...resolved,
							model: input.model ?? resolved.model,
						}, undefined, runtimeEnvironment);
						return summarizeCompactionWithProvider(
							registry.create(summaryConfig, providerRouteForConfig(summaryConfig)),
							summaryConfig,
							input,
							{ recordDiagnostic: (diagnostic) => tryAppendNodeTrace(homeDir, sessionId,
								runtimeDiagnosticTraceEvent({ ...diagnostic, kind: "model_stream_diagnostics",
									turnId: `compaction:${input.operationId}`, provider: summaryConfig.provider,
									protocol: summaryConfig.protocol, model: summaryConfig.model })) },
						);
					},
					recordModelEvent: (input) => journal.record(input),
					createCheckpointId: randomUUID,
					clock: () => new Date().toISOString(),
				});
			};
			store.modelInputLedger.recoverUnconfirmedProviderSteps({
				sessionId,
				createdAt: new Date().toISOString(),
				createEventId: () => `lifecycle-${randomUUID()}`,
			});
			const selectedSkills = new SelectedSkillContext({ sessionId, store, service: () => integrationComposition.skills });
			const coordinatorRuntime = new NodeTurnRuntime({
			runLifecycle: {
				prepare: (turnId, signal) => integrationComposition.prepareRun(JSON.stringify([sessionId, turnId]), signal),
				finish: (turnId) => integrationComposition.finishRun(JSON.stringify([sessionId, turnId])),
			},
			sessionId,
			workspaceRoot,
			threadId,
			instructions: runtimeInstructions,
			resolveInstructionSnapshot: () => resolveSessionInstructionSnapshot({
				sessionId,
				ledger: store.modelInputLedger,
				template: systemPrompt,
				clock: () => new Date().toISOString(),
			}),
			modelInputLedger: store.modelInputLedger,
			agentEffectLedger: store.agentEffectLedger,
			providerAttemptLedger: store.providerAttemptLedger,
			modelInputTokenCounter: tokenCounter,
			contextSources: ({ config: activeConfig, runSnapshot }) => Object.freeze({
				skillCatalog: runSnapshot.toolCatalog.skillCatalog ?? "",
				loadedSkillInstructions: selectedSkills.load(runSnapshot.turnId),
				workspace: workspaceInstructionsForTrust(
					workspaceRoot,
					runSnapshot.policy?.configuration
						? runSnapshot.policy.configuration.trust === "trusted"
						: runSnapshot.policy?.toolsEnabled === true,
				),
				environment: Object.freeze({
					workspace_root: workspaceRoot,
					cwd: workspaceRoot,
					platform: process.platform,
					node_version: process.version,
					provider_protocol: activeConfig.protocol,
					shell: shellProfile.name,
					shell_kind: shellProfile.kind,
				}),
			}),
				...(developerInstructions.length > 0 ? { developerInstructions } : {}),
				...(runtimeOptions.agentBudget ? { agentBudget: runtimeOptions.agentBudget } : {}),
			...(options.maxOutputTokens === undefined
				? {}
				: { maxOutputTokens: options.maxOutputTokens }),
				store,
				resolveConfig: (submission) => resolveRuntimeConfig(submission.modelOverride),
				createProvider: (resolved) => registry.create(
					resolved,
					providerRouteForConfig(resolved),
				),
				resolveProviderRoute: providerRouteForConfig,
				loadLocalImages: loadRuntimeImages,
				createTurnId: randomUUID,
				clock: () => new Date().toISOString(),
				recordDiagnostic: (event) => tryAppendNodeTrace(
					homeDir,
					sessionId,
					runtimeDiagnosticTraceEvent(event),
				),
				publishLifecycle,
			executionPolicyCoordinator,
			planTools: plannedTools,
			resolveToolCatalog: (capabilities) => {
				const catalog = extensionCatalog.snapshot;
				const exposure = planExtensionToolExposure(catalog.tools.map((tool) => tool.definition), store.loadToolDiscoveries(sessionId));
				const deferredNames = new Set(exposure.deferred.map((definition) => definition.name));
				const deferred = catalog.tools.filter((tool) => deferredNames.has(tool.definition.name));
				return Object.freeze({
					catalogVersion: catalog.version,
					directTools: Object.freeze([...plannedTools(capabilities, deferred, catalog.tools), ...exposure.direct]),
					deferredTools: exposure.deferred,
					skillCatalog: catalog.skillCatalog,
				});
			},
			loadToolActivations: (activeTurnId) => store.loadToolActivations(sessionId, activeTurnId),
			toolRouter,
			hookRunner: integrationComposition.hookRunner,
				contextItemCoordinator,
				...(runtimeOptions.agentCheckpoint ? {
					agentCheckpoint: runtimeOptions.agentCheckpoint,
				} : {}),
				isMutatingTool: runtimeOptions.isMutatingTool
					?? ((toolName) => mutatingAgentTools.has(toolName)),
					approvalPolicy: {
					beginTurn: (turnId) => { approvalPolicy.beginTurn(turnId); },
					finishTurn: (turnId) => { approvalPolicy.finishTurn(turnId); },
					configurePermissionProfile: (profile) => {
					approvalPolicy.configurePermissionProfile(profile);
				},
				evaluate: async (call, executionPolicy, turnId) => {
					await ensureExecPolicyLoaded();
					if (approvalPolicy.hasScopedExtensionTool(call.name, turnId)) {
						approvalPolicy.replaceRememberedExtensions([]);
						approvalPolicy.replaceRememberedExtensions(await integrationApprovals.load());
					}
					return approvalPolicy.evaluate(call, executionPolicy, turnId);
				},
				recordResult: (call, result, executionPolicy, turnId) => {
					approvalPolicy.recordResult(call, result, executionPolicy, turnId);
				},
			},
			approvalCoordinator,
			...(options.approvalMode !== "suspend" ? { parallelApprovals } : {}),
			clarificationCoordinator,
			queueCoordinator,
			providerContinuation,
			memoryContextService,
			writeTerminalSnapshot: async () => {
				const overview = store.loadSession(sessionId);
				if (!overview) throw new SnapshotStateError("terminal session is missing");
				const approval = loadApprovalState(store, sessionId);
				const snapshot = canonicalSnapshot(
					store,
					overview,
					approval.pendingApproval !== undefined,
					approval.pendingClarification !== undefined,
					approval.suspendedTurn,
				);
				await artifactQueue.run(async () => {
					await transcriptSnapshots.write(snapshot);
					await sessionArtifacts.appendEvent({
						sessionId,
						type: "conversation.saved",
						payload: { message_count: snapshot.message_count },
					}).catch(() => undefined);
				});
			},
				createCompactionCoordinator,
			});
			const runtime = agentWorkerPool
				&& agentExecutionAdapters.root === "worker"
				&& !runtimeOptions.subagentContext
				? new WorkerLeasedRootTurnRuntime({
					pool: agentWorkerPool,
					runtime: coordinatorRuntime,
					sessionId,
					recoverInterrupt: (input) => store.recoverInterruptedTurn(
						sessionId,
						input.turnId,
						true,
					),
				})
				: coordinatorRuntime;
			if (runtimeOptions.executionPolicy) {
				runtime.configureExecutionPolicy({
					trust: runtimeOptions.executionPolicy.trusted ? "trusted" : "untrusted",
					permission: runtimeOptions.executionPolicy.permission,
				});
				if (runtimeOptions.executionPolicy.trusted
					&& (runtimeOptions.executionPolicy.network === "enabled"
						|| (runtimeOptions.executionPolicy.readableRoots?.length ?? 0) > 0
						|| runtimeOptions.executionPolicy.writableRoots.length > 0)) {
					executionPolicyCoordinator.grant({
						turnId: sessionId,
						scope: "session",
						permissions: {
							...(runtimeOptions.executionPolicy.network === "enabled"
								? { network: { enabled: true } }
								: {}),
							fileSystem: {
								read: runtimeOptions.executionPolicy.readableRoots ?? [],
								write: runtimeOptions.executionPolicy.filesystem === "workspace_write"
									? runtimeOptions.executionPolicy.writableRoots
									: [],
							},
						},
					});
				}
			}
			const allowancePattern = (value: string): readonly string[] => {
				const parsed = parseShellCommand(value, { shellKind: shellProfile.kind });
				if (parsed.kind !== "plain" || parsed.segments.length !== 1) {
					throw new Error("invalid_arguments: command allowance must be one command prefix");
				}
				return parsed.segments[0]!.words;
			};
			const binding = Object.assign(runtime, {
				sessionPreferences: () => sessionPreferences,
				setSessionPreferences: (preferences: SessionPreferences) => {
					sessionPreferences = preferences;
				},
				ensureSessionPreferences: (input: {
					readonly provider: string;
					readonly model: string;
					readonly reasoningEffort?: ReasoningEffort;
					readonly collaborationMode: "default" | "plan";
					readonly permissionProfile?: PermissionProfile;
				}): SessionPreferences => {
					const base = sessionPreferences
						?? sessionPreferencesFromConfig(
							controlConfig,
							input.collaborationMode,
							input.permissionProfile,
						);
					if (base.provider !== input.provider || base.model !== input.model) {
						throw new SessionTransitionError(
							"session_state_invalid",
							"active model does not match the session preference base",
						);
					}
					const next = Object.freeze({
						...base,
						reasoningEffort: input.reasoningEffort ?? base.reasoningEffort,
						collaborationMode: input.collaborationMode,
						...(input.permissionProfile
							? { permissionProfile: input.permissionProfile }
							: {}),
					});
					if (!sameSessionPreferences(sessionPreferences, next)) {
						saveSessionPreferences(store, {
							sessionId,
							workspaceRoot,
							threadId,
							preferences: next,
						});
						sessionPreferences = next;
					}
					return next;
				},
				integrations: integrationComposition,
				workspaceRoot,
				toolNames: () => allToolExposure.map((tool) => tool.name),
				closeExtensions: () => {
					unsubscribeExtensions?.();
					return integrationComposition.close();
				},
				refreshExtensions,
				listCommandAllowances: () => approvalPolicy.listSessionAllowances(),
				addCommandAllowance: (value: string) => {
					approvalPolicy.allowSession(allowancePattern(value));
					return approvalPolicy.listSessionAllowances();
				},
				removeCommandAllowance: (value: string) => {
					approvalPolicy.removeSessionAllowance(allowancePattern(value));
					return approvalPolicy.listSessionAllowances();
				},
				clearCommandAllowances: () => approvalPolicy.clearSessionAllowances(),
				compact: async (input: { readonly modelOverride?: string; readonly signal: AbortSignal }) => {
					const resolved = await resolveRuntimeConfig(input.modelOverride);
					const commandId = `command_compact_${randomUUID().replaceAll("-", "")}`;
					const startedAt = performance.now();
					const result = await createCompactionCoordinator(resolved).compact({
						clientTurnId: commandId,
						turnId: commandId,
						source: "user_requested",
						conversation: store.loadConversationItems(sessionId),
						freshItemIds: new Set(),
						emit: () => undefined,
						signal: input.signal,
					});
					tryAppendNodeTrace(homeDir, sessionId, runtimeDiagnosticTraceEvent({
						kind: "compaction",
						turnId: commandId,
						source: "user_requested",
						status: result.status,
						beforeTokens: result.beforeTokens,
						afterTokens: result.afterTokens,
						...(result.failure ? { failure: result.failure } : {}),
						...(result.usage ? { usage: result.usage } : {}),
						maxTokens: resolved.maxPromptTokens,
						durationMs: elapsedMonotonicMs(startedAt, performance.now()),
					}));
					return {
						status: result.status,
						beforeTokens: result.beforeTokens,
						afterTokens: result.afterTokens,
						...(result.failure ? { failure: result.failure } : {}),
						...(result.usage ? { usage: result.usage } : {}),
					};
				},
			});
			return binding;
			} catch (error) {
				unsubscribeExtensions?.();
				await integrationComposition.close().catch(() => undefined);
				throw error;
			}
		}).then((binding) => {
			// Mailbox delivery resolves queues through the registry; publish the runtime first.
			const agent = store.agentThreads.get(threadId);
			agentMailbox.repair(Object.freeze({
				threadId: agentThreadId(threadId),
				rootThreadId: agent?.rootThreadId ?? agentThreadId(threadId),
				path: agent?.path ?? rootAgentPath(),
				sessionId,
			}));
			return binding;
		});
		childRuntimeFactoryDelegate.create = async (input) => {
			const runtimeGeneration = randomUUID();
			const runtimeOwnerId = `agent-runtime-${runtimeGeneration}`;
			if (input.purpose !== "reload") {
				store.forkAgentConversation({
					sourceSessionId: input.parentSessionId,
					targetSessionId: input.childSessionId,
					workspaceRoot: input.config.workspaceRoot,
					targetThreadId: input.threadId,
					forkTurns: input.config.forkTurns,
				});
			}
			const runtime = await createRuntime(
				input.childSessionId,
				input.config.workspaceRoot,
				input.childSessionId,
				input.purpose === "reload"
					? loadQueue(store, input.childSessionId)
					: emptyQueue(input.childSessionId),
				input.purpose === "reload"
					? loadResponsesContinuation(store, input.childSessionId)
					: undefined,
			{
				allowedTools: input.tools,
				instructions: input.config.instructions.project,
				subagentContext: input,
					executionPolicy: input.config.executionPolicy,
					provider: input.config.provider,
					environment: input.config.environment,
					agentCheckpoint: (checkpoint) => {
						store.agentThreads.saveLease({
							threadId: input.threadId,
							generation: runtimeGeneration,
							ownerId: runtimeOwnerId,
							ownerPid: process.pid,
							checkpoint,
						});
					},
					...(input.config.budget ? { agentBudget: input.config.budget } : {}),
			},
		);
			let activeTurnId: string | undefined;
			let activeTurn: {
				readonly clientTurnId: string;
				readonly turnId: string;
				readonly emit: Parameters<NodeTurnRuntime["forceInterrupt"]>[1];
				forceInterrupt?: Promise<void>;
			} | undefined;
			let running = false;
			let localAbort: AbortController | undefined;
			const runChild = async (
				prompt: string,
				signal: AbortSignal,
				emit: Parameters<ChildRuntimeHandle["run"]>[2],
				source: "user" | "agent_mailbox",
				turnId: string,
			) => {
				activeTurnId = turnId;
				running = true;
				localAbort = new AbortController();
				const forwardAbort = (): void => { localAbort?.abort(); };
				signal.addEventListener("abort", forwardAbort, { once: true });
				if (signal.aborted) localAbort.abort();
			try {
					const clientTurnId = randomUUID();
					const interactiveTurn = agentInteractiveRequests.openTurn({
						sessionId: input.childSessionId,
						agentPath: input.path,
						workerName: input.path.split("/").at(-1) ?? "subagent",
						runtime,
						signal: localAbort.signal,
						emitLifecycle: emit,
						emitRuntime: (event) => emitChildRuntimeEvent(event, emit),
					});
					const emitRuntime = (event: Parameters<typeof interactiveTurn.onRuntimeEvent>[0]): void => {
						interactiveTurn.onRuntimeEvent(event);
					};
					const currentTurn = {
						clientTurnId,
						turnId,
						emit: emitRuntime,
					};
					activeTurn = currentTurn;
					let result: Awaited<ReturnType<NodeGatewayRuntime["submit"]>>;
					try {
						const submitted = await runtime.submit({
							clientTurnId,
						turnId: activeTurnId,
						message: prompt,
						...(source === "agent_mailbox" ? { source } : {}),
						...(input.model ? { modelOverride: input.model } : {}),
						}, (event) => interactiveTurn.onRuntimeEvent(event), { signal: localAbort.signal });
						result = await interactiveTurn.waitForTerminal(submitted);
					} catch (error) {
						interactiveTurn.fail(error);
						throw error;
					}
					const budgetExhausted = (
						runtime as NodeGatewayRuntime & {
							agentBudgetExhaustion?: () => AgentBudgetExhaustionKind | undefined;
						}
					).agentBudgetExhaustion?.();
					const status = childStatus(result.status);
					return Object.freeze({
						status,
						report: budgetExhausted
							? `Subagent budget exhausted: ${budgetExhausted}`
							: childReport(result),
						usage: childUsage(result),
						...(budgetExhausted ? { budgetExhausted } : {}),
					});
				} finally {
					signal.removeEventListener("abort", forwardAbort);
					activeTurn = undefined;
					running = false;
					localAbort = undefined;
				}
			};
			return {
				run: (prompt, signal, emit, turnId) => runChild(
					prompt,
					signal,
					emit,
					"user",
					turnId,
				),
				runMailbox: (signal, emit, turnId) => runChild(
					"",
					signal,
					emit,
					"agent_mailbox",
					turnId,
				),
				bindProviderStepExecutor: (
					executor: Parameters<NodeTurnRuntime["bindProviderStepExecutor"]>[0],
				) => {
					runtime.bindProviderStepExecutor(executor);
				},
				forceInterrupt: async (_reason: string, turnId: string) => {
					localAbort?.abort();
					const current = activeTurn;
					if (!current || current.turnId !== turnId) return false;
					current.forceInterrupt ??= runtime.forceInterrupt({
						clientTurnId: current.clientTurnId,
						turnId: current.turnId,
					}, current.emit).then(() => undefined);
					await current.forceInterrupt;
					return store.recoverInterruptedTurn(input.childSessionId, turnId, true)
						?.status === "interrupted";
				},
				recoverInterrupt: async (_reason: string, turnId: string) => {
					localAbort?.abort();
					const recovered = store.recoverInterruptedTurn(
						input.childSessionId,
						turnId,
						true,
					);
					return recovered?.status === "interrupted";
				},
				markIdle: () => {
					store.agentThreads.saveLease({
						threadId: input.threadId,
						generation: runtimeGeneration,
						ownerId: runtimeOwnerId,
						ownerPid: process.pid,
						checkpoint: { kind: "idle", committed: true },
					});
				},
			send: async (message) => {
				if (!running || !activeTurnId || !runtime.queueCoordinator) {
					throw new Error("child_runtime_unavailable");
				}
				runtime.queueCoordinator.enqueueSteer({
					sessionId: input.childSessionId,
					clientTurnId: randomUUID(),
					expectedTurnId: activeTurnId,
					activeTurnId,
					steerable: true,
					text: message,
					source: "parent",
				});
			},
			interrupt: async () => {
				localAbort?.abort();
			},
				close: async () => {
					localAbort?.abort();
					store.agentThreads.clearLease(input.threadId, runtimeOwnerId);
					await runtimeRegistry.dispose(input.childSessionId, runtime);
			},
		};
		};
		try {
			startupProfiler.mark("session_prepare_started");
			const prepare = (sessionId: string, intent: "resume" | "inspect" = "resume") => prepareStoredSession({
			sessionId,
			intent,
			store,
			transcriptSnapshots,
			sessionArtifacts,
			artifactQueue,
			createRuntime,
			liveRuntime: runtimeRegistry.get(sessionId),
			fallbackWorkspaceRoot: config.workspaceRoot,
			repairAgentCompletions,
		});
		let initial: PreparedSession<NodeGatewayRuntime>;
		try {
			initial = await prepare(config.sessionId);
		} catch (error) {
			if (!hasCode(error, "session_not_found")) throw error;
				initial = await virtualSession(config.sessionId, config.workspaceRoot, createRuntime);
			}
			startupProfiler.mark("integrations_ready");
			startupProfiler.mark("session_prepared");
			const sessionCoordinator = new SessionCoordinator<NodeGatewayRuntime>({
			initial,
			prepare,
			acquireSession: (sessionId) => store.acquireSessionLease(sessionId),
			releaseSession: (sessionId) => store.releaseSessionLease(sessionId),
			retainSourceSession: true,
			create: (current) => virtualSession(randomUUID(), current.workspaceRoot, createRuntime),
			listSessions: (query) => listSessionsWithVirtualInitial(
				store,
				query ?? {},
				config.sessionId,
				config.workspaceRoot,
			),
			loadSessionLineage: (sessionId) => {
				if (sessionId === config.sessionId && !store.loadSession(sessionId)) {
					return Object.freeze([{ sessionId }]);
				}
				return store.loadSessionLineage(sessionId);
			},
			});
				const initialTrustState = await workspaceTrustStore.load(initial.workspaceRoot);
				const initialPreferences = initial.binding.sessionPreferences?.();
				if (initialPreferences) {
					controlConfig = await resolveWorkspaceModelRuntimeConfig({
						homeDir,
					workspaceRoot: initial.workspaceRoot,
					env: options.env,
					overrides: sessionPreferenceOverrides(initial.sessionId, initialPreferences),
				});
			}
			const credentialReadiness = async (): Promise<NodeGatewayCredentialReadiness> => {
				const active = sessionCoordinator.snapshot();
				const preferences = active.binding.sessionPreferences?.()
					?? loadSessionPreferences(store, active.sessionId)
					?? defaultPreferences;
				const resolved = await resolveWorkspaceModelRuntimeConfig({
					homeDir,
					workspaceRoot: active.workspaceRoot,
					env: options.env,
					overrides: sessionPreferenceOverrides(active.sessionId, preferences),
				});
				return providerCredentialReadiness(resolved, homeDir, options.env);
			};
			const providerDirectory = async (): Promise<readonly JsonObject[]> => providerDirectoryPayload(
				await providerModelDirectory.load(controlConfig),
				homeDir,
				await credentialReadiness(),
			);
			startupProfiler.mark("trust_ready");
			startupProfiler.mark("session_ready");
		const activeRuntime = (): ComposedNodeRuntime | undefined => runtimeRegistry.get(sessionCoordinator.snapshot().sessionId);
		const gatewayIntegrations = integrationGateway(
			() => activeRuntime()?.integrations,
			() => activeRuntime()?.toolNames() ?? [],
			(listener) => {
				const selected = (sessionId: string, version: number): void => {
					if (sessionId === sessionCoordinator.snapshot().sessionId) listener(version);
				};
				extensionListeners.add(selected);
				return () => { extensionListeners.delete(selected); };
			},
			sharedSubagents?.subscribe,
		);
		const closeRuntimeResources = (): Promise<void> => resourceOwner.close();
		const activeMemoryStore = () => new MemoryStore({
			homeDir,
			workspaceRoot: sessionCoordinator.snapshot().workspaceRoot,
		});
			const activeFileHistory = () => new FileHistoryStore({
				homeDir,
				workspaceRoot: sessionCoordinator.snapshot().workspaceRoot,
			});
			const sessionService = new SessionService({
				store,
				currentConfig: () => controlConfig,
				currentPermissionProfile: () => sessionCoordinator.snapshot().binding
					.sessionPreferences?.()?.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
				loadModelCatalog: async (preferences, sessionWorkspaceRoot, sessionId) => {
					const resolved = await resolveWorkspaceModelRuntimeConfig({
						homeDir,
						workspaceRoot: sessionWorkspaceRoot,
						env: options.env,
						overrides: sessionPreferenceOverrides(sessionId, preferences),
					});
					const snapshot = await providerModelDirectory.load(resolved);
					return snapshot.models(preferences.provider);
				},
				hasCredential: async (preferences) => {
					const active = sessionCoordinator.snapshot();
					const resolved = await resolveWorkspaceModelRuntimeConfig({ homeDir, workspaceRoot: active.workspaceRoot,
						env: options.env, overrides: sessionPreferenceOverrides(active.sessionId, preferences) });
					return (await providerCredentialReadiness(resolved, homeDir, options.env)).ready;
				},
				...(managedExecutionPolicy ? { managedExecutionPolicy } : {}),
			});
			const gateway = createNodeGateway({
			sessionId: config.sessionId,
			workspaceRoot: config.workspaceRoot,
			provider: controlConfig.provider,
			model: controlConfig.model,
			reasoningEffort: controlConfig.thinkingEnabled
				? controlConfig.reasoningEffort
				: "none",
			toolNames: activeRuntime()?.toolNames() ?? [],
			maxPromptTokens: () => controlConfig.maxPromptTokens,
			sandboxReadiness: await sandboxReadinessPromise,
			runtime: initial.binding,
			agentInteractiveRequests,
			mcpElicitations,
			loadConversation: (sessionId) => store.loadConversation(sessionId),
			loadProviderAttempts: (input) => store.providerAttemptLedger.list(input),
			loadTranscript: (sessionId) => {
				const active = sessionCoordinator.snapshot();
				if (!active.readOnly
					&& sessionId === active.sessionId
					&& !store.loadSession(sessionId)) {
					return active.transcript;
				}
				return canonicalTranscript(store, sessionId);
			},
			loadTranscriptPage: (sessionId, input) => projectReadableSessionTranscriptPage(
				store,
				sessionId,
				input,
			),
			loadShellOutput: (input) => store.loadShellOutputPage(input),
			loadTurnRollouts: (sessionId) => store.loadTurnRollouts(sessionId),
			memoryCommands: {
				directory: () => activeMemoryStore().directory(),
				scan: async () => (await activeMemoryStore().scan()).map((memory) => ({ ...memory })),
				remember: async (input) => ({ ...await activeMemoryStore().remember(input) }),
				forget: async (query) => (await activeMemoryStore().forget(query)).map((memory) => ({
						...memory,
					})),
				},
					backgroundTaskCommands: {
					list: (parentSessionId) => store.subagentTasks.list(parentSessionId).map((task) => ({
						...task,
					})),
					interrupt: async (parentSessionId, childSessionId) => {
						const task = store.subagentTasks.getByChildSession(parentSessionId, childSessionId);
						if (task?.status !== "running") return false;
						return await sharedSubagents?.controller.interrupt(childSessionId) ?? false;
					},
					interruptAll: async (parentSessionId) => {
						const running = store.subagentTasks.list(parentSessionId)
							.filter((task) => task.status === "running");
						let interrupted = 0;
						for (const task of running) {
							if (await sharedSubagents?.controller.interrupt(task.childSessionId)) {
								interrupted += 1;
							}
						}
						return interrupted;
						},
					},
					validateSelectedSkills: (sessionId, references) => {
						const skills = runtimeRegistry.get(sessionId)?.integrations.skills;
						if (!skills) throw new Error("skills_unavailable");
						for (const reference of references) skills.resolve(reference);
					},
					createReviewRuntime: async ({ sessionId, review, signal }) => {
						const current = runtimeRegistry.get(sessionId);
						if (!current) throw new GatewayFailure("session_changed", "Review session is unavailable.");
						const prepared = await prepareInteractiveReview({ cwd: current.workspaceRoot, review, signal }).catch((error: unknown) => { signal.throwIfAborted(); throw workspaceWorkflowFailure(error); });
						if (prepared.empty) throw new GatewayFailure("invalid_params", "No changes to review.", { additional_details: "No changes to review." });
						signal.throwIfAborted();
						const registryId = `${sessionId}:review:${randomUUID()}`;
						const runtime = await createRuntime(sessionId, current.workspaceRoot, sessionId, current.queueCoordinator!.snapshot(), undefined, {
							registryId, review: { workspaceRoot: prepared.workspaceRoot, revision: prepared.revision }, queueCoordinator: current.queueCoordinator,
							developerInstructions: [prepared.prompt, `Review paths are relative to the Git root ${JSON.stringify(prepared.workspaceRoot)}. Use this root for Read.`, "Write the review as Markdown. For each supported finding include severity, file location, trigger and impact; finish with a concise assessment. If there are no findings, say so. Do not output JSON."],
						});
						let closing: Promise<void> | undefined;
						const close = (): Promise<void> => closing ??= runtimeRegistry.dispose(registryId, runtime);
						try {
							signal.throwIfAborted();
							runtime.configureExecutionPolicy?.({ trust: await workspaceTrustStore.load(current.workspaceRoot), permission: "read-only" });
							signal.throwIfAborted();
							return { runtime, close };
						} catch (error) { await close(); throw error; }
					},
					workspaceCommands: { diff: loadGitWorkspaceDiff, init: repositoryInitPrompt },
					sessionCommands: {
						rename: (sessionId, title) => sessionService.rename(sessionId, title),
						list: (query) => sessionService.list(query),
						inspect: (sessionId) => sessionService.inspect(sessionId),
						previewResume: (sessionId) => sessionService.previewResume(sessionId),
						applyResumeRepair: (input) => sessionService.applyResumeRepair(input),
						fork: (input) => store.forkSession(input),
						search: (query, workspaceRoot) => store.searchMessages(query, {
							workspaceRoot,
							limit: 20,
						}),
							maintenance: (action, workspaceRoot) => {
								if (action === "report") {
									return {
										...store.sessionMaintenanceReport({ workspaceRoot }),
										...transcriptNormalizationReport(config.sessionsDbPath),
										...contentBlobMigrationReport(config.sessionsDbPath),
									};
								}
							if (action === "empty") {
								return { ...store.cleanupEmptySessions({ workspaceRoot }) };
							}
								if (action === "payloads") {
									return { ...store.cleanupLegacySessionPayloads({ workspaceRoot }) };
								}
								if (action === "orphans") return { ...store.cleanupOrphanedSessionRows() };
								if (action === "vacuum") return { ...store.vacuumSessionStorage() };
								if (action === "content_blob_gc") {
									const report = store.sessionMaintenanceReport({ workspaceRoot });
									if (!report.contentBlobs
										|| !("collectSessionContentBlobOrphans" in store)) {
										return {
											status: "not_blob_backed",
											phase: "garbage_collection",
											dryRun: false,
										};
									}
									return {
										status: "collected",
										phase: "garbage_collection",
										...store.collectSessionContentBlobOrphans(),
									};
								}
								if (action === "content_blobs") {
									const preparation = prepareContentBlobMigration(config.sessionsDbPath);
									if (!preparation.cutoverReady) return preparation.result;
									return closeRuntimeResources().then(() => {
										try {
											return cutoverContentBlobMigration(
												config.sessionsDbPath,
												preparation,
											);
										} catch {
											return contentBlobMigrationFailure();
										}
									}).catch(() => contentBlobMigrationFailure());
								}
								const preparation = prepareTranscriptNormalization(config.sessionsDbPath);
								if (!preparation.cutoverReady) return preparation.result;
								return closeRuntimeResources().then(() => {
									try {
										return cutoverTranscriptNormalization(config.sessionsDbPath, preparation);
									} catch {
										return transcriptNormalizationFailure();
									}
								}).catch(() => transcriptNormalizationFailure());
							},
					},
					traceCommands: {
						inspect: (sessionId) => nodeTraceRows(store, homeDir, sessionId),
						export: (sessionId) => nodeTraceRows(store, homeDir, sessionId)
							.map((row) => JSON.stringify(row)),
						logs: () => nodeLogRows(homeDir),
						append: (sessionId, event) => appendNodeTrace(homeDir, sessionId, event),
					},
					updateStatus: startupUpdateStatus,
					updateCommands: {
						status: () => updateCache.status(controlConfig.updatesCheckOnStartup),
						check: () => updateCache.refreshNow(
							controlConfig.updatesCheckOnStartup,
						),
						dismiss: (version) => updateCache.dismiss(
							version,
							controlConfig.updatesCheckOnStartup,
						),
					},
					fileHistoryCommands: {
						list: (sessionId) => activeFileHistory().listSnapshots({ sessionId }),
						undo: (sessionId) => activeFileHistory().undoLatest({ sessionId }),
					},
					controlCommands: {
						authProviders: async () => authProviderPayload(controlConfig, homeDir, await credentialReadiness()),
						credentialReadiness,
						saveApiKey: async (providerId, apiKey, requestedAuthRef) => {
							let provider;
							try {
								provider = parseProviderRouteId(providerId);
							} catch {
								throw controlRequestError("Selected provider route is invalid.");
							}
							const snapshot = await providerModelDirectory.load(controlConfig);
							const route = snapshot.route(provider);
							if (!route || route.activation !== "active") {
								throw controlRequestError("Selected provider route is not active.");
							}
							const profile = isProviderId(provider)
								? resolveProviderProfile(provider, route.protocol)
								: undefined;
							const authRef = requestedAuthRef ?? route.authRef;
							if (authRef !== route.authRef && authRef !== profile?.provider) {
								throw controlRequestError("Credential reference is not active for this provider.");
							}
							await writeApiKey({ homeDir, authRef, apiKey });
							return {
								ok: true,
								provider_id: route.routeId,
								auth_ref: authRef,
								message: `Saved API key for ${route.displayName}.`,
							};
						},
						providers: providerDirectory,
						models: async (providerValue) => {
							let provider;
							try {
								provider = parseProviderRouteId(providerValue);
							} catch {
								throw controlRequestError("Selected provider route is invalid.");
							}
							const snapshot = await providerModelDirectory.load(controlConfig);
							const route = snapshot.route(provider);
							if (!route || route.activation !== "active") {
								throw controlRequestError("Selected provider route is not active.");
							}
							return snapshot.models(provider).map(providerScopedModelPayload);
						},
							selectModel: async (input) => {
							const providerValue = controlString(input.provider, "provider");
							const protocolValue = controlString(input.protocol, "protocol");
							let provider;
							let protocol: ReturnType<typeof parseProtocol>;
							try {
								provider = parseProviderRouteId(providerValue);
								protocol = parseProtocol(protocolValue);
							} catch {
								throw controlRequestError("Selected provider or protocol is not supported.");
							}
							const model = controlString(input.model, "model");
							const apiBaseUrl = controlString(input.base_url, "base_url").replace(/\/+$/u, "");
							const collaborationMode = controlCollaborationMode(input.collaboration_mode);
							const scope = controlModelSelectionScope(input.scope);
							const requestedEffort = controlReasoningEffort(input.reasoning_effort);
							const snapshot = await providerModelDirectory.load(controlConfig);
							const route = snapshot.route(provider);
							if (!route || route.activation !== "active" || route.protocol !== protocol) {
								throw controlRequestError("Selected provider route is not active.");
							}
							const entry = findProviderScopedModelEntry(snapshot, {
								provider,
								protocol,
								model,
								baseUrl: apiBaseUrl,
							});
							if (!entry) {
								throw controlRequestError("Selected model is not available.");
							}
							const reasoningEffort = requestedEffort
								?? entry.defaultReasoningEffort
								?? (entry.supportedReasoningEfforts.length === 1
									? entry.supportedReasoningEfforts[0]
									: undefined);
							if (reasoningEffort && !entry.supportedReasoningEfforts.includes(reasoningEffort)) {
								throw controlRequestError(
									"Selected model does not support that reasoning effort.",
								);
							}
							let apiKey = await readApiKey({ homeDir, authRef: entry.authRef });
							if (
								!apiKey
								&& entry.provider === controlConfig.provider
								&& entry.authRef === controlConfig.authRef
							) {
								apiKey = controlConfig.apiKey;
							}
							if (!apiKey) {
								throw controlRequestError("No API key is configured for the selected model.");
							}
							const nextReasoningEffort = reasoningEffort ?? controlConfig.reasoningEffort;
							const thinkingEnabled = reasoningEffort !== undefined && reasoningEffort !== "none";
							const active = sessionCoordinator.snapshot();
							const preferences = Object.freeze({
								provider: entry.provider,
								protocol,
								model,
								apiBaseUrl: entry.baseUrl,
								authRef: entry.authRef,
								reasoningEffort: thinkingEnabled ? nextReasoningEffort : "none",
								collaborationMode,
							}) satisfies SessionPreferences;
							const inputTokenLimit = modelInputTokenLimit(entry);
							const unresolvedControlConfig = await resolveWorkspaceModelRuntimeConfig({
								homeDir,
								workspaceRoot: active.workspaceRoot,
								env: options.env,
								overrides: sessionPreferenceOverrides(active.sessionId, preferences),
								...(inputTokenLimit === undefined
									? {}
									: {
										defaultMaxPromptTokens: inputTokenLimit,
										maxPromptTokensCeiling: inputTokenLimit,
									}),
							});
							const nextControlConfig = applyProviderScopedModelConfig(
								unresolvedControlConfig,
								entry,
							);
							providerRoutesByConfig.set(nextControlConfig, route);
							if (scope === "user") {
								await writeUserProviderConfig({
									homeDir,
									workspaceRoot: active.workspaceRoot,
									env: options.env,
									workspaceTrust: await workspaceTrustStore.load(active.workspaceRoot),
									...profileInput,
									provider: entry.provider,
									protocol,
									model,
									apiBaseUrl: entry.baseUrl,
									authRef: entry.authRef,
									cacheRetention: nextControlConfig.cacheRetention,
									thinkingEnabled,
									reasoningEffort: nextReasoningEffort,
								});
							}
							saveSessionPreferences(store, {
								sessionId: active.sessionId,
								workspaceRoot: active.workspaceRoot,
								threadId: active.threadId,
								preferences,
							});
							active.binding.setSessionPreferences?.(preferences);
							if (scope === "user") {
								defaultPreferences = Object.freeze({
									...preferences,
									collaborationMode: defaultPreferences.collaborationMode,
									permissionProfile: defaultPreferences.permissionProfile
										?? DEFAULT_PERMISSION_PROFILE,
								});
							}
							controlConfig = nextControlConfig;
							return {
								...providerScopedModelPayload(entry),
								current: true,
								reasoning_effort: reasoningEffort ?? null,
								thinking_enabled: thinkingEnabled,
								scope,
								};
							},
							validateConnectivity: async () => {
								const active = sessionCoordinator.snapshot();
								const preferences = active.binding.sessionPreferences?.()
									?? loadSessionPreferences(store, active.sessionId)
									?? defaultPreferences;
								controlConfig = await resolveCapturedProviderModelConfig({
										homeDir,
										workspaceRoot: active.workspaceRoot,
										env: options.env,
										overrides: sessionPreferenceOverrides(active.sessionId, preferences),
									});
								return validateProviderConnectivity(
									registry,
									controlConfig,
									providerRouteForConfig(controlConfig),
								);
							},
							activateSessionPreferences: async (preferences) => {
							const active = sessionCoordinator.snapshot();
							controlConfig = await resolveWorkspaceModelRuntimeConfig({
								homeDir,
								workspaceRoot: active.workspaceRoot,
								env: options.env,
								overrides: preferences
									? sessionPreferenceOverrides(active.sessionId, preferences)
									: sessionPreferenceOverrides(active.sessionId, defaultPreferences),
							});
							return preferences
								?? sessionPreferencesFromConfig(
									controlConfig,
									"default",
									defaultPreferences.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
								);
						},
						loadSettings: async () => {
							const loaded = await resolveWorkspaceShellSettings(
								sessionCoordinator.snapshot().workspaceRoot,
							);
							return shellSettingsGatewaySnapshot(loaded, detectedTerminalCapabilities);
						},
						saveSetting: async (settingId, value) => {
							const active = sessionCoordinator.snapshot();
							await saveShellSetting({
								homeDir,
								key: settingId,
								value,
								workspaceRoot: active.workspaceRoot,
								env: options.env,
								workspaceTrust: await workspaceTrustStore.load(active.workspaceRoot),
								...profileInput,
							});
							const loaded = await resolveWorkspaceShellSettings(active.workspaceRoot);
							return shellSettingsGatewaySnapshot(loaded, detectedTerminalCapabilities);
						},
						saveSettings: async (settings) => {
							const active = sessionCoordinator.snapshot();
							await saveShellSettings({
								homeDir,
								settings,
								workspaceRoot: active.workspaceRoot,
								env: options.env,
								workspaceTrust: await workspaceTrustStore.load(active.workspaceRoot),
								...profileInput,
							});
							const loaded = await resolveWorkspaceShellSettings(active.workspaceRoot);
							return shellSettingsGatewaySnapshot(loaded, detectedTerminalCapabilities);
						},
						resetKeymap: async () => {
							const active = sessionCoordinator.snapshot();
							await resetTuiKeymap({
								homeDir,
								workspaceRoot: active.workspaceRoot,
								env: options.env,
								workspaceTrust: await workspaceTrustStore.load(active.workspaceRoot),
								...profileInput,
							});
							const loaded = await resolveWorkspaceShellSettings(active.workspaceRoot);
							return shellSettingsGatewaySnapshot(loaded, detectedTerminalCapabilities);
						},
						completePath: (prefix) => pathCompletionCandidates(
							sessionCoordinator.snapshot().workspaceRoot,
							prefix,
						),
					},
				sessionCoordinator,
			shellManager,
			shellLifecycle,
			workspaceTrust: {
				initialState: initialTrustState,
				load: (workspaceRoot) => workspaceTrustStore.load(workspaceRoot),
				save: (workspaceRoot, state) => workspaceTrustStore.save(workspaceRoot, state),
				reload: async (workspaceRoot, state) => {
					const active = sessionCoordinator.snapshot();
					const persistedPreferences = active.workspaceRoot === workspaceRoot
						? active.binding.sessionPreferences?.()
							?? loadSessionPreferences(store, active.sessionId)
						: undefined;
					const nextControlConfig = await resolveWorkspaceModelRuntimeConfig({
						homeDir,
						workspaceRoot,
						env: options.env,
						overrides: persistedPreferences
							? sessionPreferenceOverrides(active.sessionId, persistedPreferences)
							: { ...overrides, session: active.sessionId },
					}, state);
					await activeRuntime()?.integrations.reloadProjectConfiguration({
						workspaceRoot,
						enabled: state === "trusted",
					});
					for (const listener of extensionListeners) listener(active.sessionId, activeRuntime()?.integrations.version ?? 1);
					controlConfig = nextControlConfig;
					const nextPreferences = sessionPreferencesFromConfig(
						nextControlConfig,
						persistedPreferences?.collaborationMode ?? defaultPreferences.collaborationMode,
						persistedPreferences?.permissionProfile
							?? defaultPreferences.permissionProfile
							?? DEFAULT_PERMISSION_PROFILE,
					);
					if (!persistedPreferences) defaultPreferences = nextPreferences;
					return nextPreferences;
				},
			},
			integrations: gatewayIntegrations,
			pluginCatalog: async (workspaceRoot) => new PluginCatalogService({ homeDir, workspaceRoot,
				includeRepository: await workspaceTrustStore.load(workspaceRoot) === "trusted" }),
				close: () => resourceOwner.close(),
		});
			for (const recovered of recoveredInterrupts) {
			gateway.publishRecoveredInterrupt(recovered.record, {
				inputRolledBack: recovered.inputRolledBack,
			});
			}
			startupProfiler.mark("gateway_ready");
			updateCache.startBackgroundRefresh(config.updatesCheckOnStartup);
			return Object.freeze({
				transport: gateway.transport,
				completion: gateway.completion,
				close: () => gateway.close(),
				kill: () => gateway.kill(),
				diagnostic: () => gateway.diagnostic(),
				startupProfile: () => startupProfiler.snapshot(),
			});
	} catch (error) {
		await resourceOwner.close().catch(() => undefined);
		throw error;
	}
}

async function providerDirectoryPayload(
	snapshot: ProviderModelDirectorySnapshot,
	homeDir: string,
	currentCredential: NodeGatewayCredentialReadiness,
): Promise<readonly JsonObject[]> {
	const storedCredentials = new Map(await Promise.all(
		[...new Set(snapshot.routes.map((route) => route.authRef))].map(async (authRef) => [
			authRef,
			Boolean(await readProviderCredential({ homeDir, authRef })),
		] as const),
	));
	const activeRouteIds = new Set(snapshot.routes.map((route) => route.routeId));
	const active = snapshot.routes.map((route) => {
		const current = route.routeId === currentCredential.providerId;
		const credential = current && route.authRef === currentCredential.authRef
			? currentCredential
			: {
				ready: storedCredentials.get(route.authRef) === true,
				source: storedCredentials.get(route.authRef) ? "stored" : "missing",
			};
		return Object.freeze({
			id: route.routeId,
			name: route.displayName,
			support_tier: route.supportTier,
			source: route.source,
			...(route.catalogProviderId === undefined
				? {}
				: { catalog_provider_id: route.catalogProviderId }),
			protocols: Object.freeze([route.protocol]),
			protocol: route.protocol,
			base_url: route.apiBaseUrl,
			auth_ref: route.authRef,
			activation: route.activation,
			configured: true,
			ready: credential.ready,
			credential_source: credential.source,
			current,
			model_count: snapshot.models(route.routeId).length,
		});
	});
	const dormant = snapshot.catalog.providers
		.filter((provider) => !activeRouteIds.has(provider.catalogProviderId))
		.map((provider) => Object.freeze({
			id: provider.catalogProviderId,
			name: provider.name,
			support_tier: "experimental",
			source: "pi_ai_builtin",
			catalog_provider_id: provider.catalogProviderId,
			protocols: Object.freeze([...provider.protocols]),
			activation: provider.status === "unsupported" ? "unserviceable" : "inactive",
			configured: false,
			ready: false,
			current: false,
			endpoint_required: provider.endpointRequired,
			model_count: provider.models.length,
			...(provider.disabledReason === undefined
				? {}
				: { disabled_reason: provider.disabledReason }),
		}));
	return Object.freeze([...active, ...dormant]);
}

async function validateProviderConnectivity(
	registry: ProviderRegistry,
	config: NodeRuntimeConfig,
	route: ProviderRouteDescriptor,
): Promise<Record<string, unknown>> {
	if (!config.apiKey && !config.nativeTransport) {
		return { ok: false, message: "No API key is configured for the selected provider." };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => { controller.abort(); }, PROVIDER_CONNECTIVITY_TIMEOUT_MS);
	timer.unref?.();
	const request: ProviderRequest = {
		provider: config.provider,
		protocol: config.protocol,
		model: config.model,
		...(config.nativeTransport ? { nativeTransport: config.nativeTransport } : {}),
		reasoningEffort: "none",
		instructions: "This is a connectivity check.",
		messages: [{ role: "user", content: "Reply with OK." }],
		tools: [],
		maxOutputTokens: 8,
		sessionId: config.sessionId,
		cacheRetention: config.cacheRetention,
	};
	try {
		for await (const event of registry.create(config, route).stream(
			request,
			{ signal: controller.signal },
		)) {
			if (event.type === "completed") {
				return { ok: true, message: "Provider connection verified." };
			}
		}
		return { ok: false, message: "The provider ended the check without completing it." };
	} catch {
		return { ok: false, message: "Unable to reach the selected provider." };
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

function sessionPreferenceOverrides(
	sessionId: string,
	preferences: SessionPreferences,
): NonNullable<ResolveConfigOptions["overrides"]> {
	return {
		session: sessionId,
		provider: preferences.provider,
		protocol: preferences.protocol,
		model: preferences.model,
		apiBaseUrl: preferences.apiBaseUrl,
		...(preferences.authRef !== preferences.provider ? { authRef: preferences.authRef } : {}),
		reasoningEffort: preferences.reasoningEffort,
		thinkingEnabled: preferences.reasoningEffort !== "none",
	};
}

function controlString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`invalid_arguments: ${name} is required`);
	}
	return value.trim();
}

function controlCollaborationMode(value: unknown): "default" | "plan" {
	if (value === "default" || value === "plan") return value;
	throw new Error("invalid_arguments: unsupported collaboration_mode");
}

function controlRequestError(message: string): Error & { readonly code: "invalid_params" } {
	return Object.assign(new Error(message), { code: "invalid_params" as const });
}

function controlReasoningEffort(value: unknown): ReasoningEffort | undefined {
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
	) return value;
	throw new Error("invalid_arguments: unsupported reasoning_effort");
}

function controlModelSelectionScope(value: unknown): ModelSelectionScope {
	if (value === undefined) return "session";
	if (isModelSelectionScope(value)) return value;
	throw controlRequestError("Model selection scope is not supported.");
}

async function pathCompletionCandidates(
	workspaceRoot: string,
	token: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
	if (!token.startsWith("@")) return [];
	const raw = token.slice(1);
	if (raw === ".." || raw.startsWith("../") || isAbsolute(raw)) return [];
	let root: string;
	let parent: string;
	try {
		root = await realpath(workspaceRoot);
		const base = resolve(root, raw);
		parent = await realpath(raw.endsWith("/") ? base : dirname(base));
	} catch {
		return [];
	}
	if (!withinWorkspace(parent, root)) return [];
	const prefix = raw.endsWith("/") ? "" : basename(raw);
	let children;
	try {
		children = await readdir(parent, { withFileTypes: true });
	} catch {
		return [];
	}
	const items: Readonly<Record<string, unknown>>[] = [];
	for (const child of children.sort((left, right) => left.name.localeCompare(right.name)).slice(0, 200)) {
		if (prefix && !child.name.startsWith(prefix)) continue;
		const childPath = join(parent, child.name);
		let resolvedChild: string;
		let directory: boolean;
		try {
			resolvedChild = await realpath(childPath);
			directory = (await stat(resolvedChild)).isDirectory();
		} catch {
			continue;
		}
		if (!withinWorkspace(resolvedChild, root)) continue;
		const relativePath = relative(root, childPath).split(sep).join("/");
		items.push(Object.freeze({
			value: `@${relativePath}${directory ? "/" : ""}`,
			kind: directory ? "directory" : "file",
		}));
	}
	return Object.freeze(items);
}

function withinWorkspace(path: string, root: string): boolean {
	const candidate = relative(root, path);
	return candidate === ""
		|| (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

function filterToolDefinitions<Value extends { readonly name: string }>(
	definitions: readonly Value[],
	allowed: readonly string[] | undefined,
): readonly Value[] {
	if (!allowed) return definitions;
	const names = new Set(allowed);
	return Object.freeze(definitions.filter((definition) => names.has(definition.name)));
}

function runtimeToolExposure(
	builtinManifest: BuiltInToolManifest,
	direct: readonly ToolDefinition[],
	deferred: readonly IntegrationRegistration[],
	requestPermissionsToolEnabled: boolean,
): readonly ToolDefinition[] {
	return Object.freeze([
		...planToolExposure(builtinManifest, {
			shell: true,
			requestPermissionsTool: requestPermissionsToolEnabled,
			collaborationMode: "plan",
		}),
		...direct,
		...deferred.filter((registration) => registration.modelVisible !== false)
			.map((registration) => registration.definition),
	]);
}

function deferredCandidates(registrations: readonly IntegrationRegistration[]): readonly ExtensionCatalogTool[] {
	return registrations.flatMap((registration) => (
		registration.source === "mcp" || registration.source === "plugin"
			? [{
				adapter: registration.adapter,
				definition: registration.definition,
				source: registration.source,
				originMetadata: registration.originMetadata,
				...(registration.sourceDescription === undefined ? {} : { sourceDescription: registration.sourceDescription }),
			}]
			: []
	));
}

function mutatingTools(manifest: CombinedToolManifest): Set<string> {
	return new Set(manifest.tools.flatMap((tool) => {
		if (!("effects" in tool)) return [tool.name];
		return tool.effects.filesystem === "write" || tool.effects.network || tool.effects.process
			? [tool.name]
			: [];
	}));
}

function integrationGateway(
	current: () => RuntimeIntegrationComposition | undefined,
	toolNames: () => readonly string[],
	subscribeExtensions: NonNullable<NodeGatewayIntegrations["subscribeExtensions"]>,
	subscribeSubagents: NodeGatewayIntegrations["subscribeSubagents"],
): NodeGatewayIntegrations {
	const commands = combinedIntegrationCommands(() => current()?.commands ?? []);
	const integrations: NodeGatewayIntegrations = {
		get skills() { return current()?.skills; },
		get hookManagement() { return current()?.hookManagement; },
		refresh: () => current()?.refreshConfiguration() ?? Promise.resolve(),
		toolManifest: () => current()?.manifest as unknown as Record<string, unknown>,
		diagnostics: () => current()?.diagnostics.map((diagnostic) => ({ ...diagnostic })) ?? [],
		toolNames,
		listResources: () => current()?.resources.map((resource) => ({ ...resource })) ?? [],
		commands: {
			list: () => commands.list(),
			run: async (command, signal) => {
				const composition = current();
				if (!composition) return undefined;
				const owner = `plugin-command:${randomUUID()}`;
				await composition.prepareRun(owner, signal);
				try { return await combinedIntegrationCommands(() => composition.commands).run(command, signal); }
				finally { composition.finishRun(owner); }
			},
		},
		subscribeSubagents,
		subscribeExtensions,
	};
	return Object.freeze(integrations);
}

function combinedIntegrationCommands(
	services: () => readonly IntegrationCommandService[],
): NodeGatewayIntegrationCommands {
	const commands: NodeGatewayIntegrationCommands = {
		list: () => services().flatMap((service) => service.list().map((command) => ({ ...command }))),
		run: async (command: string, signal: AbortSignal) => {
			for (const service of services()) {
				const result = await service.run(command, signal);
				if (result) return { ...result };
			}
			return undefined;
		},
	};
	return Object.freeze(commands);
}

function workspaceInstructionsForTrust(
	workspaceRoot: string,
	trusted: boolean,
): ReturnType<typeof loadWorkspaceInstructions> {
	if (trusted) {
		return loadWorkspaceInstructions({ workspaceRoot, cwd: workspaceRoot });
	}
	return Object.freeze({
		content: "",
		diagnostics: Object.freeze({
			searchRoots: Object.freeze([]),
			truncated: false,
			originalLength: 0,
			renderedLength: 0,
			blocked: true,
			issues: Object.freeze(["workspace_not_trusted"]),
		}),
	});
}

function emitChildRuntimeEvent(
	event: RuntimeEvent,
	emit: (event: ChildRuntimeEvent) => void,
): void {
	if (event.type === "tool_execution_started") {
		emit({ type: "progress", summary: `Started ${event.toolName}` });
	} else if (event.type === "tool_execution_completed" || event.type === "tool_execution_failed") {
		emit({ type: "progress", summary: event.summary });
	} else if (event.type === "turn_completed") {
		emit({ type: "usage", usage: numericUsage(event.usage) });
	}
}

function childStatus(
	status: "in_progress" | "completed" | "failed" | "interrupted",
): "completed" | "failed" | "interrupted" {
	return status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
}

function childReport(turn: Awaited<ReturnType<NodeGatewayRuntime["submit"]>>): string {
	const result = turn.result;
	return result && typeof result.assistant_text === "string"
		? result.assistant_text
		: turn.status === "interrupted"
			? "Subagent interrupted"
			: turn.status === "completed"
				? "Subagent completed"
				: "Subagent failed";
}

function childUsage(
	turn: Awaited<ReturnType<NodeGatewayRuntime["submit"]>>,
): Readonly<Record<string, number>> {
	const usage = turn.result?.usage;
	return typeof usage === "object" && usage !== null && !Array.isArray(usage)
		? numericUsage(usage as Readonly<Record<string, unknown>>)
		: Object.freeze({});
}

function numericUsage(
	usage: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
	return Object.freeze(Object.fromEntries(Object.entries(usage).flatMap(([key, value]) => (
		typeof value === "number" && Number.isFinite(value) && value >= 0
			? [[key.slice(0, 64), value]]
			: []
	))));
}

function compactionThresholdForModel(config: NodeRuntimeConfig): number {
	const ratio = config.compactionTriggerRatiosByModel[config.model];
	if (ratio === undefined) return config.compactionTokenLimit;
	let buffer = config.compactionBufferTokens;
	if (config.maxPromptTokens <= buffer) {
		buffer = Math.max(0, Math.trunc(config.maxPromptTokens * 0.2));
	}
	return Math.max(1, Math.min(
		Math.trunc(config.maxPromptTokens * ratio),
		config.maxPromptTokens - buffer,
	));
}

function compactionSummaryOutputTokens(config: NodeRuntimeConfig): number {
	const desired = Math.max(
		MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
		config.compactionExpectedSummaryTokens,
	);
	return config.maxOutputTokens === undefined
		? desired
		: Math.min(desired, config.maxOutputTokens);
}

function totalCompactionBudget(threshold: number, reservedOutputTokens: number): number {
	const total = threshold + reservedOutputTokens;
	if (!Number.isSafeInteger(total) || total <= reservedOutputTokens) {
		throw new Error("config_error: compaction token budget is not representable");
	}
	return total;
}

function agentExecutionPolicySnapshot(
	snapshot: ExecutionPolicySnapshot | undefined,
): AgentExecutionPolicySnapshot {
	const profile = snapshot?.profile;
	const filesystem = profile?.filesystem ?? "read_only";
	const permission = filesystem === "unrestricted"
		? "full-access"
		: filesystem === "workspace_write"
			? "workspace"
			: "read-only";
	return Object.freeze({
		trusted: snapshot?.trusted === true && snapshot.valid,
		permission,
		sandboxMode: profile?.mode ?? "read-only",
		filesystem,
		network: profile?.network ?? "disabled",
		...(profile?.networkDomains === undefined ? {} : {
			networkDomains: Object.freeze([...profile.networkDomains]),
		}),
		...(profile?.readableRoots === undefined ? {} : {
			readableRoots: Object.freeze([...profile.readableRoots]),
		}),
		writableRoots: Object.freeze([...(profile?.writableRoots ?? [])]),
	});
}

function agentExecutionPolicyForRun(
	snapshot: RunExecutionSnapshot | undefined,
): AgentExecutionPolicySnapshot {
	const policy = snapshot?.policy;
	if (!policy) return agentExecutionPolicySnapshot(undefined);
	return agentExecutionPolicySnapshot(Object.freeze({
		trusted: policy.toolsEnabled,
		valid: true,
		profile: policy.profile,
	}));
}

function inheritedAgentExecutionPolicyConstraints(
	policy: AgentExecutionPolicySnapshot,
): ExecutionPolicyConstraints {
	return Object.freeze({
		source: "runtime" as const,
		network: policy.network,
		...(policy.networkDomains === undefined ? {} : {
			networkDomains: Object.freeze([...policy.networkDomains]),
		}),
		...(policy.readableRoots === undefined ? {} : {
			readableRoots: Object.freeze([...policy.readableRoots]),
		}),
		...(policy.filesystem === "unrestricted" ? {} : {
			writableRoots: Object.freeze([...policy.writableRoots]),
		}),
	});
}

const AGENT_ENVIRONMENT_KEYS = Object.freeze([
	"HOME",
	"USERPROFILE",
	"PATH",
	"SHELL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"TERM",
	"COLORTERM",
	"MYCLI_CI",
	"MYCLI_RIPGREP_PATH_DIR",
]);
const AGENT_ENVIRONMENT_VALUE_MAX_CHARS = 32_768;

function agentEnvironmentSnapshot(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
	return Object.freeze(Object.fromEntries(AGENT_ENVIRONMENT_KEYS.flatMap((key) => {
		const value = env[key];
		return typeof value === "string"
			&& value.length > 0
			&& value.length <= AGENT_ENVIRONMENT_VALUE_MAX_CHARS
			&& !value.includes("\0")
			? [[key, value] as const]
			: [];
	})));
}

function subagentDeveloperContext(
	input: ChildRuntimeCreateInput,
	effectiveTools: readonly string[],
): string {
	const taskName = input.path.split("/").filter(Boolean).at(-1) ?? "subagent-task";
	return [
		"You are a subagent operating under the parent agent's delegated authority.",
		`Agent path: ${input.path}`,
		`Assigned task: ${taskName}`,
		`Tool scope: ${effectiveTools.length > 0 ? [...effectiveTools].sort().join(", ") : "none"}`,
		`Permission profile: ${input.config.executionPolicy.permission}`,
		`Sandbox mode: ${input.config.executionPolicy.sandboxMode}`,
		`Filesystem policy: ${input.config.executionPolicy.filesystem}`,
		`Network policy: ${input.config.executionPolicy.network}`,
		"Complete only the user task supplied by the parent and report the result clearly.",
	].join("\n");
}

function shellSettingsGatewaySnapshot(
	loaded: LoadedShellSettings,
	detected: DetectedTerminalCapabilities,
): Readonly<Record<string, unknown>> {
	const capabilities = resolveTerminalCapabilities(loaded.settings, detected);
	return Object.freeze({
		settings: Object.freeze({ ...loaded.settings }),
		sources: Object.freeze({ ...loaded.sources }),
		keymap: Object.freeze({
			version: 1,
			bindings: cloneReadonlyLists(loaded.keymap.bindings),
			sources: Object.freeze({ ...loaded.keymap.sources }),
			overridden: cloneReadonlyLists(loaded.keymap.overridden),
		}),
		terminal_capabilities: Object.freeze({
			version: capabilities.version,
			color_mode: capabilities.colorMode,
			color_forced_off: capabilities.colorForcedOff,
			glyph_mode: capabilities.glyphMode,
			terminal_kind: capabilities.terminalKind,
			progress_visible: capabilities.progressVisible,
			progress_animated: capabilities.progressAnimated,
			reduced_motion: capabilities.reducedMotion,
			high_contrast: capabilities.highContrast,
			guidance: Object.freeze([...capabilities.guidance]),
		}),
	});
}

function cloneReadonlyLists(
	values: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
	return Object.freeze(Object.fromEntries(
		Object.entries(values).map(([key, items]) => [key, Object.freeze([...items])]),
	));
}

interface ParsedRuntimeArguments {
	readonly overrides: { readonly model?: string; readonly session?: string };
	readonly configProfile?: ConfigProfileName;
}

function parseRuntimeArguments(args: readonly string[]): ParsedRuntimeArguments {
	const overrides: { model?: string; session?: string } = {};
	let configProfile: ConfigProfileName | undefined;
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if ((flag !== "--model" && flag !== "--session" && flag !== "--profile")
			|| value === undefined) {
			throw new Error("invalid_arguments: invalid Node runtime arguments");
		}
		if (flag === "--model") overrides.model = value;
		if (flag === "--session") overrides.session = value;
		if (flag === "--profile") {
			if (configProfile) throw new Error("invalid_arguments: duplicate --profile");
			configProfile = parseConfigProfileName(value);
		}
	}
	return Object.freeze({
		overrides: Object.freeze(overrides),
		...(configProfile ? { configProfile } : {}),
	});
}

function runtimeHome(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}
