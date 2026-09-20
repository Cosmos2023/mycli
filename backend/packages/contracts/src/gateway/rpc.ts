import { readFileSync } from "node:fs";
import type { GatewayRpcMethods } from "../generated/gateway-rpc.ts";
import { gatewayRpcValidators } from "../generated/validators/gateway-rpc.ts";
import { ContractValidationError } from "../validation.ts";
import { parseProviderAttemptRecord } from "../provider-attempt.ts";
import type { ContractValidator } from "../contract-validator.ts";
import { projectGatewayErrorPayload } from "./error-context-projection.ts";

export type GatewayMethod = keyof GatewayRpcMethods;
export type GatewayParams<M extends GatewayMethod> = GatewayRpcMethods[M]["params"];
export type GatewayResult<M extends GatewayMethod> = GatewayRpcMethods[M]["result"];
export type GatewayTranscriptItem = GatewayResult<"transcript.load">["items"][number];

interface RpcSchema {
	readonly properties: Readonly<Record<string, unknown>>;
}

const schema = JSON.parse(readFileSync(new URL("../../schemas/gateway-rpc.schema.json", import.meta.url), "utf8")) as RpcSchema;
export const GATEWAY_RPC_METHODS: readonly GatewayMethod[] = Object.freeze(Object.keys(schema.properties) as GatewayMethod[]);
const methods: ReadonlySet<string> = new Set(GATEWAY_RPC_METHODS);
const validators: ReadonlyMap<string, ContractValidator> = new Map(Object.entries(gatewayRpcValidators));

export class GatewayRpcValidationError extends ContractValidationError {
	readonly code: "invalid_params" | "internal_error";

	constructor(readonly method: GatewayMethod, readonly part: "params" | "result") {
		super(`Invalid gateway ${part} for ${method}.`);
		this.name = "GatewayRpcValidationError";
		this.code = part === "params" ? "invalid_params" : "internal_error";
	}
}

export function isGatewayMethod(method: string): method is GatewayMethod {
	return methods.has(method);
}

export function parseGatewayParams<M extends GatewayMethod>(method: M, value: unknown): GatewayParams<M> {
	validate(method, "params", value);
	return value as GatewayParams<M>;
}

export function parseGatewayResult<M extends GatewayMethod>(method: M, value: unknown): GatewayResult<M> {
	value = projectGatewayErrorPayload(method, value, "read");
	validate(method, "result", value);
	if ((method === "provider.attempts.load" || method === "transcript.load") && typeof value === "object" && value !== null) {
		const source = value as Readonly<Record<string, unknown>>;
		const field = method === "provider.attempts.load" ? "records" : "provider_attempts";
		const records = source[field];
		if (Array.isArray(records)) {
			const parsed = records.map(parseProviderAttemptRecord);
			if (parsed.some((record) => record.sessionId !== source.session_id)) {
				throw new GatewayRpcValidationError(method, "result");
			}
			return { ...source, [field]: parsed } as GatewayResult<M>;
		}
	}
	return value as GatewayResult<M>;
}

function validate(method: GatewayMethod, part: "params" | "result", value: unknown): void {
	if (!isGatewayMethod(method)) throw new TypeError("Unknown gateway method.");
	const validator = validators.get(`${method}/${part}`);
	if (!validator) throw new TypeError(`Missing generated gateway validator for ${method} ${part}.`);
	if (!validator(value)) throw new GatewayRpcValidationError(method, part);
}
