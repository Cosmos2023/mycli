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
