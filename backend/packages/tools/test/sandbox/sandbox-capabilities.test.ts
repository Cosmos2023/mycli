import assert from "node:assert/strict";
import test from "node:test";
import { inspectSandboxReadiness, sandboxNotRequired } from "../../src/sandbox/sandbox-readiness.ts";
import { windowsSandboxCapabilities } from "../../src/sandbox/sandbox-capabilities.ts";

test("Windows capabilities separate backend support from setup and enforce conservative compatibility", async () => {
	for (const backend of ["psec", "restricted_token", undefined] as const) {
		for (const protocolVersion of [1, 2, 3]) {
			for (const setupComplete of [false, true]) {
				const readiness = await inspectSandboxReadiness({
					platform: "win32", isExecutable: () => true,
					windowsHandshake: async () => ({ name: "mycli-windows-sandbox", protocolVersion,
						setupComplete, sandboxReady: setupComplete, ...(backend ? { backend } : {}) }),
				});
				const capabilities = windowsSandboxCapabilities(readiness);
				assert.equal(readiness.state, protocolVersion !== 2 ? "unavailable" : setupComplete ? "ready" : "setup_required");
				assert.deepEqual(capabilities, {
					denied_reads: protocolVersion === 2 ? "supported" : "unknown",
					filesystem_rules: protocolVersion !== 2 ? "unknown" : backend === "psec" ? "supported" : "unsupported",
					structured_egress: protocolVersion !== 2 ? "unknown" : backend === "psec" ? "supported" : "unsupported",
					independent_policies: protocolVersion !== 2 ? "unknown" : backend === "psec" ? "supported" : "unsupported",
					host_loopback_access: protocolVersion === 2 && backend === "psec" ? "unsupported" : "unknown",
				});
			}
		}
	}
});

test("missing, malformed and older unclassified helpers never advertise supported capabilities", async () => {
	for (const probes of [
		{ isExecutable: () => false },
		{ isExecutable: () => true, windowsHandshake: async () => { throw new Error("private native output"); } },
	]) {
		const readiness = await inspectSandboxReadiness({ platform: "win32", ...probes });
		assert.ok(Object.values(windowsSandboxCapabilities(readiness)!).every((support) => support === "unknown"));
	}
	assert.equal(windowsSandboxCapabilities(sandboxNotRequired("win32")), undefined);
	assert.equal(windowsSandboxCapabilities(await inspectSandboxReadiness({ platform: "darwin", isExecutable: () => true })), undefined);
	assert.equal(windowsSandboxCapabilities({ platform: "win32", state: "ready", code: "ready",
		isolation: "windows_psec" })?.filesystem_rules, "unknown");
});
