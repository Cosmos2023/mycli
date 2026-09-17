import {
	listProviderProfiles,
	loadModelProviderDeclarations,
	readProviderCredential,
	type NodeRuntimeConfig,
} from "@mycli/config";
import { parseProviderRouteId } from "@mycli/core";
import type { JsonObject } from "@mycli/gateway";
import {
	captureProviderNativeEnvironment,
	inspectNativeProviderAuth,
	loadPiAiProviderEntry,
	type NativeAuthStatus,
} from "@mycli/providers";
import type { NodeGatewayCredentialReadiness } from "./node-gateway.ts";
import { DEFAULT_ACTIVE_CATALOG_PROVIDERS } from "./provider-activation.ts";

// Login readiness needs the selected provider's auth adapter, not all model routes.
export async function providerCredentialReadiness(
	config: NodeRuntimeConfig,
	homeDir: string,
	environment: Readonly<NodeJS.ProcessEnv>,
): Promise<NodeGatewayCredentialReadiness> {
	const stored = await readProviderCredential({ homeDir, authRef: config.authRef });
	const native = !config.apiKey && (stored || config.allowAmbientAuth)
		? await nativeCredentialStatus(config, homeDir, environment) : undefined;
	return Object.freeze({
		ready: Boolean(config.apiKey) || native?.configured === true,
		providerId: config.provider,
		authRef: config.authRef,
		source: config.apiKey
			? environment.MYCLI_API_KEY?.trim() ? "environment" : stored ? "stored" : "legacy_config"
			: native?.source ?? "missing",
	});
}

async function nativeCredentialStatus(
	config: NodeRuntimeConfig,
	homeDir: string,
	environment: Readonly<NodeJS.ProcessEnv>,
): Promise<NativeAuthStatus | undefined> {
	const declaration = (await loadModelProviderDeclarations(homeDir))
		.find((entry) => entry.provider === config.provider);
	if (!config.nativeTransport && declaration?.source === "pi_ai_declared") return undefined;
	const catalogProviderId = config.nativeTransport?.catalogProviderId
		?? declaration?.catalogProvider ?? config.provider;
	const entry = await loadPiAiProviderEntry(catalogProviderId);
	if (!entry?.apiKeyServiceable || !entry.protocols.includes(config.protocol)) return undefined;
	const providerEnv = config.providerEnv ?? await captureProviderNativeEnvironment({ catalogProviderId, environment });
	return inspectNativeProviderAuth({
		provider: catalogProviderId, homeDir, authRef: config.authRef, providerEnv,
		...(config.allowAmbientAuth === undefined ? {} : { allowAmbientAuth: config.allowAmbientAuth }),
	});
}

export async function authProviderPayload(
	config: NodeRuntimeConfig,
	homeDir: string,
	currentCredential: NodeGatewayCredentialReadiness,
): Promise<readonly JsonObject[]> {
	const profiles = listProviderProfiles();
	const declarations = await loadModelProviderDeclarations(homeDir);
	const ids = new Set([
		...profiles.map((profile) => profile.provider),
		...declarations.map((entry) => entry.provider),
		...DEFAULT_ACTIVE_CATALOG_PROVIDERS,
		config.provider,
	]);
	return Promise.all([...ids].map(async (id) => {
		const profile = profiles.find((entry) => entry.provider === id);
		const declaration = declarations.find((entry) => entry.provider === id);
		const authRef = id === config.provider ? config.authRef : declaration?.authRef ?? id;
		const current = id === currentCredential.providerId && authRef === currentCredential.authRef;
		const stored = current ? false : Boolean(await readProviderCredential({ homeDir, authRef }));
		const entry = profile ? undefined : await loadPiAiProviderEntry(declaration?.catalogProvider ?? parseProviderRouteId(id));
		return Object.freeze({
			id, name: profile?.displayName ?? entry?.name ?? id,
			configured: current ? currentCredential.ready : stored,
			credential_source: current ? currentCredential.source : stored ? "stored" : "missing",
			auth_ref: authRef,
			...(profile?.defaultModel ? { default_model: profile.defaultModel } : {}),
		});
	}));
}
