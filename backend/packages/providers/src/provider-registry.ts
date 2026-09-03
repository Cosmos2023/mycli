import type { NodeRuntimeConfig } from "@mycli/config";
import { ProviderFailure } from "./errors.ts";
import type { ModelProvider } from "./model-provider.ts";
import { PiAiProvider } from "./pi-ai-provider.ts";
import { mergePiAiCompatOverrides } from "./pi-ai-compat.ts";
import type { ProviderRouteDescriptor } from "./provider-directory-types.ts";

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
>;

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
		if (!apiKey) {
			throw new ProviderFailure({
				code: "auth_error",
				message: "provider API key is not configured",
			});
		}
		const routeConfig = routeTransportConfig({ ...config, apiKey }, route);
		return new PiAiProvider({
			config: routeConfig,
			...(this.#fetch ? { fetch: this.#fetch } : {}),
		});
	}
}

function routeTransportConfig(
	config: ProviderTransportConfig & { readonly apiKey: string },
	route: ProviderRouteDescriptor | undefined,
): ProviderTransportConfig & {
	readonly apiKey: string;
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
