import assert from "node:assert/strict";
import test from "node:test";
import { parseGatewayResult } from "../../src/index.ts";

test("permission diagnostics are optional for old clients and closed when provided", () => {
	const capabilities = { filesystem_rules: "supported", denied_reads: "supported", structured_egress: "supported",
		independent_policies: "supported", host_loopback_access: "unsupported" };
	const bounds = { read_scope: "allowlist", network_scope: "domain_allowlist",
		readonly_roots: 1, denied_read_rules: 2, allow_local_binding: false };
	assert.doesNotThrow(() => parseGatewayResult("permissions.list", { active: "workspace", profiles: [] }));
	assert.doesNotThrow(() => parseGatewayResult("permissions.list", {
		sandbox_capabilities: capabilities, effective: { bounds },
	}));
	for (const invalid of [{ ...capabilities, filesystem_rules: "maybe" },
		{ ...capabilities, raw_helper_output: "private" }, { filesystem_rules: "supported" }]) {
		assert.throws(() => parseGatewayResult("permissions.list", { sandbox_capabilities: invalid }));
	}
	for (const invalid of [{ ...bounds, readonly_roots: -1 }, { ...bounds, network_scope: "internet" },
		{ ...bounds, denied_read_rules: 1.5 }, { ...bounds, paths: ["C:\\private"] }]) {
		assert.throws(() => parseGatewayResult("permissions.list", { effective: { bounds: invalid } }));
	}
});
