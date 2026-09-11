import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { parseProviderAttemptRecord, parseProviderAttemptUpdate, providerAttemptId } from "@mycli/contracts";
import type { ProviderAttemptRecord, ProviderAttemptSource, ProviderAttemptUpdate } from "@mycli/contracts";
import { StorageFailure } from "../sessions/session-store.ts";
import { stableJson } from "../stable-json.ts";
import type { ModelInputLedgerStore } from "./model-input-ledger.ts";

export interface AppendProviderAttemptInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly requestId: string;
	readonly provider: string;
	readonly model: string;
	readonly source: ProviderAttemptSource;
	readonly update: ProviderAttemptUpdate;
}

export interface ListProviderAttemptsInput {
	readonly sessionId: string;
	readonly turnId?: string;
	readonly requestId?: string;
	readonly afterSequence?: number;
	readonly beforeEventId?: string;
	readonly limit?: number;
}

export interface CloseInterruptedProviderAttemptsInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly observedAt: string;
	readonly source?: "restart_recovery";
}

export interface ProviderAttemptLedgerStore {
	append(input: AppendProviderAttemptInput): ProviderAttemptRecord;
	list(input: ListProviderAttemptsInput): readonly ProviderAttemptRecord[];
	latest(requestId: string): ProviderAttemptRecord | undefined;
	closeInterruptedTurn(input: CloseInterruptedProviderAttemptsInput): readonly ProviderAttemptRecord[];
}

export type ProviderAttemptLedgerFailpoint = "after_chain" | "after_event";

export interface SQLiteProviderAttemptLedgerOptions {
	readonly database: Database.Database;
	readonly write: <Result>(operation: () => Result) => Result;
	readonly manifests: Pick<ModelInputLedgerStore, "loadProviderRequestManifest">;
	readonly ownerId: string;
	readonly clock: () => string;
	readonly available?: boolean;
	readonly errorContextVersion?: 1;
	readonly failpoint?: (name: ProviderAttemptLedgerFailpoint) => void;
}

interface AttemptRow {
	readonly record_json: string;
	readonly event_id: string;
	readonly request_id: string;
	readonly sequence_no: number;
	readonly attempt_no: number;
	readonly state: string;
}

export class SQLiteProviderAttemptLedger implements ProviderAttemptLedgerStore {
	readonly #options: SQLiteProviderAttemptLedgerOptions;

	constructor(options: SQLiteProviderAttemptLedgerOptions) {
		this.#options = options;
	}

	append(input: AppendProviderAttemptInput): ProviderAttemptRecord {
		return this.#guard(() => this.#options.write(() => this.#append(input, false)));
	}

	list(input: ListProviderAttemptsInput): readonly ProviderAttemptRecord[] {
		return this.#guard(() => {
			const sessionId = identity(input.sessionId);
			const turnId = input.turnId === undefined ? undefined : identity(input.turnId);
			const requestId = input.requestId === undefined ? undefined : identity(input.requestId);
			const beforeEventId = input.beforeEventId === undefined ? undefined : identity(input.beforeEventId);
			const limit = input.limit ?? 500;
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw invalid("history limit");
			if (input.afterSequence !== undefined && (!requestId
				|| !Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0
				|| input.afterSequence > 1000)) throw invalid("history cursor");
			if (beforeEventId && (requestId !== undefined || input.afterSequence !== undefined)) throw invalid("history cursor combination");
			if (this.#options.available === false) return Object.freeze([]);
			const cursor = beforeEventId === undefined ? undefined : this.#options.database.prepare(`
				SELECT e.global_sequence FROM provider_attempt_events AS e
				JOIN provider_retry_chains AS c ON c.request_id = e.request_id
				WHERE e.event_id = ? AND c.session_id = ? ${turnId ? "AND c.turn_id = ?" : ""}
			`).get(beforeEventId, sessionId, ...(turnId ? [turnId] : [])) as { readonly global_sequence: number } | undefined;
			if (beforeEventId !== undefined && !cursor) throw invalid("history cursor ownership");
			const rows = this.#options.database.prepare(`
				SELECT e.record_json, e.event_id, e.request_id, e.sequence_no, e.attempt_no, e.state
				FROM provider_attempt_events AS e
				JOIN provider_retry_chains AS c ON c.request_id = e.request_id
				WHERE c.session_id = ?
				${turnId ? "AND c.turn_id = ?" : ""}
				${requestId ? "AND c.request_id = ?" : ""}
				${input.afterSequence === undefined ? "" : "AND e.sequence_no > ?"}
				${cursor === undefined ? "" : "AND e.global_sequence < ?"}
				ORDER BY e.global_sequence ${requestId ? "ASC" : "DESC"} LIMIT ?
			`).all(sessionId, ...(turnId ? [turnId] : []), ...(requestId ? [requestId] : []),
				...(input.afterSequence === undefined ? [] : [input.afterSequence]),
				...(cursor === undefined ? [] : [cursor.global_sequence]), limit) as AttemptRow[];
			return Object.freeze((requestId ? rows : rows.reverse()).map(recordFromRow));
		});
	}

	latest(requestId: string): ProviderAttemptRecord | undefined {
		return this.#guard(() => {
			identity(requestId);
			if (this.#options.available === false) return undefined;
			const row = this.#options.database.prepare(`
				SELECT record_json, event_id, request_id, sequence_no, attempt_no, state FROM provider_attempt_events
				WHERE request_id = ? ORDER BY sequence_no DESC LIMIT 1
			`).get(requestId) as AttemptRow | undefined;
			return row ? recordFromRow(row) : undefined;
		});
	}

	closeInterruptedTurn(input: CloseInterruptedProviderAttemptsInput): readonly ProviderAttemptRecord[] {
		return this.#guard(() => this.#options.write(() => {
			identity(input.sessionId);
			identity(input.turnId);
			if (this.#options.available === false) return Object.freeze([]);
			const rows = this.#options.database.prepare(`
				SELECT request_id FROM provider_retry_chains WHERE session_id = ? AND turn_id = ?
				ORDER BY request_id
			`).all(input.sessionId, input.turnId) as { readonly request_id: string }[];
			const closed: ProviderAttemptRecord[] = [];
			for (const row of rows) {
				const latest = this.latest(row.request_id);
				if (!latest || terminal(latest)) continue;
				closed.push(this.#append({
					sessionId: input.sessionId,
					turnId: input.turnId,
					requestId: latest.requestId,
					provider: latest.provider,
					model: latest.model,
					source: "restart_recovery",
					update: {
						sequence: latest.sequence + 1,
						attempt: latest.attempt,
						state: latest.state === "started" ? "unknown" : "cancelled",
						policy: latest.policy,
						requestRetriesUsed: latest.requestRetriesUsed,
						streamRetriesUsed: latest.streamRetriesUsed,
						observedAt: new Date(input.observedAt).toISOString(),
						...(latest.failure ? { failure: latest.failure } : {}),
					},
				}, true));
			}
			return Object.freeze(closed);
		}));
	}

	#append(input: AppendProviderAttemptInput, recovering: boolean): ProviderAttemptRecord {
		if (this.#options.available === false) throw invalid("schema does not support provider attempts");
		const update = parseProviderAttemptUpdate(input.update);
		if (update.failure?.errorContext && this.#options.errorContextVersion !== 1) {
			throw invalid("error contexts require session schema version 14");
		}
		const digest = createHash("sha256").update(identity(input.requestId)).digest("hex");
		const candidate = parseProviderAttemptRecord({
			...update,
			eventId: `provider-attempt-event:${digest}:${update.sequence}`,
			attemptId: providerAttemptId(input.requestId, update.attempt),
			retryChainId: input.requestId,
			sessionId: input.sessionId,
			turnId: input.turnId,
			requestId: input.requestId,
			provider: input.provider,
			model: input.model,
			source: input.source,
			committedAt: new Date(this.#options.clock()).toISOString(),
		});
		const duplicate = this.#options.database.prepare(`
			SELECT record_json, event_id, request_id, sequence_no, attempt_no, state
			FROM provider_attempt_events WHERE request_id = ? AND sequence_no = ?
		`).get(candidate.requestId, candidate.sequence) as AttemptRow | undefined;
		if (duplicate) {
			const existing = recordFromRow(duplicate);
			if (stableJson({ ...existing, committedAt: undefined })
				!== stableJson({ ...candidate, committedAt: undefined })) throw invalid("conflicting duplicate");
			return existing;
		}
		const manifest = this.#options.manifests.loadProviderRequestManifest(candidate.requestId);
		if (!manifest || manifest.sessionId !== candidate.sessionId || manifest.turnId !== candidate.turnId
			|| manifest.providerConfig.provider !== candidate.provider || manifest.providerConfig.model !== candidate.model) {
			throw invalid("manifest identity mismatch");
		}
		const turn = this.#options.database.prepare(`
			SELECT status, owner_id FROM runtime_turns WHERE session_id = ? AND turn_id = ?
		`).get(candidate.sessionId, candidate.turnId) as { readonly status: string; readonly owner_id: string | null } | undefined;
		const lease = this.#options.database.prepare(`
			SELECT owner_id FROM session_runtime_leases WHERE session_id = ?
		`).get(candidate.sessionId) as { readonly owner_id: string } | undefined;
		// A resumed approval keeps its turn, while the active session lease changes owners.
		if (!turn || turn.status !== "in_progress"
			|| (!recovering && (lease?.owner_id ?? turn.owner_id) !== this.#options.ownerId)) throw invalid("turn ownership mismatch");
		if (!recovering && candidate.source === "restart_recovery") throw invalid("recovery source is reserved");
		const previous = this.latest(candidate.requestId);
		assertTransition(previous, candidate);
		if (!previous) {
			this.#options.database.prepare(`
				INSERT INTO provider_retry_chains (request_id, session_id, turn_id, provider, model, policy_json)
				VALUES (?, ?, ?, ?, ?, ?)
			`).run(candidate.requestId, candidate.sessionId, candidate.turnId,
				candidate.provider, candidate.model, stableJson(candidate.policy));
			this.#options.failpoint?.("after_chain");
		}
		this.#options.database.prepare(`
			INSERT INTO provider_attempt_events (event_id, request_id, sequence_no, attempt_no, state, record_json)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(candidate.eventId, candidate.requestId, candidate.sequence, candidate.attempt,
			candidate.state, stableJson(candidate));
		this.#options.failpoint?.("after_event");
		return candidate;
	}

	#guard<Result>(operation: () => Result): Result {
		try {
			return operation();
		} catch (error) {
			if (error instanceof StorageFailure) throw error;
			throw new StorageFailure("provider attempt ledger operation failed");
		}
	}
}

function assertTransition(previous: ProviderAttemptRecord | undefined, next: ProviderAttemptRecord): void {
	if (!previous) {
		if (next.sequence !== 1 || next.attempt !== 1 || next.state !== "started") throw invalid("initial transition");
		return;
	}
	if (next.sequence !== previous.sequence + 1 || stableJson(next.policy) !== stableJson(previous.policy)
		|| next.sessionId !== previous.sessionId || next.turnId !== previous.turnId
		|| next.provider !== previous.provider || next.model !== previous.model
		|| terminal(previous)) throw invalid("sequence or frozen identity");
	if (next.state === "scheduled") {
		if (previous.state !== "failed" || !previous.failure?.retryable || next.attempt !== previous.attempt + 1
			|| next.requestRetriesUsed !== previous.requestRetriesUsed + (next.recoveryKind === "request" ? 1 : 0)
			|| next.streamRetriesUsed !== previous.streamRetriesUsed + (next.recoveryKind === "stream" ? 1 : 0)
			|| stableJson(next.failure) !== stableJson(previous.failure)) throw invalid("retry reservation");
		return;
	}
	if (next.attempt !== previous.attempt || next.requestRetriesUsed !== previous.requestRetriesUsed
		|| next.streamRetriesUsed !== previous.streamRetriesUsed) throw invalid("attempt budget");
	const valid = previous.state === "scheduled"
		? next.state === "started" || next.state === "cancelled"
		: previous.state === "started"
			? ["failed", "completed", "recovered", "cancelled", "unknown"].includes(next.state)
			: previous.state === "failed" && (next.state === "exhausted" || next.state === "cancelled");
	if (!valid) throw invalid("state transition");
	if (next.state === "exhausted" && !previous.failure?.retryable) throw invalid("exhaustion classification");
}

function terminal(record: ProviderAttemptRecord): boolean {
	return ["completed", "recovered", "exhausted", "cancelled", "unknown"].includes(record.state)
		|| (record.state === "failed" && record.failure?.retryable === false);
}

function recordFromRow(row: AttemptRow): ProviderAttemptRecord {
	const record = parseProviderAttemptRecord(JSON.parse(row.record_json) as unknown);
	const digest = createHash("sha256").update(record.requestId).digest("hex");
	if (record.eventId !== row.event_id || record.requestId !== row.request_id
		|| record.sequence !== row.sequence_no || record.attempt !== row.attempt_no || record.state !== row.state
		|| record.eventId !== `provider-attempt-event:${digest}:${record.sequence}`
		|| record.attemptId !== providerAttemptId(record.requestId, record.attempt)
		|| record.retryChainId !== record.requestId) throw invalid("stored identity");
	return record;
}

function identity(value: string): string {
	if (typeof value !== "string" || !value.trim() || value.trim() !== value
		|| value.length > 256 || [...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})) throw invalid("identity");
	return value;
}

function invalid(reason: string): StorageFailure {
	return new StorageFailure(`invalid provider attempt ${reason}`);
}
