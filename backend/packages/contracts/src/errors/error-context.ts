import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { ContractValidationError } from "../contract-validation-error.ts";
import { sanitizeRuntimeErrorDetail } from "../gateway/runtime-errors.ts";
import type { ErrorContextV1, ErrorOccurrenceV1, ErrorReasonDetails, FailureOutcome, FailureScope, FailureSource } from "../generated/error-context.ts";
import { errorDefinition, isErrorReason, type ErrorReason } from "./catalog.ts";

type ReadonlyErrorValue<T> = T extends readonly (infer Item)[] ? readonly ReadonlyErrorValue<Item>[]
	: T extends object ? { readonly [Key in keyof T]: ReadonlyErrorValue<T[Key]> } : T;

export type ErrorContext = ReadonlyErrorValue<ErrorContextV1>;
export type ErrorOccurrence = ReadonlyErrorValue<ErrorOccurrenceV1>;
export const ERROR_CONTEXT_MAX_BYTES = 8 * 1024;
export const ERROR_CONTEXT_VERSION = 1;
export type ErrorContextIssue = "unsupported_version" | "unknown_reason" | "invalid_context";

interface ErrorIdentityInput {
	readonly id?: string;
	readonly source: FailureSource;
	readonly scope: Readonly<FailureScope>;
	readonly outcome?: Readonly<FailureOutcome>;
	readonly causes?: readonly ErrorOccurrence[];
}

export type ErrorContextInput = ErrorIdentityInput & (ErrorReasonDetails | {
	readonly reason: ErrorReason;
	readonly details?: never;
});

interface ContextSchema {
	readonly $id: string;
	readonly $defs: {
		readonly reason_details: {
			readonly oneOf: readonly {
				readonly properties: {
					readonly reason: { readonly enum: readonly ErrorReason[] };
					readonly details: { readonly $ref: string };
				};
			}[];
		};
		readonly [key: string]: unknown;
	};
}

export const errorContextSchema: object = JSON.parse(readFileSync(
	new URL("../../schemas/error-context.schema.json", import.meta.url), "utf8",
)) as object;
const schema = errorContextSchema as ContextSchema;
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false });
const validateContext = ajv.compile<ErrorContextV1>(schema);
const detailFields = new Map<ErrorReason, ReadonlyMap<string, ValidateFunction>>();
for (const branch of schema.$defs.reason_details.oneOf) {
	const ref = branch.properties.details.$ref;
	const name = ref.slice("#/$defs/".length);
	const definition = schema.$defs[name] as { readonly properties: Readonly<Record<string, object>> };
	const fields = new Map(Object.keys(definition.properties).map((key) => [
		key, ajv.compile({ $ref: `${schema.$id}${ref}/properties/${key}` }),
	] as const));
	for (const reason of branch.properties.reason.enum) detailFields.set(reason, fields);
}

export function createErrorContext(input: ErrorContextInput): ErrorContext {
	const { causes: suppliedCauses = [], outcome, details, id, ...identity } = input;
	const uniqueCauses = new Map<string, ErrorOccurrence>();
	for (const cause of suppliedCauses) if (!uniqueCauses.has(cause.id)) uniqueCauses.set(cause.id, cause);
	const unique = [...uniqueCauses.values()];
	const selected = unique.length > 3 ? [unique[0]!, unique[1]!, unique.at(-1)!] : unique;
	const causes = selected.map((cause) => errorOccurrence(parseErrorContext({ ...cause, version: 1 })));
	const safeDetails = normalizeDetails(input.reason, details);
	const candidate = {
		...identity, version: 1 as const, id: id ?? `error:${randomUUID()}`,
		scope: failureScope(input.scope.kind, input.scope.id),
		outcome: outcome ?? { state: "unknown", effects: "possible" },
		...(safeDetails ? { details: safeDetails } : {}),
		...(causes.length > 0 ? { causes } : {}),
	};
	if (unique.length > 3 && input.reason === "runtime.retry_exhausted") {
		candidate.details = { ...candidate.details, omitted_causes: unique.length - 3 };
	}
	// Keep identity and causal reasons when optional detail would exceed the wire budget.
	if (encodedBytes(candidate) > ERROR_CONTEXT_MAX_BYTES) {
		for (const cause of causes) delete (cause as { details?: unknown }).details;
		if (encodedBytes(candidate) > ERROR_CONTEXT_MAX_BYTES) delete candidate.details;
	}
	return parseErrorContext(candidate);
}

export function parseErrorContext(value: unknown): ErrorContext {
	if (encodedBytes(value) > ERROR_CONTEXT_MAX_BYTES || !validateContext(value)) throw invalid();
	const copy = JSON.parse(JSON.stringify(value)) as ErrorContextV1;
	if (new Set([copy.id, ...(copy.causes ?? []).map((cause) => cause.id)]).size !== 1 + (copy.causes?.length ?? 0)) throw invalid();
	for (const occurrence of [copy, ...(copy.causes ?? [])]) {
		if (!isErrorReason(occurrence.reason)
			|| !errorDefinition(occurrence.reason).scopes.includes(occurrence.scope.kind)
			|| safeErrorToken(occurrence.id) !== occurrence.id
			|| safeErrorToken(occurrence.scope.id) !== occurrence.scope.id) throw invalid();
		const normalized = normalizeDetails(occurrence.reason, occurrence.details);
		if (Object.keys(normalized ?? {}).length !== Object.keys(occurrence.details ?? {}).length) throw invalid();
		Object.freeze(occurrence.scope);
		Object.freeze(occurrence.outcome);
		if (occurrence.details) Object.freeze(occurrence.details);
		Object.freeze(occurrence);
	}
	if (copy.causes) Object.freeze(copy.causes);
	return Object.freeze(copy);
}

export function readErrorContext(
	value: unknown,
	onIssue?: (issue: ErrorContextIssue) => void,
): ErrorContext | undefined {
	if (value === undefined) return undefined;
	if (isRecord(value) && value.version !== 1) {
		onIssue?.("unsupported_version");
		return undefined;
	}
	if (isRecord(value) && !isErrorReason(value.reason)) {
		onIssue?.("unknown_reason");
		return undefined;
	}
	try { return parseErrorContext(value); }
	catch { onIssue?.("invalid_context"); return undefined; }
}

export function errorOccurrence(context: ErrorContext | ErrorOccurrence): ErrorOccurrence {
	return {
		id: context.id, reason: context.reason, source: context.source,
		scope: { ...context.scope }, outcome: { ...context.outcome },
		...(context.details ? { details: { ...context.details } } : {}),
	} as ErrorOccurrence;
}

export function safeErrorToken(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 256
		|| !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(value)
		|| value.includes("://") || /^[A-Za-z]:\//u.test(value)
		|| sanitizeRuntimeErrorDetail(value) !== value) return undefined;
	return value;
}

export function failureScope(kind: FailureScope["kind"], id: string): Readonly<FailureScope> {
	return Object.freeze({ kind, id: safeErrorToken(id) ?? `scope:${createHash("sha256").update(id).digest("hex")}` });
}

function normalizeDetails(reason: ErrorReason, value: unknown): ErrorReasonDetails["details"] | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string | number> = {};
	for (const [key, validate] of detailFields.get(reason) ?? []) {
		const field = value[key];
		if (!validate(field) || (typeof field === "string" && safeErrorToken(field) === undefined)) continue;
		if (typeof field === "string" || (typeof field === "number" && Number.isFinite(field))) result[key] = field;
	}
	return Object.keys(result).length > 0 ? result as ErrorReasonDetails["details"] : undefined;
}

function encodedBytes(value: unknown): number {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? Infinity : Buffer.byteLength(encoded);
	} catch { return Infinity; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): ContractValidationError {
	return new ContractValidationError("Invalid error context.");
}
