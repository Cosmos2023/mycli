import assert from "node:assert/strict";
import test from "node:test";
import {
	planSandboxRecovery,
	runSandboxRecovery,
	type SandboxReadiness,
} from "../../src/index.ts";

const WINDOWS_HELPER = "C:\\mycli\\mycli-windows-sandbox.exe";

test("PSEC lifecycle uses local setup and verifies cleanup without account operations", async () => {
	let ready = false;
	const actions: string[] = [];
	const probes = {
		platform: "win32" as const, isExecutable: () => true,
		windowsHandshake: async () => ({ name: "mycli-windows-sandbox", protocolVersion: 2,
			backend: "psec" as const, setupComplete: ready, sandboxReady: ready, managedStatePresent: ready }),
		runWindowsOperation: async ({ action }: { readonly action: string }) => {
			actions.push(action);
			ready = action === "setup" || action === "repair";
			return "completed" as const;
		},
	};
	for (const action of ["setup", "reset", "repair", "uninstall"] as const) {
		const preview = await runSandboxRecovery(action, false, probes);
		assert.equal(preview.status, "confirmation_required");
		assert.equal(preview.preview.privilege, "none");
		assert.equal(preview.preview.effects.includes("initialize_windows_identity"), false);
		assert.equal(preview.preview.effects.includes("stop_windows_sandbox_processes"),
			action === "repair" || action === "uninstall");
		assert.equal((await runSandboxRecovery(action, true, probes)).code, `${action}_completed`);
	}
	assert.deepEqual(actions, ["setup", "reset", "repair", "uninstall"]);
});

test("sandbox recovery plans manual dependencies and leaves non-Windows reset state untouched", () => {
	const missingLinux: SandboxReadiness = {
		state: "unavailable",
		code: "helper_missing",
		platform: "linux",
		isolation: "linux_bubblewrap",
	};

	assert.deepEqual(planSandboxRecovery("setup", missingLinux), {
		preview: {
			action: "setup",
			confirmationRequired: false,
			privilege: "manual_install",
			effects: ["install_platform_dependency"],
		},
		terminal: {
			status: "manual_action_required",
			code: "dependency_install_required",
		},
	});
	assert.equal(planSandboxRecovery("reset", missingLinux).terminal?.code, "no_managed_state");

	const missingMac: SandboxReadiness = {
		state: "unavailable",
		code: "helper_missing",
		platform: "darwin",
		isolation: "macos_seatbelt",
	};
	assert.equal(
		planSandboxRecovery("setup", missingMac).terminal?.code,
		"dependency_install_required",
	);

	const unsupported: SandboxReadiness = {
		state: "unavailable",
		code: "unsupported_platform",
		platform: "freebsd",
		isolation: "none",
	};
	assert.equal(
		planSandboxRecovery("setup", unsupported).terminal?.code,
		"unsupported_platform",
	);
});

test("Windows sandbox recovery requires confirmation and verifies setup and reset transitions", async () => {
	let setupComplete = false;
	let sandboxReady = false;
	const operations: string[] = [];
	const probes = {
		platform: "win32" as const,
		windowsHelperPath: WINDOWS_HELPER,
		isExecutable: () => true,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 2,
			setupComplete,
			sandboxReady,
		}),
		runWindowsOperation: async ({ action }: { readonly action: "setup" | "reset" | "repair" | "uninstall" }) => {
			operations.push(action);
			setupComplete = action === "setup";
			sandboxReady = action === "setup";
			return "completed" as const;
		},
	};

	const preview = await runSandboxRecovery("setup", false, probes);
	assert.equal(preview.status, "confirmation_required");
	assert.equal(preview.preview.privilege, "windows_uac");
	assert.deepEqual(operations, []);

	const setup = await runSandboxRecovery("setup", true, probes);
	assert.equal(setup.status, "completed");
	assert.equal(setup.code, "setup_completed");
	assert.equal(setup.after.state, "ready");

	const reset = await runSandboxRecovery("reset", true, probes);
	assert.equal(reset.status, "completed");
	assert.equal(reset.code, "reset_completed");
	assert.equal(reset.after.setupComplete, false);
	assert.deepEqual(operations, ["setup", "reset"]);
});

test("Windows sandbox recovery classifies cancellation partial setup and helper mismatch", async () => {
	const base = {
		platform: "win32" as const,
		windowsHelperPath: WINDOWS_HELPER,
		isExecutable: () => true,
	};
	const canceled = await runSandboxRecovery("setup", true, {
		...base,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 2,
			setupComplete: false,
			sandboxReady: false,
		}),
		runWindowsOperation: async () => "canceled",
	});
	assert.equal(canceled.code, "operation_canceled");

	let setupComplete = false;
	const partial = await runSandboxRecovery("setup", true, {
		...base,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 2,
			setupComplete,
			sandboxReady: false,
		}),
		runWindowsOperation: async () => {
			setupComplete = true;
			return "completed";
		},
	});
	assert.equal(partial.status, "partial");
	assert.equal(partial.code, "enforcement_unavailable");

	const mismatch = await runSandboxRecovery("setup", true, {
		...base,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 1,
			setupComplete: false,
			sandboxReady: false,
		}),
		runWindowsOperation: async () => {
			throw new Error("must not run");
		},
	});
	assert.equal(mismatch.status, "failed");
	assert.equal(mismatch.code, "helper_version_mismatch");

	const missing = await runSandboxRecovery("setup", true, {
		platform: "win32",
		windowsHelperPath: WINDOWS_HELPER,
		isExecutable: () => false,
		runWindowsOperation: async () => {
			throw new Error("must not run");
		},
	});
	assert.equal(missing.status, "failed");
	assert.equal(missing.code, "helper_missing");
});

test("Windows reset fails verification when the post-operation helper becomes incompatible", async () => {
	let protocolVersion = 2;
	let setupComplete = true;
	let sandboxReady = true;
	const response = await runSandboxRecovery("reset", true, {
		platform: "win32",
		windowsHelperPath: WINDOWS_HELPER,
		isExecutable: () => true,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion,
			setupComplete,
			sandboxReady,
		}),
		runWindowsOperation: async () => {
			protocolVersion = 1;
			setupComplete = false;
			sandboxReady = false;
			return "completed";
		},
	});

	assert.equal(response.status, "failed");
	assert.equal(response.code, "verification_failed");
	assert.equal(response.after.helperCompatible, false);
});

test("repair and uninstall preview all effects and require verified cleanup", async () => {
	for (const action of ["repair", "uninstall"] as const) {
		let calls = 0;
		let ready = true;
		let present = true;
		const probes = {
			platform: "win32" as const, windowsHelperPath: WINDOWS_HELPER, isExecutable: () => true,
			windowsHandshake: async () => ({ name: "mycli-windows-sandbox", protocolVersion: 2,
				setupComplete: ready, sandboxReady: ready, managedStatePresent: present }),
			runWindowsOperation: async () => { ++calls; ready = action === "repair"; present = ready; return "completed" as const; },
		};
		const preview = await runSandboxRecovery(action, false, probes);
		assert.equal(calls, 0);
		assert.equal(preview.status, "confirmation_required");
		assert.equal(preview.preview.privilege, "windows_uac");
		assert.ok(preview.preview.effects.includes("clean_windows_sandbox_acls"));
		assert.ok(preview.preview.effects.includes("stop_windows_sandbox_processes"));
		const result = await runSandboxRecovery(action, true, probes);
		assert.equal(calls, 1);
		assert.equal(result.code, `${action}_completed`);
		const canceled = await runSandboxRecovery(action, true, { ...probes, runWindowsOperation: async () => "canceled" });
		assert.equal(canceled.status, "canceled");
	}
	const leftover = await runSandboxRecovery("uninstall", true, {
		platform: "win32", isExecutable: () => true,
		windowsHandshake: async () => ({ name: "mycli-windows-sandbox", protocolVersion: 2,
			setupComplete: false, sandboxReady: false, managedStatePresent: true }),
		runWindowsOperation: async () => "completed",
	});
	assert.equal(leftover.code, "verification_failed");
});
