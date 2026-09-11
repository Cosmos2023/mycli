import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { CreateModelsOptions, Credential, CredentialStore, Models, Provider, ProviderAuth } from "@earendil-works/pi-ai";
import { deleteApiKey, modifyProviderCredential, parseProviderCredential, readProviderCredential } from "@mycli/config";
import type { CredentialJsonValue, ProviderCredential } from "@mycli/config";
import { providerNativeEndpointSha256, type ProviderNativeTransportSnapshot } from "@mycli/core";
import { ProviderFailure } from "../errors.ts";

interface PiAiAuthConfig {
	readonly provider: string;
	readonly homeDir?: string;
	readonly authRef?: string;
	readonly providerEnv?: Readonly<Record<string, string>>;
	readonly allowAmbientAuth?: boolean;
	readonly nativeTransport?: ProviderNativeTransportSnapshot;
}

export function createPiAiModelsAuth(
	config: PiAiAuthConfig,
	onFailure?: () => void,
): Pick<CreateModelsOptions, "credentials" | "authContext"> {
	const environment = Object.freeze({ ...(config.providerEnv ?? (config.allowAmbientAuth ? process.env : {})) });
	return {
		...(config.homeDir ? { credentials: credentialStore(config, onFailure) } : {}),
		authContext: {
			env: async (name) => config.allowAmbientAuth ? environment[name] : undefined,
			fileExists: async (path) => {
				if (!config.allowAmbientAuth) return false;
				try { await access(path.startsWith("~/") ? join(config.homeDir ?? homedir(), path.slice(2)) : path); return true; }
				catch { return false; }
			},
		},
	};
}

export function createPiAiRequestModels(
	provider: Provider,
	config: PiAiAuthConfig,
	onFailure: (failure?: ProviderFailure) => void,
): Models {
	const authOptions = createPiAiModelsAuth({
		...config, provider: provider.id, authRef: config.authRef ?? config.provider,
	}, onFailure);
	const credentials = authOptions.credentials;
	const models = createModels({ ...authOptions, ...(credentials ? { credentials: {
		...credentials,
		read: async (id, operation) => {
			const credential = await credentials.read(id, operation);
			if ((!credential && (!provider.auth.apiKey || config.allowAmbientAuth === false))
				|| (credential?.type === "oauth" && !provider.auth.oauth)
				|| (credential?.type === "api_key" && !provider.auth.apiKey)) { onFailure(); throw piAiAuthFailure(); }
			if (provider.filterModels && !provider.filterModels(provider.getModels(), credential).length) {
				const failure = new ProviderFailure({ code: "permission_denied", message: "provider account cannot access the selected model",
					errorReason: { reason: "auth.model_access_denied", details: { provider: provider.id } },
					outcome: { state: "not_started", effects: "none" },
				});
				onFailure(failure);
				throw failure;
			}
			return credential;
		},
	} } : {}) });
	models.setProvider({ ...provider, auth: observedAuth(provider.auth, config, onFailure) });
	return models;
}

export function piAiAuthFailure(): ProviderFailure {
	return new ProviderFailure({
		code: "auth_error", message: "provider authentication could not be resolved",
		publicDetail: "Provider credentials are missing, invalid, or could not be refreshed.",
		diagnostics: { error_source: "authentication" },
	});
}

function observedAuth(auth: ProviderAuth, config: PiAiAuthConfig, onFailure: (failure?: ProviderFailure) => void): ProviderAuth {
	function validateEndpoint(baseUrl: string | undefined): void {
		if (baseUrl && config.nativeTransport && providerNativeEndpointSha256(baseUrl) !== config.nativeTransport.endpointSha256) {
			const failure = new ProviderFailure({ code: "config_error", message: "provider authentication changed the committed endpoint",
				publicDetail: "The provider account endpoint differs from this model route. Select its configured endpoint before retrying." });
			onFailure(failure);
			throw failure;
		}
	}
	return {
		...(auth.apiKey ? { apiKey: {
			...auth.apiKey,
			resolve: async (input) => {
				try {
					const result = await auth.apiKey!.resolve(input);
					if (!result) onFailure();
					validateEndpoint(result?.auth.baseUrl);
					return result;
				} catch (error) { onFailure(); throw error; }
			},
		} } : {}),
		...(auth.oauth ? { oauth: {
			...auth.oauth,
			refresh: async (credential, signal) => {
				try { return await auth.oauth!.refresh(credential, signal); }
				catch (error) { onFailure(); throw error; }
			},
			toAuth: async (credential) => {
				try {
					const result = await auth.oauth!.toAuth(credential);
					validateEndpoint(result.baseUrl);
					return result;
				}
				catch (error) { onFailure(); throw error; }
			},
		} } : {}),
	};
}

function credentialStore(config: PiAiAuthConfig, onFailure?: () => void): CredentialStore {
	const options = { homeDir: config.homeDir!, authRef: config.authRef ?? config.provider };
	function providerId(value: string): void {
		if (value !== config.provider) { onFailure?.(); throw piAiAuthFailure(); }
	}
	return {
		read: async (id, operation) => {
			providerId(id);
			try {
				const credential = await readProviderCredential({ ...options, ...operation });
				return credential ? toPiAiCredential(credential) : undefined;
			} catch (error) { onFailure?.(); throw error; }
		},
		list: async (operation) => {
			const credential = await readProviderCredential({ ...options, ...operation });
			return credential ? [{ providerId: config.provider, type: credential.type }] : [];
		},
		modify: async (id, update, operation) => {
			providerId(id);
			try {
				const result = await modifyProviderCredential({ ...options, ...operation }, async (current) => {
					const next = await update(current ? toPiAiCredential(current) : undefined);
					return next ? fromPiAiCredential(next) : undefined;
				});
				return result ? toPiAiCredential(result) : undefined;
			} catch (error) { onFailure?.(); throw error; }
		},
		delete: async (id, operation) => { providerId(id); await deleteApiKey({ ...options, ...operation }); },
	};
}

function toPiAiCredential(credential: ProviderCredential): Credential {
	if (credential.type === "api_key") return { ...credential, ...(credential.env ? { env: { ...credential.env } } : {}) };
	return { ...credential.metadata, type: "oauth", access: credential.access, refresh: credential.refresh, expires: credential.expires };
}

function fromPiAiCredential(credential: Credential): ProviderCredential {
	if (credential.type === "api_key") return parseProviderCredential(credential);
	const { type, access: token, refresh, expires, ...metadata } = credential;
	return parseProviderCredential({ type, access: token, refresh, expires, metadata: metadata as Readonly<Record<string, CredentialJsonValue>> });
}
