import type { ProtocolId, ProviderId } from "@mycli/core";

export interface ProviderProfile {
	readonly provider: ProviderId;
	readonly defaultProtocol: ProtocolId;
	readonly supportsResponses: boolean;
	readonly supportsChatCompletions: boolean;
	readonly supportsAnthropicMessages: boolean;
	readonly supportsImages: boolean;
	readonly supportsHostedWebSearch: boolean;
	readonly defaultBaseUrl: string;
	readonly defaultModel?: string;
	readonly promptCacheKeyEnabled: boolean;
	readonly cacheControlEnabled: boolean;
}

const PROFILES: Readonly<Record<ProviderId, ProviderProfile>> = {
	openai: {
		provider: "openai",
		defaultProtocol: "responses",
		supportsResponses: true,
		supportsChatCompletions: true,
		supportsAnthropicMessages: false,
		supportsImages: true,
		supportsHostedWebSearch: true,
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-5",
		promptCacheKeyEnabled: true,
		cacheControlEnabled: false,
	},
	codex: {
		provider: "codex",
		defaultProtocol: "responses",
		supportsResponses: true,
		supportsChatCompletions: false,
		supportsAnthropicMessages: false,
		supportsImages: true,
		supportsHostedWebSearch: true,
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-5",
		promptCacheKeyEnabled: true,
		cacheControlEnabled: false,
	},
	compatible: {
		provider: "compatible",
		defaultProtocol: "chat_completions",
		supportsResponses: true,
		supportsChatCompletions: true,
		supportsAnthropicMessages: false,
		supportsImages: true,
		supportsHostedWebSearch: false,
		defaultBaseUrl: "https://api.openai.com/v1",
		promptCacheKeyEnabled: true,
		cacheControlEnabled: false,
	},
	qwen: {
		provider: "qwen",
		defaultProtocol: "chat_completions",
		supportsResponses: true,
		supportsChatCompletions: true,
		supportsAnthropicMessages: false,
		supportsImages: true,
		supportsHostedWebSearch: false,
		defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		defaultModel: "qwen3.6-plus",
		promptCacheKeyEnabled: false,
		cacheControlEnabled: false,
	},
	deepseek: {
		provider: "deepseek",
		defaultProtocol: "chat_completions",
		supportsResponses: false,
		supportsChatCompletions: true,
		supportsAnthropicMessages: false,
		supportsImages: false,
		supportsHostedWebSearch: false,
		defaultBaseUrl: "https://api.deepseek.com",
		defaultModel: "deepseek-chat",
		promptCacheKeyEnabled: false,
		cacheControlEnabled: false,
	},
	anthropic: {
		provider: "anthropic",
		defaultProtocol: "anthropic_messages",
		supportsResponses: false,
		supportsChatCompletions: false,
		supportsAnthropicMessages: true,
		supportsImages: true,
		supportsHostedWebSearch: false,
		defaultBaseUrl: "https://api.anthropic.com",
		defaultModel: "claude-sonnet-4-6",
		promptCacheKeyEnabled: false,
		cacheControlEnabled: true,
	},
};

const PROVIDERS = new Set<string>(Object.keys(PROFILES));
const PROTOCOLS = new Set<string>(["responses", "chat_completions", "anthropic_messages"]);
const PROVIDER_ORDER: readonly ProviderId[] = Object.freeze([
	"openai",
	"codex",
	"deepseek",
	"qwen",
	"anthropic",
	"compatible",
]);

export function listProviderProfiles(): readonly ProviderProfile[] {
	return Object.freeze(PROVIDER_ORDER.map((provider) => PROFILES[provider]));
}

export function inferProviderFromBaseUrl(baseUrl: string): ProviderId {
	let hostname = "";
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return "compatible";
	}
	if (hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com")) {
		return "deepseek";
	}
	if (hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".dashscope.aliyuncs.com")) {
		return "qwen";
	}
	if (hostname === "api.openai.com" || hostname.endsWith(".openai.com")) {
		return "openai";
	}
	if (hostname === "api.anthropic.com" || hostname.endsWith(".anthropic.com")) {
		return "anthropic";
	}
	return "compatible";
}

export function resolveProviderProfile(providerValue: string, protocolValue?: string): ProviderProfile {
	if (!PROVIDERS.has(providerValue)) {
		throw new Error(`config_error: unsupported provider '${providerValue}'`);
	}
	const provider = providerValue as ProviderId;
	const profile = PROFILES[provider];
	const protocol = protocolValue ?? profile.defaultProtocol;
	if (!PROTOCOLS.has(protocol)) {
		throw new Error(`config_error: unsupported protocol '${protocol}'`);
	}
	if (protocol === "responses" && !profile.supportsResponses) {
		throw new Error(`config_error: provider '${provider}' does not support protocol 'responses'`);
	}
	if (protocol === "chat_completions" && !profile.supportsChatCompletions) {
		throw new Error(
			`config_error: provider '${provider}' does not support protocol 'chat_completions'`,
		);
	}
	if (protocol === "anthropic_messages" && !profile.supportsAnthropicMessages) {
		throw new Error(
			`config_error: provider '${provider}' does not support protocol 'anthropic_messages'`,
		);
	}
	return profile;
}

export function parseProtocol(value: string): ProtocolId {
	if (!PROTOCOLS.has(value)) {
		throw new Error(`config_error: unsupported protocol '${value}'`);
	}
	return value as ProtocolId;
}
