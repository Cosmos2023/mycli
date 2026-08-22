import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
	AgentPathError,
	agentTaskName,
	agentThreadId,
	assertAgentStatusTransition,
	childAgentPath,
	parseAgentPath,
	rootAgentPath,
} from "@mycli/core";
import type {
	AgentLifecycleStatus,
	AgentPath,
	AgentSpawnConfigSnapshot,
	AgentThreadId,
} from "@mycli/core";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";
import type {
	ReserveSubagentTaskInput,
	SubagentTaskRecord,
} from "./subagent-task-store.ts";

export interface AgentThreadRecord {
	readonly threadId: AgentThreadId;
	readonly rootThreadId: AgentThreadId;
	readonly parentThreadId: AgentThreadId;
	readonly path: AgentPath;
	readonly taskName: string;
	readonly nickname?: string;
	readonly profileId: string;
	readonly status: AgentLifecycleStatus;
	readonly spawnConfig?: AgentSpawnConfigSnapshot;
	readonly sourceTaskId?: string;
	readonly terminalSummary?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastActiveAt: string;
	readonly completedAt?: string;
}

export interface ReserveAgentThreadInput {
	readonly threadId: string;
	readonly rootThreadId: string;
	readonly parentThreadId: string;
	readonly parentPath: AgentPath;
	readonly taskName: string;
	readonly nickname?: string;
	readonly profileId: string;
	readonly spawnConfig: AgentSpawnConfigSnapshot;
}

export interface TransitionAgentThreadInput {
	readonly threadId: string;
	readonly status: AgentLifecycleStatus;
	readonly terminalSummary?: string;
}

export interface AgentRuntimeCheckpoint {
	readonly kind: "idle" | "provider_turn" | "tool_call";
	readonly committed: boolean;
	readonly turnId?: string;
	readonly callId?: string;
	readonly mutating?: boolean;
}

export interface AgentRuntimeLease {
	readonly threadId: AgentThreadId;
	readonly generation: string;
	readonly ownerId: string;
	readonly ownerPid: number;
	readonly checkpoint: AgentRuntimeCheckpoint;
	readonly acquiredAt: string;
	readonly updatedAt: string;
}

export interface SaveAgentRuntimeLeaseInput {
	readonly threadId: string;
	readonly generation: string;
	readonly ownerId: string;
	readonly ownerPid: number;
	readonly checkpoint: AgentRuntimeCheckpoint;
}

export interface AgentThreadListQuery {
	readonly rootThreadId: string;
	readonly pathPrefix?: AgentPath;
	readonly limit?: number;
}

export interface AgentRuntimeReconciliationResult {
	readonly restoredIdle: number;
	readonly interrupted: number;
	readonly terminalized: number;
	readonly liveOwners: number;
	readonly clearedLeases: number;
}

export interface AgentThreadStore {
	reserve(input: ReserveAgentThreadInput): AgentThreadRecord;
	get(threadId: string): AgentThreadRecord | undefined;
	getByPath(rootThreadId: string, path: AgentPath): AgentThreadRecord | undefined;
	list(query: AgentThreadListQuery): readonly AgentThreadRecord[];
	transition(input: TransitionAgentThreadInput): AgentThreadRecord;
	touch(threadId: string): AgentThreadRecord;
	saveLease(input: SaveAgentRuntimeLeaseInput): AgentRuntimeLease;
	loadLease(threadId: string): AgentRuntimeLease | undefined;
	clearLease(threadId: string, ownerId?: string): boolean;
	reconcileStaleRuntimes(reason: string): AgentRuntimeReconciliationResult;
	projectLegacyTasks(parentSessionId?: string): number;
}

export interface ReserveAgentSpawnInput {
	readonly thread: ReserveAgentThreadInput;
	readonly task: ReserveSubagentTaskInput;
}

export interface AgentSpawnReservation {
	readonly thread: AgentThreadRecord;
	readonly task: SubagentTaskRecord;
}

export interface AgentSpawnStore {
	reserve(input: ReserveAgentSpawnInput): AgentSpawnReservation;
}

export interface SQLiteAgentThreadRepositoryOptions {
	readonly database: Database.Database;
	readonly clock: () => string;
	readonly write: <Result>(operation: () => Result) => Result;
	readonly isProcessAlive: (processId: number) => boolean;
}

interface AgentThreadRow {
	readonly thread_id: unknown;
	readonly root_thread_id: unknown;
	readonly parent_thread_id: unknown;
	readonly agent_path: unknown;
	readonly task_name: unknown;
	readonly nickname: unknown;
	readonly profile_id: unknown;
	readonly status: unknown;
	readonly spawn_config_json: unknown;
	readonly source_task_id: unknown;
	readonly terminal_summary: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly last_active_at: unknown;
	readonly completed_at: unknown;
}

interface AgentRuntimeLeaseRow {
	readonly thread_id: unknown;
	readonly generation: unknown;
	readonly owner_id: unknown;
	readonly owner_pid: unknown;
	readonly checkpoint_json: unknown;
	readonly acquired_at: unknown;
	readonly updated_at: unknown;
}

interface LegacyTaskRow {
	readonly task_id: unknown;
	readonly parent_session_id: unknown;
	readonly child_session_id: unknown;
	readonly profile_id: unknown;
	readonly status: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly completed_at: unknown;
	readonly root_thread_id: unknown;
	readonly child_thread_id: unknown;
}

interface RecoveryTaskRow {
	readonly task_id: unknown;
	readonly status: unknown;
	readonly payload_json: unknown;
}

const THREAD_COLUMNS = `
thread_id,
root_thread_id,
parent_thread_id,
agent_path,
task_name,
nickname,
profile_id,
status,
spawn_config_json,
source_task_id,
terminal_summary,
created_at,
updated_at,
last_active_at,
completed_at
`;
const LEASE_COLUMNS = `
thread_id,
generation,
owner_id,
owner_pid,
checkpoint_json,
acquired_at,
updated_at
`;
const TERMINAL_STATUSES = new Set<AgentLifecycleStatus>(["completed", "failed", "interrupted"]);
const AGENT_THREAD_LIST_MAX = 10_000;
const IDENTIFIER_MAX_CHARS = 256;
const PROFILE_MAX_CHARS = 64;
const SUMMARY_MAX_CHARS = 131_072;
const SPAWN_CONFIG_MAX_CHARS = 524_288;
const CHECKPOINT_MAX_CHARS = 16_384;

export class SQLiteAgentThreadRepository implements AgentThreadStore {
	readonly #database: Database.Database;
	readonly #clock: () => string;
	readonly #writeTransaction: <Result>(operation: () => Result) => Result;
	readonly #isProcessAlive: (processId: number) => boolean;

	constructor(options: SQLiteAgentThreadRepositoryOptions) {
		this.#database = options.database;
		this.#clock = options.clock;
		this.#writeTransaction = options.write;
		this.#isProcessAlive = options.isProcessAlive;
	}

	reserve(input: ReserveAgentThreadInput): AgentThreadRecord {
		const candidate = validateReserve(input);
		return this.#writeTransaction(() => {
			const existing = this.#get(candidate.threadId);
			if (existing) {
				if (!sameReservation(existing, candidate)) {
					throw new StorageFailure("agent thread reservation conflicts with existing thread");
				}
				return existing;
			}
			const pathOwner = this.#getByPath(candidate.rootThreadId, candidate.path);
			if (pathOwner) throw new StorageFailure("agent path is already reserved");
			const now = timestamp(this.#clock(), "clock");
			this.#database.prepare(`
				INSERT INTO agent_threads (
					thread_id, root_thread_id, parent_thread_id, agent_path,
					task_name, nickname, profile_id, status, spawn_config_json,
					source_task_id, terminal_summary, created_at, updated_at,
					last_active_at, completed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, ?, NULL)
			`).run(
				candidate.threadId,
				candidate.rootThreadId,
				candidate.parentThreadId,
				candidate.path,
				candidate.taskName,
				candidate.nickname ?? null,
				candidate.profileId,
				stableJson(candidate.spawnConfig),
				now,
				now,
				now,
			);
			this.#database.prepare(`
				INSERT INTO agent_spawn_edges (
					parent_thread_id, child_thread_id, root_thread_id,
					status, created_at, updated_at
				) VALUES (?, ?, ?, 'queued', ?, ?)
			`).run(
				candidate.parentThreadId,
				candidate.threadId,
				candidate.rootThreadId,
				now,
				now,
			);
			return this.#required(candidate.threadId);
		});
	}

	get(threadId: string): AgentThreadRecord | undefined {
		return this.#read(() => this.#get(agentThreadId(threadId)));
	}

	getByPath(rootThreadId: string, path: AgentPath): AgentThreadRecord | undefined {
		return this.#read(() => this.#getByPath(agentThreadId(rootThreadId), parseAgentPath(path)));
	}

	list(query: AgentThreadListQuery): readonly AgentThreadRecord[] {
		const rootThreadId = agentThreadId(query.rootThreadId);
		const prefix = query.pathPrefix === undefined ? undefined : parseAgentPath(query.pathPrefix);
		const limit = positiveInteger(query.limit ?? 1_000, "limit", AGENT_THREAD_LIST_MAX);
		return this.#read(() => {
			const rows = this.#database.prepare(`
				SELECT ${THREAD_COLUMNS}
				FROM agent_threads
				WHERE root_thread_id = ?
					${prefix === undefined ? "" : "AND (agent_path = ? OR agent_path LIKE ? ESCAPE '\\')"}
				ORDER BY agent_path ASC, created_at ASC, thread_id ASC
				LIMIT ?
			`).all(...(
				prefix === undefined
					? [rootThreadId, limit]
					: [rootThreadId, prefix, `${escapeLike(prefix)}/%`, limit]
			)) as readonly AgentThreadRow[];
			return Object.freeze(rows.map(recordFromRow));
		});
	}

	transition(input: TransitionAgentThreadInput): AgentThreadRecord {
		const threadId = agentThreadId(input.threadId);
		const target = statusValue(input.status);
		const summary = input.terminalSummary === undefined
			? undefined
			: boundedString(input.terminalSummary, "terminal summary", SUMMARY_MAX_CHARS);
		if (TERMINAL_STATUSES.has(target) !== (summary !== undefined)) {
			throw new StorageFailure("terminal agent transitions require a terminal summary");
		}
		return this.#writeTransaction(() => {
			const current = this.#required(threadId);
			if (current.status === target) {
				if (current.terminalSummary === summary) return current;
				throw new StorageFailure("agent terminal transition conflicts with existing state");
			}
			try {
				assertAgentStatusTransition(current.status, target);
			} catch {
				throw new StorageFailure(`invalid agent transition from ${current.status} to ${target}`);
			}
			const now = timestamp(this.#clock(), "clock");
			const completedAt = TERMINAL_STATUSES.has(target) ? now : null;
			this.#database.prepare(`
				UPDATE agent_threads
				SET status = ?, terminal_summary = ?, updated_at = ?,
					last_active_at = ?, completed_at = ?
				WHERE thread_id = ? AND status = ?
			`).run(target, summary ?? null, now, now, completedAt, threadId, current.status);
			this.#database.prepare(`
				UPDATE agent_spawn_edges
				SET status = ?, updated_at = ?
				WHERE child_thread_id = ?
			`).run(target, now, threadId);
			if (TERMINAL_STATUSES.has(target)) {
				this.#database.prepare("DELETE FROM agent_runtime_leases WHERE thread_id = ?").run(threadId);
			}
			return this.#required(threadId);
		});
	}

	touch(threadId: string): AgentThreadRecord {
		const normalized = agentThreadId(threadId);
		return this.#writeTransaction(() => {
			this.#required(normalized);
			const now = timestamp(this.#clock(), "clock");
			this.#database.prepare(`
				UPDATE agent_threads
				SET updated_at = ?, last_active_at = ?
				WHERE thread_id = ?
			`).run(now, now, normalized);
			return this.#required(normalized);
		});
	}

	saveLease(input: SaveAgentRuntimeLeaseInput): AgentRuntimeLease {
		const candidate = validateLease(input);
		return this.#writeTransaction(() => {
			const thread = this.#required(candidate.threadId);
			if (TERMINAL_STATUSES.has(thread.status)) {
				throw new StorageFailure("terminal agent cannot acquire a runtime lease");
			}
			const now = timestamp(this.#clock(), "clock");
			const current = this.#loadLease(candidate.threadId);
			if (current && current.ownerId !== candidate.ownerId) {
				throw new StorageFailure("agent runtime lease is owned by another runtime");
			}
			this.#database.prepare(`
				INSERT INTO agent_runtime_leases (
					thread_id, generation, owner_id, owner_pid,
					checkpoint_json, acquired_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(thread_id) DO UPDATE SET
					generation = excluded.generation,
					owner_id = excluded.owner_id,
					owner_pid = excluded.owner_pid,
					checkpoint_json = excluded.checkpoint_json,
					updated_at = excluded.updated_at
			`).run(
				candidate.threadId,
				candidate.generation,
				candidate.ownerId,
				candidate.ownerPid,
				stableJson(candidate.checkpoint),
				current?.acquiredAt ?? now,
				now,
			);
			return this.#requiredLease(candidate.threadId);
		});
	}

	loadLease(threadId: string): AgentRuntimeLease | undefined {
		return this.#read(() => this.#loadLease(agentThreadId(threadId)));
	}

	clearLease(threadId: string, ownerId?: string): boolean {
		const normalizedThreadId = agentThreadId(threadId);
		const normalizedOwnerId = ownerId === undefined ? undefined : identifier(ownerId, "ownerId");
		return this.#writeTransaction(() => this.#database.prepare(`
			DELETE FROM agent_runtime_leases
			WHERE thread_id = ? ${normalizedOwnerId === undefined ? "" : "AND owner_id = ?"}
		`).run(...(normalizedOwnerId === undefined
			? [normalizedThreadId]
			: [normalizedThreadId, normalizedOwnerId])).changes > 0);
	}

	reconcileStaleRuntimes(reason: string): AgentRuntimeReconciliationResult {
		const interruptionReason = boundedString(reason, "reconciliation reason", 4_096);
		return this.#writeTransaction(() => {
			const rows = this.#database.prepare(`
				SELECT ${THREAD_COLUMNS}
				FROM agent_threads
				WHERE status NOT IN ('completed', 'failed', 'interrupted')
				ORDER BY created_at ASC, thread_id ASC
			`).all() as readonly AgentThreadRow[];
			const result = {
				restoredIdle: 0,
				interrupted: 0,
				terminalized: 0,
				liveOwners: 0,
				clearedLeases: 0,
			};
			let reconciliationTimestamp: string | undefined;
			const now = (): string => {
				reconciliationTimestamp ??= timestamp(this.#clock(), "clock");
				return reconciliationTimestamp;
			};
			for (const row of rows) {
				const thread = recordFromRow(row);
				const lease = this.#loadLease(thread.threadId);
				if (lease && this.#isProcessAlive(lease.ownerPid)) {
					result.liveOwners += 1;
					continue;
				}
				const task = this.#database.prepare(`
					SELECT task_id, status, payload_json
					FROM subagent_tasks
					WHERE child_session_id = ?
					ORDER BY created_at DESC, task_id DESC
					LIMIT 1
				`).get(thread.threadId) as RecoveryTaskRow | undefined;
				const taskStatus = task === undefined
					? undefined
					: enumValue(task.status, ["queued", "running", "completed", "failed", "interrupted"], "task status");
				if (taskStatus === "completed") {
					if (thread.status !== "idle" && thread.status !== "unloaded") {
						this.#setRecoveredThread(thread.threadId, "idle", now());
						result.restoredIdle += 1;
					}
					if (lease && this.#deleteLease(thread.threadId)) result.clearedLeases += 1;
					continue;
				}
				if (task && (taskStatus === "failed" || taskStatus === "interrupted")) {
					this.#setRecoveredThread(
						thread.threadId,
						taskStatus,
							now(),
						recoveryTaskSummary(task, taskStatus),
					);
					result.terminalized += 1;
					if (lease && this.#deleteLease(thread.threadId)) result.clearedLeases += 1;
					continue;
				}
				if ((thread.status === "idle" || thread.status === "unloaded")
					&& (!lease || lease.checkpoint.kind === "idle" && lease.checkpoint.committed)) {
					if (lease && this.#deleteLease(thread.threadId)) result.clearedLeases += 1;
					continue;
				}
				if (task && (taskStatus === "queued" || taskStatus === "running")) {
					const payload = recoveryTaskPayload(task.payload_json);
					this.#database.prepare(`
						UPDATE subagent_tasks
						SET status = 'interrupted', payload_json = ?, updated_at = ?, completed_at = ?
						WHERE task_id = ? AND status IN ('queued', 'running')
					`).run(
						stableJson({ ...payload, interruptionReason }),
							now(),
							now(),
						identifier(task.task_id, "task_id"),
					);
				}
				this.#setRecoveredThread(thread.threadId, "interrupted", now(), interruptionReason);
				result.interrupted += 1;
				if (lease && this.#deleteLease(thread.threadId)) result.clearedLeases += 1;
			}
			return Object.freeze(result);
		});
	}

	projectLegacyTasks(parentSessionId?: string): number {
		const parentFilter = parentSessionId === undefined
			? undefined
			: identifier(parentSessionId, "parentSessionId");
		return this.#writeTransaction(() => {
			const rows = this.#database.prepare(`
				SELECT
					t.task_id, t.parent_session_id, t.child_session_id,
					t.profile_id, t.status, t.payload_json, t.created_at,
					t.updated_at, t.completed_at,
					COALESCE(parent.thread_id, t.parent_session_id) AS root_thread_id,
					COALESCE(child.thread_id, t.child_session_id) AS child_thread_id
				FROM subagent_tasks AS t
				LEFT JOIN sessions AS parent ON parent.session_id = t.parent_session_id
				LEFT JOIN sessions AS child ON child.session_id = t.child_session_id
				WHERE NOT EXISTS (
					SELECT 1 FROM agent_threads AS a WHERE a.source_task_id = t.task_id
				)
				${parentFilter === undefined ? "" : "AND t.parent_session_id = ?"}
				ORDER BY t.created_at ASC, t.task_id ASC
			`).all(...(parentFilter === undefined ? [] : [parentFilter])) as readonly LegacyTaskRow[];
			let projected = 0;
			for (const row of rows) projected += this.#projectLegacyRow(row);
			return projected;
		});
	}

	#projectLegacyRow(row: LegacyTaskRow): number {
		const taskId = identifier(row.task_id, "task_id");
		const threadId = agentThreadId(identifier(row.child_thread_id, "child_thread_id"));
		const rootThreadId = agentThreadId(identifier(row.root_thread_id, "root_thread_id"));
		if (this.#get(threadId)) return 0;
		const taskName = `legacy-${createHash("sha256").update(taskId).digest("hex").slice(0, 12)}`;
		const path = childAgentPath(rootAgentPath(), taskName);
		if (this.#getByPath(rootThreadId, path)) return 0;
		const legacyStatus = String(row.status);
		const status: AgentLifecycleStatus = legacyStatus === "completed"
			? "completed"
			: legacyStatus === "failed"
				? "failed"
				: "interrupted";
		const summary = legacySummary(row.payload_json, status);
		const createdAt = timestamp(row.created_at, "created_at");
		const updatedAt = timestamp(row.updated_at, "updated_at");
		const completedAt = row.completed_at === null
			? updatedAt
			: timestamp(row.completed_at, "completed_at");
		this.#database.prepare(`
			INSERT INTO agent_threads (
				thread_id, root_thread_id, parent_thread_id, agent_path,
				task_name, nickname, profile_id, status, spawn_config_json,
				source_task_id, terminal_summary, created_at, updated_at,
				last_active_at, completed_at
			) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
		`).run(
			threadId,
			rootThreadId,
			rootThreadId,
			path,
			taskName,
			identifier(row.profile_id, "profile_id", PROFILE_MAX_CHARS),
			status,
			taskId,
			summary,
			createdAt,
			updatedAt,
			updatedAt,
			completedAt,
		);
		this.#database.prepare(`
			INSERT INTO agent_spawn_edges (
				parent_thread_id, child_thread_id, root_thread_id,
				status, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)
		`).run(rootThreadId, threadId, rootThreadId, status, createdAt, updatedAt);
		return 1;
	}

	#get(threadId: string): AgentThreadRecord | undefined {
		const row = this.#database.prepare(`
			SELECT ${THREAD_COLUMNS}
			FROM agent_threads
			WHERE thread_id = ?
		`).get(threadId) as AgentThreadRow | undefined;
		return row ? recordFromRow(row) : undefined;
	}

	#getByPath(rootThreadId: string, path: AgentPath): AgentThreadRecord | undefined {
		const row = this.#database.prepare(`
			SELECT ${THREAD_COLUMNS}
			FROM agent_threads
			WHERE root_thread_id = ? AND agent_path = ?
		`).get(rootThreadId, path) as AgentThreadRow | undefined;
		return row ? recordFromRow(row) : undefined;
	}

	#required(threadId: string): AgentThreadRecord {
		const record = this.#get(threadId);
		if (!record) throw new StorageFailure("agent thread does not exist");
		return record;
	}

	#loadLease(threadId: string): AgentRuntimeLease | undefined {
		const row = this.#database.prepare(`
			SELECT ${LEASE_COLUMNS}
			FROM agent_runtime_leases
			WHERE thread_id = ?
		`).get(threadId) as AgentRuntimeLeaseRow | undefined;
		return row ? leaseFromRow(row) : undefined;
	}

	#deleteLease(threadId: string): boolean {
		return this.#database.prepare(
			"DELETE FROM agent_runtime_leases WHERE thread_id = ?",
		).run(threadId).changes > 0;
	}

	#setRecoveredThread(
		threadId: string,
		status: "idle" | "failed" | "interrupted",
		now: string,
		terminalSummary?: string,
	): void {
		const terminal = status === "failed" || status === "interrupted";
		this.#database.prepare(`
			UPDATE agent_threads
			SET status = ?, terminal_summary = ?, updated_at = ?, last_active_at = ?, completed_at = ?
			WHERE thread_id = ?
		`).run(
			status,
			terminal ? terminalSummary ?? "agent runtime was not recoverable" : null,
			now,
			now,
			terminal ? now : null,
			threadId,
		);
		this.#database.prepare(`
			UPDATE agent_spawn_edges
			SET status = ?, updated_at = ?
			WHERE child_thread_id = ?
		`).run(status, now, threadId);
	}

	#requiredLease(threadId: string): AgentRuntimeLease {
		const record = this.#loadLease(threadId);
		if (!record) throw new StorageFailure("agent runtime lease does not exist");
		return record;
	}

	#read<Result>(operation: () => Result): Result {
		try {
			return operation();
		} catch (error) {
			if (error instanceof StorageFailure) throw error;
			throw new StorageFailure("agent thread read failed");
		}
	}
}

function validateReserve(input: ReserveAgentThreadInput): ReserveAgentThreadInput & { readonly path: AgentPath } {
	const parentPath = parseAgentPath(input.parentPath);
	const taskName = agentTaskName(input.taskName);
	return Object.freeze({
		threadId: agentThreadId(input.threadId),
		rootThreadId: agentThreadId(input.rootThreadId),
		parentThreadId: agentThreadId(input.parentThreadId),
		parentPath,
		taskName,
		path: childAgentPath(parentPath, taskName),
		...(input.nickname === undefined ? {} : {
			nickname: boundedString(input.nickname, "nickname", 64),
		}),
		profileId: identifier(input.profileId, "profileId", PROFILE_MAX_CHARS),
		spawnConfig: validateSpawnConfig(input.spawnConfig),
	});
}

function validateLease(input: SaveAgentRuntimeLeaseInput): SaveAgentRuntimeLeaseInput {
	return Object.freeze({
		threadId: agentThreadId(input.threadId),
		generation: identifier(input.generation, "generation"),
		ownerId: identifier(input.ownerId, "ownerId"),
		ownerPid: positiveInteger(input.ownerPid, "ownerPid", Number.MAX_SAFE_INTEGER),
		checkpoint: validateCheckpoint(input.checkpoint),
	});
}

function sameReservation(
	record: AgentThreadRecord,
	input: ReturnType<typeof validateReserve>,
): boolean {
	return record.threadId === input.threadId
		&& record.rootThreadId === input.rootThreadId
		&& record.parentThreadId === input.parentThreadId
		&& record.path === input.path
		&& record.taskName === input.taskName
		&& record.nickname === input.nickname
		&& record.profileId === input.profileId
		&& stableJson(record.spawnConfig) === stableJson(input.spawnConfig);
}

function recordFromRow(row: AgentThreadRow): AgentThreadRecord {
	const status = statusValue(row.status);
	const completedAt = row.completed_at === null ? undefined : timestamp(row.completed_at, "completed_at");
	if (TERMINAL_STATUSES.has(status) !== (completedAt !== undefined)) {
		throw new StorageFailure("agent thread terminal timestamp is invalid");
	}
	const terminalSummary = nullableBounded(row.terminal_summary, "terminal_summary", SUMMARY_MAX_CHARS);
	if (TERMINAL_STATUSES.has(status) !== (terminalSummary !== undefined)) {
		throw new StorageFailure("agent thread terminal summary is invalid");
	}
	return Object.freeze({
		threadId: agentThreadId(identifier(row.thread_id, "thread_id")),
		rootThreadId: agentThreadId(identifier(row.root_thread_id, "root_thread_id")),
		parentThreadId: agentThreadId(identifier(row.parent_thread_id, "parent_thread_id")),
		path: safePath(row.agent_path),
		taskName: safeTaskName(row.task_name),
		...(row.nickname === null ? {} : { nickname: boundedString(row.nickname, "nickname", 64) }),
		profileId: identifier(row.profile_id, "profile_id", PROFILE_MAX_CHARS),
		status,
		...(row.spawn_config_json === null ? {} : {
			spawnConfig: parseSpawnConfig(row.spawn_config_json),
		}),
		...(row.source_task_id === null ? {} : {
			sourceTaskId: identifier(row.source_task_id, "source_task_id"),
		}),
		...(terminalSummary === undefined ? {} : { terminalSummary }),
		createdAt: timestamp(row.created_at, "created_at"),
		updatedAt: timestamp(row.updated_at, "updated_at"),
		lastActiveAt: timestamp(row.last_active_at, "last_active_at"),
		...(completedAt === undefined ? {} : { completedAt }),
	});
}

function leaseFromRow(row: AgentRuntimeLeaseRow): AgentRuntimeLease {
	return Object.freeze({
		threadId: agentThreadId(identifier(row.thread_id, "thread_id")),
		generation: identifier(row.generation, "generation"),
		ownerId: identifier(row.owner_id, "owner_id"),
		ownerPid: positiveInteger(row.owner_pid, "owner_pid", Number.MAX_SAFE_INTEGER),
		checkpoint: parseCheckpoint(row.checkpoint_json),
		acquiredAt: timestamp(row.acquired_at, "acquired_at"),
		updatedAt: timestamp(row.updated_at, "updated_at"),
	});
}

function validateSpawnConfig(value: AgentSpawnConfigSnapshot): AgentSpawnConfigSnapshot {
	return parseSpawnConfig(stableJson(value));
}

function parseSpawnConfig(value: unknown): AgentSpawnConfigSnapshot {
	const parsed = parseBoundedJson(value, "agent spawn config", SPAWN_CONFIG_MAX_CHARS);
	if (!isRecord(parsed)) throw new StorageFailure("agent spawn config is invalid");
	const executionPolicy = recordField(parsed, "executionPolicy");
	const provider = recordField(parsed, "provider");
	const instructions = recordField(parsed, "instructions");
	const environment = recordField(parsed, "environment");
	const tools = stringArray(parsed.tools, "tools", 256);
	const forkTurns = parseForkTurns(parsed.forkTurns);
	const budget = parsed.budget === undefined ? undefined : parseBudget(parsed.budget);
	const config = {
		workspaceRoot: boundedString(parsed.workspaceRoot, "workspaceRoot", 4_096),
		cwd: boundedString(parsed.cwd, "cwd", 4_096),
		environment: Object.freeze(Object.fromEntries(
			Object.entries(environment).map(([key, item]) => [
				boundedString(key, "environment key", 256),
				boundedString(item, "environment value", 32_768),
			]),
		)),
		executionPolicy: Object.freeze({
			trusted: booleanValue(executionPolicy.trusted, "trusted"),
			permission: enumValue(executionPolicy.permission, ["read-only", "workspace", "full-access"], "permission"),
			sandboxMode: enumValue(executionPolicy.sandboxMode, ["read-only", "workspace-write", "danger-full-access"], "sandboxMode"),
			filesystem: enumValue(executionPolicy.filesystem, ["read_only", "workspace_write", "unrestricted"], "filesystem"),
			network: enumValue(executionPolicy.network, ["disabled", "enabled"], "network"),
			writableRoots: stringArray(executionPolicy.writableRoots, "writableRoots", 256),
		}),
		provider: Object.freeze({
			provider: enumValue(provider.provider, ["openai", "codex", "compatible", "qwen", "deepseek", "anthropic"], "provider"),
			protocol: enumValue(provider.protocol, ["responses", "chat_completions", "anthropic_messages"], "protocol"),
			model: boundedString(provider.model, "model", 256),
			...(provider.reasoningEffort === undefined ? {} : {
				reasoningEffort: enumValue(provider.reasoningEffort, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], "reasoningEffort"),
			}),
		}),
		instructions: Object.freeze({
			project: boundedString(instructions.project, "project instructions", 262_144),
			...(instructions.role === undefined ? {} : {
				role: boundedString(instructions.role, "role instructions", 131_072),
			}),
		}),
		tools,
		...(budget === undefined ? {} : { budget }),
		forkTurns,
	} satisfies AgentSpawnConfigSnapshot;
	return deepFreeze(config);
}

function parseBudget(value: unknown): NonNullable<AgentSpawnConfigSnapshot["budget"]> {
	if (!isRecord(value)) throw new StorageFailure("agent budget is invalid");
	const result = {
		...(value.maxTurns === undefined ? {} : { maxTurns: positiveInteger(value.maxTurns, "maxTurns") }),
		...(value.maxToolCalls === undefined ? {} : { maxToolCalls: positiveInteger(value.maxToolCalls, "maxToolCalls") }),
		...(value.maxTokens === undefined ? {} : { maxTokens: positiveInteger(value.maxTokens, "maxTokens") }),
		...(value.noProgressTurnLimit === undefined ? {} : {
			noProgressTurnLimit: positiveInteger(value.noProgressTurnLimit, "noProgressTurnLimit"),
		}),
		...(value.wallClockMs === undefined ? {} : { wallClockMs: positiveInteger(value.wallClockMs, "wallClockMs") }),
	};
	return Object.freeze(result);
}

function parseForkTurns(value: unknown): AgentSpawnConfigSnapshot["forkTurns"] {
	if (value === "none" || value === "all") return value;
	if (!isRecord(value) || value.kind !== "last_n") {
		throw new StorageFailure("agent fork turns is invalid");
	}
	return Object.freeze({ kind: "last_n", turns: positiveInteger(value.turns, "fork turns") });
}

function validateCheckpoint(value: AgentRuntimeCheckpoint): AgentRuntimeCheckpoint {
	return parseCheckpoint(stableJson(value));
}

function parseCheckpoint(value: unknown): AgentRuntimeCheckpoint {
	const parsed = parseBoundedJson(value, "agent runtime checkpoint", CHECKPOINT_MAX_CHARS);
	if (!isRecord(parsed)) throw new StorageFailure("agent runtime checkpoint is invalid");
	return Object.freeze({
		kind: enumValue(parsed.kind, ["idle", "provider_turn", "tool_call"], "checkpoint kind"),
		committed: booleanValue(parsed.committed, "checkpoint committed"),
		...(parsed.turnId === undefined ? {} : { turnId: identifier(parsed.turnId, "turnId") }),
		...(parsed.callId === undefined ? {} : { callId: identifier(parsed.callId, "callId") }),
		...(parsed.mutating === undefined ? {} : {
			mutating: booleanValue(parsed.mutating, "checkpoint mutating"),
		}),
	});
}

function legacySummary(value: unknown, status: AgentLifecycleStatus): string {
	const parsed = parseBoundedJson(value, "legacy subagent payload", 196_608);
	if (!isRecord(parsed)) return status === "interrupted" ? "legacy task was not recoverable" : "legacy task ended";
	const preferred = status === "completed"
		? parsed.report
		: status === "failed"
			? parsed.error ?? parsed.report
			: parsed.interruptionReason ?? parsed.report;
	return typeof preferred === "string"
		? boundedString(preferred, "legacy terminal summary", SUMMARY_MAX_CHARS)
		: status === "interrupted"
			? "legacy task was not recoverable"
			: "legacy task ended";
}

function recoveryTaskPayload(value: unknown): Readonly<Record<string, unknown>> {
	const parsed = parseBoundedJson(value, "subagent recovery payload", 196_608);
	if (!isRecord(parsed)) throw new StorageFailure("subagent recovery payload is invalid");
	return parsed;
}

function recoveryTaskSummary(
	task: RecoveryTaskRow,
	status: "failed" | "interrupted",
): string {
	const payload = recoveryTaskPayload(task.payload_json);
	const preferred = status === "failed"
		? payload.error ?? payload.report
		: payload.interruptionReason ?? payload.report;
	return typeof preferred === "string" && preferred.trim()
		? preferred.slice(0, SUMMARY_MAX_CHARS)
		: `Subagent ${status}`;
}

function statusValue(value: unknown): AgentLifecycleStatus {
	return enumValue(value, [
		"queued",
		"running",
		"waiting",
		"idle",
		"unloaded",
		"completed",
		"failed",
		"interrupted",
	], "agent status");
}

function safePath(value: unknown): AgentPath {
	try {
		return parseAgentPath(boundedString(value, "agent_path", 512));
	} catch (error) {
		if (error instanceof AgentPathError) throw new StorageFailure("persisted agent path is invalid");
		throw error;
	}
}

function safeTaskName(value: unknown): string {
	try {
		return agentTaskName(boundedString(value, "task_name", 64));
	} catch (error) {
		if (error instanceof AgentPathError) throw new StorageFailure("persisted agent task name is invalid");
		throw error;
	}
}

function parseBoundedJson(value: unknown, field: string, maximum: number): unknown {
	if (typeof value !== "string" || value.length > maximum) {
		throw new StorageFailure(`${field} is invalid`);
	}
	try {
		return JSON.parse(value);
	} catch {
		throw new StorageFailure(`${field} is invalid`);
	}
}

function recordField(value: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
	const field = value[key];
	if (!isRecord(field)) throw new StorageFailure(`agent spawn config ${key} is invalid`);
	return field;
}

function stringArray(value: unknown, field: string, maximumItems: number): readonly string[] {
	if (!Array.isArray(value) || value.length > maximumItems) {
		throw new StorageFailure(`${field} is invalid`);
	}
	return Object.freeze(value.map((item) => boundedString(item, field, 4_096)));
}

function enumValue<const Values extends readonly string[]>(
	value: unknown,
	values: Values,
	field: string,
): Values[number] {
	if (typeof value !== "string" || !values.includes(value)) {
		throw new StorageFailure(`${field} is invalid`);
	}
	return value as Values[number];
}

function booleanValue(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new StorageFailure(`${field} is invalid`);
	return value;
}

function identifier(value: unknown, field: string, maximum = IDENTIFIER_MAX_CHARS): string {
	return boundedString(value, field, maximum);
}

function timestamp(value: unknown, field: string): string {
	return boundedString(value, field, 64);
}

function nullableBounded(value: unknown, field: string, maximum: number): string | undefined {
	return value === null ? undefined : boundedString(value, field, maximum);
}

function boundedString(value: unknown, field: string, maximum: number): string {
	if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) {
		throw new StorageFailure(`${field} is invalid`);
	}
	return value;
}

function positiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
		throw new StorageFailure(`${field} is invalid`);
	}
	return value;
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const item of Object.values(value)) deepFreeze(item);
	return Object.freeze(value);
}
