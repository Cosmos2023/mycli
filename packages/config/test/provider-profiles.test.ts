import assert from "node:assert/strict";
import test from "node:test";
import { inferProviderFromBaseUrl, resolveProviderProfile } from "../src/index.ts";

test("infers built-in providers from endpoint hosts", () => {
	assert.equal(inferProviderFromBaseUrl("https://api.openai.com/v1"), "openai");
	assert.equal(inferProviderFromBaseUrl("https://region.dashscope.aliyuncs.com/compatible-mode/v1"), "qwen");
	assert.equal(inferProviderFromBaseUrl("https://api.deepseek.com"), "deepseek");
	assert.equal(inferProviderFromBaseUrl("https://models.example.test/v1"), "compatible");
});

test("rejects a protocol unsupported by the selected provider", () => {
	assert.throws(
		() => resolveProviderProfile("deepseek", "responses"),
		/config_error: provider 'deepseek' does not support protocol 'responses'/,
	);
});

test("resolves the Anthropic Messages profile", () => {
	const profile = resolveProviderProfile("anthropic", "anthropic_messages");

	assert.deepEqual(profile, {
		provider: "anthropic",
		defaultProtocol: "anthropic_messages",
		supportsResponses: false,
		supportsChatCompletions: false,
		supportsAnthropicMessages: true,
		defaultBaseUrl: "https://api.anthropic.com",
		defaultModel: "claude-sonnet-4-6",
		promptCacheKeyEnabled: false,
		cacheControlEnabled: true,
	});
	assert.equal(inferProviderFromBaseUrl("https://api.anthropic.com"), "anthropic");
});
