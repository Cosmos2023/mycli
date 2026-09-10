import {
	PROVIDER_NATIVE_APIS,
	parseProviderNativeTransportSnapshot,
	providerNativeEndpointSha256,
	providerNativeProtocol,
} from "@mycli/core";
import type { ProtocolId, ProviderNativeApi, ProviderNativeTransportSnapshot, ProviderRouteId } from "@mycli/core";
import { ProviderFailure } from "../errors.ts";
import { loadPiAiBuiltinProvider } from "./provider-directory.ts";

export interface ResolveProviderNativeTransportInput {
	readonly catalogProviderId: ProviderRouteId;
	readonly modelId: string;
	readonly protocol: ProtocolId;
	readonly apiBaseUrl: string;
	readonly azure?: ProviderNativeTransportSnapshot["azure"];
	readonly allowDeclaredModel?: boolean;
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

export async function captureProviderNativeEnvironment(input: Readonly<{
	catalogProviderId: ProviderRouteId;
	environment: Readonly<Record<string, string | undefined>>;
	apiKey?: string;
}>): Promise<Readonly<Record<string, string>>> {
	const provider = await loadPiAiBuiltinProvider(input.catalogProviderId);
	if (!provider || !provider.getModels().some((model) => PROVIDER_NATIVE_APIS.includes(model.api as ProviderNativeApi))) {
		throw unavailable("native provider environment is unsupported");
	}
	const captured: Record<string, string> = {};
	await provider.auth.apiKey?.resolve({
		ctx: {
			env: async (name) => {
				const value = input.environment[name];
				if (value === undefined) return undefined;
				if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) || value.length > 16_384 || value.includes("\0")) {
					throw unavailable("native provider environment is invalid");
				}
				captured[name] = value;
				return value;
			},
			fileExists: async () => false,
		},
		...(input.apiKey ? { credential: { type: "api_key", key: input.apiKey } } : {}),
		signal: new AbortController().signal,
	});
	return Object.freeze(captured);
}

export async function resolveProviderNativeTransport(
	input: ResolveProviderNativeTransportInput,
): Promise<ProviderNativeTransportSnapshot> {
	const provider = await loadPiAiBuiltinProvider(input.catalogProviderId);
	const models = provider?.getModels() ?? [];
	const model = models.find((candidate) => candidate.id === input.modelId);
	const supportedApis = [...new Set(models.flatMap((candidate) =>
		PROVIDER_NATIVE_APIS.includes(candidate.api as ProviderNativeApi)
			&& providerNativeProtocol(candidate.api as ProviderNativeApi) === input.protocol ? [candidate.api as ProviderNativeApi] : []))];
	const api = model?.api ?? (input.allowDeclaredModel && supportedApis.length === 1 ? supportedApis[0] : undefined);
	if (!provider || api === undefined || !PROVIDER_NATIVE_APIS.includes(api as ProviderNativeApi)) {
		throw unavailable("native provider model or API is unsupported");
	}
	if (providerNativeProtocol(api as ProviderNativeApi) !== input.protocol) throw unavailable("native model API does not match configured protocol");
	try {
		return parseProviderNativeTransportSnapshot({ version: 1, catalogProviderId: input.catalogProviderId,
			modelId: input.modelId, modelSource: model ? "catalog" : "declared", api, endpointSha256: providerNativeEndpointSha256(input.apiBaseUrl),
			...(api === "azure-openai-responses" ? { azure: input.azure ?? azureConfiguration(input.modelId, input.environment ?? {}) } : {}),
		});
	} catch { throw unavailable("native provider configuration is invalid"); }
}

function azureConfiguration(modelId: string, environment: Readonly<Record<string, string | undefined>>): NonNullable<ProviderNativeTransportSnapshot["azure"]> {
	const map = new Map<string, string>();
	const setting = environment.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
	if (setting !== undefined) {
		if (setting.length > 16_384) throw unavailable("Azure deployment mapping is invalid");
		for (const entry of setting.split(",")) {
			if (!entry.trim()) continue;
			const parts = entry.split("=");
			const key = parts[0]?.trim();
			const value = parts[1]?.trim();
			if (parts.length !== 2 || !key || !value || map.has(key)) throw unavailable("Azure deployment mapping is invalid");
			map.set(key, value);
		}
	}
	return { apiVersion: environment.AZURE_OPENAI_API_VERSION ?? "v1", deploymentName: map.get(modelId) ?? modelId };
}

function unavailable(message: string): ProviderFailure {
	return new ProviderFailure({ code: "config_error", message });
}
