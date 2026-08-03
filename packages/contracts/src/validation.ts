import { readFileSync } from "node:fs";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { GatewayContractCatalog } from "./generated/catalog.ts";
import type { GatewayEventNotification } from "./generated/gateway-event-notification.ts";
import type { JsonRpcMessage } from "./generated/json-rpc-message.ts";

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
