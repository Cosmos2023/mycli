import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_IDS } from "@mycli/core";
import {
	inferProviderFromBaseUrl,
	listProviderProfiles,
	resolveProviderProfile,
} from "../../src/index.ts";

test("infers built-in providers from endpoint hosts", () => {
	assert.equal(inferProviderFromBaseUrl("https://api.openai.com/v1"), "openai");
	assert.equal(inferProviderFromBaseUrl("https://region.dashscope.aliyuncs.com/compatible-mode/v1"), "qwen");
	assert.equal(inferProviderFromBaseUrl("https://api.deepseek.com"), "deepseek");
	const curatedHosts = [
		["openrouter", "openrouter.ai", "edge.openrouter.ai"],
		["groq", "api.groq.com", "region.api.groq.com"],
		["together", "api.together.ai", "region.api.together.ai"],
		["moonshotai", "api.moonshot.ai", "region.api.moonshot.ai"],
		["nvidia", "integrate.api.nvidia.com", "region.api.nvidia.com"],
		["cerebras", "api.cerebras.ai", "region.api.cerebras.ai"],
	] as const;
	for (const [provider, exactHost, subdomain] of curatedHosts) {
		assert.equal(inferProviderFromBaseUrl(`https://${exactHost}/v1`), provider);
		assert.equal(inferProviderFromBaseUrl(`https://${subdomain}/v1`), provider);
		assert.equal(inferProviderFromBaseUrl(`https://${exactHost}.example.test/v1`), "compatible");
	}
	assert.equal(inferProviderFromBaseUrl("not a URL"), "compatible");
	assert.equal(inferProviderFromBaseUrl("https://models.example.test/v1"), "compatible");
});

test("lists each supported provider exactly once in canonical order", () => {
	const profiles = listProviderProfiles();
	assert.deepEqual(profiles.map((profile) => profile.provider), PROVIDER_IDS);
	assert.equal(new Set(profiles.map((profile) => profile.provider)).size, PROVIDER_IDS.length);
});

test("resolves curated pi-ai provider profiles", () => {
	const expected = [
		["openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openrouter/auto"],
		["groq", "Groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b"],
		["together", "Together", "https://api.together.ai/v1", "moonshotai/Kimi-K2.7-Code"],
		["moonshotai", "Moonshot AI", "https://api.moonshot.ai/v1", "kimi-k2.7-code"],
		["nvidia", "NVIDIA", "https://integrate.api.nvidia.com/v1", "openai/gpt-oss-120b"],
		["cerebras", "Cerebras", "https://api.cerebras.ai/v1", "gpt-oss-120b"],
	] as const;

	for (const [provider, displayName, defaultBaseUrl, defaultModel] of expected) {
		const profile = resolveProviderProfile(provider);
		assert.equal(profile.displayName, displayName);
		assert.equal(profile.defaultProtocol, "chat_completions");
		assert.equal(profile.defaultBaseUrl, defaultBaseUrl);
		assert.equal(profile.defaultModel, defaultModel);
		assert.deepEqual(Object.keys(profile).sort(), [
			"defaultBaseUrl", "defaultModel", "defaultProtocol", "displayName", "provider",
		].sort());
	}
});

test("rejects uncurated pi-ai provider identities", () => {
	assert.throws(
		() => resolveProviderProfile("google"),
		/config_error: unsupported provider 'google'/,
	);
});

test("leaves protocol serviceability to provider/model resolution", () => {
	assert.equal(resolveProviderProfile("deepseek", "responses").provider, "deepseek");
});

test("resolves the Anthropic Messages profile", () => {
	const profile = resolveProviderProfile("anthropic", "anthropic_messages");

	assert.deepEqual(profile, {
		provider: "anthropic",
		displayName: "Anthropic",
		defaultProtocol: "anthropic_messages",
		defaultBaseUrl: "https://api.anthropic.com",
		defaultModel: "claude-sonnet-4-6",
	});
	assert.equal(inferProviderFromBaseUrl("https://api.anthropic.com"), "anthropic");
});
