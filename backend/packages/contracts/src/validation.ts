import { readFileSync } from "node:fs";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { GatewayContractCatalog } from "./generated/catalog.ts";
import type { GatewayEventNotification } from "./generated/gateway-event-notification.ts";
import type { JsonRpcMessage } from "./generated/json-rpc-message.ts";
import type { PluginV2Manifest } from "./generated/plugin-v2-manifest.ts";
import type { PluginV2ProtocolMessage } from "./generated/plugin-v2-protocol.ts";
import type { RuntimeStateRecord } from "./generated/runtime-state-record.ts";
import type { RuntimeTurnRecord } from "./generated/runtime-turn-record.ts";

const ajv = new Ajv2020({
	allErrors: true,
	allowUnionTypes: true,
	strict: true,
	strictRequired: false,
});
ajv.addKeyword({ keyword: "name", schemaType: "string", valid: true });

function compile(name: string): ValidateFunction {
	const url = new URL(`../schemas/${name}`, import.meta.url);
	return ajv.compile(JSON.parse(readFileSync(url, "utf8")) as object);
}

const validateCatalog = compile("catalog.schema.json");
const validateGatewayEvent = compile("gateway-events.schema.json");
const validateJsonRpcMessage = compile("json-rpc.schema.json");
const validatePluginV2Manifest = compile("plugin-v2-manifest.schema.json");
const validatePluginV2ProtocolMessage = compile("plugin-v2-protocol.schema.json");
const validateRuntimeState = compile("runtime-state.schema.json");
const validateRuntimeTurnRecord = compile("runtime-turn.schema.json");

export class ContractValidationError extends Error {
	readonly errors: readonly ErrorObject[];

	constructor(message: string, errors: readonly ErrorObject[] = []) {
		super(message);
		this.name = "ContractValidationError";
		this.errors = errors;
	}
}

function parse<T>(value: unknown, validator: ValidateFunction, label: string): T {
	if (!validator(value)) {
		throw new ContractValidationError(`Invalid ${label}.`, validator.errors ?? []);
	}
	return value as T;
}

export function parseGatewayEvent(value: unknown): GatewayEventNotification {
	return parse(value, validateGatewayEvent, "gateway event");
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
