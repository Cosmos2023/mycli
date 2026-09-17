import type { MycliShellAuthProvider } from "../model.ts";

// Used only before gateway metadata is available. Runtime provider rows take precedence.
export const FALLBACK_OPENAI_MODEL = "gpt-5.5";

export function defaultAuthProviders(): MycliShellAuthProvider[] {
	return [
		{ id: "openai", name: "OpenAI", defaultModel: FALLBACK_OPENAI_MODEL },
		{ id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-chat" },
		{ id: "qwen", name: "Qwen", defaultModel: "qwen3.6-plus" },
		{ id: "anthropic", name: "Anthropic", defaultModel: "claude-sonnet-4-6" },
		{ id: "compatible", name: "Compatible" },
	];
}
