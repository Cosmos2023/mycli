import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseRuntimeState } from "@mycli/contracts";
import {
	ExecPolicyStore,
	listProviderProfiles,
	loadShellSettings,
	parseProtocol,
	readApiKey,
	resolveConfig,
	resolveProviderProfile,
	saveShellSettings,
	writeApiKey,
	writeUserProviderConfig,
	WorkspaceTrustStore,
} from "@mycli/config";
import type { NodeRuntimeConfig } from "@mycli/config";
import type {
	QueueSnapshot,
	QueuedInput,
	ReasoningEffort,
	RuntimeEvent,
	ShellLifecycleEvent,
} from "@mycli/core";
import {
	skillInvocationArtifactFromMetadata,
	type ChildRuntimeCreateInput,
	type ChildRuntimeEvent,
	type ChildRuntimeFactory,
	type ChildRuntimeHandle,
} from "@mycli/integrations";
import { ProviderRegistry } from "@mycli/providers";
import {
	ApprovalContinuationCoordinator,
	ClarificationContinuationCoordinator,
	CompactionCoordinator,
	ContextItemCoordinator,
	ExecutionPolicyCoordinator,
	MemoryContextService,
	MemorySelector,
	MemoryStore,
	NodeTurnRuntime,
	ProviderContinuationCoordinator,
	QueueCoordinator,
	SessionCoordinator,
	SessionTransitionError,
	ShellLifecycleProjector,
	summarizeCompactionWithProvider,
	TokenCounter,
} from "@mycli/runtime";
import type {
	PendingSessionApproval,
	PendingSessionClarification,
	PreparedSession,
} from "@mycli/runtime";
import {
	projectTranscript,
	SnapshotStateError,
	SQLiteSessionStore,
	TranscriptSnapshotStore,
} from "@mycli/storage";
import type {
	LegacySnapshotMessage,
	SessionListQuery,
	SessionOverview,
	TranscriptItem,
	TranscriptSnapshotV2,
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
	ReadTool,
	resolveShellProfile,
	ShellOutputTool,
	ShellSessionManager,
	ShellTool,
	startNodePtyTransport,
	startPipeTransport,
	ToolRouter,
	KillShellTool,
	WriteStdinTool,
	WriteTool,
} from "@mycli/tools";
import {
	createRuntimeIntegrationComposition,
	type IntegrationCommandService,
	type RuntimeIntegrationComposition,
} from "./integration-composition.ts";
import {
	createNodeGateway,
	type NodeGateway,
	type NodeGatewayIntegrationCommands,
	type NodeGatewayIntegrations,
	type NodeGatewayRuntime,
} from "./node-gateway.ts";

export type NodeBackend = NodeGateway;

export interface StartNodeBackendOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly args: readonly string[];
	readonly maxOutputTokens?: number;
}

export async function startNodeBackend(options: StartNodeBackendOptions): Promise<NodeBackend> {
	const overrides = parseOverrides(options.args);
	let activeModelOverride = overrides.model;
	const homeDir = runtimeHome(options.env);
	const config = await resolveConfig({
		homeDir,
		workspaceRoot: options.cwd,
		env: options.env,
		overrides,
	});
	const store = new SQLiteSessionStore({ dbPath: config.sessionsDbPath });
	const workspaceTrustStore = new WorkspaceTrustStore({ homeDir });
	const registry = new ProviderRegistry();
	let controlConfig = config;
	const toolManifest = builtinToolManifest();
	const shellManager = new ShellSessionManager({
		transportFactory: (request) => request.tty
			? startNodePtyTransport(request)
			: startPipeTransport(request),
	});
	const shellLifecycle = new ShellLifecycleProjector({ store });
	const publishLifecycle: (event: ShellLifecycleEvent) => void = (event) => {
		shellLifecycle.enqueue(event);
	};
	const transcriptSnapshots = new TranscriptSnapshotStore({ homeDir });
	const tokenCounter = new TokenCounter();
	const childRuntimeFactoryDelegate: {
		create?: (input: ChildRuntimeCreateInput) => Promise<ChildRuntimeHandle>;
	} = {};
	const childRuntimeFactory: ChildRuntimeFactory = {
		create: async (input) => {
			const create = childRuntimeFactoryDelegate.create;
			if (!create) throw new Error("child_runtime_unavailable");
			return create(input);
		},
	};
	let integrationComposition: RuntimeIntegrationComposition;
	try {
		integrationComposition = await createRuntimeIntegrationComposition({
			builtinManifest: toolManifest,
			workspaceRoot: config.workspaceRoot,
			homeDir,
			env: options.env,
			parentSessionId: config.sessionId,
			parentTurnId: () => "parent-turn-unavailable",
			parentTools: () => allToolExposure.map((tool) => tool.name),
			childRuntimeFactory,
			taskStore: store.subagentTasks,
		});
	} catch (error) {
		try {
			await shellManager.close().catch(() => undefined);
		} finally {
			try {
				await shellLifecycle.drain();
			} finally {
				store.close();
			}
		}
		throw error;
	}
	const extensionDefinitions = Object.freeze(integrationComposition.registrations.map(
		(registration) => registration.definition,
	));
	const allToolExposure = Object.freeze([
		...planToolExposure(toolManifest, { shell: true }),
		...extensionDefinitions,
	]);
	const contextItemCoordinator = new ContextItemCoordinator({
		extractArtifact: skillInvocationArtifactFromMetadata,
	});
	const createRuntime = (
		sessionId: string,
		workspaceRoot: string,
		threadId: string,
		initialQueue: QueueSnapshot,
		initialContinuation?: unknown,
		runtimeOptions: { readonly allowedTools?: readonly string[] } = {},
		): NodeGatewayRuntime => {
			const fileSnapshots = new FileSnapshotStore();
			const fileHistory = new FileHistoryStore({ homeDir, workspaceRoot });
			const executionPolicyCoordinator = new ExecutionPolicyCoordinator({ workspaceRoot });
			const mutationRuntime = new FileMutationRuntime({
				workspaceRoot,
				snapshots: fileSnapshots,
				sessionId,
				history: fileHistory,
			});
		const shellProfile = resolveShellProfile({ env: options.env });
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
		const ensureExecPolicyLoaded = (): Promise<void> => {
			loadExecPolicy ??= execPolicyStore.load().then((rules) => {
				approvalPolicy.replaceExecPolicyRules(rules);
			});
			return loadExecPolicy;
		};
		const shellTool = new ShellTool({
			workspaceRoot,
			manager: shellManager,
			env: options.env,
			profile: shellProfile,
		});
		const adapters = [
			new ReadTool({ workspaceRoot, snapshots: fileSnapshots }),
			new EditTool(mutationRuntime),
			new PatchTool(mutationRuntime),
			new WriteTool({ runtime: mutationRuntime }),
			new AskUserQuestionTool(),
			shellTool,
			new WriteStdinTool({ manager: shellManager }),
			new BashTool({ shell: shellTool }),
			new ShellOutputTool({ manager: shellManager }),
			new BashOutputTool({ manager: shellManager }),
			new KillShellTool({ manager: shellManager }),
			...integrationComposition.registrations.map((registration) => registration.adapter),
		];
		const plannedTools = (
			capabilities: { readonly shell: boolean },
		) => filterToolDefinitions(
			Object.freeze([
				...planToolExposure(toolManifest, capabilities),
				...extensionDefinitions,
			]),
			runtimeOptions.allowedTools,
		);
		const toolRouter = new ToolRouter({
			adapters,
			exposure: plannedTools({ shell: true }),
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
		});
		approvalCoordinator.recover();
		const clarificationCoordinator = new ClarificationContinuationCoordinator({
			sessionId,
			workspaceRoot,
			threadId,
			store,
			clock: () => new Date().toISOString(),
		});
		const queueCoordinator = new QueueCoordinator({
			initial: initialQueue,
			store: {
				loadCommittedQueueIds: () => store.loadCommittedQueueIds(sessionId),
				saveSnapshot: (snapshot) => {
					store.saveQueueSnapshot({ sessionId, workspaceRoot, threadId, snapshot });
				},
				commitPending: (turnId, records) => store.commitQueuedInputs({
					sessionId,
					turnId,
					records,
				}),
			},
			activeTurnId: null,
			createQueueId: randomUUID,
			clock: () => new Date().toISOString(),
		});
		const runtimeInstructions = "You are mycli, a coding agent and personal assistant.";
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
			selector: new MemorySelector({
				provider: {
					stream: (request, streamOptions) => registry.create({
						...config,
						provider: request.provider,
						protocol: request.protocol,
						model: request.model,
					}).stream(request, streamOptions),
				},
				providerConfig: {
					provider: config.provider,
					protocol: config.protocol,
					model: config.model,
				},
			}),
				tokenCounter,
			});
			const createCompactionCoordinator = (
				resolved: Awaited<ReturnType<typeof resolveConfig>>,
			): CompactionCoordinator => {
				const compactionThreshold = compactionThresholdForModel(resolved);
				return new CompactionCoordinator({
					sessionId,
					workspaceRoot,
					threadId,
					store,
					tokenCounter,
					baseContext: `${runtimeInstructions}\n${JSON.stringify(allToolExposure)}`,
					tokenLimit: totalCompactionBudget(
						compactionThreshold,
						resolved.compactionReservedOutputTokens,
					),
					reservedOutputTokens: resolved.compactionReservedOutputTokens,
					triggerRatio: 1,
					tailTurns: resolved.compactionTailTurns,
					tailMaxTokens: resolved.compactionTailMaxTokens,
					minSavingsRatio: resolved.compactionMinSavingsRatio,
					summaryMaxTokens: 600,
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
			const runtime = new NodeTurnRuntime({
			sessionId,
			workspaceRoot,
			threadId,
			instructions: runtimeInstructions,
			...(options.maxOutputTokens === undefined
				? {}
				: { maxOutputTokens: options.maxOutputTokens }),
			store,
			resolveConfig: (submission) => resolveConfig({
				homeDir,
				workspaceRoot,
				env: options.env,
				overrides: {
					session: sessionId,
					model: submission.modelOverride ?? activeModelOverride,
				},
			}),
			createProvider: (resolved) => registry.create(resolved),
			createTurnId: randomUUID,
			clock: () => new Date().toISOString(),
			publishLifecycle,
			executionPolicyCoordinator,
			planTools: plannedTools,
			toolRouter,
			hookRunner: integrationComposition.hookRunner,
			contextItemCoordinator,
			approvalPolicy: {
				evaluate: async (call) => {
					await ensureExecPolicyLoaded();
					return approvalPolicy.evaluate(call);
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
				await transcriptSnapshots.write(canonicalSnapshot(
					store,
					overview,
					approval.pendingApproval !== undefined,
					approval.pendingClarification !== undefined,
					approval.suspendedTurn,
				));
			},
				createCompactionCoordinator,
			});
			const allowancePattern = (value: string): readonly string[] => {
				const parsed = parseShellCommand(value, { shellKind: shellProfile.kind });
				if (parsed.kind !== "plain" || parsed.segments.length !== 1) {
					throw new Error("invalid_arguments: command allowance must be one command prefix");
				}
				return parsed.segments[0]!.words;
			};
			return Object.assign(runtime, {
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
					const resolved = await resolveConfig({
						homeDir,
						workspaceRoot,
						env: options.env,
						overrides: {
							session: sessionId,
							model: input.modelOverride ?? activeModelOverride,
						},
					});
					const commandId = `command_compact_${randomUUID().replaceAll("-", "")}`;
					const result = await createCompactionCoordinator(resolved).compact({
						clientTurnId: commandId,
						turnId: commandId,
						source: "user_requested",
						conversation: store.loadConversationItems(sessionId),
						freshItemIds: new Set(),
						emit: () => undefined,
						signal: input.signal,
					});
					return {
						status: result.status,
						beforeTokens: result.beforeTokens,
						afterTokens: result.afterTokens,
					};
				},
			});
		};
	childRuntimeFactoryDelegate.create = async (input) => {
		const runtime = createRuntime(
			input.childSessionId,
			config.workspaceRoot,
			input.childSessionId,
			emptyQueue(input.childSessionId),
			undefined,
			{ allowedTools: input.tools },
		);
		let activeTurnId: string | undefined;
		let running = false;
		return {
			run: async (prompt, signal, emit) => {
				activeTurnId = randomUUID();
				running = true;
				try {
					const result = await runtime.submit({
						clientTurnId: randomUUID(),
						turnId: activeTurnId,
						message: prompt,
						...(input.model ? { modelOverride: input.model } : {}),
					}, (event) => emitChildRuntimeEvent(event, emit), { signal });
					return Object.freeze({
						status: childStatus(result.status),
						report: childReport(result),
						usage: childUsage(result),
					});
				} finally {
					running = false;
				}
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
			interrupt: async () => undefined,
			close: async () => undefined,
		};
	};
	try {
		const prepare = (sessionId: string) => prepareStoredSession({
			sessionId,
			store,
			transcriptSnapshots,
			createRuntime,
			fallbackWorkspaceRoot: config.workspaceRoot,
		});
		let initial: PreparedSession<NodeGatewayRuntime>;
		try {
			initial = await prepare(config.sessionId);
		} catch (error) {
			if (!hasCode(error, "session_not_found")) throw error;
			initial = virtualSession(config.sessionId, config.workspaceRoot, createRuntime);
		}
		const sessionCoordinator = new SessionCoordinator<NodeGatewayRuntime>({
			initial,
			prepare,
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
			const gatewayIntegrations = integrationGateway(integrationComposition);
				const activeMemoryStore = () => new MemoryStore({
				homeDir,
				workspaceRoot: sessionCoordinator.snapshot().workspaceRoot,
				});
				const activeFileHistory = () => new FileHistoryStore({
					homeDir,
					workspaceRoot: sessionCoordinator.snapshot().workspaceRoot,
				});
			return createNodeGateway({
			sessionId: config.sessionId,
			workspaceRoot: config.workspaceRoot,
			provider: config.provider,
			model: config.model,
			toolNames: allToolExposure.map((tool) => tool.name),
			maxPromptTokens: config.maxPromptTokens,
			runtime: initial.binding,
				loadConversation: (sessionId) => store.loadConversation(sessionId),
				loadTranscript: (sessionId) => canonicalTranscript(store, sessionId),
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
								return { ...store.sessionMaintenanceReport({ workspaceRoot }) };
							}
							if (action === "empty") {
								return { ...store.cleanupEmptySessions({ workspaceRoot }) };
							}
							if (action === "orphans") return { ...store.cleanupOrphanedSessionRows() };
							return { ...store.vacuumSessionStorage() };
						},
					},
					traceCommands: {
						inspect: (sessionId) => nodeTraceRows(store, sessionId),
						export: (sessionId) => nodeTraceRows(store, sessionId).map((row) => JSON.stringify(row)),
						logs: () => nodeLogRows(homeDir),
					},
					fileHistoryCommands: {
						undo: (sessionId) => activeFileHistory().undoLatest({ sessionId }),
					},
					controlCommands: {
						authProviders: async () => await Promise.all(listProviderProfiles().map(async (profile) => ({
							id: profile.provider,
							name: providerDisplayName(profile.provider),
							configured: Boolean(await readApiKey({
								homeDir,
								authRef: profile.provider,
							})),
							...(profile.defaultModel ? { default_model: profile.defaultModel } : {}),
						}))),
						saveApiKey: async (providerId, apiKey) => {
							const profile = resolveProviderProfile(providerId);
							await writeApiKey({ homeDir, authRef: profile.provider, apiKey });
							return {
								ok: true,
								provider_id: profile.provider,
								message: `Saved API key for ${providerDisplayName(profile.provider)}.`,
							};
						},
						models: async () => modelCatalog(controlConfig),
						selectModel: async (input) => {
							const provider = controlString(input.provider, "provider");
							const protocolValue = controlString(input.protocol, "protocol");
							const profile = resolveProviderProfile(provider, protocolValue);
							const protocol = parseProtocol(protocolValue);
							const model = controlString(input.model, "model");
							const apiBaseUrl = controlString(input.base_url, "base_url").replace(/\/+$/u, "");
							const reasoningEffort = controlReasoningEffort(input.reasoning_effort);
							await writeUserProviderConfig({
								homeDir,
								provider: profile.provider,
								protocol,
								model,
								apiBaseUrl,
								authRef: profile.provider,
								promptCacheKeyEnabled: profile.promptCacheKeyEnabled,
								cacheControlEnabled: profile.cacheControlEnabled,
								...(reasoningEffort ? { reasoningEffort } : {}),
							});
							activeModelOverride = model;
							controlConfig = {
								...controlConfig,
								provider: profile.provider,
								protocol,
								model,
								apiBaseUrl,
								authRef: profile.provider,
								promptCacheKeyEnabled: profile.promptCacheKeyEnabled,
								cacheControlEnabled: profile.cacheControlEnabled,
								...(reasoningEffort ? { reasoningEffort } : {}),
							};
							return modelCatalogEntry(controlConfig, true);
						},
						loadSettings: async () => ({ ...await loadShellSettings({ homeDir }) }),
						saveSettings: async (settings) => ({
							...await saveShellSettings({ homeDir, settings }),
						}),
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
			close: async () => {
				try {
					await integrationComposition.close();
				} finally {
					try {
						await shellManager.close();
					} finally {
						try {
							await shellLifecycle.drain();
						} finally {
							store.close();
						}
					}
				}
			},
		});
	} catch (error) {
		try {
			await integrationComposition.close().catch(() => undefined);
		} finally {
			try {
				await shellManager.close().catch(() => undefined);
			} finally {
				try {
					await shellLifecycle.drain();
				} finally {
					store.close();
				}
			}
		}
		throw error;
	}
}

function modelCatalog(config: NodeRuntimeConfig): readonly Readonly<Record<string, unknown>>[] {
	return Object.freeze(listProviderProfiles().flatMap((profile) => {
		const current = profile.provider === config.provider;
		const model = current ? config.model : profile.defaultModel;
		if (!model) return [];
		const entryConfig: NodeRuntimeConfig = current ? config : {
			...config,
			provider: profile.provider,
			protocol: profile.defaultProtocol,
			model,
			apiBaseUrl: profile.defaultBaseUrl,
		};
		return [modelCatalogEntry(entryConfig, current)];
	}));
}

function modelCatalogEntry(
	config: NodeRuntimeConfig,
	current: boolean,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		provider: config.provider,
		protocol: config.protocol,
		model: config.model,
		name: config.model,
		description: `${providerDisplayName(config.provider)} ${config.protocol.replaceAll("_", " ")}`,
		base_url: config.apiBaseUrl,
		supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
		default_reasoning_effort: config.reasoningEffort,
		default: resolveProviderProfile(config.provider).defaultModel === config.model,
		current,
	});
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

function controlString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`invalid_arguments: ${name} is required`);
	}
	return value.trim();
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
	) return value;
	throw new Error("invalid_arguments: unsupported reasoning_effort");
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

function integrationGateway(
	composition: RuntimeIntegrationComposition,
): NodeGatewayIntegrations {
		const integrations: NodeGatewayIntegrations = {
			toolManifest: composition.manifest as unknown as Record<string, unknown>,
			diagnostics: composition.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		listResources: () => composition.resources.map((resource) => ({ ...resource })),
		...(composition.commands.length > 0 ? {
			commands: combinedIntegrationCommands(composition.commands),
		} : {}),
		subscribeSubagents: (
			listener: (subagent: Readonly<Record<string, unknown>>) => void,
		) => composition.subscribeSubagents(listener),
	};
	return Object.freeze(integrations);
}

function nodeTraceRows(
	store: SQLiteSessionStore,
	sessionId: string,
): readonly Readonly<Record<string, unknown>>[] {
	return store.loadTurnRollouts(sessionId).slice(-50).map((rollout) => {
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

function compactionThresholdForModel(config: Awaited<ReturnType<typeof resolveConfig>>): number {
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

function totalCompactionBudget(threshold: number, reservedOutputTokens: number): number {
	const total = threshold + reservedOutputTokens;
	if (!Number.isSafeInteger(total) || total <= reservedOutputTokens) {
		throw new Error("config_error: compaction token budget is not representable");
	}
	return total;
}

interface PrepareStoredSessionOptions {
	readonly sessionId: string;
	readonly store: SQLiteSessionStore;
	readonly transcriptSnapshots: TranscriptSnapshotStore;
	readonly fallbackWorkspaceRoot: string;
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
	const { sessionId, store, transcriptSnapshots, createRuntime } = options;
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
			return {
				sessionId,
				workspaceRoot: importedOverview.workspaceRoot,
				threadId: importedOverview.threadId,
				transcript: degraded.snapshot.transcript,
				queue: emptyQueue(sessionId),
				suspendedTurn: false,
				readOnly: false,
				binding: createRuntime(
					sessionId,
					importedOverview.workspaceRoot,
					importedOverview.threadId,
					emptyQueue(sessionId),
				),
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
	return {
		sessionId,
		workspaceRoot: overview.workspaceRoot,
		threadId: overview.threadId,
		transcript: transcript.snapshot.transcript,
		queue,
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
	store: SQLiteSessionStore,
	overview: SessionOverview,
	pendingApproval: boolean,
	pendingClarification: boolean,
	suspendedTurn: boolean,
): TranscriptSnapshotV2 {
	const transcript = canonicalTranscript(store, overview.sessionId);
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
	};
}

function canonicalTranscript(
	store: SQLiteSessionStore,
	sessionId: string,
): readonly TranscriptItem[] {
	const projected = projectTranscript(
		store.loadHistoryItems(sessionId),
		store.loadTurnRollouts(sessionId),
		{ limit: 500 },
	);
	return projected.length > 0 ? projected : legacyConversationTranscript(store, sessionId);
}

function legacyConversationTranscript(
	store: SQLiteSessionStore,
	sessionId: string,
): readonly TranscriptItem[] {
	return Object.freeze(store.loadConversation(sessionId).map((message, index) => Object.freeze({
		id: `${sessionId}:legacy:${index + 1}`,
		type: message.role === "user" ? "user_message" : "assistant_message",
		text: message.content,
	}) satisfies TranscriptItem));
}

function importLegacySnapshot(
	store: SQLiteSessionStore,
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

function loadQueue(store: SQLiteSessionStore, sessionId: string): QueueSnapshot {
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
	store: SQLiteSessionStore,
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
	store: SQLiteSessionStore,
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
	store: SQLiteSessionStore,
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
