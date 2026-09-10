import assert from "node:assert/strict";
import test from "node:test";
import { loadPiAiProviderDirectory } from "../../src/registry/provider-directory.ts";

test("loads one immutable sanitized pi-ai provider directory snapshot", async () => {
	const first = loadPiAiProviderDirectory();
	const second = loadPiAiProviderDirectory();
	assert.strictEqual(first, second);

	const directory = await first;
	assert(Object.isFrozen(directory));
	assert(Object.isFrozen(directory.providers));
	assert(directory.providers.length >= 40);
	assert.equal(typeof directory.generatedAt, "number");

	const openai = requiredProvider(directory.providers, "openai");
	assert.equal(openai.status, "serviceable");
	assert.deepEqual(openai.protocols, ["responses"]);
	assert.equal(openai.apiKeyServiceable, true);
	assert.equal(openai.endpointRequired, false);
	assert(openai.models.length > 0);
	assert(openai.models.every((model) => model.protocol === "responses"));
	assert(Object.isFrozen(openai));
	assert(Object.isFrozen(openai.models));

	const serialized = JSON.stringify(directory);
	for (const forbidden of ["auth", "headers", "cost", "apiKey", "oauth"]) {
		assert(!serialized.includes(`"${forbidden}"`), forbidden);
	}
});

test("classifies supported, configurable, and unsupported catalog providers", async () => {
	const directory = await loadPiAiProviderDirectory();

	const deepseek = requiredProvider(directory.providers, "deepseek");
	assert.equal(deepseek.status, "serviceable");
	assert.deepEqual(deepseek.protocols, ["chat_completions"]);
	for (const modelId of [
		"deepseek-v4-flash",
		"deepseek-v4-flash-vision-exp",
		"deepseek-v4-pro",
	]) {
		assert(deepseek.models.some((model) => model.id === modelId), modelId);
	}
	const vision = deepseek.models.find((model) => model.id === "deepseek-v4-flash-vision-exp");
	assert(vision);
	assert.deepEqual(vision.input, ["text", "image"]);
	assert.deepEqual(vision.reasoningEfforts, ["low", "high", "max"]);
	assert.equal(vision.contextWindowTokens, 1_000_000);
	assert.equal(vision.maxOutputTokens, 384_000);

	const mixed = requiredProvider(directory.providers, "cloudflare-ai-gateway");
	assert.equal(mixed.status, "configuration_required");
	assert.equal(mixed.endpointRequired, true);
	assert.deepEqual(mixed.protocols, [
		"responses",
		"chat_completions",
		"anthropic_messages",
	]);

	const google = requiredProvider(directory.providers, "google");
	assert.equal(google.status, "unsupported");
	assert.equal(google.disabledReason, "unsupported_protocol");
	assert.deepEqual(google.models, []);

	const codex = requiredProvider(directory.providers, "openai-codex");
	assert.equal(codex.status, "unsupported");
	assert.equal(codex.disabledReason, "unsupported_auth");
	assert.equal(codex.apiKeyServiceable, false);

	const radius = requiredProvider(directory.providers, "radius");
	assert.equal(radius.status, "unsupported");
	assert.equal(radius.disabledReason, "no_supported_models");
});

test("keeps pi-ai wire compatibility private to provider construction", async () => {
	const directory = await loadPiAiProviderDirectory();
	const deepseek = requiredProvider(directory.providers, "deepseek");
	const reasoner = deepseek.models.find((model) => model.id === "deepseek-v4-flash");
	assert(reasoner);
	assert(!Object.hasOwn(reasoner, "compatibility"));
	assert.deepEqual(reasoner.reasoningEfforts, ["low", "high", "max"]);

	const nvidia = requiredProvider(directory.providers, "nvidia");
	const nvidiaReasoner = nvidia.models.find((model) => model.id === "openai/gpt-oss-120b");
	assert(nvidiaReasoner);
	assert.deepEqual(nvidiaReasoner.reasoningEfforts, ["minimal", "low", "medium", "high"]);

	const together = requiredProvider(directory.providers, "together");
	const togetherReasoner = together.models.find(
		(model) => model.id === "moonshotai/Kimi-K2.7-Code",
	);
	assert(togetherReasoner);
	assert.deepEqual(togetherReasoner.reasoningEfforts, ["high"]);
});

function requiredProvider(
	providers: Awaited<ReturnType<typeof loadPiAiProviderDirectory>>["providers"],
	providerId: string,
) {
	const provider = providers.find((candidate) => candidate.catalogProviderId === providerId);
	assert(provider, `missing provider ${providerId}`);
	return provider;
}
