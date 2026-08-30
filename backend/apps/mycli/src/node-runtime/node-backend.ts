import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	isModelSelectionScope,
	parseRuntimeState,
	type ModelSelectionScope,
	type RuntimeTurnRecord,
} from "@mycli/contracts";
import {
	ExecPolicyStore,
	findModelCatalogEntry,
	listProviderProfiles,
	loadModelCatalog,
	loadManagedExecutionPolicy,
	loadShellSettings,
	modelCatalogEntryPayload,
	parseProtocol,
	readApiKey,
	resolveModelRuntimeConfig,
	resolveProviderProfile,
	saveShellSettings,
	writeApiKey,
	writeUserProviderConfig,
	WorkspaceTrustStore,
} from "@mycli/config";
import type { NodeRuntimeConfig, ResolveConfigOptions } from "@mycli/config";
import type {
	AgentBudget,
	AgentBudgetExhaustionKind,
	AgentCanonicalEvent,
	AgentExecutionPolicySnapshot,
	AgentProviderSnapshot,
	QueueSnapshot,
	QueuedInput,
	ReasoningEffort,
	RuntimeEvent,
	ShellLifecycleEvent,
} from "@mycli/core";
import {
	agentThreadId,
	modelInputSha256,
	narrowAgentExecutionPolicy,
	rootAgentPath,
} from "@mycli/core";
import {
	skillInvocationArtifactFromMetadata,
	serializeSubagentTaskNotification,
	type IntegrationRegistration,
	type ChildRuntimeCreateInput,
	type ChildRuntimeEvent,
	type ChildRuntimeFactory,
	type ChildRuntimeHandle,
	type WaitAgentActivityContract,
	type WaitAgentActivityInput,
} from "@mycli/integrations";
import { ProviderRegistry } from "@mycli/providers";
import {
	ApprovalContinuationCoordinator,
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
	resolveAgentExecutionAdapters,
	loadWorkspaceInstructions,
	ProviderContinuationCoordinator,
	QueueCoordinator,
	SessionCoordinator,
	SessionTransitionError,
	ShellLifecycleProjector,
	summarizeCompactionWithProvider,
	TokenCounter,
	WorkerLeasedAgentThreadRuntimeFactory,
	WorkerLeasedRootTurnRuntime,
} from "@mycli/runtime";
import type {
	ExecutionPolicyConstraints,
	ExecutionPolicySnapshot,
	NodeTurnRuntimeOptions,
	PendingSessionApproval,
	PendingSessionClarification,
	PreparedSession,
	RuntimeDiagnosticEvent,
} from "@mycli/runtime";
import {
	SessionArtifactStore,
	sessionSubagentIndexEntry,
	subagentRunId,
	SnapshotStateError,
	openRuntimeSessionStore,
	TranscriptSnapshotStore,
} from "@mycli/storage";
import type {
	AgentThreadRecord,
	LegacySnapshotMessage,
	RuntimeSessionStore,
	SessionListQuery,
	SessionOverview,
	TranscriptItem,
	TranscriptSnapshotV2,
	SubagentTaskRecord,
	WriteSubagentSnapshotInput,
} from "@mycli/storage";
import {
	ApprovalPolicy,
	AskUserQuestionTool,
	BashOutputTool,
	BashTool,
	builtinToolManifest,
	EditTool,
	FileHistoryStore,
	FileMutationRuntime,
	FileSnapshotStore,
	PatchTool,
	planToolExposure,
	parseShellCommand,
	permissionRequestFromJson,
	ReadTool,
	RequestPermissionsTool,
	resolveShellProfile,
	ShellOutputTool,
	ShellSessionManager,
	ShellTool,
	startNodePtyTransport,
	startPipeTransport,
	ToolRouter,
	ToolSearchTool,
	KillShellTool,
	type BuiltInToolManifest,
	type CombinedToolManifest,
	type ToolAdapter,
	UpdatePlanTool,
	WebFetchTool,
	loadLocalImages,
	WriteStdinTool,
	WriteTool,
} from "@mycli/tools";
import type { ToolDefinition } from "@mycli/core";
import {
	createRuntimeIntegrationComposition,
	partitionRuntimeToolRegistrations,
	type IntegrationCommandService,
	type RuntimeIntegrationComposition,
} from "./integration-composition.ts";
import {
	createNodeGateway,
	type NodeGateway,
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
	projectReadableSessionTranscript,
	projectReadableSessionTranscriptPage,
	projectRecentSessionTranscript,
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

export interface NodeBackend {
	readonly transport: NodeGateway["transport"];
	readonly completion: Promise<number>;
	close(): Promise<void>;
	kill(): void;
	diagnostic(): string;
	startupProfile?(): StartupProfileSnapshot | undefined;
}

export interface RecoverInterruptedTurnOptions {
	readonly sessionId: string;
	readonly turnId: string;
	readonly inputRolledBack?: boolean;
	readonly userInitiated: boolean;
}

export interface StartNodeBackendOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly args: readonly string[];
	readonly sessionOwnerId?: string;
	readonly maxOutputTokens?: number;
	readonly recoverInterruptedTurns?: readonly RecoverInterruptedTurnOptions[];
}

type ComposedNodeRuntime = NodeGatewayRuntime & Pick<
	NodeTurnRuntime,
	"bindProviderStepExecutor"
>;

const DEFAULT_AGENT_MAX_RESIDENTS = 4;
const DEFAULT_AGENT_MAX_DEPTH = 1;
const DEFAULT_AGENT_WORKER_INTERRUPT_TIMEOUT_MS = 12_000;
const MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS = 4_096;

export async function startNodeBackend(options: StartNodeBackendOptions): Promise<NodeBackend> {
	const startupProfiler = new StartupProfiler({
		enabled: startupProfileEnabled(options.env),
		scope: "backend",
		origin: 0,
	});
	startupProfiler.mark("runtime_entered");
	const overrides = parseOverrides(options.args);
	const agentExecutionAdapters = resolveAgentExecutionAdapters(options.env);
	const agentWorkerSettings = resolveAgentWorkerSettings(options.env);
	const homeDir = runtimeHome(options.env);
	const managedExecutionPolicy = await loadManagedExecutionPolicy({ homeDir });
	const workspaceTrustStore = new WorkspaceTrustStore({ homeDir });
	const resolveWorkspaceModelRuntimeConfig = async (
		input: ResolveConfigOptions,
	): Promise<NodeRuntimeConfig> => resolveModelRuntimeConfig({
		...input,
		workspaceTrust: await workspaceTrustStore.load(input.workspaceRoot),
	});
	let startupTrustState = await workspaceTrustStore.load(options.cwd);
	let config = await resolveModelRuntimeConfig({
		homeDir,
		workspaceRoot: options.cwd,
		env: options.env,
		overrides,
		workspaceTrust: startupTrustState,
	});
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
			config = await resolveModelRuntimeConfig({
				homeDir,
				workspaceRoot: persisted.workspaceRoot,
				env: options.env,
				overrides,
				workspaceTrust: startupTrustState,
			});
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
	let defaultPreferences = sessionPreferencesFromConfig(config, "default");
	startupProfiler.mark("config_ready");
	startupProfiler.mark("storage_ready");
	const productSystemPrompt = packagedSystemPrompt();
	const registry = new ProviderRegistry();
	const agentWorkerPool = Object.values(agentExecutionAdapters).includes("worker")
		? new AgentWorkerPool(agentWorkerSettings)
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
	const runtimeBySessionId = new Map<string, NodeGatewayRuntime>();
	const agentInteractiveRequests = new AgentInteractiveRequestBroker();
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
		queueForSession: (sessionId) => runtimeBySessionId.get(sessionId)?.queueCoordinator,
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
			const queue = runtimeBySessionId.get(input.parentSessionId)?.queueCoordinator;
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
	let integrationComposition: RuntimeIntegrationComposition;
	try {
		integrationComposition = await createRuntimeIntegrationComposition({
			builtinManifest: toolManifest,
			workspaceRoot: config.workspaceRoot,
			homeDir,
			env: options.env,
			projectConfigurationEnabled: startupTrustState === "trusted",
			parentSessionId: config.sessionId,
			parentTurnId: () => "parent-turn-unavailable",
			parentTools: () => allToolExposure.map((tool) => tool.name),
			createSubagentSupervisor: (supervisorOptions) => {
					agentSupervisor = new AgentSupervisor({
						spawnStore: store.agentSpawns,
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
				const parentPreferences = runtimeBySessionId.get(input.parentSessionId)
					?.sessionPreferences?.();
				const resolved = await resolveWorkspaceModelRuntimeConfig({
					homeDir,
					workspaceRoot,
					env: options.env,
					overrides: sessionPreferenceOverrides(
						input.childSessionId,
						parentPreferences ?? defaultPreferences,
					),
				});
				const executionPolicy = narrowAgentExecutionPolicy(agentExecutionPolicySnapshot(
					runtimeBySessionId.get(input.parentSessionId)?.executionPolicySnapshot?.(),
				));
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
						forkTurns: "none" as const,
					}),
				});
			},
			agentActivity,
				agentMailbox,
			resolveAgentRouteContext,
			onStartupStage: (stage) => { startupProfiler.mark(stage); },
			});
		publishSubagentProjection = (value) => { integrationComposition.publishSubagent(value); };
		startupProfiler.mark("integrations_ready");
	} catch (error) {
		try {
			await agentWorkerPool?.close().catch(() => undefined);
		} finally {
			try {
				await shellManager.close().catch(() => undefined);
			} finally {
				try {
					await shellLifecycle.drain();
				} finally {
					try {
						await artifactQueue.drain();
					} finally {
						store.close();
					}
				}
			}
		}
		throw error;
	}
	const partitionedRegistrations = partitionRuntimeToolRegistrations(integrationComposition.registrations);
	const directExtensionRegistrations = partitionedRegistrations.direct;
	const staticDeferredRegistrations = partitionedRegistrations.deferred.filter(
		(registration) => registration.source !== "mcp",
	);
	const directExtensionDefinitions = Object.freeze(directExtensionRegistrations
		.map((registration) => registration.definition));
	const currentDeferredRegistrations = () => partitionRuntimeToolRegistrations(
		integrationComposition.registrations,
	).deferred;
	let allToolExposure = runtimeToolExposure(
		toolManifest,
		directExtensionDefinitions,
		currentDeferredRegistrations(),
		requestPermissionsToolEnabled,
	);
	const mutatingAgentTools = mutatingTools(integrationComposition.manifest);
	const refreshRuntimeExtensions = (): void => {
		allToolExposure = runtimeToolExposure(
			toolManifest,
			directExtensionDefinitions,
			currentDeferredRegistrations(),
			requestPermissionsToolEnabled,
		);
		for (const name of mutatingTools(integrationComposition.manifest)) mutatingAgentTools.add(name);
		for (const runtime of runtimeBySessionId.values()) runtime.refreshExtensions?.();
	};
	const unsubscribeRuntimeExtensions = integrationComposition.subscribeExtensions(() => {
		refreshRuntimeExtensions();
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
		): ComposedNodeRuntime => {
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
				const resolved = await resolveWorkspaceModelRuntimeConfig({
					homeDir,
					workspaceRoot,
					env: options.env,
					overrides: {
						session: sessionId,
						...(preferences ? {
							provider: preferences.provider,
							protocol: preferences.protocol,
							apiBaseUrl: preferences.apiBaseUrl,
							authRef: preferences.authRef,
							reasoningEffort: preferences.reasoningEffort,
							thinkingEnabled: preferences.reasoningEffort !== "none",
						} : {}),
						model: runtimeOptions.provider?.model
							?? modelOverride
							?? preferences?.model
							?? defaultPreferences.model,
					},
				});
				if (!runtimeOptions.provider) return resolved;
				return Object.freeze({
					...resolved,
					provider: runtimeOptions.provider.provider,
					protocol: runtimeOptions.provider.protocol,
					model: runtimeOptions.provider.model,
					reasoningEffort: runtimeOptions.provider.reasoningEffort ?? "none",
					thinkingEnabled: (runtimeOptions.provider.reasoningEffort ?? "none") !== "none",
				});
			};
			const fileSnapshots = new FileSnapshotStore();
			const fileHistory = new FileHistoryStore({ homeDir, workspaceRoot });
			const executionPolicyConstraints = runtimeOptions.executionPolicy
				? inheritedAgentExecutionPolicyConstraints(runtimeOptions.executionPolicy)
				: managedExecutionPolicy;
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
		const approvalPolicy = new ApprovalPolicy({
			workspaceRoot,
			autoApproveMedium: true,
			shellKind: shellProfile.kind,
			extensionTools: integrationComposition.registrations.map((registration) => ({
				name: registration.definition.name,
				approvalPolicy: registration.source === "skill" || registration.source === "subagent"
					? "auto_allow" as const
					: "request" as const,
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
				const allowedNames = runtimeOptions.allowedTools
					? new Set(runtimeOptions.allowedTools)
					: undefined;
				return currentDeferredRegistrations().filter(
					(registration) => !allowedNames || allowedNames.has(registration.definition.name),
				);
			};
			const allowedStaticDeferredDefinitions = filterToolDefinitions(
				staticDeferredRegistrations.map((registration) => registration.definition),
				runtimeOptions.allowedTools,
			);
			const toolSearch = new ToolSearchTool(deferredCandidates(allowedDeferredRegistrations()));
			const staticAdapters = [
				new ReadTool({ workspaceRoot, snapshots: fileSnapshots }),
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
				...integrationComposition.registrations
					.filter((registration) => registration.source !== "mcp")
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
			) => filterToolDefinitions(
			Object.freeze([
				...planToolExposure(toolManifest, {
					...capabilities,
					requestPermissionsTool: requestPermissionsToolEnabled,
				}),
				...directExtensionDefinitions,
			]),
			runtimeOptions.allowedTools,
		);
				const toolRouter = new ToolRouter({
					adapters: staticAdapters,
					exposure: plannedTools({ shell: true, collaborationMode: "plan" }),
			});
			const refreshExtensions = (): void => {
				const deferred = allowedDeferredRegistrations();
				toolSearch.replaceCandidates(deferredCandidates(deferred));
				toolRouter.replaceDynamicAdapters(deferred
					.filter((registration) => registration.source === "mcp")
					.map((registration) => registration.adapter));
				approvalPolicy.replaceExtensionTools(integrationComposition.registrations.map(
					(registration) => ({
						name: registration.definition.name,
						approvalPolicy: registration.source === "skill" || registration.source === "subagent"
							? "auto_allow" as const
							: "request" as const,
					}),
				));
			};
			refreshExtensions();
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
			grantPermissions: (input) => executionPolicyCoordinator.grant(input),
		});
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
			const queueCoordinator = new QueueCoordinator({
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
			): CompactionCoordinator => {
				const compactionThreshold = compactionThresholdForModel(resolved);
				return new CompactionCoordinator({
					sessionId,
					workspaceRoot,
					threadId,
					store,
					tokenCounter,
					baseContext: [
						runtimeInstructions,
						...developerInstructions,
						JSON.stringify(allToolExposure),
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
					summarize: (input) => {
						const summaryConfig = {
							...resolved,
							model: input.model ?? resolved.model,
						};
						return summarizeCompactionWithProvider(
							registry.create(summaryConfig),
							{
								provider: summaryConfig.provider,
								protocol: summaryConfig.protocol,
								model: summaryConfig.model,
							},
							input,
						);
					},
					createCheckpointId: randomUUID,
					clock: () => new Date().toISOString(),
				});
			};
			store.modelInputLedger.recoverUnconfirmedProviderSteps({
				sessionId,
				createdAt: new Date().toISOString(),
				createEventId: () => `lifecycle-${randomUUID()}`,
			});
			const coordinatorRuntime = new NodeTurnRuntime({
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
			modelInputTokenCounter: tokenCounter,
			contextSources: ({ config: activeConfig }) => Object.freeze({
				skillCatalog: integrationComposition.skillCatalog,
				workspace: loadWorkspaceInstructions({
					workspaceRoot,
					cwd: workspaceRoot,
				}),
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
				createProvider: (resolved) => registry.create(resolved),
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
				deferredTools: (turnId) => Object.freeze([
					...allowedStaticDeferredDefinitions,
					...toolRouter.dynamicDefinitions(turnId),
				]),
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
					return approvalPolicy.evaluate(call, executionPolicy, turnId);
				},
				recordResult: (call, result, executionPolicy, turnId) => {
					approvalPolicy.recordResult(call, result, executionPolicy, turnId);
				},
			},
			approvalCoordinator,
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
				}): SessionPreferences => {
					const base = sessionPreferences
						?? sessionPreferencesFromConfig(controlConfig, input.collaborationMode);
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
						maxTokens: resolved.maxPromptTokens,
						durationMs: elapsedMonotonicMs(startedAt, performance.now()),
					}));
					return {
						status: result.status,
						beforeTokens: result.beforeTokens,
						afterTokens: result.afterTokens,
					};
				},
			});
			runtimeBySessionId.set(sessionId, binding);
			const agent = store.agentThreads.get(threadId);
			agentMailbox.repair(Object.freeze({
				threadId: agentThreadId(threadId),
				rootThreadId: agent?.rootThreadId ?? agentThreadId(threadId),
				path: agent?.path ?? rootAgentPath(),
				sessionId,
			}));
			return binding;
		};
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
			const runtime = createRuntime(
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
					isMutatingTool: (toolName) => mutatingAgentTools.has(toolName),
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
					if (runtimeBySessionId.get(input.childSessionId) === runtime) {
					runtimeBySessionId.delete(input.childSessionId);
				}
			},
		};
		};
		try {
			startupProfiler.mark("session_prepare_started");
			const prepare = (sessionId: string) => prepareStoredSession({
			sessionId,
			store,
			transcriptSnapshots,
			sessionArtifacts,
			artifactQueue,
			createRuntime,
			fallbackWorkspaceRoot: config.workspaceRoot,
			repairAgentCompletions,
		});
		let initial: PreparedSession<NodeGatewayRuntime>;
		try {
			initial = await prepare(config.sessionId);
		} catch (error) {
			if (!hasCode(error, "session_not_found")) throw error;
				initial = virtualSession(config.sessionId, config.workspaceRoot, createRuntime);
			}
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
				const environmentApiKey = options.env.MYCLI_API_KEY?.trim();
				const storedApiKey = await readApiKey({ homeDir, authRef: resolved.authRef });
				return Object.freeze({
					ready: Boolean(resolved.apiKey),
					providerId: resolved.provider,
					authRef: resolved.authRef,
					source: environmentApiKey
						? "environment"
						: storedApiKey
							? "stored"
							: resolved.apiKey
								? "legacy_config"
								: "missing",
				});
			};
			startupProfiler.mark("trust_ready");
			startupProfiler.mark("session_ready");
		const gatewayIntegrations = integrationGateway(
			integrationComposition,
			() => allToolExposure.map((tool) => tool.name),
		);
		const activeMemoryStore = () => new MemoryStore({
			homeDir,
			workspaceRoot: sessionCoordinator.snapshot().workspaceRoot,
		});
			const activeFileHistory = () => new FileHistoryStore({
				homeDir,
				workspaceRoot: sessionCoordinator.snapshot().workspaceRoot,
			});
			let closeRuntimeResourcesPromise: Promise<void> | undefined;
			const closeRuntimeResources = (): Promise<void> => {
				closeRuntimeResourcesPromise ??= (async () => {
					unsubscribeRuntimeExtensions();
					try {
						await integrationComposition.close();
					} finally {
						try {
							await agentWorkerPool?.close();
						} finally {
							try {
								await shellManager.close();
							} finally {
								try {
									await shellLifecycle.drain();
								} finally {
									try {
										await artifactQueue.drain();
									} finally {
										store.close();
									}
								}
							}
						}
					}
				})();
				return closeRuntimeResourcesPromise;
			};
			const gateway = createNodeGateway({
			sessionId: config.sessionId,
			workspaceRoot: config.workspaceRoot,
			provider: controlConfig.provider,
			model: controlConfig.model,
			reasoningEffort: controlConfig.thinkingEnabled
				? controlConfig.reasoningEffort
				: "none",
			toolNames: allToolExposure.map((tool) => tool.name),
			maxPromptTokens: () => controlConfig.maxPromptTokens,
			runtime: initial.binding,
			agentInteractiveRequests,
			loadConversation: (sessionId) => store.loadConversation(sessionId),
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
						return await integrationComposition.subagentController?.interrupt(childSessionId) ?? false;
					},
					interruptAll: async (parentSessionId) => {
						const running = store.subagentTasks.list(parentSessionId)
							.filter((task) => task.status === "running");
						let interrupted = 0;
						for (const task of running) {
							if (await integrationComposition.subagentController?.interrupt(task.childSessionId)) {
								interrupted += 1;
							}
						}
						return interrupted;
						},
					},
					sessionCommands: {
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
					fileHistoryCommands: {
						list: (sessionId) => activeFileHistory().listSnapshots({ sessionId }),
						undo: (sessionId) => activeFileHistory().undoLatest({ sessionId }),
					},
					controlCommands: {
						authProviders: async () => {
							const current = await credentialReadiness();
							return await Promise.all(listProviderProfiles().map(async (profile) => {
								const isCurrent = profile.provider === current.providerId;
								const authRef = isCurrent ? current.authRef : profile.provider;
								const stored = isCurrent && current.source === "stored"
									? true
									: Boolean(await readApiKey({ homeDir, authRef }));
								return {
									id: profile.provider,
									name: providerDisplayName(profile.provider),
									configured: isCurrent ? current.ready : stored,
									credential_source: isCurrent ? current.source : stored ? "stored" : "missing",
									...(isCurrent ? { auth_ref: current.authRef } : {}),
									...(profile.defaultModel ? { default_model: profile.defaultModel } : {}),
								};
							}));
						},
						credentialReadiness,
						saveApiKey: async (providerId, apiKey, requestedAuthRef) => {
							const profile = resolveProviderProfile(providerId);
							const current = await credentialReadiness();
							const authRef = requestedAuthRef ?? profile.provider;
							if (authRef !== profile.provider
								&& (profile.provider !== current.providerId || authRef !== current.authRef)) {
								throw controlRequestError("Credential reference is not active for this provider.");
							}
							await writeApiKey({ homeDir, authRef, apiKey });
							return {
								ok: true,
								provider_id: profile.provider,
								auth_ref: authRef,
								message: `Saved API key for ${providerDisplayName(profile.provider)}.`,
							};
						},
						models: async () => await modelCatalog(homeDir, controlConfig),
						selectModel: async (input) => {
							const provider = controlString(input.provider, "provider");
							const protocolValue = controlString(input.protocol, "protocol");
							let profile: ReturnType<typeof resolveProviderProfile>;
							let protocol: ReturnType<typeof parseProtocol>;
							try {
								profile = resolveProviderProfile(provider, protocolValue);
								protocol = parseProtocol(protocolValue);
							} catch {
								throw controlRequestError("Selected provider or protocol is not supported.");
							}
							const model = controlString(input.model, "model");
							const apiBaseUrl = controlString(input.base_url, "base_url").replace(/\/+$/u, "");
							const collaborationMode = controlCollaborationMode(input.collaboration_mode);
							const scope = controlModelSelectionScope(input.scope);
							const requestedEffort = controlReasoningEffort(input.reasoning_effort);
							const catalog = await loadModelCatalog({ homeDir, currentConfig: controlConfig });
							const entry = findModelCatalogEntry(catalog, {
								provider: profile.provider,
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
							const nextControlConfig = await resolveWorkspaceModelRuntimeConfig({
								homeDir,
								workspaceRoot: active.workspaceRoot,
								env: options.env,
								overrides: sessionPreferenceOverrides(active.sessionId, preferences),
							});
							if (scope === "user") {
								await writeUserProviderConfig({
									homeDir,
									workspaceRoot: active.workspaceRoot,
									env: options.env,
									workspaceTrust: await workspaceTrustStore.load(active.workspaceRoot),
									provider: entry.provider,
									protocol,
									model,
									apiBaseUrl: entry.baseUrl,
									authRef: entry.authRef,
									promptCacheKeyEnabled: profile.promptCacheKeyEnabled,
									cacheControlEnabled: profile.cacheControlEnabled,
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
								});
							}
							controlConfig = nextControlConfig;
							return {
								...modelCatalogEntryPayload(entry),
								current: true,
								reasoning_effort: reasoningEffort ?? null,
								thinking_enabled: thinkingEnabled,
								scope,
							};
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
								?? sessionPreferencesFromConfig(controlConfig, "default");
						},
						loadSettings: async () => ({ ...await loadShellSettings({ homeDir }) }),
						saveSettings: async (settings) => {
							const active = sessionCoordinator.snapshot();
							return {
								...await saveShellSettings({
									homeDir,
									settings,
									workspaceRoot: active.workspaceRoot,
									env: options.env,
									workspaceTrust: await workspaceTrustStore.load(active.workspaceRoot),
								}),
							};
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
			},
			integrations: gatewayIntegrations,
				close: closeRuntimeResources,
		});
			for (const recovered of recoveredInterrupts) {
			gateway.publishRecoveredInterrupt(recovered.record, {
				inputRolledBack: recovered.inputRolledBack,
			});
			}
			startupProfiler.mark("gateway_ready");
			return Object.freeze({
				transport: gateway.transport,
				completion: gateway.completion,
				close: () => gateway.close(),
				kill: () => gateway.kill(),
				diagnostic: () => gateway.diagnostic(),
				startupProfile: () => startupProfiler.snapshot(),
			});
	} catch (error) {
		try {
			await integrationComposition.close().catch(() => undefined);
		} finally {
			try {
				await agentWorkerPool?.close().catch(() => undefined);
			} finally {
				try {
					await shellManager.close().catch(() => undefined);
				} finally {
					try {
						await shellLifecycle.drain();
					} finally {
						try {
							await artifactQueue.drain();
						} finally {
							store.close();
						}
					}
				}
			}
		}
		throw error;
	}
}

async function modelCatalog(
	homeDir: string,
	config: NodeRuntimeConfig,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
	const entries = await loadModelCatalog({ homeDir, currentConfig: config });
	return Object.freeze(entries.map(modelCatalogEntryPayload));
}

function providerDisplayName(provider: string): string {
	return {
		openai: "OpenAI",
		codex: "OpenAI Codex",
		compatible: "OpenAI Compatible",
		qwen: "Qwen",
		deepseek: "DeepSeek",
		anthropic: "Anthropic",
	}[provider] ?? provider;
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
		authRef: preferences.authRef,
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

function deferredCandidates(registrations: readonly IntegrationRegistration[]) {
	return registrations.flatMap((registration) => (
		registration.source === "mcp" || registration.source === "plugin"
			? [{
				definition: registration.definition,
				source: registration.source,
				originMetadata: registration.originMetadata,
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
	composition: RuntimeIntegrationComposition,
	toolNames: () => readonly string[],
): NodeGatewayIntegrations {
		const integrations: NodeGatewayIntegrations = {
			toolManifest: () => composition.manifest as unknown as Record<string, unknown>,
			diagnostics: () => composition.diagnostics.map((diagnostic) => ({ ...diagnostic })),
			toolNames,
			listResources: () => composition.resources.map((resource) => ({ ...resource })),
		...(composition.commands.length > 0 ? {
			commands: combinedIntegrationCommands(composition.commands),
		} : {}),
			subscribeSubagents: (
			listener: (subagent: Readonly<Record<string, unknown>>) => void,
			) => composition.subscribeSubagents(listener),
			subscribeExtensions: (listener: (version: number) => void) => (
				composition.subscribeExtensions(listener)
			),
	};
	return Object.freeze(integrations);
}

function nodeTraceRows(
	store: RuntimeSessionStore,
	homeDir: string,
	sessionId: string,
): readonly Readonly<Record<string, unknown>>[] {
	const diagnostics = loadNodeTrace(homeDir, sessionId);
	const turns = store.loadTurnRollouts(sessionId).slice(-50).map((rollout) => {
		const continuation = objectValue(rollout.continuation_state);
		const usage = objectValue(continuation.usage);
		return Object.freeze({
			kind: "turn",
			...(boundedTraceString(rollout.turn_id, 256) ? {
				turn_id: boundedTraceString(rollout.turn_id, 256),
			} : {}),
			...(boundedTraceString(rollout.status, 32) ? {
				status: boundedTraceString(rollout.status, 32),
			} : {}),
			...(boundedTraceString(rollout.stop_reason, 64) ? {
				stop_reason: boundedTraceString(rollout.stop_reason, 64),
			} : {}),
			...(boundedTraceString(rollout.started_at, 64) ? {
				started_at: boundedTraceString(rollout.started_at, 64),
			} : {}),
			...(boundedTraceString(rollout.completed_at, 64) ? {
				completed_at: boundedTraceString(rollout.completed_at, 64),
			} : {}),
			...traceUsage(usage),
		});
	});
	return Object.freeze([...turns, ...diagnostics].slice(-50));
}

function appendNodeTrace(
	homeDir: string,
	sessionId: string,
	event: Readonly<Record<string, unknown>>,
): void {
	const identity = traceSessionId(sessionId);
	const kind = nodeTraceKind(event.kind);
	const turnId = boundedTraceString(event.turn_id, 256);
	if (!kind || !turnId) return;
	const payload = nodeTracePayload(kind, objectValue(event.payload));
	const tracesRoot = join(homeDir, ".mycli", "traces");
	const logsRoot = join(homeDir, ".mycli", "logs");
	mkdirSync(tracesRoot, { recursive: true, mode: 0o700 });
	mkdirSync(logsRoot, { recursive: true, mode: 0o700 });
	const tracePath = join(tracesRoot, `${identity}-trace.jsonl`);
	const traceLine = `${JSON.stringify({ kind, turn_id: turnId, payload })}\n`;
	rotateNodeTraceIfNeeded(tracePath, Buffer.byteLength(traceLine, "utf8"));
	appendFileSync(
		tracePath,
		traceLine,
		{ encoding: "utf8", mode: 0o600 },
	);
	appendFileSync(
		join(logsRoot, "agent.log"),
		`event=${kind} session_id=${identity} turn_id=${turnId}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

const NODE_TRACE_MAX_BYTES = 5 * 1024 * 1024;

function rotateNodeTraceIfNeeded(path: string, incomingBytes: number): void {
	if (!existsSync(path) || statSync(path).size + incomingBytes <= NODE_TRACE_MAX_BYTES) return;
	const backup = `${path}.1`;
	rmSync(backup, { force: true });
	renameSync(path, backup);
}

function loadNodeTrace(
	homeDir: string,
	sessionId: string,
): readonly Readonly<Record<string, unknown>>[] {
	const identity = traceSessionId(sessionId);
	const path = join(homeDir, ".mycli", "traces", `${identity}-trace.jsonl`);
	if (!existsSync(path)) return Object.freeze([]);
	const rows: Readonly<Record<string, unknown>>[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
			const event = parsed as Readonly<Record<string, unknown>>;
			const kind = nodeTraceKind(event.kind);
			const turnId = boundedTraceString(event.turn_id, 256);
			if (!kind || !turnId) continue;
			rows.push(Object.freeze({
				kind,
				turn_id: turnId,
				payload: nodeTracePayload(kind, objectValue(event.payload)),
			}));
		} catch {
			// Corrupt diagnostics are skipped without affecting the runtime.
		}
	}
	return Object.freeze(rows.slice(-50));
}

function traceSessionId(value: string): string {
	if (!value || value.startsWith("<") || value.endsWith(">")
		|| value.includes("/") || value.includes("\\") || value.includes("..")) {
		throw new Error("invalid trace session id");
	}
	return value.slice(0, 256);
}

type NodeTraceKind =
	| "turn_interrupt_requested"
	| "turn_interrupted"
	| "model_stream_diagnostics"
	| "tool_execution"
	| "compaction"
	| "subagent_lifecycle";

function nodeTraceKind(value: unknown): NodeTraceKind | undefined {
	return [
		"turn_interrupt_requested",
		"turn_interrupted",
		"model_stream_diagnostics",
		"tool_execution",
		"compaction",
		"subagent_lifecycle",
	].includes(value as NodeTraceKind)
		? value as NodeTraceKind
		: undefined;
}

function nodeTracePayload(
	kind: NodeTraceKind,
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	if (kind === "model_stream_diagnostics") return modelStreamTracePayload(value);
	if (kind === "tool_execution") return toolExecutionTracePayload(value);
	if (kind === "compaction") return compactionTracePayload(value);
	if (kind === "subagent_lifecycle") return subagentLifecycleTracePayload(value);
	const clientTurnId = boundedTraceString(value.client_turn_id, 256);
	return Object.freeze({
		...(clientTurnId ? { client_turn_id: clientTurnId } : {}),
		...(typeof value.requested === "boolean" ? { requested: value.requested } : {}),
		...(typeof value.input_rolled_back === "boolean"
			? { input_rolled_back: value.input_rolled_back }
			: {}),
		...(value.status === "interrupted" ? { status: "interrupted" } : {}),
	});
}

function modelStreamTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return compactTracePayload({
		provider: traceEnum(value.provider, ["openai", "codex", "compatible", "qwen", "deepseek", "anthropic"]),
		protocol: traceEnum(value.protocol, ["responses", "chat_completions", "anthropic_messages"]),
		model: boundedTraceToken(value.model, 256),
		attempt: boundedTraceCount(value.attempt),
		elapsed_ms: boundedTraceNumber(value.elapsed_ms),
		ttfb_ms: boundedTraceNumber(value.ttfb_ms),
		ttft_ms: boundedTraceNumber(value.ttft_ms),
		tbt_ms: boundedTraceNumber(value.tbt_ms),
		max_tbt_ms: boundedTraceNumber(value.max_tbt_ms),
		text_delta_interval_count: boundedTraceCount(value.text_delta_interval_count),
		provider_event_count: boundedTraceCount(value.provider_event_count),
		reasoning_event_count: boundedTraceCount(value.reasoning_event_count),
		text_event_count: boundedTraceCount(value.text_event_count),
		provider_state_event_count: boundedTraceCount(value.provider_state_event_count),
		tool_call_event_count: boundedTraceCount(value.tool_call_event_count),
		usage_event_count: boundedTraceCount(value.usage_event_count),
		completed_event_count: boundedTraceCount(value.completed_event_count),
		reasoning_bytes: boundedTraceCount(value.reasoning_bytes),
		text_bytes: boundedTraceCount(value.text_bytes),
		success: typeof value.success === "boolean" ? value.success : undefined,
		failure_kind: boundedTraceToken(value.failure_kind, 64),
	});
}

function toolExecutionTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return compactTracePayload({
		call_id: boundedTraceToken(value.call_id, 256),
		tool_name: boundedTraceToken(value.tool_name, 128),
		duration_ms: boundedTraceNumber(value.duration_ms),
		success: typeof value.success === "boolean" ? value.success : undefined,
		output_chars: boundedTraceCount(value.output_chars),
		output_truncated: typeof value.output_truncated === "boolean"
			? value.output_truncated
			: undefined,
		failure_kind: boundedTraceToken(value.failure_kind, 128),
	});
}

function compactionTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return compactTracePayload({
		source: traceEnum(value.source, ["pre_turn", "mid_turn", "context_overflow", "user_requested"]),
		status: traceEnum(value.status, ["not_needed", "compressed", "skipped", "failed", "interrupted"]),
		before_tokens: boundedTraceCount(value.before_tokens),
		after_tokens: boundedTraceCount(value.after_tokens),
		max_tokens: boundedTraceCount(value.max_tokens),
		duration_ms: boundedTraceNumber(value.duration_ms),
	});
}

function subagentLifecycleTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return compactTracePayload({
		thread_id: boundedTraceToken(value.thread_id, 256),
		status: traceEnum(value.status, ["started", "completed", "failed", "interrupted"]),
		duration_ms: boundedTraceNumber(value.duration_ms),
	});
}

function runtimeDiagnosticTraceEvent(
	event: RuntimeDiagnosticEvent,
): Readonly<Record<string, unknown>> {
	if (event.kind === "model_stream_diagnostics") {
		return Object.freeze({
			kind: event.kind,
			turn_id: event.turnId,
			payload: {
				provider: event.provider,
				protocol: event.protocol,
				model: event.model,
				attempt: event.attempt,
				elapsed_ms: event.elapsedMs,
				...(event.ttfbMs === undefined ? {} : { ttfb_ms: event.ttfbMs }),
				...(event.ttftMs === undefined ? {} : { ttft_ms: event.ttftMs }),
				...(event.tbtMs === undefined ? {} : { tbt_ms: event.tbtMs }),
				...(event.maxTbtMs === undefined ? {} : { max_tbt_ms: event.maxTbtMs }),
				text_delta_interval_count: event.textDeltaIntervalCount,
				provider_event_count: event.providerEventCount,
				reasoning_event_count: event.reasoningEventCount,
				text_event_count: event.textEventCount,
				provider_state_event_count: event.providerStateEventCount,
				tool_call_event_count: event.toolCallEventCount,
				usage_event_count: event.usageEventCount,
				completed_event_count: event.completedEventCount,
				reasoning_bytes: event.reasoningBytes,
				text_bytes: event.textBytes,
				success: event.success,
				...(event.failureKind ? { failure_kind: event.failureKind } : {}),
			},
		});
	}
	if (event.kind === "tool_execution") {
		return Object.freeze({
			kind: event.kind,
			turn_id: event.turnId,
			payload: {
				call_id: event.callId,
				tool_name: event.toolName,
				duration_ms: event.durationMs,
				success: event.success,
				output_chars: event.outputChars,
				output_truncated: event.outputTruncated,
				...(event.failureKind ? { failure_kind: event.failureKind } : {}),
			},
		});
	}
	return Object.freeze({
		kind: event.kind,
		turn_id: event.turnId,
		payload: {
			source: event.source,
			status: event.status,
			before_tokens: event.beforeTokens,
			after_tokens: event.afterTokens,
			max_tokens: event.maxTokens,
			duration_ms: event.durationMs,
		},
	});
}

function tryAppendNodeTrace(
	homeDir: string,
	sessionId: string,
	event: Readonly<Record<string, unknown>>,
): void {
	try {
		appendNodeTrace(homeDir, sessionId, event);
	} catch {
		// Observability is best-effort and never participates in turn success.
	}
}

function elapsedIsoMs(startedAt: string, finishedAt: string): number {
	const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
	return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function elapsedMonotonicMs(startedAt: number, finishedAt: number): number {
	const elapsed = finishedAt - startedAt;
	return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function boundedTraceNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		&& value <= 24 * 60 * 60 * 1_000
		? value
		: undefined;
}

function boundedTraceCount(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0
		&& (value as number) <= 1_099_511_627_776
		? value as number
		: undefined;
}

function boundedTraceToken(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= limit
		&& /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
		? value
		: undefined;
}

function traceEnum<const Value extends string>(
	value: unknown,
	allowed: readonly Value[],
): Value | undefined {
	return typeof value === "string" && allowed.includes(value as Value)
		? value as Value
		: undefined;
}

function compactTracePayload(
	value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return Object.freeze(Object.fromEntries(
		Object.entries(value).filter((entry) => entry[1] !== undefined),
	));
}

function nodeLogRows(homeDir: string): readonly string[] {
	const logsRoot = join(homeDir, ".mycli", "logs");
	const rows = ["agent.log", "errors.log", "model-events.jsonl"].map((name) => {
		const path = join(logsRoot, name);
		return existsSync(path)
			? `${name} present bytes=${statSync(path).size}`
			: `${name} absent`;
	});
	return Object.freeze(rows);
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

function boundedTraceString(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value
		? value.slice(0, limit)
		: undefined;
}

function traceUsage(value: Readonly<Record<string, unknown>>): Readonly<Record<string, number>> {
	const result: Record<string, number> = {};
	for (const key of ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens"] as const) {
		const count = value[key];
		if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) result[key] = count;
	}
	return Object.freeze(result);
}

function combinedIntegrationCommands(
	services: readonly IntegrationCommandService[],
): NodeGatewayIntegrationCommands {
	const commands: NodeGatewayIntegrationCommands = {
		list: () => services.flatMap((service) => service.list().map((command) => ({ ...command }))),
		run: async (command: string, signal: AbortSignal) => {
			for (const service of services) {
				const result = await service.run(command, signal);
				if (result) return { ...result };
			}
			return undefined;
		},
	};
	return Object.freeze(commands);
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

interface PrepareStoredSessionOptions {
	readonly sessionId: string;
	readonly store: RuntimeSessionStore;
	readonly transcriptSnapshots: TranscriptSnapshotStore;
	readonly sessionArtifacts: SessionArtifactStore;
	readonly artifactQueue: SerializedSessionArtifactQueue;
	readonly fallbackWorkspaceRoot: string;
	readonly repairAgentCompletions?: (parentSessionId: string) => Promise<void>;
	readonly createRuntime: (
		sessionId: string,
		workspaceRoot: string,
		threadId: string,
		initialQueue: QueueSnapshot,
		initialContinuation?: unknown,
	) => NodeGatewayRuntime;
}

async function prepareStoredSession(
	options: PrepareStoredSessionOptions,
): Promise<PreparedSession<NodeGatewayRuntime>> {
	const {
		sessionId,
		store,
		transcriptSnapshots,
		sessionArtifacts,
		artifactQueue,
		createRuntime,
	} = options;
	let overview: SessionOverview | undefined;
	try {
		overview = store.loadSession(sessionId);
	} catch (error) {
		const degraded = await loadDegradedSnapshot(transcriptSnapshots, sessionId, error);
		return preparedFromReadOnlySnapshot(degraded, createRuntime);
	}
	if (!overview) {
		try {
			const degraded = await transcriptSnapshots.loadOrRebuild(sessionId, {
				loadCanonical: () => undefined,
				importLegacy: (legacySessionId, messages) => importLegacySnapshot(
					store,
					legacySessionId,
					messages,
					undefined,
					options.fallbackWorkspaceRoot,
				),
			});
			if (degraded.readOnly) {
				return preparedFromReadOnlySnapshot(degraded.snapshot, createRuntime);
			}
			const importedOverview = store.loadSession(sessionId);
			if (!importedOverview) {
				throw new SessionTransitionError("session_state_invalid", "legacy session was not imported");
			}
			const initialQueue = emptyQueue(sessionId);
			const binding = createRuntime(
				sessionId,
				importedOverview.workspaceRoot,
				importedOverview.threadId,
				initialQueue,
			);
			const records = store.subagentTasks.list(sessionId, 1_000);
			await repairSessionArtifacts(
				sessionId,
				store,
				transcriptSnapshots,
				sessionArtifacts,
				artifactQueue,
			);
			await options.repairAgentCompletions?.(sessionId);
			repairSubagentNotifications(binding.queueCoordinator, records, sessionArtifacts, store);
			return {
				sessionId,
				workspaceRoot: importedOverview.workspaceRoot,
				threadId: importedOverview.threadId,
				transcript: degraded.snapshot.transcript,
				queue: binding.queueCoordinator?.snapshot() ?? initialQueue,
				suspendedTurn: false,
				readOnly: false,
				binding,
			};
		} catch (error) {
			if (error instanceof SnapshotStateError) {
				throw new SessionTransitionError("session_not_found", "the target session does not exist");
			}
			throw error;
		}
	}

	const queue = loadQueue(store, sessionId);
	const approvalState = loadApprovalState(store, sessionId);
	const compactionState = store.loadState(sessionId, "compact_checkpoint");
	const responsesContinuation = loadResponsesContinuation(store, sessionId);
	const binding = createRuntime(
		sessionId,
		overview.workspaceRoot,
		overview.threadId,
		queue,
		responsesContinuation,
	);
	const records = store.subagentTasks.list(sessionId, 1_000);
	let transcript;
	try {
		transcript = await transcriptSnapshots.loadOrRebuild(sessionId, {
			loadCanonical: () => canonicalSnapshot(
				store,
				overview,
				approvalState.pendingApproval !== undefined,
				approvalState.pendingClarification !== undefined,
				approvalState.suspendedTurn,
			),
			importLegacy: (legacySessionId, messages) => importLegacySnapshot(
				store,
				legacySessionId,
				messages,
				overview,
				options.fallbackWorkspaceRoot,
			),
		});
	} catch (error) {
		if (error instanceof SnapshotStateError) {
			throw new SessionTransitionError("session_state_invalid", "transcript state is not usable");
		}
		throw error;
	}
	if (transcript.readOnly) {
		return preparedFromReadOnlySnapshot(transcript.snapshot, createRuntime);
	}
	await repairSessionArtifacts(
		sessionId,
		store,
		transcriptSnapshots,
		sessionArtifacts,
		artifactQueue,
	);
	await options.repairAgentCompletions?.(sessionId);
	repairSubagentNotifications(binding.queueCoordinator, records, sessionArtifacts, store);
	const repairedQueue = binding.queueCoordinator?.snapshot() ?? queue;
	return {
		sessionId,
		workspaceRoot: overview.workspaceRoot,
		threadId: overview.threadId,
		transcript: transcript.snapshot.transcript,
		queue: repairedQueue,
		...(approvalState.pendingApproval
			? { pendingApproval: approvalState.pendingApproval }
			: {}),
		...(approvalState.pendingClarification
			? { pendingClarification: approvalState.pendingClarification }
			: {}),
		suspendedTurn: approvalState.suspendedTurn,
		...(compactionState === undefined ? {} : { compactionState }),
		...(responsesContinuation === undefined ? {} : { responsesContinuation }),
		readOnly: false,
		binding,
	};
}

function virtualSession(
	sessionId: string,
	workspaceRoot: string,
	createRuntime: PrepareStoredSessionOptions["createRuntime"],
): PreparedSession<NodeGatewayRuntime> {
	return {
		sessionId,
		workspaceRoot,
		threadId: sessionId,
		transcript: Object.freeze([]),
		queue: emptyQueue(sessionId),
		suspendedTurn: false,
		readOnly: false,
		binding: createRuntime(sessionId, workspaceRoot, sessionId, emptyQueue(sessionId)),
	};
}

function canonicalSnapshot(
	store: RuntimeSessionStore,
	overview: SessionOverview,
	pendingApproval: boolean,
	pendingClarification: boolean,
	suspendedTurn: boolean,
): TranscriptSnapshotV2 {
	const transcript = recentCanonicalTranscript(store, overview.sessionId);
	return {
		schema_version: 2,
		session_id: overview.sessionId,
		cwd: overview.workspaceRoot,
		state: pendingApproval
			? "waiting_approval"
			: pendingClarification
				? "waiting_clarification"
				: suspendedTurn ? "interrupted" : "idle",
		message_count: overview.messageCount,
		created_at: overview.createdAt,
		updated_at: overview.updatedAt,
		transcript,
		subagents: subagentIndex(store, overview.sessionId),
		links: { events: "events.jsonl" },
	};
}

function canonicalTranscript(
	store: RuntimeSessionStore,
	sessionId: string,
): readonly TranscriptItem[] {
	const projected = projectReadableSessionTranscript(store, sessionId);
	return projected.hasCanonicalHistory
		? projected.items
		: legacyConversationTranscript(store, sessionId);
}

function recentCanonicalTranscript(
	store: RuntimeSessionStore,
	sessionId: string,
): readonly TranscriptItem[] {
	const projected = projectRecentSessionTranscript(store, sessionId);
	return projected.hasCanonicalHistory
		? projected.items
		: legacyConversationTranscript(store, sessionId);
}

function subagentIndex(
	store: RuntimeSessionStore,
	parentSessionId: string,
): TranscriptSnapshotV2["subagents"] {
	return Object.freeze(store.subagentTasks.list(parentSessionId, 1_000)
			.map((record) => sessionSubagentIndexEntry(subagentSnapshotInput(
				record,
				[],
				store.agentThreads.get(record.childSessionId),
			)))
		.sort((left, right) => left.run_id.localeCompare(right.run_id)));
}

function subagentSnapshotInput(
	record: SubagentTaskRecord,
	messages: readonly TranscriptItem[],
	thread?: AgentThreadRecord,
	lifecycleKind?: string,
): WriteSubagentSnapshotInput {
	const usage = record.payload.usage ?? {};
	const usageToolCalls = usage.tool_calls ?? usage.toolCalls;
	const toolCalls = Number.isSafeInteger(usageToolCalls) && usageToolCalls >= 0
		? usageToolCalls
		: Math.floor(record.progressSequence / 2);
	return Object.freeze({
		parentSessionId: record.parentSessionId,
		childSessionId: record.childSessionId,
		parentTurnId: record.parentTurnId,
		profileId: record.profileId,
		threadId: thread?.threadId ?? record.childSessionId,
		...(thread ? {
			rootThreadId: thread.rootThreadId,
			parentThreadId: thread.parentThreadId,
			agentPath: thread.path,
			taskName: thread.taskName,
			...(thread.nickname ? { nickname: thread.nickname } : {}),
		} : {}),
		...(lifecycleKind ? { lifecycleKind } : {}),
		status: record.status,
		...(record.payload.mode ? { mode: record.payload.mode } : {}),
		...(record.payload.description === undefined ? {} : {
			description: record.payload.description,
		}),
		...(record.payload.report === undefined ? {} : { report: record.payload.report }),
		toolCalls,
		...(subagentError(record) ? { error: subagentError(record) } : {}),
		startedAt: record.createdAt,
		...(record.completedAt ? { completedAt: record.completedAt } : {}),
		contextDiagnostics: Object.freeze({
			progress_sequence: record.progressSequence,
			...(Object.keys(usage).length > 0 ? { usage } : {}),
		}),
		messages,
	});
}

function subagentError(record: SubagentTaskRecord): string | undefined {
	return record.payload.error ?? record.payload.interruptionReason;
}

function terminalSubagentOutput(record: SubagentTaskRecord): string {
	for (const candidate of [
		record.payload.report,
		record.payload.error,
		record.payload.interruptionReason,
	]) {
		if (candidate?.trim()) return candidate;
	}
	return `Subagent ${record.status}`;
}

interface SubagentArtifactProjectionResult {
	readonly outputReady: boolean;
	readonly snapshotReady: boolean;
}

async function projectSubagentRecord(
	record: SubagentTaskRecord,
	store: RuntimeSessionStore,
	artifacts: SessionArtifactStore,
	thread = store.agentThreads.get(record.childSessionId),
	lifecycleKind?: string,
): Promise<SubagentArtifactProjectionResult> {
	let outputReady = !isTerminalSubagentStatus(record.status);
	if (isTerminalSubagentStatus(record.status)) {
		try {
			await artifacts.writeTaskOutput({
				sessionId: record.parentSessionId,
				taskId: record.childSessionId,
				output: terminalSubagentOutput(record),
			});
			await artifacts.writeTaskOutput({
				sessionId: record.childSessionId,
				taskId: record.taskId,
				output: terminalSubagentOutput(record),
			}).catch(() => undefined);
			outputReady = true;
		} catch {
			outputReady = false;
		}
	}
	let snapshotReady = false;
	try {
		await artifacts.writeSubagentSnapshot(subagentSnapshotInput(
			record,
			recentCanonicalTranscript(store, record.childSessionId),
			thread,
			lifecycleKind,
		));
		snapshotReady = true;
	} catch {
		snapshotReady = false;
	}
	return Object.freeze({ outputReady, snapshotReady });
}

async function refreshParentArtifactSnapshot(
	parentSessionId: string,
	store: RuntimeSessionStore,
	transcriptSnapshots: TranscriptSnapshotStore,
): Promise<void> {
	const overview = store.loadSession(parentSessionId);
	if (!overview) return;
	const approval = loadApprovalState(store, parentSessionId);
	await transcriptSnapshots.write(canonicalSnapshot(
		store,
		overview,
		approval.pendingApproval !== undefined,
		approval.pendingClarification !== undefined,
		approval.suspendedTurn,
	));
}

async function repairSessionArtifacts(
	parentSessionId: string,
	store: RuntimeSessionStore,
	transcriptSnapshots: TranscriptSnapshotStore,
	artifacts: SessionArtifactStore,
	queue: SerializedSessionArtifactQueue,
): Promise<void> {
	await queue.run(async () => {
		for (const record of store.subagentTasks.list(parentSessionId, 1_000)) {
			await projectSubagentRecord(record, store, artifacts);
		}
		await refreshParentArtifactSnapshot(
			parentSessionId,
			store,
			transcriptSnapshots,
		).catch(() => undefined);
	});
}

interface CanonicalAgentEventProjectionInput {
	readonly event: AgentCanonicalEvent;
	readonly store: RuntimeSessionStore;
	readonly transcriptSnapshots: TranscriptSnapshotStore;
	readonly artifacts: SessionArtifactStore;
}

async function projectCanonicalAgentEvent(
	input: CanonicalAgentEventProjectionInput,
): Promise<void> {
	const { event, store, transcriptSnapshots, artifacts } = input;
	const sessionIds = new Set<string>([event.threadId]);
	if (event.type === "agent_communication") {
		sessionIds.add(event.senderThreadId);
		sessionIds.add(event.receiverThreadId);
	} else if ("task" in event && event.task) {
		sessionIds.add(event.task.parentSessionId);
	}
	for (const sessionId of sessionIds) {
		await artifacts.appendEvent({
			sessionId,
			type: canonicalAgentArtifactType(event),
			payload: canonicalAgentArtifactPayload(event),
		}).catch(() => undefined);
	}
	if (event.type === "agent_communication" || !("task" in event) || !event.task) return;
	const record = store.subagentTasks.get(event.task.taskId);
	const thread = store.agentThreads.get(event.threadId);
	if (!record || !thread || record.childSessionId !== event.threadId) return;
	const projection = await projectSubagentRecord(
		record,
		store,
		artifacts,
		thread,
		event.kind,
	);
	await refreshParentArtifactSnapshot(
		record.parentSessionId,
		store,
		transcriptSnapshots,
	).catch(() => undefined);
	if (!projection.snapshotReady || !shouldPublishSubagentEvent(event)) return;
	const entry = sessionSubagentIndexEntry(subagentSnapshotInput(record, [], thread, event.kind));
	const subagent = subagentEventProjection(event, record, thread, entry);
	await artifacts.appendEvent({
		sessionId: record.parentSessionId,
		type: "subagent.updated",
		payload: { subagent },
	}).catch(() => undefined);
}

function publishCanonicalSubagentEvent(
	event: AgentCanonicalEvent,
	store: RuntimeSessionStore,
	publish: (value: Readonly<Record<string, unknown>>) => void,
): void {
	if (event.type === "agent_communication" || !shouldPublishSubagentEvent(event)
		|| !("task" in event) || !event.task) return;
	const record = store.subagentTasks.get(event.task.taskId);
	const thread = store.agentThreads.get(event.threadId);
	if (!record || !thread || record.childSessionId !== event.threadId) return;
	const entry = sessionSubagentIndexEntry(subagentSnapshotInput(record, [], thread, event.kind));
	publish(subagentEventProjection(event, record, thread, entry));
}

function canonicalAgentArtifactType(
	event: AgentCanonicalEvent,
): "agent.lifecycle" | "agent.progress" | "agent.usage" | "agent.communication" {
	if (event.type === "agent_lifecycle") return "agent.lifecycle";
	if (event.type === "agent_progress") return "agent.progress";
	if (event.type === "agent_usage") return "agent.usage";
	return "agent.communication";
}

function canonicalAgentArtifactPayload(
	event: AgentCanonicalEvent,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		event_id: event.eventId,
		occurred_at: event.occurredAt,
		kind: event.kind,
		thread_id: event.threadId,
		root_thread_id: event.rootThreadId,
		...(event.parentThreadId ? { parent_thread_id: event.parentThreadId } : {}),
		agent_path: event.path,
		...(event.sourceCallId ? { source_call_id: event.sourceCallId } : {}),
		...(event.type === "agent_lifecycle" ? {
			thread_status: event.threadStatus,
			...(event.summary ? { summary: event.summary } : {}),
		} : {}),
		...(event.type === "agent_progress" ? {
			progress_sequence: event.progressSequence,
			summary: event.summary,
			usage: event.usage,
		} : {}),
		...(event.type === "agent_usage" ? { usage: event.usage } : {}),
		...(event.type === "agent_communication" ? {
			message_id: event.messageId,
			sender_thread_id: event.senderThreadId,
			sender_path: event.senderPath,
			receiver_thread_id: event.receiverThreadId,
			receiver_path: event.receiverPath,
			receiver_sequence: event.receiverSequence,
			trigger_mode: event.triggerMode,
			payload_kind: event.payloadKind,
		} : {}),
		...("task" in event && event.task ? {
			task_id: event.task.taskId,
			parent_session_id: event.task.parentSessionId,
			parent_turn_id: event.task.parentTurnId,
			profile_id: event.task.profileId,
			task_status: event.task.taskStatus,
		} : {}),
	});
}

function shouldPublishSubagentEvent(event: AgentCanonicalEvent): boolean {
	return event.type === "agent_progress"
		|| event.type === "agent_lifecycle" && [
			"started",
			"waiting",
			"loaded",
			"unloaded",
			"completed",
			"failed",
			"interrupted",
		].includes(event.kind);
}

function subagentEventProjection(
	event: Exclude<AgentCanonicalEvent, { readonly type: "agent_communication" }>,
	record: SubagentTaskRecord,
	thread: AgentThreadRecord,
	entry: ReturnType<typeof sessionSubagentIndexEntry>,
): Readonly<Record<string, unknown>> {
	const usage = record.payload.usage ?? (event.type === "agent_progress" || event.type === "agent_usage"
		? event.usage
		: {});
	const totalTokens = Object.entries(usage).reduce((total, [key, value]) => (
		key.includes("token") && Number.isFinite(value) ? total + value : total
	), 0);
	return Object.freeze({
		...entry,
		parent_session_id: record.parentSessionId,
		run_id: subagentRunId(thread.threadId),
		thread_id: thread.threadId,
		root_thread_id: thread.rootThreadId,
		parent_thread_id: thread.parentThreadId,
		agent_path: thread.path,
		task_name: thread.taskName,
		...(thread.nickname ? { nickname: thread.nickname } : {}),
		lifecycle_kind: event.kind,
		status: subagentEventStatus(event, record),
		summary: event.type === "agent_progress"
			? event.summary
			: event.type === "agent_lifecycle" && event.summary
				? event.summary
				: `Subagent ${event.kind}`,
		progress: event.type === "agent_progress"
			? [Object.freeze({ kind: "progress", summary: event.summary })]
			: event.type === "agent_lifecycle" && isTerminalSubagentStatus(record.status)
				? [Object.freeze({ kind: "final", summary: event.summary ?? `Subagent ${event.kind}` })]
				: [],
		...(totalTokens > 0 ? { total_tokens: totalTokens } : {}),
	});
}

function subagentEventStatus(
	event: Exclude<AgentCanonicalEvent, { readonly type: "agent_communication" }>,
	record: SubagentTaskRecord,
): string {
	if (event.type !== "agent_lifecycle") return record.status === "queued" ? "running" : record.status;
	if (event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted") {
		return event.kind;
	}
	if (event.kind === "loaded") return "idle";
	if (event.kind === "unloaded") return "unloaded";
	if (event.kind === "waiting") return "waiting";
	return "running";
}

function repairSubagentNotifications(
	queue: QueueCoordinator | undefined,
	records: readonly SubagentTaskRecord[],
	artifacts?: SessionArtifactStore,
	store?: RuntimeSessionStore,
): void {
	if (!queue) return;
	for (const record of [...records].reverse()) {
		if (store?.agentThreads.get(record.childSessionId)?.spawnConfig) continue;
		const outputFile = artifacts?.taskOutputPath(
			record.parentSessionId,
			record.childSessionId,
		);
		const text = serializeSubagentTaskNotification(record, {
			...(outputFile && existsSync(outputFile) ? { outputFile } : {}),
		});
		if (!text) continue;
		try {
			queue.enqueueTaskNotification({
				sessionId: record.parentSessionId,
				taskId: record.taskId,
				text,
			});
		} catch {
			// The durable task remains the recovery source for a later session preparation.
			break;
		}
	}
}

function isTerminalSubagentStatus(
	value: unknown,
): value is "completed" | "failed" | "interrupted" {
	return value === "completed" || value === "failed" || value === "interrupted";
}

class SerializedSessionArtifactQueue {
	#pending: Promise<void> = Promise.resolve();

	run(operation: () => Promise<void>): Promise<void> {
		const scheduled = this.#pending.then(operation);
		this.#pending = scheduled.catch(() => undefined);
		return scheduled;
	}

	drain(): Promise<void> {
		return this.#pending;
	}
}

function legacyConversationTranscript(
	store: RuntimeSessionStore,
	sessionId: string,
): readonly TranscriptItem[] {
	return Object.freeze(store.loadConversation(sessionId).map((message, index) => Object.freeze({
		id: `${sessionId}:legacy:${index + 1}`,
		type: message.role === "user" ? "user_message" : "assistant_message",
		text: message.content,
	}) satisfies TranscriptItem));
}

function importLegacySnapshot(
	store: RuntimeSessionStore,
	sessionId: string,
	messages: readonly LegacySnapshotMessage[],
	overview: SessionOverview | undefined,
	fallbackWorkspaceRoot: string,
): TranscriptSnapshotV2 {
	const workspaceRoot = overview?.workspaceRoot ?? fallbackWorkspaceRoot;
	const imported = store.importLegacyConversation({
		sessionId,
		workspaceRoot,
		threadId: overview?.threadId ?? sessionId,
		messages,
	});
	const current = store.loadSession(sessionId);
	if (!imported || !current) {
		throw new SessionTransitionError("session_state_invalid", "legacy transcript import failed");
	}
	return canonicalSnapshot(store, current, false, false, false);
}

async function loadDegradedSnapshot(
	snapshots: TranscriptSnapshotStore,
	sessionId: string,
	storageError: unknown,
): Promise<TranscriptSnapshotV2> {
	const result = await snapshots.loadOrRebuild(sessionId, {
		loadCanonical: () => { throw storageError; },
		importLegacy: () => { throw storageError; },
	});
	if (!result.readOnly) {
		throw new SessionTransitionError("session_state_invalid", "degraded transcript is writable");
	}
	return result.snapshot;
}

function preparedFromReadOnlySnapshot(
	snapshot: TranscriptSnapshotV2,
	createRuntime: PrepareStoredSessionOptions["createRuntime"],
): PreparedSession<NodeGatewayRuntime> {
	return {
		sessionId: snapshot.session_id,
		workspaceRoot: snapshot.cwd,
		threadId: snapshot.session_id,
		transcript: snapshot.transcript,
		queue: emptyQueue(snapshot.session_id),
		suspendedTurn: snapshot.state === "waiting_approval" || snapshot.state === "interrupted",
		readOnly: true,
		binding: createRuntime(
			snapshot.session_id,
			snapshot.cwd,
			snapshot.session_id,
			emptyQueue(snapshot.session_id),
		),
	};
}

function loadQueue(store: RuntimeSessionStore, sessionId: string): QueueSnapshot {
	const payload = store.loadState(sessionId, "input_queue");
	if (payload === undefined) return emptyQueue(sessionId);
	const state = parseRuntimeState({ kind: "input_queue", version: 1, payload });
	if (state.kind !== "input_queue" || state.payload.session_id !== sessionId) {
		throw new SessionTransitionError("session_state_invalid", "queue session does not match");
	}
	return Object.freeze({
		sessionId,
		revision: state.payload.revision,
		pendingSteers: Object.freeze(state.payload.pending_steers.map(queueRecord)),
		rejectedSteers: Object.freeze(state.payload.rejected_steers.map(queueRecord)),
		followUps: Object.freeze(state.payload.follow_ups.map(queueRecord)),
	});
}

function queueRecord(record: {
	readonly queue_id: string;
	readonly session_id: string;
	readonly client_turn_id: string;
	readonly target_turn_id: string | null;
	readonly kind: QueuedInput["kind"];
	readonly state: QueuedInput["state"];
	readonly text: string;
	readonly image_paths: readonly string[];
	readonly source: string;
	readonly created_at: string;
	readonly updated_at: string;
}): QueuedInput {
	return Object.freeze({
		queueId: record.queue_id,
		sessionId: record.session_id,
		clientTurnId: record.client_turn_id,
		targetTurnId: record.target_turn_id,
		kind: record.kind,
		state: record.state,
		text: record.text,
		imagePaths: Object.freeze([...record.image_paths]),
		source: record.source,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
	});
}

function emptyQueue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 0,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
}

function loadApprovalState(
	store: RuntimeSessionStore,
	sessionId: string,
): {
	readonly pendingApproval?: PendingSessionApproval;
	readonly pendingClarification?: PendingSessionClarification;
	readonly suspendedTurn: boolean;
} {
	const pendingPayload = store.loadState(sessionId, "pending_decision");
	const suspendedPayload = store.loadState(sessionId, "suspended_turn");
	const suspended = suspendedPayload === undefined
		? undefined
		: parseRuntimeState({ kind: "suspended_turn", version: 1, payload: suspendedPayload });
	if (suspended !== undefined && (suspended.kind !== "suspended_turn"
		|| (suspended.payload.session_id !== undefined
			&& suspended.payload.session_id !== sessionId))) {
		throw new SessionTransitionError("session_state_invalid", "suspended session does not match");
	}
	const pendingClarification = suspended?.kind === "suspended_turn"
		? clarificationFromSuspendedState(sessionId, suspended.payload)
		: undefined;
	if (pendingPayload === undefined) {
		return {
			...(pendingClarification ? { pendingClarification } : {}),
			suspendedTurn: suspended !== undefined,
		};
	}
	if (suspended === undefined) {
		throw new SessionTransitionError("session_state_invalid", "pending approval has no suspended turn");
	}
	const pending = parseRuntimeState({ kind: "pending_decision", version: 1, payload: pendingPayload });
	if (pending.kind !== "pending_decision" || suspended.kind !== "suspended_turn") {
		throw new SessionTransitionError("session_state_invalid", "approval continuation is invalid");
	}
	if (pendingClarification) {
		throw new SessionTransitionError(
			"session_state_invalid",
			"approval and clarification cannot both be pending",
		);
	}
	const clientTurnId = requiredStateString(suspended.payload.client_turn_id, "client turn id");
	const turnId = requiredStateString(suspended.payload.turn_id, "turn id");
	const call = pending.payload.tool_call;
	const permissionRequest = permissionRequestFromJson(
		objectValue(pending.payload.metadata).permission_request,
	);
	if (suspended.payload.pending_approval?.tool_call.call_id !== undefined
		&& suspended.payload.pending_approval.tool_call.call_id !== call.call_id) {
		throw new SessionTransitionError("session_state_invalid", "pending approval call does not match");
	}
	return {
		pendingApproval: {
			sessionId,
			clientTurnId,
			turnId,
			decisionId: call.call_id,
			callId: call.call_id,
			toolName: call.name,
			preview: pending.payload.preview,
			reason: pending.payload.reason,
			options: Object.freeze([...pending.payload.options]),
			...(permissionRequest ? { permissionRequest } : {}),
		},
		suspendedTurn: true,
	};
}

function clarificationFromSuspendedState(
	sessionId: string,
	payload: Extract<ReturnType<typeof parseRuntimeState>, { kind: "suspended_turn" }>['payload'],
): PendingSessionClarification | undefined {
	const clarification = payload.pending_clarification;
	if (!clarification) return undefined;
	const clientTurnId = requiredStateString(payload.client_turn_id, "client turn id");
	const clientUserMessageId = typeof payload.client_user_message_id === "string"
		&& payload.client_user_message_id.trim()
		? payload.client_user_message_id
		: clientTurnId;
	const callId = requiredStateString(clarification.tool_call.call_id, "clarification call id");
	return Object.freeze({
		sessionId,
		clientTurnId,
		clientUserMessageId,
		turnId: requiredStateString(payload.turn_id, "turn id"),
		requestId: requiredStateString(clarification.request_id, "clarification request id"),
		callId,
		toolName: requiredStateString(clarification.tool_call.name, "clarification tool name"),
		question: requiredStateString(clarification.question, "clarification question"),
		options: Object.freeze(clarification.options.map(clarificationStateOption)),
		header: typeof clarification.header === "string" ? clarification.header : "",
		multiSelect: clarification.multi_select,
	});
}

function clarificationStateOption(value: unknown): {
	readonly label: string;
	readonly description?: string;
} {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SessionTransitionError("session_state_invalid", "clarification option is invalid");
	}
	const option = value as Readonly<Record<string, unknown>>;
	const label = requiredStateString(option.label, "clarification option label");
	if (option.description !== undefined && typeof option.description !== "string") {
		throw new SessionTransitionError("session_state_invalid", "clarification option is invalid");
	}
	return Object.freeze({
		label,
		...(typeof option.description === "string" && option.description
			? { description: option.description }
			: {}),
	});
}

function loadResponsesContinuation(
	store: RuntimeSessionStore,
	sessionId: string,
): unknown | undefined {
	const payload = store.loadState(sessionId, "responses_continuation_state");
	if (payload === undefined) return undefined;
	const state = parseRuntimeState({ kind: "responses_continuation", version: 1, payload });
	if (state.kind !== "responses_continuation"
		|| (state.payload.session_id !== undefined && state.payload.session_id !== sessionId)) {
		throw new SessionTransitionError("session_state_invalid", "provider continuation does not match");
	}
	return payload;
}

function requiredStateString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new SessionTransitionError("session_state_invalid", `${label} is missing`);
	}
	return value;
}

function listSessionsWithVirtualInitial(
	store: RuntimeSessionStore,
	query: SessionListQuery,
	initialSessionId: string,
	initialWorkspaceRoot: string,
): readonly SessionOverview[] {
	const sessions = [...store.listSessions(query)];
	if (store.loadSession(initialSessionId)
		|| (query.workspaceRoot !== undefined && query.workspaceRoot !== initialWorkspaceRoot)) {
		return Object.freeze(sessions);
	}
	const timestamp = "";
	sessions.push(Object.freeze({
		sessionId: initialSessionId,
		workspaceRoot: initialWorkspaceRoot,
		threadId: initialSessionId,
		createdAt: timestamp,
		updatedAt: timestamp,
		lastActiveAt: timestamp,
		status: "active",
		messageCount: 0,
		summaryCount: 0,
	}));
	return Object.freeze(sessions.slice(0, query.limit ?? 20));
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error
		&& "code" in error
		&& (error as Error & { readonly code: unknown }).code === code;
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

function parseOverrides(args: readonly string[]): { model?: string; session?: string } {
	const overrides: { model?: string; session?: string } = {};
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if ((flag !== "--model" && flag !== "--session") || value === undefined) {
			throw new Error("invalid_arguments: invalid Node runtime arguments");
		}
		if (flag === "--model") overrides.model = value;
		if (flag === "--session") overrides.session = value;
	}
	return overrides;
}

function runtimeHome(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}
