import type Database from "better-sqlite3";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";

export type SubagentTaskStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "interrupted";

export interface SubagentTaskUsage {
	readonly [key: string]: number;
}

export interface SubagentTaskPayload {
	readonly progressSummary?: string;
	readonly report?: string;
	readonly outputReference?: string;
	readonly usage?: SubagentTaskUsage;
	readonly error?: string;
	readonly interruptionReason?: string;
}

export interface SubagentTaskRecord {
	readonly taskId: string;
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly childSessionId: string;
	readonly profileId: string;
	readonly status: SubagentTaskStatus;
	readonly progressSequence: number;
	readonly payload: SubagentTaskPayload;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly completedAt?: string;
}

export interface ReserveSubagentTaskInput {
	readonly taskId: string;
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly childSessionId: string;
	readonly profileId: string;
}

export interface SubagentTaskOwnership {
	readonly taskId: string;
	readonly parentSessionId: string;
	readonly childSessionId: string;
}

export interface UpdateSubagentTaskProgressInput extends SubagentTaskOwnership {
	readonly sequence: number;
	readonly summary: string;
	readonly usage?: Readonly<Record<string, number>>;
}

export interface CompleteSubagentTaskInput extends SubagentTaskOwnership {
	readonly report: string;
	readonly outputReference?: string;
	readonly usage?: Readonly<Record<string, number>>;
}

export interface FailSubagentTaskInput extends SubagentTaskOwnership {
	readonly error: string;
	readonly report?: string;
	readonly outputReference?: string;
	readonly usage?: Readonly<Record<string, number>>;
}

export interface InterruptSubagentTaskInput extends SubagentTaskOwnership {
	readonly reason: string;
	readonly report?: string;
	readonly outputReference?: string;
	readonly usage?: Readonly<Record<string, number>>;
}

export interface SubagentTaskStore {
	reserve(input: ReserveSubagentTaskInput): SubagentTaskRecord;
	get(taskId: string): SubagentTaskRecord | undefined;
	getByChildSession(parentSessionId: string, childSessionId: string): SubagentTaskRecord | undefined;
	list(parentSessionId: string, limit?: number): readonly SubagentTaskRecord[];
	markRunning(input: SubagentTaskOwnership): SubagentTaskRecord;
	updateProgress(input: UpdateSubagentTaskProgressInput): SubagentTaskRecord;
	complete(input: CompleteSubagentTaskInput): SubagentTaskRecord;
	fail(input: FailSubagentTaskInput): SubagentTaskRecord;
	interrupt(input: InterruptSubagentTaskInput): SubagentTaskRecord;
	interruptAbandoned(parentSessionId: string, reason: string): number;
}

export interface SQLiteSubagentTaskRepositoryOptions {
	readonly database: Database.Database;
	readonly clock: () => string;
	readonly write: <Result>(operation: () => Result) => Result;
}

interface SubagentTaskRow {
	readonly task_id: unknown;
	readonly parent_session_id: unknown;
	readonly parent_turn_id: unknown;
	readonly child_session_id: unknown;
	readonly profile_id: unknown;
	readonly status: unknown;
	readonly progress_sequence: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly completed_at: unknown;
}

interface TerminalPayloadInput {
	readonly report?: string;
	readonly outputReference?: string;
	readonly usage?: Readonly<Record<string, number>>;
	readonly error?: string;
	readonly interruptionReason?: string;
}

export const SUBAGENT_TASK_REPORT_MAX_CHARS = 131_072;
export const SUBAGENT_TASK_OUTPUT_REFERENCE_MAX_CHARS = 1_024;
export const SUBAGENT_TASK_PROGRESS_MAX_CHARS = 2_048;
export const SUBAGENT_TASK_ERROR_MAX_CHARS = 4_096;
const SUBAGENT_TASK_PAYLOAD_MAX_CHARS = 196_608;
const SUBAGENT_TASK_ID_MAX_CHARS = 256;
const SUBAGENT_TASK_PROFILE_ID_MAX_CHARS = 64;
const SUBAGENT_TASK_TIMESTAMP_MAX_CHARS = 64;
const SUBAGENT_TASK_USAGE_MAX_ENTRIES = 64;
const SUBAGENT_TASK_USAGE_KEY_MAX_CHARS = 64;
const SUBAGENT_TASK_LIST_MAX = 1_000;
const TERMINAL_STATUSES = new Set<SubagentTaskStatus>([
	"completed",
	"failed",
	"interrupted",
]);
const PAYLOAD_KEYS = new Set([
	"progressSummary",
	"report",
	"outputReference",
	"usage",
	"error",
	"interruptionReason",
]);
const TASK_COLUMNS = `
task_id,
parent_session_id,
parent_turn_id,
child_session_id,
profile_id,
status,
progress_sequence,
payload_json,
created_at,
updated_at,
completed_at
`;

export class SQLiteSubagentTaskRepository implements SubagentTaskStore {
	readonly #database: Database.Database;
	readonly #clock: () => string;
	readonly #writeTransaction: <Result>(operation: () => Result) => Result;

	constructor(options: SQLiteSubagentTaskRepositoryOptions) {
		this.#database = options.database;
		this.#clock = options.clock;
		this.#writeTransaction = options.write;
	}

	reserve(input: ReserveSubagentTaskInput): SubagentTaskRecord {
		const candidate = validateReserveInput(input);
		return this.#writeTransaction(() => {
			const existing = this.#get(candidate.taskId);
			if (existing) {
				if (!sameReservation(existing, candidate)) {
					throw new StorageFailure("subagent task reservation conflicts with existing task");
				}
				return existing;
			}
			const now = timestamp(this.#clock(), "clock");
			this.#database.prepare(`
				INSERT INTO subagent_tasks (
					task_id, parent_session_id, parent_turn_id, child_session_id,
					profile_id, status, progress_sequence, payload_json,
					created_at, updated_at, completed_at
				) VALUES (?, ?, ?, ?, ?, 'queued', 0, '{}', ?, ?, NULL)
			`).run(
				candidate.taskId,
				candidate.parentSessionId,
				candidate.parentTurnId,
				candidate.childSessionId,
				candidate.profileId,
				now,
				now,
			);
			return this.#required(candidate.taskId);
		});
	}

	get(taskId: string): SubagentTaskRecord | undefined {
		return this.#read(() => this.#get(identifier(taskId, "taskId")));
	}

	getByChildSession(
		parentSessionId: string,
		childSessionId: string,
	): SubagentTaskRecord | undefined {
		return this.#read(() => {
			const row = this.#database.prepare(`
				SELECT ${TASK_COLUMNS}
				FROM subagent_tasks
				WHERE parent_session_id = ? AND child_session_id = ?
				ORDER BY created_at DESC, task_id DESC
				LIMIT 1
			`).get(
				identifier(parentSessionId, "parentSessionId"),
				identifier(childSessionId, "childSessionId"),
			) as SubagentTaskRow | undefined;
			return row ? recordFromRow(row) : undefined;
		});
	}

	list(parentSessionId: string, limit = 50): readonly SubagentTaskRecord[] {
		const boundedLimit = positiveSafeInteger(limit, "limit", SUBAGENT_TASK_LIST_MAX);
		return this.#read(() => Object.freeze(
			(this.#database.prepare(`
				SELECT ${TASK_COLUMNS}
				FROM subagent_tasks
				WHERE parent_session_id = ?
				ORDER BY created_at DESC, task_id DESC
				LIMIT ?
			`).all(
				identifier(parentSessionId, "parentSessionId"),
				boundedLimit,
			) as readonly SubagentTaskRow[]).map(recordFromRow),
		));
	}

	markRunning(input: SubagentTaskOwnership): SubagentTaskRecord {
		const owner = validateOwnership(input);
		return this.#writeTransaction(() => {
			const current = this.#owned(owner);
			if (current.status === "running") return current;
			if (current.status !== "queued") {
				throw invalidTransition(current.status, "running");
			}
			const now = timestamp(this.#clock(), "clock");
			this.#database.prepare(`
				UPDATE subagent_tasks
				SET status = 'running', updated_at = ?
				WHERE task_id = ? AND status = 'queued'
			`).run(now, owner.taskId);
			return this.#required(owner.taskId);
		});
	}

	updateProgress(input: UpdateSubagentTaskProgressInput): SubagentTaskRecord {
		const owner = validateOwnership(input);
		const sequence = positiveSafeInteger(input.sequence, "progress sequence");
		const summary = boundedRequired(
			input.summary,
			"progress summary",
			SUBAGENT_TASK_PROGRESS_MAX_CHARS,
		);
		const usage = input.usage === undefined ? undefined : validateUsage(input.usage);
		return this.#writeTransaction(() => {
			const current = this.#ownedRunning(owner);
			if (sequence !== current.progressSequence + 1) {
				throw new StorageFailure("subagent task progress sequence is not monotonic");
			}
			const payload = freezePayload({
				...current.payload,
				progressSummary: summary,
				...(usage ? { usage } : {}),
			});
			const now = timestamp(this.#clock(), "clock");
			this.#database.prepare(`
				UPDATE subagent_tasks
				SET progress_sequence = ?, payload_json = ?, updated_at = ?
				WHERE task_id = ? AND status = 'running'
			`).run(sequence, stableJson(payload), now, owner.taskId);
			return this.#required(owner.taskId);
		});
	}

	complete(input: CompleteSubagentTaskInput): SubagentTaskRecord {
		return this.#terminal(validateOwnership(input), "completed", {
			report: boundedString(input.report, "report", SUBAGENT_TASK_REPORT_MAX_CHARS),
			...(input.outputReference === undefined
				? {}
				: { outputReference: outputReference(input.outputReference) }),
			...(input.usage === undefined ? {} : { usage: validateUsage(input.usage) }),
		});
	}

	fail(input: FailSubagentTaskInput): SubagentTaskRecord {
		return this.#terminal(validateOwnership(input), "failed", {
			error: boundedRequired(input.error, "error", SUBAGENT_TASK_ERROR_MAX_CHARS),
			...(input.report === undefined
				? {}
				: { report: boundedString(input.report, "report", SUBAGENT_TASK_REPORT_MAX_CHARS) }),
			...(input.outputReference === undefined
				? {}
				: { outputReference: outputReference(input.outputReference) }),
			...(input.usage === undefined ? {} : { usage: validateUsage(input.usage) }),
		});
	}

	interrupt(input: InterruptSubagentTaskInput): SubagentTaskRecord {
		return this.#terminal(validateOwnership(input), "interrupted", {
			interruptionReason: boundedRequired(
				input.reason,
				"interruption reason",
				SUBAGENT_TASK_ERROR_MAX_CHARS,
			),
			...(input.report === undefined
				? {}
				: { report: boundedString(input.report, "report", SUBAGENT_TASK_REPORT_MAX_CHARS) }),
			...(input.outputReference === undefined
				? {}
				: { outputReference: outputReference(input.outputReference) }),
			...(input.usage === undefined ? {} : { usage: validateUsage(input.usage) }),
		});
	}

	interruptAbandoned(parentSessionId: string, reason: string): number {
		const parent = identifier(parentSessionId, "parentSessionId");
		const interruptionReason = boundedRequired(
			reason,
			"interruption reason",
			SUBAGENT_TASK_ERROR_MAX_CHARS,
		);
		return this.#writeTransaction(() => {
			const rows = this.#database.prepare(`
				SELECT ${TASK_COLUMNS}
				FROM subagent_tasks
				WHERE parent_session_id = ? AND status = 'running'
				ORDER BY task_id
			`).all(parent) as readonly SubagentTaskRow[];
			const records = rows.map(recordFromRow);
			if (records.length === 0) return 0;
			const now = timestamp(this.#clock(), "clock");
			const update = this.#database.prepare(`
				UPDATE subagent_tasks
				SET status = 'interrupted', payload_json = ?, updated_at = ?, completed_at = ?
				WHERE task_id = ? AND status = 'running'
			`);
			let changed = 0;
			for (const record of records) {
				const payload = freezePayload({
					...record.payload,
					interruptionReason,
				});
				changed += update.run(stableJson(payload), now, now, record.taskId).changes;
			}
			return changed;
		});
	}

	#terminal(
		owner: SubagentTaskOwnership,
		status: Extract<SubagentTaskStatus, "completed" | "failed" | "interrupted">,
		terminal: TerminalPayloadInput,
	): SubagentTaskRecord {
		return this.#writeTransaction(() => {
			const current = this.#owned(owner);
			const payload = freezePayload({ ...current.payload, ...terminal });
			if (TERMINAL_STATUSES.has(current.status)) {
				if (current.status === status && stableJson(current.payload) === stableJson(payload)) {
					return current;
				}
				throw invalidTransition(current.status, status);
			}
			if (current.status !== "running") throw invalidTransition(current.status, status);
			const now = timestamp(this.#clock(), "clock");
			this.#database.prepare(`
				UPDATE subagent_tasks
				SET status = ?, payload_json = ?, updated_at = ?, completed_at = ?
				WHERE task_id = ? AND status = 'running'
			`).run(status, stableJson(payload), now, now, owner.taskId);
			return this.#required(owner.taskId);
		});
	}

	#ownedRunning(owner: SubagentTaskOwnership): SubagentTaskRecord {
		const record = this.#owned(owner);
		if (record.status !== "running") throw invalidTransition(record.status, "running update");
		return record;
	}

	#owned(owner: SubagentTaskOwnership): SubagentTaskRecord {
		const record = this.#required(owner.taskId);
		if (
			record.parentSessionId !== owner.parentSessionId
			|| record.childSessionId !== owner.childSessionId
		) {
			throw new StorageFailure("subagent task ownership does not match");
		}
		return record;
	}

	#required(taskId: string): SubagentTaskRecord {
		const record = this.#get(taskId);
		if (!record) throw new StorageFailure("subagent task does not exist");
		return record;
	}

	#get(taskId: string): SubagentTaskRecord | undefined {
		const row = this.#database.prepare(`
			SELECT ${TASK_COLUMNS}
			FROM subagent_tasks
			WHERE task_id = ?
		`).get(taskId) as SubagentTaskRow | undefined;
		return row ? recordFromRow(row) : undefined;
	}

	#read<Result>(operation: () => Result): Result {
		try {
			return operation();
		} catch (error) {
			if (error instanceof StorageFailure) throw error;
			throw new StorageFailure("subagent task read failed");
		}
	}
}

function validateReserveInput(input: ReserveSubagentTaskInput): ReserveSubagentTaskInput {
	return Object.freeze({
		taskId: identifier(input.taskId, "taskId"),
		parentSessionId: identifier(input.parentSessionId, "parentSessionId"),
		parentTurnId: identifier(input.parentTurnId, "parentTurnId"),
		childSessionId: identifier(input.childSessionId, "childSessionId"),
		profileId: identifier(input.profileId, "profileId", SUBAGENT_TASK_PROFILE_ID_MAX_CHARS),
	});
}

function validateOwnership(input: SubagentTaskOwnership): SubagentTaskOwnership {
	return Object.freeze({
		taskId: identifier(input.taskId, "taskId"),
		parentSessionId: identifier(input.parentSessionId, "parentSessionId"),
		childSessionId: identifier(input.childSessionId, "childSessionId"),
	});
}

function sameReservation(
	record: SubagentTaskRecord,
	input: ReserveSubagentTaskInput,
): boolean {
	return record.taskId === input.taskId
		&& record.parentSessionId === input.parentSessionId
		&& record.parentTurnId === input.parentTurnId
		&& record.childSessionId === input.childSessionId
		&& record.profileId === input.profileId;
}

function recordFromRow(row: SubagentTaskRow): SubagentTaskRecord {
	const status = statusValue(row.status);
	const completedAt = row.completed_at === null
		? undefined
		: timestamp(row.completed_at, "completed_at");
	if (TERMINAL_STATUSES.has(status) !== (completedAt !== undefined)) {
		throw new StorageFailure("subagent task terminal timestamp is invalid");
	}
	const payload = parsePayload(row.payload_json);
	if (status === "completed" && payload.report === undefined) {
		throw new StorageFailure("subagent task completed payload is invalid");
	}
	if (status === "failed" && payload.error === undefined) {
		throw new StorageFailure("subagent task failed payload is invalid");
	}
	if (status === "interrupted" && payload.interruptionReason === undefined) {
		throw new StorageFailure("subagent task interrupted payload is invalid");
	}
	return Object.freeze({
		taskId: identifier(row.task_id, "task_id"),
		parentSessionId: identifier(row.parent_session_id, "parent_session_id"),
		parentTurnId: identifier(row.parent_turn_id, "parent_turn_id"),
		childSessionId: identifier(row.child_session_id, "child_session_id"),
		profileId: identifier(row.profile_id, "profile_id", SUBAGENT_TASK_PROFILE_ID_MAX_CHARS),
		status,
		progressSequence: nonNegativeSafeInteger(row.progress_sequence, "progress_sequence"),
		payload,
		createdAt: timestamp(row.created_at, "created_at"),
		updatedAt: timestamp(row.updated_at, "updated_at"),
		...(completedAt ? { completedAt } : {}),
	});
}

function parsePayload(value: unknown): SubagentTaskPayload {
	if (typeof value !== "string" || value.length > SUBAGENT_TASK_PAYLOAD_MAX_CHARS) {
		throw new StorageFailure("subagent task payload is invalid");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new StorageFailure("subagent task payload is invalid");
	}
	if (!isRecord(parsed) || Object.keys(parsed).some((key) => !PAYLOAD_KEYS.has(key))) {
		throw new StorageFailure("subagent task payload is invalid");
	}
	return freezePayload({
		...(parsed.progressSummary === undefined
			? {}
			: { progressSummary: boundedRequired(
				parsed.progressSummary,
				"progress summary",
				SUBAGENT_TASK_PROGRESS_MAX_CHARS,
			) }),
		...(parsed.report === undefined
			? {}
			: { report: boundedString(parsed.report, "report", SUBAGENT_TASK_REPORT_MAX_CHARS) }),
		...(parsed.outputReference === undefined
			? {}
			: { outputReference: outputReference(parsed.outputReference) }),
		...(parsed.usage === undefined ? {} : { usage: validateUsage(parsed.usage) }),
		...(parsed.error === undefined
			? {}
			: { error: boundedRequired(parsed.error, "error", SUBAGENT_TASK_ERROR_MAX_CHARS) }),
		...(parsed.interruptionReason === undefined
			? {}
			: { interruptionReason: boundedRequired(
				parsed.interruptionReason,
				"interruption reason",
				SUBAGENT_TASK_ERROR_MAX_CHARS,
			) }),
	});
}

function freezePayload(input: SubagentTaskPayload): SubagentTaskPayload {
	const payload = Object.freeze({
		...input,
		...(input.usage ? { usage: Object.freeze({ ...input.usage }) } : {}),
	});
	if (stableJson(payload).length > SUBAGENT_TASK_PAYLOAD_MAX_CHARS) {
		throw new StorageFailure("subagent task payload is too large");
	}
	return payload;
}

function validateUsage(value: unknown): SubagentTaskUsage {
	if (!isRecord(value)) throw new StorageFailure("subagent task usage is invalid");
	const entries = Object.entries(value);
	if (entries.length > SUBAGENT_TASK_USAGE_MAX_ENTRIES) {
		throw new StorageFailure("subagent task usage is invalid");
	}
	const usage: Record<string, number> = {};
	for (const [key, item] of entries) {
		if (
			!key
			|| key.length > SUBAGENT_TASK_USAGE_KEY_MAX_CHARS
			|| key.includes("\0")
			|| typeof item !== "number"
			|| !Number.isSafeInteger(item)
			|| item < 0
		) {
			throw new StorageFailure("subagent task usage is invalid");
		}
		usage[key] = item;
	}
	return Object.freeze(usage);
}

function outputReference(value: unknown): string {
	return boundedRequired(
		value,
		"output reference",
		SUBAGENT_TASK_OUTPUT_REFERENCE_MAX_CHARS,
	);
}

function identifier(
	value: unknown,
	field: string,
	maximum = SUBAGENT_TASK_ID_MAX_CHARS,
): string {
	return boundedRequired(value, field, maximum);
}

function timestamp(value: unknown, field: string): string {
	return boundedRequired(value, field, SUBAGENT_TASK_TIMESTAMP_MAX_CHARS);
}

function boundedRequired(value: unknown, field: string, maximum: number): string {
	const result = boundedString(value, field, maximum).trim();
	if (!result) throw new StorageFailure(`subagent task ${field} is invalid`);
	return result;
}

function boundedString(value: unknown, field: string, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
		throw new StorageFailure(`subagent task ${field} is invalid`);
	}
	return value;
}

function positiveSafeInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
		throw new StorageFailure(`subagent task ${field} is invalid`);
	}
	return value as number;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new StorageFailure(`subagent task ${field} is invalid`);
	}
	return value as number;
}

function statusValue(value: unknown): SubagentTaskStatus {
	if (
		value !== "queued"
		&& value !== "running"
		&& value !== "completed"
		&& value !== "failed"
		&& value !== "interrupted"
	) {
		throw new StorageFailure("subagent task status is invalid");
	}
	return value;
}

function invalidTransition(current: SubagentTaskStatus, next: string): StorageFailure {
	return new StorageFailure("invalid subagent task transition", {
		current_status: current,
		next_status: next.slice(0, 32),
	});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
