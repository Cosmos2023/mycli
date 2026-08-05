import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { parseRuntimeState } from "@mycli/contracts";
import {
	ExecPolicyStore,
	resolveConfig,
	WorkspaceTrustStore,
} from "@mycli/config";
import type {
	QueueSnapshot,
	QueuedInput,
	ShellLifecycleEvent,
} from "@mycli/core";
import { OpenAIProviderRegistry } from "@mycli/providers";
import {
	ApprovalContinuationCoordinator,
	CompactionCoordinator,
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
	BashOutputTool,
	BashTool,
	builtinToolManifest,
	EditTool,
	FileMutationRuntime,
	FileSnapshotStore,
	PatchTool,
	planToolExposure,
	ReadTool,
	resolveShellProfile,
	ShellOutputTool,
	ShellSessionManager,
	ShellTool,
	startPipeTransport,
	ToolRouter,
	KillShellTool,
	WriteStdinTool,
	WriteTool,
} from "@mycli/tools";
import {
	createNodeGateway,
	type NodeGateway,
	type NodeGatewayRuntime,
} from "./node-gateway.ts";

export type NodeBackend = NodeGateway;

export interface StartNodeBackendOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly args: readonly string[];
}

export async function startNodeBackend(options: StartNodeBackendOptions): Promise<NodeBackend> {
	const overrides = parseOverrides(options.args);
	const homeDir = runtimeHome(options.env);
	const config = await resolveConfig({
		homeDir,
		workspaceRoot: options.cwd,
		env: options.env,
		overrides,
	});
	const store = new SQLiteSessionStore({ dbPath: config.sessionsDbPath });
	const workspaceTrustStore = new WorkspaceTrustStore({ homeDir });
	const registry = new OpenAIProviderRegistry();
	const toolExposure = planToolExposure(builtinToolManifest(), { shell: false });
	const shellManager = new ShellSessionManager({ transportFactory: startPipeTransport });
	const shellLifecycle = new ShellLifecycleProjector({ store });
	const publishLifecycle: (event: ShellLifecycleEvent) => void = (event) => {
		shellLifecycle.enqueue(event);
	};
	const transcriptSnapshots = new TranscriptSnapshotStore({ homeDir });
	const tokenCounter = new TokenCounter();
	const createRuntime = (
		sessionId: string,
		workspaceRoot: string,
		threadId: string,
		initialQueue: QueueSnapshot,
		initialContinuation?: unknown,
	): NodeGatewayRuntime => {
		const fileSnapshots = new FileSnapshotStore();
		const mutationRuntime = new FileMutationRuntime({ workspaceRoot, snapshots: fileSnapshots });
		const shellProfile = resolveShellProfile({ env: options.env });
		const execPolicyStore = new ExecPolicyStore({ homeDir, workspaceRoot });
		const approvalPolicy = new ApprovalPolicy({
			workspaceRoot,
			autoApproveMedium: true,
			shellKind: shellProfile.kind,
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
			shellTool,
			new WriteStdinTool({ manager: shellManager }),
			new BashTool({ shell: shellTool }),
			new ShellOutputTool({ manager: shellManager }),
			new BashOutputTool({ manager: shellManager }),
			new KillShellTool({ manager: shellManager }),
		];
		const toolRouter = new ToolRouter({ adapters, exposure: toolExposure });
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
		return new NodeTurnRuntime({
			sessionId,
			workspaceRoot,
			threadId,
			instructions: runtimeInstructions,
			store,
			resolveConfig: (submission) => resolveConfig({
				homeDir,
				workspaceRoot,
				env: options.env,
				overrides: {
					session: sessionId,
					model: submission.modelOverride ?? overrides.model,
				},
			}),
			createProvider: (resolved) => registry.create(resolved),
			createTurnId: randomUUID,
			clock: () => new Date().toISOString(),
			publishLifecycle,
			planTools: () => toolExposure,
			toolRouter,
			approvalPolicy: {
				evaluate: async (call) => {
					await ensureExecPolicyLoaded();
					return approvalPolicy.evaluate(call);
				},
			},
			approvalCoordinator,
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
					approval.suspendedTurn,
				));
			},
			createCompactionCoordinator: (resolved) => {
				const compactionThreshold = compactionThresholdForModel(resolved);
				return new CompactionCoordinator({
					sessionId,
					workspaceRoot,
					threadId,
					store,
					tokenCounter,
					baseContext: `${runtimeInstructions}\n${JSON.stringify(toolExposure)}`,
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
			},
		});
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
		return createNodeGateway({
			sessionId: config.sessionId,
			workspaceRoot: config.workspaceRoot,
			provider: config.provider,
			model: config.model,
			toolNames: toolExposure.map((tool) => tool.name),
			maxPromptTokens: config.maxPromptTokens,
			runtime: initial.binding,
			loadConversation: (sessionId) => store.loadConversation(sessionId),
			sessionCoordinator,
			shellManager,
			shellLifecycle,
			workspaceTrust: {
				initialState: initialTrustState,
				load: (workspaceRoot) => workspaceTrustStore.load(workspaceRoot),
				save: (workspaceRoot, state) => workspaceTrustStore.save(workspaceRoot, state),
			},
			close: async () => {
				try {
					await shellManager.close();
				} finally {
					try {
						await shellLifecycle.drain();
					} finally {
						store.close();
					}
				}
			},
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
	suspendedTurn: boolean,
): TranscriptSnapshotV2 {
	const projected = projectTranscript(
		store.loadHistoryItems(overview.sessionId),
		store.loadTurnRollouts(overview.sessionId),
		{ limit: 500 },
	);
	const transcript = projected.length > 0
		? projected
		: legacyConversationTranscript(store, overview.sessionId);
	return {
		schema_version: 2,
		session_id: overview.sessionId,
		cwd: overview.workspaceRoot,
		state: pendingApproval ? "waiting_approval" : suspendedTurn ? "interrupted" : "idle",
		message_count: overview.messageCount,
		created_at: overview.createdAt,
		updated_at: overview.updatedAt,
		transcript,
	};
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
	return canonicalSnapshot(store, current, false, false);
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
): { readonly pendingApproval?: PendingSessionApproval; readonly suspendedTurn: boolean } {
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
	if (pendingPayload === undefined) {
		return { suspendedTurn: suspended !== undefined };
	}
	if (suspended === undefined) {
		throw new SessionTransitionError("session_state_invalid", "pending approval has no suspended turn");
	}
	const pending = parseRuntimeState({ kind: "pending_decision", version: 1, payload: pendingPayload });
	if (pending.kind !== "pending_decision" || suspended.kind !== "suspended_turn") {
		throw new SessionTransitionError("session_state_invalid", "approval continuation is invalid");
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
