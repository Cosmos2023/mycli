import type { AuthEvent, AuthPrompt, Provider } from "@earendil-works/pi-ai";
import { parseProviderRouteId, type ProviderRouteId } from "@mycli/core";
import { sanitizeRuntimeErrorDetail } from "@mycli/contracts";
import { readProviderCredential } from "@mycli/config";
import { ProviderFailure } from "../errors.ts";
import { createPiAiModelsAuth } from "../pi-ai/pi-ai-auth.ts";
import { loadPiAiRoot, type PiAiRoot } from "../pi-ai/pi-ai-module.ts";
import { loadPiAiBuiltinProvider, loadPiAiProviderEntry } from "../registry/provider-directory.ts";

export type NativeAuthPrompt = {
	readonly signal?: AbortSignal;
} & (
	| { readonly type: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
	| { readonly type: "select"; readonly message: string; readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[] }
);

export type NativeAuthEvent =
	| { readonly type: "info" | "progress"; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
	| { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
	| { readonly type: "device_code"; readonly userCode: string; readonly verificationUri: string };

export interface NativeAuthInteraction {
	prompt(prompt: NativeAuthPrompt): Promise<string>;
	notify(event: NativeAuthEvent): void;
}

export interface NativeAuthTarget {
	readonly provider: string;
	readonly homeDir: string;
	readonly authRef: string;
	readonly providerEnv?: Readonly<Record<string, string>>;
	readonly allowAmbientAuth?: boolean;
	readonly signal?: AbortSignal;
}

export interface NativeAuthStatus {
	readonly configured: boolean;
	readonly source: "stored" | "environment" | "missing";
	readonly credentialType?: "api_key" | "oauth";
}

interface NativeProviderAuthOperations {
	login(interaction: NativeAuthInteraction): Promise<NativeAuthStatus>;
	status(): Promise<NativeAuthStatus>;
	logout(): Promise<void>;
}

export async function loginNativeProvider(input: NativeAuthTarget & { readonly interaction: NativeAuthInteraction }): Promise<NativeAuthStatus> {
	return (await operations(input)).login(input.interaction);
}

export async function inspectNativeProviderAuth(input: NativeAuthTarget): Promise<NativeAuthStatus> {
	return (await operations(input)).status();
}

// Package-internal injection boundary: SDK provider types do not cross the public exports.
export function createNativeProviderAuthOperations(
	piAi: Pick<PiAiRoot, "createModels">,
	provider: Provider,
	input: NativeAuthTarget,
): NativeProviderAuthOperations {
	const models = piAi.createModels({
		...createPiAiModelsAuth({ ...input, provider: provider.id }),
	});
	models.setProvider({
		...provider,
		auth: {
			...provider.auth,
			...(provider.auth.apiKey ? { apiKey: {
				...provider.auth.apiKey,
				check: provider.auth.apiKey.check ?? (async (options) => {
					if (options.credential) return { type: "api_key" as const, source: "stored" };
					if (!input.allowAmbientAuth) return undefined;
					const resolved = await provider.auth.apiKey!.resolve(options);
					return resolved ? { type: "api_key" as const, source: resolved.source } : undefined;
				}),
			} } : {}),
		},
	});
	const signal = input.signal ?? new AbortController().signal;
	const status = async (): Promise<NativeAuthStatus> => {
		const checked = await models.checkAuth(provider.id, { signal });
		const stored = checked ? await readProviderCredential(input) : undefined;
		return Object.freeze({ configured: checked !== undefined, source: checked ? stored ? "stored" : "environment" : "missing",
			...(checked ? { credentialType: checked.type } : {}) });
	};
	return {
		status,
		login: async (interaction) => {
			signal.throwIfAborted();
			if (!provider.auth.oauth) throw unavailable();
			await models.login(provider.id, "oauth", {
				signal,
				prompt: async (prompt) => {
					const answer = await interaction.prompt(normalizePrompt(prompt));
					if (typeof answer !== "string" || answer.length > 16 * 1024 || answer.includes("\0")) throw unavailable();
					return answer;
				},
				notify: (event) => interaction.notify(normalizeEvent(event)),
			});
			return status();
		},
		logout: async () => models.logout(provider.id, { signal }),
	};
}

async function operations(input: NativeAuthTarget): Promise<NativeProviderAuthOperations> {
	input.signal?.throwIfAborted();
	let id: ProviderRouteId;
	try { id = parseProviderRouteId(input.provider); } catch { throw unavailable(); }
	const entry = await loadPiAiProviderEntry(id);
	if (!entry || entry.status === "unsupported") throw unavailable();
	const provider = await loadPiAiBuiltinProvider(id);
	if (!provider) throw unavailable();
	return createNativeProviderAuthOperations(await loadPiAiRoot(), provider, input);
}

function normalizePrompt(prompt: AuthPrompt): NativeAuthPrompt {
	const common = { message: safeText(prompt.message), ...(prompt.signal ? { signal: prompt.signal } : {}) };
	if (prompt.type === "select") {
		if (prompt.options.length < 1 || prompt.options.length > 32) throw unavailable();
		return Object.freeze({ ...common, type: "select", options: Object.freeze(prompt.options.map((option) => Object.freeze({
			id: plainText(option.id, 256), label: safeText(option.label), ...(option.description ? { description: safeText(option.description) } : {}),
		}))) });
	}
	return Object.freeze({ ...common, type: prompt.type, ...(prompt.placeholder ? { placeholder: safeText(prompt.placeholder) } : {}) });
}

function normalizeEvent(event: AuthEvent): NativeAuthEvent {
	if (event.type === "auth_url") return Object.freeze({ type: event.type, url: authUrl(event.url), ...(event.instructions ? { instructions: safeText(event.instructions) } : {}) });
	if (event.type === "device_code") return Object.freeze({ type: event.type, userCode: plainText(event.userCode, 128), verificationUri: authUrl(event.verificationUri) });
	return Object.freeze({ type: event.type, message: safeText(event.message), ...("links" in event && event.links ? {
		links: Object.freeze(event.links.slice(0, 8).map((link) => Object.freeze({ url: authUrl(link.url), ...(link.label ? { label: safeText(link.label) } : {}) }))),
	} : {}) });
}

function authUrl(value: string): string {
	const text = plainText(value, 8192);
	let url: URL;
	try { url = new URL(text); } catch { throw unavailable(); }
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw unavailable();
	return url.toString();
}

function safeText(value: string): string {
	if (!value || value.length > 2048 || [...value].some((character) => {
		const code = character.charCodeAt(0);
		return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
	})) throw unavailable();
	return sanitizeRuntimeErrorDetail(value) ?? "Provider authentication";
}

function plainText(value: string, limit: number): string {
	if (!value || value.length > limit || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw unavailable();
	return value;
}

function unavailable(): ProviderFailure {
	return new ProviderFailure({ code: "unsupported_capability", message: "native provider authentication is unavailable",
		errorReason: { reason: "capability.auth_flow_unavailable" }, outcome: { state: "not_started", effects: "none" },
	});
}
