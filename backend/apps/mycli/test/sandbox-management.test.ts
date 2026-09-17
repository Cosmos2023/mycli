import assert from "node:assert/strict";
import test from "node:test";
import { renderManagementResponse } from "../src/management/render.ts";
import {
	inspectSandboxStatus,
	SandboxManagementService,
} from "../src/management/sandbox.ts";

test("sandbox status renders one canonical readiness response in human and JSON modes", async () => {
	const response = await inspectSandboxStatus({
		platform: "darwin",
		isExecutable: (path) => path === "/usr/bin/sandbox-exec",
	});

	assert.deepEqual(response, {
		ok: true,
		action: "status",
		message: "mycli sandbox status",
		readiness: {
			state: "ready",
			code: "ready",
			platform: "darwin",
			isolation: "macos_seatbelt",
		},
		exitCode: 0,
	});
	assert.equal(renderManagementResponse(
		{ kind: "sandbox", action: "status", json: false },
		response,
	), [
		"mycli sandbox status",
		"state=ready",
		"code=ready",
		"platform=darwin",
		"isolation=macos_seatbelt",
		"",
	].join("\n"));
	assert.deepEqual(JSON.parse(renderManagementResponse(
		{ kind: "sandbox", action: "status", json: true },
		response,
	)), response);
});

test("sandbox status maps incomplete Windows setup to bounded actionable state", async () => {
	const response = await inspectSandboxStatus({
		platform: "win32",
		windowsHelperPath: "C:\\bounded\\mycli-windows-sandbox.exe",
		isExecutable: () => true,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 2,
			setupComplete: false,
			sandboxReady: false,
		}),
	});

	assert.equal(response.ok, false);
	assert.equal(response.exitCode, 1);
	assert.equal(response.readiness.state, "setup_required");
	assert.equal(response.readiness.code, "setup_incomplete");
	assert.equal(response.readiness.helperVersion, 2);
	assert.equal(response.readiness.helperCompatible, true);
	assert.equal(response.readiness.setupComplete, false);
	assert.equal(response.readiness.sandboxReady, false);
	assert.deepEqual(response.issues, ["setup_incomplete"]);
	assert.match(response.remediation ?? "", /sandbox setup/u);
	assert.doesNotMatch(JSON.stringify(response), /C:\\bounded/u);
});

test("sandbox setup previews confirmation then verifies one Windows recovery operation", async () => {
	let setupComplete = false;
	let sandboxReady = false;
	const operations: string[] = [];
	const service = new SandboxManagementService({
		platform: "win32",
		windowsHelperPath: "C:\\private\\mycli-windows-sandbox.exe",
		isExecutable: () => true,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 2,
			setupComplete,
			sandboxReady,
		}),
		runWindowsOperation: async ({ action }) => {
			operations.push(action);
			setupComplete = true;
			sandboxReady = true;
			return "completed";
		},
	});

	const previewCommand = {
		kind: "sandbox",
		action: "setup",
		confirmed: false,
		json: false,
	} as const;
	const preview = await service.execute(previewCommand);
	assert.equal(preview.ok, false);
	assert.deepEqual(preview.result, {
		status: "confirmation_required",
		code: "confirmation_required",
	});
	assert.deepEqual(preview.preview, {
		action: "setup",
		confirmationRequired: true,
		confirmationFlag: "--confirm",
		privilege: "windows_uac",
		effects: ["initialize_windows_identity", "configure_windows_firewall"],
	});
	assert.deepEqual(operations, []);
	assert.match(renderManagementResponse(previewCommand, preview), /confirmation_flag=--confirm/u);

	const confirmedCommand = { ...previewCommand, confirmed: true };
	const completed = await service.execute(confirmedCommand);
	assert.equal(completed.ok, true);
	assert.deepEqual(completed.result, { status: "completed", code: "setup_completed" });
	assert.equal(completed.readiness.state, "ready");
	assert.deepEqual(operations, ["setup"]);
	assert.doesNotMatch(JSON.stringify(completed), /C:\\private/u);
});

test("sandbox reset is explicit idempotent recovery and verifies setup state removal", async () => {
	let setupComplete = true;
	let sandboxReady = true;
	const operations: string[] = [];
	const service = new SandboxManagementService({
		platform: "win32",
		windowsHelperPath: "C:\\mycli-windows-sandbox.exe",
		isExecutable: () => true,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 2,
			setupComplete,
			sandboxReady,
		}),
		runWindowsOperation: async ({ action }) => {
			operations.push(action);
			setupComplete = false;
			sandboxReady = false;
			return "completed";
		},
	});
	const command = { kind: "sandbox", action: "reset", confirmed: true, json: true } as const;

	const preview = await service.execute({ ...command, confirmed: false });
	assert.deepEqual(preview.result, {
		status: "confirmation_required",
		code: "confirmation_required",
	});
	assert.deepEqual(preview.preview?.effects, ["clean_windows_sandbox_acls", "clear_windows_setup_state"]);
	assert.deepEqual(operations, []);

	const response = await service.execute(command);

	assert.equal(response.ok, true);
	assert.deepEqual(response.result, { status: "completed", code: "reset_completed" });
	assert.equal(response.readiness.state, "setup_required");
	assert.deepEqual(operations, ["reset"]);
	assert.deepEqual(JSON.parse(renderManagementResponse(command, response)), response);

	const repeated = await service.execute(command);
	assert.deepEqual(repeated.result, { status: "completed", code: "reset_completed" });
	assert.deepEqual(operations, ["reset", "reset"]);
});

test("sandbox recovery maps UAC cancellation and incompatible helpers without native details", async () => {
	const canceled = new SandboxManagementService({
		platform: "win32",
		windowsHelperPath: "C:\\secret\\helper.exe",
		isExecutable: () => true,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 2,
			setupComplete: false,
			sandboxReady: false,
		}),
		runWindowsOperation: async () => "canceled",
	});
	const canceledResponse = await canceled.execute({
		kind: "sandbox",
		action: "setup",
		confirmed: true,
		json: true,
	});
	assert.deepEqual(canceledResponse.result, {
		status: "canceled",
		code: "operation_canceled",
	});
	assert.doesNotMatch(JSON.stringify(canceledResponse), /secret|stderr|stack/iu);

	const incompatible = await inspectSandboxStatus({
		platform: "win32",
		windowsHelperPath: "C:\\secret\\helper.exe",
		isExecutable: () => true,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 1,
			setupComplete: true,
			sandboxReady: true,
		}),
	});
	assert.equal(incompatible.readiness.code, "handshake_failed");
	assert.equal(incompatible.readiness.helperVersion, 1);
	assert.equal(incompatible.readiness.helperCompatible, false);
	assert.match(incompatible.remediation ?? "", /matches this runtime/u);
});

test("sandbox setup reports manual platform dependency recovery without executing an installer", async () => {
	const service = new SandboxManagementService({
		platform: "linux",
		isExecutable: () => false,
		runWindowsOperation: async () => {
			throw new Error("must not run");
		},
	});

	const response = await service.execute({
		kind: "sandbox",
		action: "setup",
		confirmed: true,
		json: false,
	});

	assert.equal(response.ok, false);
	assert.deepEqual(response.result, {
		status: "manual_action_required",
		code: "dependency_install_required",
	});
	assert.equal(response.preview?.privilege, "manual_install");
	assert.match(response.remediation ?? "", /bubblewrap/u);
});

test("sandbox recovery contains interruption and native operation failures", async () => {
	const base = {
		platform: "win32" as const,
		windowsHelperPath: "C:\\private\\helper.exe",
		isExecutable: () => true,
		windowsHandshake: async () => ({
			name: "mycli-windows-sandbox",
			protocolVersion: 2,
			setupComplete: false,
			sandboxReady: false,
		}),
	};
	const interrupted = await new SandboxManagementService({
		...base,
		runWindowsOperation: async () => {
			throw new DOMException("private interruption detail", "AbortError");
		},
	}).execute({ kind: "sandbox", action: "setup", confirmed: true, json: true });
	assert.deepEqual(interrupted.result, { status: "canceled", code: "interrupted" });
	assert.doesNotMatch(JSON.stringify(interrupted), /private|AbortError/iu);

	const failed = await new SandboxManagementService({
		...base,
		runWindowsOperation: async () => {
			throw new Error("private native failure");
		},
	}).execute({ kind: "sandbox", action: "setup", confirmed: true, json: true });
	assert.deepEqual(failed.result, { status: "failed", code: "operation_failed" });
	assert.doesNotMatch(JSON.stringify(failed), /private|native failure/iu);
});
