import assert from "node:assert/strict";
import test from "node:test";
import { ProviderFailure } from "../../src/errors.ts";
import {
	mergePiAiCompatOverrides,
	validatePiAiCompatOverride,
} from "../../src/pi-ai/pi-ai-compat.ts";

test("validates and freezes API-specific pi-ai compat overrides", () => {
	const chat = validatePiAiCompatOverride("chat_completions", {
		supportsDeveloperRole: false,
		maxTokensField: "max_tokens",
		vllmPriority: -2,
		thinkingFormat: "chat-template",
		chatTemplateKwargs: {
			enable_thinking: { $var: "thinking.enabled", omitWhenOff: true },
			top_k: 20,
		},
		openRouterRouting: {
			allow_fallbacks: false,
			order: ["first", "second"],
			max_price: { prompt: "0.25", completion: 1 },
		},
	});
	assert.deepEqual(chat, {
		supportsDeveloperRole: false,
		maxTokensField: "max_tokens",
		vllmPriority: -2,
		thinkingFormat: "chat-template",
		chatTemplateKwargs: {
			enable_thinking: { $var: "thinking.enabled", omitWhenOff: true },
			top_k: 20,
		},
		openRouterRouting: {
			allow_fallbacks: false,
			order: ["first", "second"],
			max_price: { prompt: "0.25", completion: 1 },
		},
	});
	assert(chat);
	assert(Object.isFrozen(chat));
	assert(Object.isFrozen(chat.chatTemplateKwargs));
	assert(Object.isFrozen(chat.openRouterRouting));
	assert(Object.isFrozen(
		(chat.openRouterRouting as Readonly<Record<string, unknown>>).order,
	));

	assert.deepEqual(validatePiAiCompatOverride("responses", {
		supportsDeveloperRole: false,
		sessionAffinityFormat: "openai-nosession",
		supportsExplicitPromptCacheMode: true,
		supportsMaxOutputTokens: false,
	}), {
		supportsDeveloperRole: false,
		sessionAffinityFormat: "openai-nosession",
		supportsExplicitPromptCacheMode: true,
		supportsMaxOutputTokens: false,
	});
	assert.deepEqual(validatePiAiCompatOverride("anthropic_messages", {
		supportsLongCacheRetention: false,
		sendSessionAffinityHeaders: true,
		supportsStrictTools: true,
		supportsMidConvoEffort: true,
	}), {
		supportsLongCacheRetention: false,
		sendSessionAffinityHeaders: true,
		supportsStrictTools: true,
		supportsMidConvoEffort: true,
	});
});

test("rejects cross-API fields and invalid nested compat values", () => {
	for (const [protocol, value] of [
		["responses", { thinkingFormat: "deepseek" }],
		["responses", { supportsMaxOutputTokens: "false" }],
		["responses", { vllmPriority: 0 }],
		["anthropic_messages", { supportsMidConvoEffort: 1 }],
		["chat_completions", { supportsMidConvoEffort: true }],
		["chat_completions", { supportsMaxOutputTokens: false }],
		["chat_completions", { vllmPriority: 0.5 }],
		["chat_completions", { vllmPriority: Infinity }],
		["chat_completions", { vllmPriority: Number.MAX_SAFE_INTEGER + 1 }],
		["chat_completions", { vllmPriority: "1" }],
		["anthropic_messages", { maxTokensField: "max_tokens" }],
		["chat_completions", { supportsTemperature: false }],
		["chat_completions", { supportsStore: "yes" }],
		["chat_completions", { maxTokensField: "max_output_tokens" }],
		["chat_completions", { chatTemplateKwargs: { thinking: { $var: "unknown" } } }],
		["chat_completions", { openRouterRouting: { secret_extension: true } }],
		["chat_completions", { openRouterRouting: { order: ["first", 2] } }],
		["chat_completions", { vercelGatewayRouting: { only: "first" } }],
	] as const) {
		assert.throws(
			() => validatePiAiCompatOverride(protocol, value),
			(error: unknown) => error instanceof ProviderFailure && error.code === "config_error",
		);
	}
});

test("merges model compat over route compat over pi-ai defaults", () => {
	const merged = mergePiAiCompatOverrides(
		"chat_completions",
		{ supportsDeveloperRole: false, maxTokensField: "max_tokens" },
		{ supportsDeveloperRole: true, supportsStore: false },
	);
	assert.deepEqual(merged, {
		supportsDeveloperRole: true,
		maxTokensField: "max_tokens",
		supportsStore: false,
	});
	assert(merged);
	assert(Object.isFrozen(merged));
});
