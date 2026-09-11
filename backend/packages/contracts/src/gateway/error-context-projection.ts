import { readErrorContext } from "../errors/error-context.ts";

type Fields = Readonly<Record<string, unknown>>;
type Mode = "read" | "legacy";

export function projectGatewayErrorPayload(method: string, value: unknown, mode: Mode): unknown {
	if (!isRecord(value)) return value;
	if (method === "runtime.event" && typeof value.type === "string" && value.type !== "runtime.event") {
		return { ...value, payload: projectGatewayErrorPayload(value.type, value.payload, mode) };
	}
	let result = contextFields(value, "error_context", mode);
	if ((method === "turn.event" || method === "tool.complete" || method === "tool.failed") && isRecord(result.metadata)) {
		result = { ...result, metadata: contextFields(result.metadata, "error_context", mode) };
	}
	if (isRecord(result.failure)) result = { ...result, failure: runtimeFailure(result.failure, mode) };
	if (isRecord(result.tool_record)) result = { ...result, tool_record: contextFields(result.tool_record, "error_context", mode) };
	if (method === "provider.attempt.updated" && isRecord(result.record)) result = { ...result, record: attempt(result.record, mode) };
	if (method === "provider.attempts.load" && Array.isArray(result.records)) result = { ...result, records: result.records.map((record) => attempt(record, mode)) };
	if (method === "transcript.load") {
		if (Array.isArray(result.provider_attempts)) result = { ...result, provider_attempts: result.provider_attempts.map((record) => attempt(record, mode)) };
		if (Array.isArray(result.items)) result = { ...result, items: result.items.map((item) => transcriptItem(item, mode)) };
	}
	if (isRecord(result.turn) && isRecord(result.turn.result)) {
		result = { ...result, turn: { ...result.turn, result: contextFields(result.turn.result, "error_context", mode) } };
	}
	return result;
}

export function projectGatewayErrorData(value: unknown, mode: Mode): unknown {
	return isRecord(value) ? contextFields(value, "error_context", mode) : value;
}

function transcriptItem(value: unknown, mode: Mode): unknown {
	if (!isRecord(value)) return value;
	const metadata = isRecord(value.metadata) ? contextFields(value.metadata, "error_context", mode) : undefined;
	return { ...value,
		...(metadata ? { metadata: { ...metadata,
			...(isRecord(metadata.provider_attempt) ? { provider_attempt: attempt(metadata.provider_attempt, mode) } : {}),
		} } : {}),
		...(isRecord(value.tool_record) ? { tool_record: contextFields(value.tool_record, "error_context", mode) } : {}),
	};
}

function attempt(value: unknown, mode: Mode): unknown {
	if (!isRecord(value)) return value;
	return { ...value,
		...(isRecord(value.failure) ? { failure: runtimeFailure(value.failure, mode) } : {}),
	};
}

function runtimeFailure(value: Fields, mode: Mode): Fields {
	const normalized = contextFields(value, "errorContext", mode);
	if (normalized.error_context_invalid !== true) return normalized;
	const fields = { ...normalized };
	delete fields.error_context_invalid;
	return { ...fields, diagnostics: { ...(isRecord(fields.diagnostics) ? fields.diagnostics : {}), error_context_invalid: true } };
}

function contextFields(value: Fields, key: "errorContext" | "error_context", mode: Mode): Fields {
	if (mode === "legacy") {
		if (value[key] === undefined && value.error_context_invalid === undefined && !Array.isArray(value.recovery_actions)) return value;
		const result = { ...value };
		delete result[key];
		delete result.error_context_invalid;
		if (Array.isArray(result.recovery_actions)) {
			result.recovery_actions = result.recovery_actions.filter((action) =>
				action !== "inspect_execution" && action !== "select_compatible_model");
		}
		return result;
	}
	if (value[key] === undefined) return value;
	const result = { ...value };
	delete result[key];
	const context = readErrorContext(value[key]);
	if (context) result[key] = context;
	else {
		result.error_context_invalid = true;
		delete result.recovery_actions;
	}
	return result;
}

function isRecord(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
