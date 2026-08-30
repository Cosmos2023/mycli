import assert from "node:assert/strict";
import test from "node:test";
import { renderManagementResponse } from "../src/management/render.ts";
import { inspectSandboxStatus } from "../src/management/sandbox.ts";

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
			protocolVersion: 1,
			setupComplete: false,
			sandboxReady: false,
		}),
	});

	assert.equal(response.ok, false);
	assert.equal(response.exitCode, 1);
	assert.equal(response.readiness.state, "setup_required");
	assert.equal(response.readiness.code, "setup_incomplete");
	assert.deepEqual(response.issues, ["setup_incomplete"]);
	assert.match(response.remediation ?? "", /elevated terminal/u);
	assert.doesNotMatch(JSON.stringify(response), /C:\\bounded/u);
});
