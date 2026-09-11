import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderNativeTransportSnapshot, providerNativeEndpointSha256, providerNativeProtocol } from "../../src/index.ts";

test("native transport snapshots retain a bounded API identity and frozen Azure deployment", () => {
	const input = { version: 1, catalogProviderId: "azure-openai-responses", api: "azure-openai-responses",
		modelId: "gpt-5.5", endpointSha256: providerNativeEndpointSha256("https://example.azure.com/openai/v1"),
		azure: { apiVersion: "v1", deploymentName: "production" } };
	const snapshot = parseProviderNativeTransportSnapshot(input);
	assert.equal(providerNativeProtocol(snapshot.api), "responses");
	assert(Object.isFrozen(snapshot));
	assert(Object.isFrozen(snapshot.azure));
	for (const patch of [{ api: "mistral-conversations" }, { version: 2 }, { azure: undefined }, { endpointSha256: "bad" },
		{ apiKey: "secret" }, { modelId: " " }, { azure: { apiVersion: "v1", deploymentName: "a,b=c" } }]) {
		assert.throws(() => parseProviderNativeTransportSnapshot({ ...input, ...patch }), TypeError);
	}
});

test("native endpoint hashes normalize URL authority and trailing slashes without exposing URL credentials", () => {
	assert.equal(providerNativeEndpointSha256("https://EXAMPLE.com:443/v1/"), providerNativeEndpointSha256("https://example.com/v1"));
	assert.equal(providerNativeEndpointSha256("https://example.com/"), providerNativeEndpointSha256("https://example.com"));
	assert.notEqual(providerNativeEndpointSha256("https://example.com/v1"), providerNativeEndpointSha256("https://example.com/v2"));
	for (const endpoint of ["https://user:secret@example.com", "https://example.com?key=private", "https://example.com#private", "file:///private"]) {
		assert.throws(() => providerNativeEndpointSha256(endpoint), TypeError);
	}
});
