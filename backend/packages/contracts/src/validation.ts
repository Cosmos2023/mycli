import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Ajv2020 as AjvCompiler } from "ajv/dist/2020.js";
import type { GatewayContractCatalog } from "./generated/catalog.ts";
import type { GatewayEventNotification } from "./generated/gateway-event-notification.ts";
import type { GatewayToolRecord } from "./generated/gateway-tool-record.ts";
import type { JsonRpcMessage } from "./generated/json-rpc-message.ts";
import type { PluginV2Manifest } from "./generated/plugin-v2-manifest.ts";
import type { PluginV2ProtocolMessage } from "./generated/plugin-v2-protocol.ts";
import type { RuntimeStateRecord } from "./generated/runtime-state-record.ts";
import type { SessionGoal } from "./generated/session-goal.ts";
import type { RuntimeTurnRecord } from "./generated/runtime-turn-record.ts";
import { parseProviderAttemptRecord } from "./provider-attempt.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { errorContextSchema } from "./errors/error-context.ts";
import { projectGatewayErrorData, projectGatewayErrorPayload } from "./gateway/error-context-projection.ts";
import type { ContractValidator } from "./contract-validator.ts";
import {
	validateCatalog,
	validateGatewayErrorCode,
	validateGatewayEvent,
	validateGatewayToolRecord,
	validateJsonRpcMessage,
	validatePluginV2Manifest,
	validatePluginV2ProtocolMessage,
	validateRuntimeState,
	validateRuntimeTurnRecord,
	validateSessionGoal,
} from "./generated/validators/contract-validation.ts";
export { ContractValidationError } from "./contract-validation-error.ts";

const contractRequire = createRequire(import.meta.url);
let pluginSchemaCompiler: AjvCompiler | undefined;

type AjvCompilerConstructor = new (options: {
	readonly allErrors: boolean;
	readonly allowUnionTypes: boolean;
	readonly strict: boolean;
	readonly strictRequired: boolean;
}) => AjvCompiler;

/**
 * Ajv is only needed for the JSON Schemas that plugins register at runtime, so
 * the compiler loads on the first registration instead of on contract import.
 * Every other validator is generated at build time by scripts/generate.mjs.
 */
function pluginSchemaAjv(): AjvCompiler {
	if (pluginSchemaCompiler) return pluginSchemaCompiler;
	const { Ajv2020 } = contractRequire("ajv/dist/2020.js") as { readonly Ajv2020: AjvCompilerConstructor };
	const ajv = new Ajv2020({
		allErrors: true,
		allowUnionTypes: true,
		strict: true,
		strictRequired: false,
	});
	ajv.addKeyword({ keyword: "name", schemaType: "string", valid: true });
	ajv.addSchema(errorContextSchema, "https://mycli.local/contracts/error-context.schema.json");
	ajv.addSchema(JSON.parse(readFileSync(new URL("../schemas/mcp-elicitation.schema.json", import.meta.url), "utf8")) as object);
	pluginSchemaCompiler = ajv;
	return ajv;
}

function parse<T>(value: unknown, validator: ContractValidator, label: string): T {
	if (!validator(value)) {
		throw new ContractValidationError(`Invalid ${label}.`, validator.errors ?? []);
	}
	return value as T;
}

export function isGatewayErrorCode(value: unknown): value is Extract<GatewayEventNotification, { method: "gateway.error" }>["params"]["code"] {
	return validateGatewayErrorCode(value) === true;
}

export function parseSessionGoal(value: unknown): SessionGoal {
	return Object.freeze(parse<SessionGoal>(value, validateSessionGoal, "session goal"));
}

export function parseGatewayEvent(value: unknown): GatewayEventNotification {
	if (typeof value === "object" && value !== null && "method" in value && "params" in value && typeof value.method === "string") {
		value = { ...value, params: projectGatewayErrorPayload(value.method, value.params, "read") };
	}
	const event = parse<GatewayEventNotification>(value, validateGatewayEvent, "gateway event");
	const method = event.method === "runtime.event" ? event.params.type : event.method;
	const params: unknown = event.method === "runtime.event" ? event.params.payload : event.params;
	if (method === "provider.attempt.updated" && typeof params === "object" && params !== null && "record" in params) {
		const record = parseProviderAttemptRecord(params.record);
		if (!("session_id" in params) || params.session_id !== record.sessionId
			|| !("turn_id" in params) || params.turn_id !== record.turnId
			|| (event.method === "runtime.event" && (event.params.session_id !== record.sessionId
				|| event.params.turn_id !== record.turnId))) {
			throw new ContractValidationError("Invalid provider attempt event identity.");
		}
		const normalized = { ...params, record };
		return (event.method === "runtime.event"
			? { ...event, params: { ...event.params, payload: normalized } }
			: { ...event, params: normalized }) as GatewayEventNotification;
	}
	if ((method === "tool.start" || method === "tool.complete" || method === "tool.failed")
		&& typeof params === "object" && params !== null && "tool_record" in params
		&& params.tool_record !== undefined) {
		const record = parseGatewayToolRecord(params.tool_record);
		if (("call_id" in params && record.call_id !== params.call_id)
			|| ("name" in params && record.name !== params.name)) {
			throw new ContractValidationError("Invalid gateway tool record identity.");
		}
	}
	return event;
}

export function parseGatewayToolRecord(value: unknown): GatewayToolRecord {
	return parse(projectGatewayErrorData(value, "read"), validateGatewayToolRecord, "gateway tool record");
}

export function parseGatewayContractCatalog(value: unknown): GatewayContractCatalog {
	return parse(value, validateCatalog, "gateway contract catalog");
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
	return parse(value, validateJsonRpcMessage, "JSON-RPC message");
}

export function parsePluginV2Manifest(value: unknown): PluginV2Manifest {
	return parse(value, validatePluginV2Manifest, "Plugin API v2 manifest");
}

export function parsePluginV2ProtocolMessage(value: unknown): PluginV2ProtocolMessage {
	const message = parse<PluginV2ProtocolMessage>(
		value,
		validatePluginV2ProtocolMessage,
		"Plugin API v2 protocol message",
	);
	if (message.type === "registered") {
		const ajv = pluginSchemaAjv();
		for (const registration of message.registrations) {
			let valid = false;
			try {
				valid = ajv.validateSchema(registration.input_schema) === true;
			} catch {
				valid = false;
			}
			if (!valid) {
				throw new ContractValidationError(
					"Invalid Plugin API v2 registration schema.",
					ajv.errors ?? [],
				);
			}
		}
	}
	return message;
}

export function parseRuntimeTurnRecord(value: unknown): RuntimeTurnRecord {
	return parse(value, validateRuntimeTurnRecord, "runtime turn record");
}

export function parseRuntimeState(value: unknown): RuntimeStateRecord {
	const state = parse<RuntimeStateRecord>(value, validateRuntimeState, "runtime state");
	if (state.kind === "input_queue") {
		const records = [
			...state.payload.pending_steers,
			...state.payload.rejected_steers,
			...state.payload.follow_ups,
		];
		if (records.some((record) => record.session_id !== state.payload.session_id)) {
			throw new ContractValidationError("Invalid runtime state: queue session mismatch.");
		}
	}
	if (state.kind === "compact_checkpoint"
		&& !Array.isArray(state.payload.replacement_messages)
		&& typeof state.payload.transcript_event_id !== "string") {
		throw new ContractValidationError(
			"Invalid runtime state: compact checkpoint has no transcript source.",
		);
	}
	return state;
}
