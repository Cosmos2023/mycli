import { existsSync } from "node:fs";
import { parseRuntimeState } from "@mycli/contracts";
import type {
	AgentCanonicalEvent,
	QueueSnapshot,
	QueuedInput,
} from "@mycli/core";
import { serializeSubagentTaskNotification } from "@mycli/integrations";
import {
	SessionTransitionError,
	type QueueCoordinator,
	type PendingSessionApproval,
	type PendingSessionClarification,
	type PreparedSession,
} from "@mycli/runtime";
import {
	SnapshotStateError,
	snapshotRequestSummary,
	snapshotSessionMetadata,
	sessionSubagentIndexEntry,
	subagentRunId,
	type AgentThreadRecord,
	type LegacySnapshotMessage,
	type RuntimeSessionStore,
	type SessionArtifactStore,
	type SessionListQuery,
	type SessionOverview,
	type TranscriptItem,
	type TranscriptSnapshotStore,
	type TranscriptSnapshotV2,
	type SubagentTaskRecord,
	type WriteSubagentSnapshotInput,
} from "@mycli/storage";
import { permissionRequestFromJson, shellApprovalPreview } from "@mycli/tools";
import type { NodeGatewayRuntime } from "./node-gateway.ts";
import {
	projectReadableSessionTranscript,
	projectRecentSessionTranscript,
} from "./readable-session-transcript.ts";
import type { SerializedSessionArtifactQueue } from "./node-runtime-resources.ts";

interface PrepareStoredSessionOptions {
	readonly sessionId: string;
	readonly intent: "resume" | "inspect";
	readonly store: RuntimeSessionStore;
	readonly transcriptSnapshots: TranscriptSnapshotStore;
	readonly sessionArtifacts: SessionArtifactStore;
	readonly artifactQueue: SerializedSessionArtifactQueue;
	readonly fallbackWorkspaceRoot: string;
	readonly repairAgentCompletions?: (parentSessionId: string) => Promise<void>;
	readonly liveRuntime?: NodeGatewayRuntime & { readonly workspaceRoot: string };
	readonly createRuntime: (
		sessionId: string,
		workspaceRoot: string,
		threadId: string,
		initialQueue: QueueSnapshot,
		initialContinuation?: unknown,
	) => NodeGatewayRuntime | Promise<NodeGatewayRuntime>;
}

export async function prepareStoredSession(
	options: PrepareStoredSessionOptions,
): Promise<PreparedSession<NodeGatewayRuntime>> {
	const {
		sessionId,
		store,
		transcriptSnapshots,
		sessionArtifacts,
		artifactQueue,
	} = options;
	const createRuntime: PrepareStoredSessionOptions["createRuntime"] = options.liveRuntime
		? () => options.liveRuntime!
		: options.intent === "inspect" ? () => inspectionRuntime() : options.createRuntime;
	let overview: SessionOverview | undefined;
	try {
		overview = store.loadSession(sessionId);
	} catch (error) {
		const degraded = await loadDegradedSnapshot(transcriptSnapshots, sessionId, error);
		return preparedFromReadOnlySnapshot(degraded);
	}
	if (!overview) {
		if (options.liveRuntime) return virtualSession(sessionId, options.liveRuntime.workspaceRoot, createRuntime);
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
				return preparedFromReadOnlySnapshot(degraded.snapshot);
			}
			const importedOverview = store.loadSession(sessionId);
			if (!importedOverview) {
				throw new SessionTransitionError("session_state_invalid", "legacy session was not imported");
			}
			const initialQueue = emptyQueue(sessionId);
			const binding = await createRuntime(
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
	const compactionState = store.loadState(sessionId, "compact_checkpoint");
	const responsesContinuation = loadResponsesContinuation(store, sessionId);
	if (options.intent === "resume" && !options.liveRuntime) store.interruptSessionForResume(sessionId);
	overview = store.loadSession(sessionId) ?? overview;

	const approvalState = loadApprovalState(store, sessionId);
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
		return preparedFromReadOnlySnapshot(transcript.snapshot);
	}
	const binding = await createRuntime(
		sessionId,
		overview.workspaceRoot,
		overview.threadId,
		queue,
		responsesContinuation,
	);
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

export async function virtualSession(
	sessionId: string,
	workspaceRoot: string,
	createRuntime: PrepareStoredSessionOptions["createRuntime"],
): Promise<PreparedSession<NodeGatewayRuntime>> {
	return {
		sessionId,
		workspaceRoot,
		threadId: sessionId,
		transcript: Object.freeze([]),
		queue: emptyQueue(sessionId),
		suspendedTurn: false,
		readOnly: false,
		binding: await createRuntime(sessionId, workspaceRoot, sessionId, emptyQueue(sessionId)),
	};
}

export function canonicalSnapshot(
	store: RuntimeSessionStore,
	overview: SessionOverview,
	pendingApproval: boolean,
	pendingClarification: boolean,
	suspendedTurn: boolean,
): TranscriptSnapshotV2 {
	const window = store.loadReadableTranscriptSnapshot(overview.sessionId);
	const hasCanonicalHistory = window.coverage.included_events > 0 || window.coverage.has_older_events;
	const transcript = hasCanonicalHistory ? window.items : legacyConversationTranscript(store, overview.sessionId);
	const coverage = hasCanonicalHistory || transcript.length === 0 ? window.coverage : undefined;
	const manifest = store.modelInputLedger.loadLatestProviderRequestManifest(overview.sessionId);
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
		session: snapshotSessionMetadata(overview),
		...(manifest ? { last_request: snapshotRequestSummary(manifest) } : {}),
		...(coverage ? { coverage } : {}),
		transcript,
		subagents: subagentIndex(store, overview.sessionId),
		links: { events: "events.jsonl" },
	};
}

export function canonicalTranscript(
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

export function terminalSubagentOutput(record: SubagentTaskRecord): string {
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

export async function projectCanonicalAgentEvent(
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

export function publishCanonicalSubagentEvent(
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

export function isTerminalSubagentStatus(
	value: unknown,
): value is "completed" | "failed" | "interrupted" {
	return value === "completed" || value === "failed" || value === "interrupted";
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
): PreparedSession<NodeGatewayRuntime> {
	return {
		sessionId: snapshot.session_id,
		workspaceRoot: snapshot.cwd,
		threadId: snapshot.session_id,
		transcript: snapshot.transcript,
		queue: emptyQueue(snapshot.session_id),
		suspendedTurn: snapshot.state === "waiting_approval" || snapshot.state === "interrupted",
		readOnly: true,
		binding: inspectionRuntime(),
	};
}

/** Transcript inspection never starts tools, clients or a writable runtime. */
function inspectionRuntime(): NodeGatewayRuntime {
	const unavailable = (): never => {
		throw new SessionTransitionError("session_state_invalid", "an inspected session cannot execute turns");
	};
	return Object.freeze({ reserve: unavailable, submit: unavailable, resolveApproval: unavailable,
		resolveClarification: unavailable, forceInterrupt: unavailable });
}

export function loadQueue(store: RuntimeSessionStore, sessionId: string): QueueSnapshot {
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
	readonly claim_turn_id?: string | null;
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
		...(record.claim_turn_id ? { claimTurnId: record.claim_turn_id } : {}),
		text: record.text,
		imagePaths: Object.freeze([...record.image_paths]),
		source: record.source,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
	});
}

export function emptyQueue(sessionId: string): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision: 0,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
}

export function loadApprovalState(
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
			...shellApprovalPreview({
				callId: call.call_id,
				name: call.name,
				argumentsJson: JSON.stringify(call.arguments),
			}),
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

export function loadResponsesContinuation(
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

export function listSessionsWithVirtualInitial(
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

export function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error
		&& "code" in error
		&& (error as Error & { readonly code: unknown }).code === code;
}


function objectValue(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}
