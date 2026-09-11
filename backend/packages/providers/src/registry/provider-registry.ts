import type { NodeRuntimeConfig } from "@mycli/config";
import { ProviderFailure } from "../errors.ts";
import type { ModelProvider } from "../model-provider.ts";
import { PiAiProvider } from "../pi-ai/pi-ai-provider.ts";
import { mergePiAiCompatOverrides } from "../pi-ai/pi-ai-compat.ts";
import type { ProviderRouteDescriptor } from "./provider-directory-types.ts";
import type { ProviderNativeTransportSnapshot } from "@mycli/core";

export interface ProviderRegistryOptions {
	readonly fetch?: typeof globalThis.fetch;
}

export type ProviderTransportConfig = Pick<
	NodeRuntimeConfig,
	| "apiBaseUrl"
	| "apiKey"
	| "maxOutputTokens"
	| "maxPromptTokens"
	| "model"
	| "modelContextWindowTokens"
	| "protocol"
	| "provider"
	| "supportsImages"
> & Readonly<{
	homeDir?: string;
	authRef?: string;
	providerEnv?: Readonly<Record<string, string>>;
	allowAmbientAuth?: boolean;
	nativeTransport?: ProviderNativeTransportSnapshot;
}>;

export class ProviderRegistry {
	readonly #fetch: typeof globalThis.fetch | undefined;

	constructor(options: ProviderRegistryOptions = {}) {
		this.#fetch = options.fetch;
	}

	create(
		config: ProviderTransportConfig,
		route?: ProviderRouteDescriptor,
	): ModelProvider {
		const apiKey = config.apiKey;
		if (!apiKey && (route?.source === "pi_ai_declared" || (!config.homeDir && !config.allowAmbientAuth))) {
			throw new ProviderFailure({
				code: "auth_error",
				message: "provider API key is not configured",
				errorReason: { reason: "auth.credentials_missing", details: { provider: config.provider } },
				outcome: { state: "not_started", effects: "none" },
			});
		}
		const routeConfig = routeTransportConfig(config, route);
		return new PiAiProvider({
			config: routeConfig,
			...(this.#fetch ? { fetch: this.#fetch } : {}),
		});
	}
}

function routeTransportConfig(
	config: ProviderTransportConfig,
	route: ProviderRouteDescriptor | undefined,
): ProviderTransportConfig & {
	readonly routeSource?: ProviderRouteDescriptor["source"];
	readonly catalogProviderId?: ProviderRouteDescriptor["catalogProviderId"];
	readonly compat?: Readonly<Record<string, unknown>>;
} {
	if (route === undefined) return config;
	if (route.activation !== "active"
		|| route.routeId !== config.provider
		|| route.protocol !== config.protocol
		|| normalizedBaseUrl(route.apiBaseUrl) !== normalizedBaseUrl(config.apiBaseUrl)) {
		throw new ProviderFailure({
			code: "config_error",
			message: "provider route snapshot does not match transport configuration",
		});
	}
	const compat = mergePiAiCompatOverrides(
		config.protocol,
		route.compat,
		route.modelCompat?.[config.model],
	);
	return Object.freeze({
		...config,
		...(route.nativeTransport ? { nativeTransport: route.nativeTransport } : {}),
		routeSource: route.source,
		...(route.catalogProviderId === undefined
			? {}
			: { catalogProviderId: route.catalogProviderId }),
		...(compat === undefined ? {} : { compat }),
	});
}

function normalizedBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/u, "");
}
