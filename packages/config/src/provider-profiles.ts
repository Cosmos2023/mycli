import type { ProtocolId, ProviderId } from "@mycli/core";

export interface ProviderProfile {
	readonly provider: ProviderId;
	readonly defaultProtocol: ProtocolId;
	readonly supportsResponses: boolean;
	readonly supportsChatCompletions: boolean;
	readonly defaultBaseUrl: string;
	readonly defaultModel?: string;
	readonly promptCacheKeyEnabled: boolean;
}

const PROFILES: Readonly<Record<ProviderId, ProviderProfile>> = {
	openai: {
		provider: "openai",
		defaultProtocol: "responses",
		supportsResponses: true,
		supportsChatCompletions: true,
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-5",
		promptCacheKeyEnabled: true,
	},
	codex: {
		provider: "codex",
		defaultProtocol: "responses",
		supportsResponses: true,
		supportsChatCompletions: false,
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-5",
		promptCacheKeyEnabled: true,
	},
	compatible: {
		provider: "compatible",
		defaultProtocol: "chat_completions",
		supportsResponses: true,
		supportsChatCompletions: true,
		defaultBaseUrl: "https://api.openai.com/v1",
		promptCacheKeyEnabled: true,
	},
	qwen: {
		provider: "qwen",
		defaultProtocol: "chat_completions",
		supportsResponses: true,
		supportsChatCompletions: true,
		defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		defaultModel: "qwen3.6-plus",
		promptCacheKeyEnabled: false,
	},
	deepseek: {
		provider: "deepseek",
		defaultProtocol: "chat_completions",
		supportsResponses: false,
		supportsChatCompletions: true,
		defaultBaseUrl: "https://api.deepseek.com",
		defaultModel: "deepseek-chat",
		promptCacheKeyEnabled: false,
	},
};

const PROVIDERS = new Set<string>(Object.keys(PROFILES));
const PROTOCOLS = new Set<string>(["responses", "chat_completions"]);

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
	return profile;
}

export function parseProtocol(value: string): ProtocolId {
	if (!PROTOCOLS.has(value)) {
		throw new Error(`config_error: unsupported protocol '${value}'`);
	}
	return value as ProtocolId;
}
