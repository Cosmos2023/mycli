import type Database from "better-sqlite3";
import {
	agentMailboxMessageId,
	agentMailboxMessageIdFor,
	agentThreadId,
	parseAgentPath,
} from "@mycli/core";
import type {
	AgentMailboxDeliveryState,
	AgentMailboxPayload,
	AgentMailboxRecord,
	AgentMailboxTriggerMode,
	AgentPath,
	AgentThreadId,
} from "@mycli/core";
import { StorageFailure } from "../sessions/session-store.ts";
import { stableJson } from "../stable-json.ts";

export interface EnqueueAgentMailboxItemInput {
	readonly rootThreadId: AgentThreadId;
	readonly senderThreadId: AgentThreadId;
	readonly senderPath: AgentPath;
	readonly receiverThreadId: AgentThreadId;
	readonly receiverPath: AgentPath;
	readonly receiverSessionId: string;
	readonly triggerMode: AgentMailboxTriggerMode;
	readonly sourceCallId?: string;
	readonly dedupeKey: string;
	readonly payload: AgentMailboxPayload;
}

export interface AgentMailboxEnqueueResult {
	readonly disposition: "enqueued" | "duplicate";
	readonly item: AgentMailboxRecord;
}

export interface AgentMailboxListQuery {
	readonly receiverThreadId: string;
	readonly afterSequence?: number;
	readonly states?: readonly AgentMailboxDeliveryState[];
	readonly limit?: number;
}

export interface TransitionAgentMailboxItemInput {
	readonly messageId: string;
	readonly state: Extract<AgentMailboxDeliveryState, "queued" | "committed">;
}

export interface AgentMailboxStore {
	enqueue(input: EnqueueAgentMailboxItemInput): AgentMailboxEnqueueResult;
	get(messageId: string): AgentMailboxRecord | undefined;
	getByDedupeKey(receiverThreadId: string, dedupeKey: string): AgentMailboxRecord | undefined;
	list(query: AgentMailboxListQuery): readonly AgentMailboxRecord[];
	transition(input: TransitionAgentMailboxItemInput): AgentMailboxRecord;
}

export interface SQLiteAgentMailboxRepositoryOptions {
	readonly database: Database.Database;
	readonly clock: () => string;
	readonly write: <Result>(operation: () => Result) => Result;
}

interface AgentMailboxRow {
	readonly message_id: unknown;
	readonly queue_id: unknown;
	readonly root_thread_id: unknown;
	readonly sender_thread_id: unknown;
	readonly sender_path: unknown;
	readonly receiver_thread_id: unknown;
	readonly receiver_path: unknown;
	readonly receiver_session_id: unknown;
	readonly receiver_sequence: unknown;
	readonly trigger_mode: unknown;
	readonly source_call_id: unknown;
	readonly dedupe_key: unknown;
	readonly payload_json: unknown;
	readonly state: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly queued_at: unknown;
	readonly committed_at: unknown;
}

const MAILBOX_COLUMNS = `
message_id,
queue_id,
root_thread_id,
sender_thread_id,
sender_path,
receiver_thread_id,
receiver_path,
receiver_session_id,
receiver_sequence,
trigger_mode,
source_call_id,
dedupe_key,
payload_json,
state,
created_at,
updated_at,
queued_at,
committed_at
`;
const DEDUPE_KEY_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAILBOX_LIST_MAX = 10_000;
const IDENTIFIER_MAX_CHARS = 256;
const MESSAGE_TEXT_MAX_CHARS = 65_536;
const COMPLETION_REPORT_MAX_CHARS = 32_768;
const OUTPUT_REFERENCE_MAX_CHARS = 4_096;

export class SQLiteAgentMailboxRepository implements AgentMailboxStore {
	readonly #database: Database.Database;
	readonly #clock: () => string;
	readonly #writeTransaction: <Result>(operation: () => Result) => Result;

	constructor(options: SQLiteAgentMailboxRepositoryOptions) {
		this.#database = options.database;
		this.#clock = options.clock;
		this.#writeTransaction = options.write;
	}

	enqueue(input: EnqueueAgentMailboxItemInput): AgentMailboxEnqueueResult {
		const candidate = validateEnqueue(input);
		const messageId = agentMailboxMessageIdFor(candidate.receiverThreadId, candidate.dedupeKey);
		return this.#writeTransaction(() => {
			const duplicate = this.#getByDedupeKey(candidate.receiverThreadId, candidate.dedupeKey);
			if (duplicate) {
				if (!sameLogicalItem(duplicate, candidate)) {
					throw new StorageFailure("agent mailbox dedupe key conflicts with existing item");
				}
				return Object.freeze({ disposition: "duplicate", item: duplicate });
			}
			const idOwner = this.#get(messageId);
			if (idOwner) throw new StorageFailure("agent mailbox message id collision");
			const nextSequence = Number((this.#database.prepare(`
				SELECT COALESCE(MAX(receiver_sequence), 0) + 1 AS next_sequence
				FROM agent_mailbox_items
				WHERE receiver_thread_id = ?
			`).get(candidate.receiverThreadId) as { readonly next_sequence: unknown }).next_sequence);
			if (!Number.isSafeInteger(nextSequence) || nextSequence <= 0) {
				throw new StorageFailure("agent mailbox receiver sequence is exhausted");
			}
			const now = timestamp(this.#clock(), "clock");
			this.#database.prepare(`
				INSERT INTO agent_mailbox_items (
					message_id, queue_id, root_thread_id, sender_thread_id,
					sender_path, receiver_thread_id, receiver_path,
					receiver_session_id, receiver_sequence, trigger_mode,
					source_call_id, dedupe_key, payload_json, state,
					created_at, updated_at, queued_at, committed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)
			`).run(
				messageId,
				messageId,
				candidate.rootThreadId,
				candidate.senderThreadId,
				candidate.senderPath,
				candidate.receiverThreadId,
				candidate.receiverPath,
				candidate.receiverSessionId,
				nextSequence,
				candidate.triggerMode,
				candidate.sourceCallId ?? null,
				candidate.dedupeKey,
				stableJson(candidate.payload),
				now,
				now,
			);
			return Object.freeze({
				disposition: "enqueued",
				item: this.#required(messageId),
			});
		});
	}

	get(messageId: string): AgentMailboxRecord | undefined {
		return this.#read(() => this.#get(agentMailboxMessageId(messageId)));
	}

	getByDedupeKey(receiverThreadId: string, dedupeKey: string): AgentMailboxRecord | undefined {
		const receiver = agentThreadId(receiverThreadId);
		const key = dedupeKeyValue(dedupeKey);
		return this.#read(() => this.#getByDedupeKey(receiver, key));
	}

	list(query: AgentMailboxListQuery): readonly AgentMailboxRecord[] {
		const receiverThreadId = agentThreadId(query.receiverThreadId);
		const afterSequence = nonNegativeInteger(query.afterSequence ?? 0, "afterSequence");
		const states = query.states === undefined
			? undefined
			: Object.freeze([...new Set(query.states.map(stateValue))]);
		const limit = positiveInteger(query.limit ?? 1_000, "limit", MAILBOX_LIST_MAX);
		if (states?.length === 0) return Object.freeze([]);
		return this.#read(() => {
			const placeholders = states?.map(() => "?").join(", ");
			const rows = this.#database.prepare(`
				SELECT ${MAILBOX_COLUMNS}
				FROM agent_mailbox_items
				WHERE receiver_thread_id = ? AND receiver_sequence > ?
					${states === undefined ? "" : `AND state IN (${placeholders})`}
				ORDER BY receiver_sequence ASC
				LIMIT ?
			`).all(receiverThreadId, afterSequence, ...(states ?? []), limit) as readonly AgentMailboxRow[];
			return Object.freeze(rows.map(recordFromRow));
		});
	}

	transition(input: TransitionAgentMailboxItemInput): AgentMailboxRecord {
		const messageId = agentMailboxMessageId(input.messageId);
		const target = stateValue(input.state);
		if (target === "pending") throw new StorageFailure("agent mailbox cannot transition to pending");
		return this.#writeTransaction(() => {
			const current = this.#required(messageId);
			if (current.state === target) return current;
			if (!canTransition(current.state, target)) {
				throw new StorageFailure(`invalid agent mailbox transition from ${current.state} to ${target}`);
			}
			const now = timestamp(this.#clock(), "clock");
			this.#database.prepare(`
				UPDATE agent_mailbox_items
				SET state = ?, updated_at = ?,
					queued_at = CASE WHEN ? = 'queued' THEN ? ELSE queued_at END,
					committed_at = CASE WHEN ? = 'committed' THEN ? ELSE committed_at END
				WHERE message_id = ? AND state = ?
			`).run(target, now, target, now, target, now, messageId, current.state);
			return this.#required(messageId);
		});
	}

	#get(messageId: string): AgentMailboxRecord | undefined {
		const row = this.#database.prepare(`
			SELECT ${MAILBOX_COLUMNS}
			FROM agent_mailbox_items
			WHERE message_id = ?
		`).get(messageId) as AgentMailboxRow | undefined;
		return row ? recordFromRow(row) : undefined;
	}

	#getByDedupeKey(
		receiverThreadId: AgentThreadId,
		dedupeKey: string,
	): AgentMailboxRecord | undefined {
		const row = this.#database.prepare(`
			SELECT ${MAILBOX_COLUMNS}
			FROM agent_mailbox_items
			WHERE receiver_thread_id = ? AND dedupe_key = ?
		`).get(receiverThreadId, dedupeKey) as AgentMailboxRow | undefined;
		return row ? recordFromRow(row) : undefined;
	}

	#required(messageId: string): AgentMailboxRecord {
		const item = this.#get(messageId);
		if (!item) throw new StorageFailure("agent mailbox item does not exist");
		return item;
	}

	#read<Result>(operation: () => Result): Result {
		try {
			return operation();
		} catch (error) {
			if (error instanceof StorageFailure) throw error;
			throw new StorageFailure("agent mailbox read failed");
		}
	}
}

function validateEnqueue(input: EnqueueAgentMailboxItemInput): EnqueueAgentMailboxItemInput {
	return Object.freeze({
		rootThreadId: agentThreadId(input.rootThreadId),
		senderThreadId: agentThreadId(input.senderThreadId),
		senderPath: parseAgentPath(input.senderPath),
		receiverThreadId: agentThreadId(input.receiverThreadId),
		receiverPath: parseAgentPath(input.receiverPath),
		receiverSessionId: identifier(input.receiverSessionId, "receiverSessionId"),
		triggerMode: triggerModeValue(input.triggerMode),
		...(input.sourceCallId === undefined ? {} : {
			sourceCallId: identifier(input.sourceCallId, "sourceCallId"),
		}),
		dedupeKey: dedupeKeyValue(input.dedupeKey),
		payload: payloadValue(input.payload),
	});
}

function sameLogicalItem(
	item: AgentMailboxRecord,
	input: EnqueueAgentMailboxItemInput,
): boolean {
	return item.rootThreadId === input.rootThreadId
		&& item.senderThreadId === input.senderThreadId
		&& item.senderPath === input.senderPath
		&& item.receiverThreadId === input.receiverThreadId
		&& item.receiverPath === input.receiverPath
		&& item.receiverSessionId === input.receiverSessionId
		&& item.triggerMode === input.triggerMode
		&& item.sourceCallId === input.sourceCallId
		&& item.dedupeKey === input.dedupeKey
		&& stableJson(item.payload) === stableJson(input.payload);
}

function recordFromRow(row: AgentMailboxRow): AgentMailboxRecord {
	const state = stateValue(row.state);
	const queuedAt = nullableTimestamp(row.queued_at, "queued_at");
	const committedAt = nullableTimestamp(row.committed_at, "committed_at");
	if ((state === "pending") !== (queuedAt === undefined)) {
		throw new StorageFailure("agent mailbox queued timestamp is invalid");
	}
	if ((state === "committed") !== (committedAt !== undefined)) {
		throw new StorageFailure("agent mailbox committed timestamp is invalid");
	}
	return Object.freeze({
		messageId: agentMailboxMessageId(identifier(row.message_id, "message_id")),
		queueId: agentMailboxMessageId(identifier(row.queue_id, "queue_id")),
		rootThreadId: agentThreadId(identifier(row.root_thread_id, "root_thread_id")),
		senderThreadId: agentThreadId(identifier(row.sender_thread_id, "sender_thread_id")),
		senderPath: parseAgentPath(stringValue(row.sender_path, "sender_path", 512)),
		receiverThreadId: agentThreadId(identifier(row.receiver_thread_id, "receiver_thread_id")),
		receiverPath: parseAgentPath(stringValue(row.receiver_path, "receiver_path", 512)),
		receiverSessionId: identifier(row.receiver_session_id, "receiver_session_id"),
		receiverSequence: positiveInteger(row.receiver_sequence, "receiver_sequence"),
		triggerMode: triggerModeValue(row.trigger_mode),
		...(row.source_call_id === null ? {} : {
			sourceCallId: identifier(row.source_call_id, "source_call_id"),
		}),
		dedupeKey: dedupeKeyValue(row.dedupe_key),
		payload: payloadFromJson(row.payload_json),
		state,
		createdAt: timestamp(row.created_at, "created_at"),
		updatedAt: timestamp(row.updated_at, "updated_at"),
		...(queuedAt === undefined ? {} : { queuedAt }),
		...(committedAt === undefined ? {} : { committedAt }),
	});
}

function payloadFromJson(value: unknown): AgentMailboxPayload {
	if (typeof value !== "string" || value.length > 131_072) {
		throw new StorageFailure("agent mailbox payload is invalid");
	}
	try {
		return payloadValue(JSON.parse(value));
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure("agent mailbox payload is invalid");
	}
}

function payloadValue(value: unknown): AgentMailboxPayload {
	if (!isRecord(value)) throw new StorageFailure("agent mailbox payload is invalid");
	if (value.kind === "message") {
		return Object.freeze({
			kind: "message",
			text: boundedPayloadText(value.text, "mailbox message", MESSAGE_TEXT_MAX_CHARS),
		});
	}
	if (value.kind !== "completion") throw new StorageFailure("agent mailbox payload kind is invalid");
	const status = value.status;
	if (status !== "completed" && status !== "failed" && status !== "interrupted") {
		throw new StorageFailure("agent mailbox completion status is invalid");
	}
	return Object.freeze({
		kind: "completion",
		status,
		report: boundedPayloadText(value.report, "completion report", COMPLETION_REPORT_MAX_CHARS),
		...(value.outputReference === undefined ? {} : {
			outputReference: boundedIdentity(
				value.outputReference,
				"completion output reference",
				OUTPUT_REFERENCE_MAX_CHARS,
			),
		}),
	});
}

function canTransition(from: AgentMailboxDeliveryState, to: AgentMailboxDeliveryState): boolean {
	return from === "pending" && to === "queued" || from === "queued" && to === "committed";
}

function triggerModeValue(value: unknown): AgentMailboxTriggerMode {
	if (value !== "queue_only" && value !== "follow_up") {
		throw new StorageFailure("agent mailbox trigger mode is invalid");
	}
	return value;
}

function stateValue(value: unknown): AgentMailboxDeliveryState {
	if (value !== "pending" && value !== "queued" && value !== "committed") {
		throw new StorageFailure("agent mailbox state is invalid");
	}
	return value;
}

function dedupeKeyValue(value: unknown): string {
	const key = stringValue(value, "dedupe key", 512);
	if (!DEDUPE_KEY_PATTERN.test(key)) {
		throw new StorageFailure("agent mailbox dedupe key is invalid");
	}
	return key;
}

function identifier(value: unknown, field: string): string {
	return boundedIdentity(value, field, IDENTIFIER_MAX_CHARS);
}

function boundedIdentity(value: unknown, field: string, maximum: number): string {
	const result = stringValue(value, field, maximum);
	if (!result.trim() || /[\0\r\n]/u.test(result)) {
		throw new StorageFailure(`${field} is invalid`);
	}
	return result;
}

function boundedPayloadText(value: unknown, field: string, maximum: number): string {
	const result = stringValue(value, field, maximum);
	if (!result.trim()) throw new StorageFailure(`${field} is invalid`);
	return result;
}

function stringValue(value: unknown, field: string, maximum: number): string {
	if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) {
		throw new StorageFailure(`${field} is invalid`);
	}
	return value;
}

function timestamp(value: unknown, field: string): string {
	const result = stringValue(value, field, 128);
	if (Number.isNaN(Date.parse(result))) throw new StorageFailure(`${field} is invalid`);
	return result;
}

function nullableTimestamp(value: unknown, field: string): string | undefined {
	return value === null ? undefined : timestamp(value, field);
}

function positiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
		throw new StorageFailure(`${field} is invalid`);
	}
	return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new StorageFailure(`${field} is invalid`);
	}
	return Number(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
