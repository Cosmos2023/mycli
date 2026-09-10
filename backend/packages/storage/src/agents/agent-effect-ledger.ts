import type Database from "better-sqlite3";
import { modelInputSha256 } from "@mycli/core";
import { StorageFailure } from "../sessions/session-store.ts";
import { stableJson } from "../stable-json.ts";

export type AgentEffectAttemptKind = "provider" | "tool";
export type AgentEffectAttemptTerminalState =
	| "completed"
	| "failed"
	| "interrupted"
	| "unknown"
	| "effect_outcome_unknown";
export type AgentEffectAttemptState = "reserved" | AgentEffectAttemptTerminalState;

export interface AgentEffectAttempt {
	readonly attemptId: string;
	readonly kind: AgentEffectAttemptKind;
	readonly sessionId: string;
	readonly turnId: string;
	readonly jobId: string;
	readonly externalId: string;
	readonly mutating: boolean;
	readonly requestSha256: string;
	readonly request: Readonly<Record<string, unknown>>;
	readonly state: AgentEffectAttemptState;
	readonly resultSha256?: string;
	readonly result?: Readonly<Record<string, unknown>>;
	readonly createdAt: string;
	readonly completedAt?: string;
}

export interface ReserveAgentEffectAttemptInput {
	readonly attemptId: string;
	readonly kind: AgentEffectAttemptKind;
	readonly sessionId: string;
	readonly turnId: string;
	readonly jobId: string;
	readonly externalId: string;
	readonly mutating: boolean;
	readonly request: Readonly<Record<string, unknown>>;
	readonly createdAt: string;
}

export interface CompleteAgentEffectAttemptInput {
	readonly attemptId: string;
	readonly state: AgentEffectAttemptTerminalState;
	readonly result: Readonly<Record<string, unknown>>;
	readonly completedAt: string;
}

export interface RecoverInterruptedToolAttemptsInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly completedAt: string;
}

export interface AgentEffectAttemptReservation {
	readonly kind: "reserved" | "existing";
	readonly attempt: AgentEffectAttempt;
}

export interface AgentEffectLedgerStore {
	reserve(input: ReserveAgentEffectAttemptInput): AgentEffectAttemptReservation;
	complete(input: CompleteAgentEffectAttemptInput): AgentEffectAttempt;
	recoverInterruptedTools(
		input: RecoverInterruptedToolAttemptsInput,
	): readonly AgentEffectAttempt[];
	load(attemptId: string): AgentEffectAttempt | undefined;
}

export interface SQLiteAgentEffectLedgerOptions {
	readonly database: Database.Database;
	readonly errorContextVersion?: 1;
	readonly write: <Result>(operation: () => Result) => Result;
}

interface AgentEffectAttemptRow {
	readonly attempt_id: unknown;
	readonly kind: unknown;
	readonly session_id: unknown;
	readonly turn_id: unknown;
	readonly job_id: unknown;
	readonly external_id: unknown;
	readonly mutating: unknown;
	readonly request_sha256: unknown;
	readonly request_json: unknown;
	readonly state: unknown;
	readonly result_sha256: unknown;
	readonly result_json: unknown;
	readonly created_at: unknown;
	readonly completed_at: unknown;
}

const ATTEMPT_COLUMNS = `
a.attempt_id, a.kind, a.session_id, a.turn_id, a.job_id, a.external_id, a.mutating,
a.request_sha256, a.request_json, o.state, o.result_sha256, o.result_json,
a.created_at, o.completed_at
`;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export class SQLiteAgentEffectLedger implements AgentEffectLedgerStore {
	readonly #database: Database.Database;
	readonly #errorContextVersion: 1 | undefined;
	readonly #write: <Result>(operation: () => Result) => Result;

	constructor(options: SQLiteAgentEffectLedgerOptions) {
		this.#database = options.database;
		this.#errorContextVersion = options.errorContextVersion;
		this.#write = options.write;
	}

	reserve(input: ReserveAgentEffectAttemptInput): AgentEffectAttemptReservation {
		return this.#write(() => {
			const candidate = reservedAttempt(input);
			const existing = this.#load(candidate.attemptId);
			if (existing) {
				assertSameReservation(existing, candidate);
				return Object.freeze({ kind: "existing", attempt: existing });
			}
			const external = this.#loadByExternalIdentity(candidate);
			if (external) {
				throw new StorageFailure("agent effect external identity is already reserved");
			}
			this.#database.prepare(`
				INSERT INTO agent_effect_attempts (
					attempt_id, kind, session_id, turn_id, job_id, external_id, mutating,
					request_sha256, request_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				candidate.attemptId,
				candidate.kind,
				candidate.sessionId,
				candidate.turnId,
				candidate.jobId,
				candidate.externalId,
				candidate.mutating ? 1 : 0,
				candidate.requestSha256,
				stableJson(candidate.request),
				candidate.createdAt,
			);
			return Object.freeze({ kind: "reserved", attempt: this.#required(candidate.attemptId) });
		});
	}

	complete(input: CompleteAgentEffectAttemptInput): AgentEffectAttempt {
		return this.#write(() => {
			const attemptId = identity(input.attemptId, "agent effect attempt");
			const state = terminalState(input.state);
			const result = record(input.result, "agent effect result");
			const metadata = result.metadata;
			if (this.#errorContextVersion !== 1 && (result.errorContext !== undefined
				|| (typeof metadata === "object" && metadata !== null && "error_context" in metadata))) {
				throw new StorageFailure("error contexts require session schema version 14");
			}
			const resultJson = stableJson(result);
			const resultSha256 = modelInputSha256(result);
			const completedAt = timestamp(input.completedAt, "agent effect completion");
			const existing = this.#required(attemptId);
			if (existing.state !== "reserved") {
				if (existing.state !== state
					|| existing.resultSha256 !== resultSha256
					|| stableJson(existing.result) !== resultJson) {
					throw new StorageFailure("agent effect attempt already has a different terminal outcome");
				}
				return existing;
			}
			this.#database.prepare(`
				INSERT INTO agent_effect_attempt_outcomes (
					attempt_id, state, result_sha256, result_json, completed_at
				) VALUES (?, ?, ?, ?, ?)
			`).run(attemptId, state, resultSha256, resultJson, completedAt);
			return this.#required(attemptId);
		});
	}

	recoverInterruptedTools(
		input: RecoverInterruptedToolAttemptsInput,
	): readonly AgentEffectAttempt[] {
		return this.#write(() => {
			const sessionId = identity(input.sessionId, "agent effect session");
			const turnId = identity(input.turnId, "agent effect turn");
			const completedAt = timestamp(input.completedAt, "agent effect completion");
			const attempts = this.#loadToolsForTurn(sessionId, turnId);
			for (const attempt of attempts) {
				if (attempt.state !== "reserved") continue;
				const state = attempt.mutating ? "effect_outcome_unknown" : "interrupted";
				const result = Object.freeze({ error_kind: state });
				this.#database.prepare(`
					INSERT INTO agent_effect_attempt_outcomes (
						attempt_id, state, result_sha256, result_json, completed_at
					) VALUES (?, ?, ?, ?, ?)
				`).run(
					attempt.attemptId,
					state,
					modelInputSha256(result),
					stableJson(result),
					completedAt,
				);
			}
			return Object.freeze(this.#loadToolsForTurn(sessionId, turnId));
		});
	}

	load(attemptId: string): AgentEffectAttempt | undefined {
		return this.#read(() => this.#load(identity(attemptId, "agent effect attempt")));
	}

	#required(attemptId: string): AgentEffectAttempt {
		const attempt = this.#load(attemptId);
		if (!attempt) throw new StorageFailure("agent effect attempt does not exist");
		return attempt;
	}

	#load(attemptId: string): AgentEffectAttempt | undefined {
		const row = this.#database.prepare(`
			SELECT ${ATTEMPT_COLUMNS}
			FROM agent_effect_attempts AS a
			LEFT JOIN agent_effect_attempt_outcomes AS o ON o.attempt_id = a.attempt_id
			WHERE a.attempt_id = ?
		`).get(attemptId) as AgentEffectAttemptRow | undefined;
		return row ? attempt(row) : undefined;
	}

	#loadByExternalIdentity(input: AgentEffectAttempt): AgentEffectAttempt | undefined {
		const row = this.#database.prepare(`
			SELECT ${ATTEMPT_COLUMNS}
			FROM agent_effect_attempts AS a
			LEFT JOIN agent_effect_attempt_outcomes AS o ON o.attempt_id = a.attempt_id
			WHERE a.kind = ? AND a.session_id = ? AND a.turn_id = ? AND a.external_id = ?
		`).get(
			input.kind,
			input.sessionId,
			input.turnId,
			input.externalId,
		) as AgentEffectAttemptRow | undefined;
		return row ? attempt(row) : undefined;
	}

	#loadToolsForTurn(sessionId: string, turnId: string): AgentEffectAttempt[] {
		const rows = this.#database.prepare(`
			SELECT ${ATTEMPT_COLUMNS}
			FROM agent_effect_attempts AS a
			LEFT JOIN agent_effect_attempt_outcomes AS o ON o.attempt_id = a.attempt_id
			WHERE a.kind = 'tool' AND a.session_id = ? AND a.turn_id = ?
			ORDER BY a.created_at, a.attempt_id
		`).all(sessionId, turnId) as readonly AgentEffectAttemptRow[];
		return rows.map(attempt);
	}

	#read<Result>(operation: () => Result): Result {
		try {
			return operation();
		} catch (error) {
			if (error instanceof StorageFailure) throw error;
			throw new StorageFailure("agent effect ledger read failed");
		}
	}
}

function reservedAttempt(input: ReserveAgentEffectAttemptInput): AgentEffectAttempt {
	const request = record(input.request, "agent effect request");
	return Object.freeze({
		attemptId: identity(input.attemptId, "agent effect attempt"),
		kind: effectKind(input.kind),
		sessionId: identity(input.sessionId, "agent effect session"),
		turnId: identity(input.turnId, "agent effect turn"),
		jobId: identity(input.jobId, "agent effect job"),
		externalId: identity(input.externalId, "agent effect external identity"),
		mutating: input.mutating,
		requestSha256: modelInputSha256(request),
		request,
		state: "reserved",
		createdAt: timestamp(input.createdAt, "agent effect reservation"),
	});
}

function attempt(row: AgentEffectAttemptRow): AgentEffectAttempt {
	const state = row.state === null ? "reserved" : terminalState(row.state);
	const request = jsonRecord(row.request_json, "agent effect request");
	const requestSha256 = sha256(row.request_sha256, "agent effect request hash");
	if (modelInputSha256(request) !== requestSha256) {
		throw new StorageFailure("agent effect request hash does not match");
	}
	const result = row.result_json === null
		? undefined
		: jsonRecord(row.result_json, "agent effect result");
	const resultSha256 = row.result_sha256 === null
		? undefined
		: sha256(row.result_sha256, "agent effect result hash");
	const completedAt = row.completed_at === null
		? undefined
		: timestamp(row.completed_at, "agent effect completion");
	if (state === "reserved"
		? result !== undefined || resultSha256 !== undefined || completedAt !== undefined
		: result === undefined || resultSha256 === undefined || completedAt === undefined) {
		throw new StorageFailure("agent effect terminal payload is inconsistent");
	}
	if (result && modelInputSha256(result) !== resultSha256) {
		throw new StorageFailure("agent effect result hash does not match");
	}
	return Object.freeze({
		attemptId: identity(row.attempt_id, "agent effect attempt"),
		kind: effectKind(row.kind),
		sessionId: identity(row.session_id, "agent effect session"),
		turnId: identity(row.turn_id, "agent effect turn"),
		jobId: identity(row.job_id, "agent effect job"),
		externalId: identity(row.external_id, "agent effect external identity"),
		mutating: booleanColumn(row.mutating),
		requestSha256,
		request,
		state,
		...(resultSha256 ? { resultSha256 } : {}),
		...(result ? { result } : {}),
		createdAt: timestamp(row.created_at, "agent effect reservation"),
		...(completedAt ? { completedAt } : {}),
	});
}

function assertSameReservation(existing: AgentEffectAttempt, candidate: AgentEffectAttempt): void {
	if (existing.kind !== candidate.kind
		|| existing.sessionId !== candidate.sessionId
		|| existing.turnId !== candidate.turnId
		|| existing.jobId !== candidate.jobId
		|| existing.externalId !== candidate.externalId
		|| existing.mutating !== candidate.mutating
		|| existing.requestSha256 !== candidate.requestSha256
		|| stableJson(existing.request) !== stableJson(candidate.request)) {
		throw new StorageFailure("agent effect attempt id collides with different content");
	}
}

function jsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "string") throw new StorageFailure(`${label} is invalid`);
	try {
		return record(JSON.parse(value) as unknown, label);
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure(`${label} is invalid`);
	}
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new StorageFailure(`${label} is invalid`);
	}
	try {
		const json = stableJson(value);
		if (json === undefined) throw new TypeError("not serializable");
		return Object.freeze(JSON.parse(json) as Record<string, unknown>);
	} catch {
		throw new StorageFailure(`${label} is invalid`);
	}
}

function identity(value: unknown, label: string): string {
	if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.length > 128) {
		throw new StorageFailure(`${label} timestamp is invalid`);
	}
	return value;
}

function effectKind(value: unknown): AgentEffectAttemptKind {
	if (value !== "provider" && value !== "tool") {
		throw new StorageFailure("agent effect kind is invalid");
	}
	return value;
}

function terminalState(value: unknown): AgentEffectAttemptTerminalState {
	if (value !== "completed" && value !== "failed" && value !== "interrupted" && value !== "unknown"
		&& value !== "effect_outcome_unknown") {
		throw new StorageFailure("agent effect terminal state is invalid");
	}
	return value;
}

function booleanColumn(value: unknown): boolean {
	if (value !== 0 && value !== 1) throw new StorageFailure("agent effect mutation flag is invalid");
	return value === 1;
}

function sha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return value;
}
