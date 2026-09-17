import { PROVIDER_IDS, type ProtocolId, type ProviderId } from "@mycli/core";

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

export interface ProviderProfile {
	readonly provider: ProviderId;
	readonly displayName: string;
	readonly defaultProtocol: ProtocolId;
	readonly defaultBaseUrl: string;
	readonly defaultModel?: string;
}

const PROFILES: Readonly<Record<ProviderId, ProviderProfile>> = {
	openai: {
		provider: "openai",
		displayName: "OpenAI",
		defaultProtocol: "responses",
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: DEFAULT_OPENAI_MODEL,
	},
	codex: {
		provider: "codex",
		displayName: "OpenAI Codex",
		defaultProtocol: "responses",
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: DEFAULT_OPENAI_MODEL,
	},
	compatible: {
		provider: "compatible",
		displayName: "OpenAI Compatible",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://api.openai.com/v1",
	},
	qwen: {
		provider: "qwen",
		displayName: "Qwen",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		defaultModel: "qwen3.6-plus",
	},
	deepseek: {
		provider: "deepseek",
		displayName: "DeepSeek",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://api.deepseek.com",
		defaultModel: "deepseek-chat",
	},
	anthropic: {
		provider: "anthropic",
		displayName: "Anthropic",
		defaultProtocol: "anthropic_messages",
		defaultBaseUrl: "https://api.anthropic.com",
		defaultModel: "claude-sonnet-4-6",
	},
	openrouter: {
		provider: "openrouter",
		displayName: "OpenRouter",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		defaultModel: "openrouter/auto",
	},
	groq: {
		provider: "groq",
		displayName: "Groq",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://api.groq.com/openai/v1",
		defaultModel: "openai/gpt-oss-120b",
	},
	together: {
		provider: "together",
		displayName: "Together",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://api.together.ai/v1",
		defaultModel: "moonshotai/Kimi-K2.7-Code",
	},
	moonshotai: {
		provider: "moonshotai",
		displayName: "Moonshot AI",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://api.moonshot.ai/v1",
		defaultModel: "kimi-k2.7-code",
	},
	nvidia: {
		provider: "nvidia",
		displayName: "NVIDIA",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
		defaultModel: "openai/gpt-oss-120b",
	},
	cerebras: {
		provider: "cerebras",
		displayName: "Cerebras",
		defaultProtocol: "chat_completions",
		defaultBaseUrl: "https://api.cerebras.ai/v1",
		defaultModel: "gpt-oss-120b",
	},
};

const PROVIDERS = new Set<string>(PROVIDER_IDS);
const PROTOCOLS = new Set<string>(["responses", "chat_completions", "anthropic_messages"]);

export function listProviderProfiles(): readonly ProviderProfile[] {
	return Object.freeze(PROVIDER_IDS.map((provider) => PROFILES[provider]));
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
	if (hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")) {
		return "openrouter";
	}
	if (hostname === "api.groq.com" || hostname.endsWith(".groq.com")) {
		return "groq";
	}
	if (hostname === "api.together.ai" || hostname.endsWith(".together.ai")) {
		return "together";
	}
	if (hostname === "api.moonshot.ai" || hostname.endsWith(".moonshot.ai")) {
		return "moonshotai";
	}
	if (hostname === "integrate.api.nvidia.com" || hostname.endsWith(".api.nvidia.com")) {
		return "nvidia";
	}
	if (hostname === "api.cerebras.ai" || hostname.endsWith(".cerebras.ai")) {
		return "cerebras";
	}
	return "compatible";
}

export function resolveProviderProfile(providerValue: string, protocolValue?: string): ProviderProfile {
	if (!PROVIDERS.has(providerValue)) {
		throw new Error(`config_error: unsupported provider '${providerValue}'`);
	}
	const provider = providerValue as ProviderId;
	const profile = PROFILES[provider];
	parseProtocol(protocolValue ?? profile.defaultProtocol);
	return profile;
}

export function parseProtocol(value: string): ProtocolId {
	if (!PROTOCOLS.has(value)) {
		throw new Error(`config_error: unsupported protocol '${value}'`);
	}
	return value as ProtocolId;
}
