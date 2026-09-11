import { parseProviderRouteId, type ProviderRouteId } from "@mycli/core";
import { configError } from "../configuration/config-diagnostics.ts";

export interface ProviderRetryPolicy {
	readonly requestMaxRetries: number;
	readonly streamMaxRetries: number;
}

export interface ProviderRetryPolicyConfig extends ProviderRetryPolicy {
	readonly requestMaxRetriesByProvider?: Readonly<Record<string, number>>;
	readonly streamMaxRetriesByProvider?: Readonly<Record<string, number>>;
}

export function resolveProviderRetryPolicy(
	config: ProviderRetryPolicyConfig,
	provider: ProviderRouteId,
): ProviderRetryPolicy {
	return Object.freeze({
		requestMaxRetries: boundedRetries(ownOverride(config.requestMaxRetriesByProvider, provider)
			?? config.requestMaxRetries),
		streamMaxRetries: boundedRetries(ownOverride(config.streamMaxRetriesByProvider, provider)
			?? config.streamMaxRetries),
	});
}

export function parseProviderRetryOverrides(
	value: unknown,
	keyPath: string,
): Readonly<Record<string, number>> {
	if (value === undefined) return Object.freeze({});
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidOverrides(keyPath);
	}
	const entries = Object.entries(value);
	if (entries.length > 128) throw invalidOverrides(keyPath);
	const result: Record<string, number> = {};
	for (const [provider, retries] of entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
		try {
			parseProviderRouteId(provider);
		} catch {
			throw invalidOverrides(keyPath);
		}
		if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > 100) {
			throw invalidOverrides(keyPath);
		}
		Object.defineProperty(result, provider, { value: retries, enumerable: true });
	}
	return Object.freeze(result);
}

function ownOverride(
	values: Readonly<Record<string, number>> | undefined,
	provider: ProviderRouteId,
): number | undefined {
	return values && Object.hasOwn(values, provider) ? values[provider] : undefined;
}

function boundedRetries(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.trunc(value))) : 0;
}

function invalidOverrides(keyPath: string): Error {
	return configError({
		code: "invalid_value",
		severity: "error",
		keyPath,
		message: "provider retry overrides require at most 128 route identifiers with integer budgets from 0 to 100",
		remediation: "Use a provider route table with bounded retry counts, or remove the setting.",
	});
}
