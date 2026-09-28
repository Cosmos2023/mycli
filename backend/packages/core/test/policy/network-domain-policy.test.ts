import assert from "node:assert/strict";
import test from "node:test";
import {
	networkDomainAllowed,
	intersectNetworkDomains,
	normalizeNetworkDomains,
} from "../../src/index.ts";

test("domain policies canonicalize IPv6 literals without accepting host ports or scoped addresses", () => {
	assert.deepEqual(normalizeNetworkDomains(["[2606:4700:4700::1111]", "2606:4700:4700:0:0:0:0:1111"]), ["2606:4700:4700::1111"]);
	assert.equal(networkDomainAllowed("[2606:4700:4700:0:0:0:0:1111]", ["2606:4700:4700::1111"]), true);
	for (const value of ["example.com:80", "[example.com]", "*.2606:4700:4700::1111", "fe80::1%en0"]) assert.throws(() => normalizeNetworkDomains([value]));
});

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

test("intersects exact, nested wildcard and offline domain ceilings without widening", () => {
	assert.equal(intersectNetworkDomains(undefined, undefined), undefined);
	assert.deepEqual(intersectNetworkDomains(undefined, ["API.Example.com."]), ["api.example.com"]);
	assert.deepEqual(intersectNetworkDomains(["*.example.com"], ["example.com"]), []);
	assert.deepEqual(intersectNetworkDomains(["*.example.com"], ["api.example.com", "*.sub.example.com", "other.com"]), ["api.example.com", "*.sub.example.com"]);
	const policies = [undefined, [], ["example.com"], ["api.example.com"], ["*.example.com"], ["*.sub.example.com"], ["other.com"]];
	for (const left of policies) for (const right of policies) {
		const result = intersectNetworkDomains(left, right);
		for (const host of ["example.com", "api.example.com", "x.sub.example.com", "sub.example.com", "notexample.com", "other.com"]) {
			assert.equal(networkDomainAllowed(host, result), networkDomainAllowed(host, left) && networkDomainAllowed(host, right));
		}
		if (result !== undefined) assert.ok(Object.isFrozen(result));
	}
});
