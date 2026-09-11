import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import {
	canonicalRuntimeFailureMessage,
	isRuntimeErrorCode,
	sanitizeRuntimeErrorDetail,
} from "./gateway/runtime-errors.ts";
import type { RuntimeFailure, RuntimeFailureDiagnosticValue } from "./gateway/runtime-errors.ts";
import type { ProviderAttemptFields } from "./generated/provider-attempt.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { errorContextSchema, readErrorContext } from "./errors/error-context.ts";

export interface ProviderAttemptPolicy {
	readonly requestMaxRetries: number;
	readonly streamMaxRetries: number;
}

export function providerAttemptId(requestId: string, attempt: number): string {
	return `provider-attempt:${createHash("sha256").update(requestId).digest("hex")}:${attempt}`;
}

export type ProviderAttemptState = ProviderAttemptFields["state"];
export type ProviderAttemptSource = "worker" | "in_process" | "restart_recovery";

export interface ProviderAttemptUpdate {
	readonly sequence: number;
	readonly attempt: number;
	readonly state: ProviderAttemptState;
	readonly policy: ProviderAttemptPolicy;
	readonly requestRetriesUsed: number;
	readonly streamRetriesUsed: number;
	readonly observedAt: string;
	readonly failure?: RuntimeFailure;
	readonly recoveryKind?: "request" | "stream";
	readonly retryAt?: string;
	readonly resetOutput?: boolean;
}

export interface ProviderAttemptRecord extends ProviderAttemptUpdate {
	readonly eventId: string;
	readonly attemptId: string;
	readonly retryChainId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly requestId: string;
	readonly provider: string;
	readonly model: string;
	readonly source: ProviderAttemptSource;
	readonly committedAt: string;
}

const schema = JSON.parse(readFileSync(
	new URL("../schemas/provider-attempt.schema.json", import.meta.url), "utf8",
)) as object;
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false });
ajv.addSchema(errorContextSchema);
ajv.addSchema(JSON.parse(readFileSync(
	new URL("../schemas/runtime-turn.schema.json", import.meta.url), "utf8",
)) as object);
ajv.addSchema(schema);
const validateUpdate = ajv.compile({ $ref: "https://mycli.local/schemas/provider-attempt.schema.json#/$defs/update" });
const validateRecord = ajv.compile({ $ref: "https://mycli.local/schemas/provider-attempt.schema.json#/$defs/record" });
const validateFailure = ajv.compile({ $ref: "https://mycli.local/schemas/provider-attempt.schema.json#/$defs/failure" });
const MAX_BYTES = 64 * 1024;
const SAFE_DIAGNOSTICS = new Set([
	"status", "upstream_code", "upstream_type", "upstream_reason", "request_id",
	"provider", "protocol", "model", "transport", "error_source", "source", "retry_after_seconds",
	"provider_error_code", "provider_error_type", "transport_error_code", "transport_error_name",
	"error_context_invalid",
]);

export function parseProviderAttemptUpdate(value: unknown): ProviderAttemptUpdate {
	value = normalizeAttemptErrorContext(value);
	validate(value, validateUpdate);
	return normalizedUpdate(value as ProviderAttemptUpdate);
}

export function parseRuntimeFailure(value: unknown): RuntimeFailure {
	value = normalizeFailureErrorContext(value);
	validate(value, validateFailure);
	return safeFailure(value as RuntimeFailure);
}

export function parseProviderAttemptRecord(value: unknown): ProviderAttemptRecord {
	value = normalizeAttemptErrorContext(value);
	validate(value, validateRecord);
	const record = value as ProviderAttemptRecord;
	timestamp(record.committedAt);
	for (const identity of [record.eventId, record.attemptId, record.retryChainId,
		record.sessionId, record.turnId, record.requestId, record.model]) {
		if (identity.trim() !== identity || !identity.trim()) throw invalid();
	}
	return Object.freeze({ ...record, ...normalizedUpdate(record) });
}

function normalizedUpdate(update: ProviderAttemptUpdate): ProviderAttemptUpdate {
	timestamp(update.observedAt);
	if (update.requestRetriesUsed > update.policy.requestMaxRetries
		|| update.streamRetriesUsed > update.policy.streamMaxRetries
		|| update.attempt !== 1 + update.requestRetriesUsed + update.streamRetriesUsed) throw invalid();
	if (update.retryAt !== undefined) {
		timestamp(update.retryAt);
		const delay = Date.parse(update.retryAt) - Date.parse(update.observedAt);
		if (delay < 0 || delay > 3_600_000) throw invalid();
	}
	if (update.state === "scheduled") {
		if (!update.failure || !update.failure.retryable || !update.recoveryKind
			|| !update.retryAt || update.attempt === 1) throw invalid();
	} else if (update.retryAt !== undefined || update.resetOutput !== undefined) throw invalid();
	if ((update.state === "failed" || update.state === "exhausted") && !update.failure) throw invalid();
	if ((update.state === "completed" || update.state === "recovered") && update.failure) throw invalid();
	if (update.state === "completed" && update.attempt !== 1) throw invalid();
	if (update.state === "recovered" && update.attempt === 1) throw invalid();
	return Object.freeze({
		sequence: update.sequence,
		attempt: update.attempt,
		state: update.state,
		policy: Object.freeze({ ...update.policy }),
		requestRetriesUsed: update.requestRetriesUsed,
		streamRetriesUsed: update.streamRetriesUsed,
		observedAt: update.observedAt,
		...(update.failure ? { failure: safeFailure(update.failure) } : {}),
		...(update.recoveryKind ? { recoveryKind: update.recoveryKind } : {}),
		...(update.retryAt ? { retryAt: update.retryAt } : {}),
		...(update.resetOutput === undefined ? {} : { resetOutput: update.resetOutput }),
	});
}

function safeFailure(failure: RuntimeFailure): RuntimeFailure {
	if (!isRuntimeErrorCode(failure.code)) throw invalid();
	const diagnostics: Record<string, RuntimeFailureDiagnosticValue> = {};
	for (const [key, value] of Object.entries(failure.diagnostics ?? {})) {
		if (!SAFE_DIAGNOSTICS.has(key)) continue;
		if (typeof value === "number" && !Number.isFinite(value)) throw invalid();
		const safe = typeof value === "string" ? sanitizeRuntimeErrorDetail(value) : value;
		if (safe !== undefined) diagnostics[key] = safe;
	}
	const details = sanitizeRuntimeErrorDetail(failure.additionalDetails);
	const errorContext = readErrorContext(failure.errorContext);
	return Object.freeze({
		code: failure.code,
		message: canonicalRuntimeFailureMessage(failure.code, failure.message, errorContext),
		...(errorContext ? { errorContext } : {}),
		retryable: failure.retryable,
		...(details ? { additionalDetails: details } : {}),
		...(failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds }),
		...(Object.keys(diagnostics).length ? { diagnostics: Object.freeze(diagnostics) } : {}),
	});
}

function normalizeAttemptErrorContext(value: unknown): unknown {
	if (!isRecord(value) || !Object.hasOwn(value, "failure")) return value;
	return { ...value, failure: normalizeFailureErrorContext(value.failure) };
}

function normalizeFailureErrorContext(value: unknown): unknown {
	if (!isRecord(value) || !Object.hasOwn(value, "errorContext")) return value;
	const { errorContext: raw, ...failure } = value;
	const errorContext = readErrorContext(raw);
	if (errorContext) return { ...failure, errorContext };
	return {
		...failure,
		diagnostics: { ...(isRecord(failure.diagnostics) ? failure.diagnostics : {}), error_context_invalid: true },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: string): void {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.toISOString().replace(".000Z", "Z")
		!== value.replace(".000Z", "Z")) throw invalid();
}

function validate(value: unknown, validator: ValidateFunction): void {
	try {
		const json = JSON.stringify(value);
		if (json === undefined || Buffer.byteLength(json) > MAX_BYTES || !validator(value)) throw invalid();
	} catch {
		throw invalid();
	}
}

function invalid(): ContractValidationError {
	return new ContractValidationError("Invalid provider attempt record.");
}
