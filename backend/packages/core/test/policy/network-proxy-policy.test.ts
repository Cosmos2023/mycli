import assert from "node:assert/strict";
import test from "node:test";
import { freezeNetworkProxyPolicy, intersectNetworkProxyPolicy, networkProxyPolicyIsSubset, validateNetworkProxyPolicy } from "../../src/index.ts";

test("approval restrictions are frozen and cannot be removed by a child or restored policy", () => {
	const patterns = ["*.Example.com"];
	const broad = freezeNetworkProxyPolicy({ approvalDomains: patterns });
	patterns.length = 0;
	assert.deepEqual(broad.approvalDomains, ["*.example.com"]);
	assert.ok(Object.isFrozen(broad.approvalDomains));
	const narrow = freezeNetworkProxyPolicy({ approvalDomains: ["api.example.com"] });
	assert.equal(networkProxyPolicyIsSubset(narrow, broad), false);
	assert.equal(networkProxyPolicyIsSubset(broad, narrow), true);
	assert.equal(networkProxyPolicyIsSubset(freezeNetworkProxyPolicy({}), broad), false);
	assert.deepEqual(intersectNetworkProxyPolicy(broad, narrow)?.approvalDomains, ["*.example.com", "api.example.com"]);
	for (const approvalDomains of [true, "example.com", ["https://secret"], Array(257).fill("a.test")]) {
		assert.throws(() => freezeNetworkProxyPolicy({ approvalDomains }));
	}
});

test("proxy policies normalize defaults and reject unknown or malformed authority", () => {
	assert.deepEqual(freezeNetworkProxyPolicy({}), { mode: "full", enableSocks5: true, allowUpstreamProxy: false });
	assert.ok(Object.isFrozen(freezeNetworkProxyPolicy({ mode: "limited" })));
	for (const value of [null, [], "full", { mode: "read-only" }, { enableSocks5: "true" }, { allowUpstreamProxy: 1 }, { upstreamUrl: "http://private" }]) {
		assert.throws(() => freezeNetworkProxyPolicy(value), /invalid network proxy policy/u);
	}
});

test("intersections and subset checks retain limited mode and disabled transports", () => {
	const limited = freezeNetworkProxyPolicy({ mode: "limited", enableSocks5: false });
	const full = freezeNetworkProxyPolicy({ allowUpstreamProxy: true });
	assert.deepEqual(intersectNetworkProxyPolicy(limited, full), limited);
	assert.deepEqual(intersectNetworkProxyPolicy(undefined, limited), limited);
	assert.deepEqual(intersectNetworkProxyPolicy(limited, undefined), limited);
	assert.equal(networkProxyPolicyIsSubset(undefined, limited), false);
	assert.equal(networkProxyPolicyIsSubset(full, limited), false);
	assert.equal(networkProxyPolicyIsSubset(limited, full), true);
	assert.equal(networkProxyPolicyIsSubset(full, undefined), false);
});

test("limited networking forbids loopback bypasses and requires domain authorization", () => {
	const networkProxy = freezeNetworkProxyPolicy({ mode: "limited" });
	for (const rest of [{}, { networkDomains: [], networkEgress: {} }, { networkDomains: ["example.com"], allowLocalBinding: true },
		{ networkDomains: ["example.com"], loopbackPorts: [8080] }]) {
		assert.throws(() => validateNetworkProxyPolicy({ networkProxy, ...rest }));
	}
	validateNetworkProxyPolicy({ networkProxy, networkDomains: [], loopbackPorts: [], allowLocalBinding: false });
});
