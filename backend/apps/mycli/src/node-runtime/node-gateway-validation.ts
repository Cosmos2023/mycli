import { GatewayFailure } from "./node-gateway-errors.ts";

export function requiredBoundedString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) {
		throw new GatewayFailure("invalid_params", `${name} must be a non-empty string.`);
	}
	return value;
}

export function optionalBoundedIdentity(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > 512 || value.includes("\0")) {
		throw new GatewayFailure("invalid_params", `${name} must be a bounded string.`);
	}
	return value;
}

export function requiredTrimmedString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new GatewayFailure("invalid_params", `${name} is required.`);
	}
	return value;
}
