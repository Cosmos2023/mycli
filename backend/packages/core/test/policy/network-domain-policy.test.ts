import assert from "node:assert/strict";
import test from "node:test";
import {
	networkDomainAllowed,
	normalizeNetworkDomains,
} from "../../src/index.ts";

test("normalizes exact and wildcard domains with strict subdomain matching", () => {
	const domains = normalizeNetworkDomains([
		"API.Example.com.",
		"*.services.example.com",
		"api.example.com",
	]);

	assert.deepEqual(domains, ["api.example.com", "*.services.example.com"]);
	assert.equal(networkDomainAllowed("api.example.com", domains), true);
	assert.equal(networkDomainAllowed("a.services.example.com", domains), true);
	assert.equal(networkDomainAllowed("services.example.com", domains), false);
	assert.equal(networkDomainAllowed("notexample.com", domains), false);
	assert.equal(networkDomainAllowed("anything.example", undefined), true);
	assert.throws(() => normalizeNetworkDomains(["https://example.com"]));
	assert.throws(() => normalizeNetworkDomains(["*.127.0.0.1"]));
});
