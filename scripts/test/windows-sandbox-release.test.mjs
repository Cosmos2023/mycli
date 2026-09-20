import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertVendoredSandboxHelperIdentity,
	assertWindowsPackageEvidence,
	assertWindowsReady,
	assertWindowsSuiteSummary,
	packedSandboxOptions,
	verifyInstalledWindowsSandbox,
	windowsSandboxSuites,
} from "../windows-sandbox-release-checks.mjs";
import { verifyWindowsPackageEvidence } from "../publish-release.mjs";

test("Vendored sandbox helper must match the promoted helper", () => {
	assert.equal(assertVendoredSandboxHelperIdentity("a".repeat(64), undefined), false);
	assert.equal(assertVendoredSandboxHelperIdentity("a".repeat(64), "a".repeat(64)), true);
	assert.throws(() => assertVendoredSandboxHelperIdentity("a".repeat(64), "b".repeat(64)),
		{ message: "windows_sandbox_vendored_helper_stale" });
	assert.throws(() => assertVendoredSandboxHelperIdentity(undefined, "b".repeat(64)),
		{ message: "windows_sandbox_source_helper_missing" });
});

function status(state = "ready", changes = {}) {
	const ready = state === "ready";
	return JSON.stringify({ action: "status", ok: ready, exitCode: ready ? 0 : 1,
		readiness: { platform: "win32", isolation: "windows_restricted_token", state,
			code: ready ? "ready" : "setup_incomplete", helperCompatible: true,
			setupComplete: ready, sandboxReady: ready, managedStatePresent: ready, ...changes } });
}

function setupResult() {
	return JSON.stringify({ ...JSON.parse(status()), action: "setup",
		result: { status: "completed", code: "setup_completed" } });
}

test("strict installed readiness requires Windows and a packaged helper", () => {
	assert.deepEqual(packedSandboxOptions(["--require-windows-ready"], "win32"), {
		requireReady: true, requireHelper: true, setup: false,
	});
	assert.deepEqual(packedSandboxOptions(["--require-windows-helper"], "linux"), {
		requireReady: false, requireHelper: true, setup: false,
	});
	for (const platform of ["linux", "darwin"]) {
		assert.throws(() => packedSandboxOptions(["--require-windows-ready"], platform), /requires_windows/u);
	}
	assert.throws(() => packedSandboxOptions(["--setup-windows-sandbox"], "win32"), /requires_readiness_gate/u);
	assert.throws(() => packedSandboxOptions(["--app-only", "--require-windows-ready"], "win32"), /incompatible/u);
	assert.throws(() => packedSandboxOptions(["--require-windows-raedy"], "win32"), /unknown_option/u);
	assert.throws(() => packedSandboxOptions(["--artifacts-dir"], "win32"), /directory_required/u);
	assert.equal(packedSandboxOptions(["--artifacts-dir", "release evidence"], "win32").artifactDirectory,
		"release evidence");
});

test("Windows readiness rejects unavailable, waived, and malformed results without leaking output", () => {
	assert.doesNotThrow(() => assertWindowsReady(status()));
	for (const state of ["unavailable", "setup_required", "not_required"]) {
		assert.throws(() => assertWindowsReady(status(state)), /not_ready/u);
	}
	for (const changes of [{ helperCompatible: false }, { setupComplete: false },
		{ sandboxReady: false }, { state: "ready", code: "helper_missing" }]) {
		assert.throws(() => assertWindowsReady(status("ready", changes)), /not_ready/u);
	}
	for (const output of ["private-sentinel", "x".repeat(16_385), "null", "[]",
		status("ready", { platform: "linux" }), status("ready", { isolation: "none" })]) {
		assert.throws(() => assertWindowsReady(output), { message: "windows_sandbox_response_invalid" });
	}
});

test("ordinary strict readiness never starts setup", async () => {
	const evidence = await verifyInstalledWindowsSandbox({
		runStatus: async () => status(), runSetup: () => assert.fail("unexpected setup"),
	});
	assert.deepEqual(evidence, { state: "ready", isolation: "windows_restricted_token", fresh_setup: false });
	await assert.rejects(verifyInstalledWindowsSandbox({
		runStatus: async () => status("setup_required"), runSetup: () => assert.fail("unexpected setup"),
	}), /not_ready/u);
});

test("installed PSEC evidence pins the backend throughout fresh setup", async () => {
	const psec = { isolation: "windows_psec" };
	const setup = JSON.stringify({ ...JSON.parse(status("ready", psec)), action: "setup",
		result: { status: "completed", code: "setup_completed" } });
	const evidence = await verifyInstalledWindowsSandbox({ setup: true,
		runStatus: async (ready) => status(ready ? "ready" : "setup_required", psec),
		runSetup: async () => setup,
	});
	assert.deepEqual(evidence, { state: "ready", isolation: "windows_psec", fresh_setup: true });
	for (const phase of ["setup", "status"]) {
		await assert.rejects(verifyInstalledWindowsSandbox({ setup: true,
			runStatus: async (ready) => status(ready ? "ready" : "setup_required",
				ready && phase === "status" ? {} : psec),
			runSetup: async () => phase === "setup" ? setupResult() : setup,
		}), /backend_changed/u);
	}
});

test("fresh installed setup verifies absence, setup completion, and a separate final status", async () => {
	const calls = [];
	const expectedReady = [];
	let inspected = false;
	const evidence = await verifyInstalledWindowsSandbox({ setup: true,
		runStatus: async (expectReady) => {
			calls.push("status");
			expectedReady.push(expectReady);
			const output = status(inspected ? "ready" : "setup_required");
			inspected = true;
			return output;
		},
		runSetup: async () => { calls.push("setup"); return setupResult(); },
	});
	assert.deepEqual(calls, ["status", "setup", "status"]);
	assert.deepEqual(expectedReady, [false, true]);
	assert.equal(evidence.fresh_setup, true);
	for (const before of [status(), status("setup_required", { managedStatePresent: true }),
		status("setup_required", { managedStatePresent: undefined })]) {
		await assert.rejects(verifyInstalledWindowsSandbox({ setup: true,
			runStatus: async () => before, runSetup: () => assert.fail("must not alter existing state"),
		}), /clean_setup_required/u);
	}
});

test("setup cancellation, malformed success, and loss of readiness fail acceptance", async () => {
	for (const setup of [JSON.stringify({ ...JSON.parse(setupResult()), ok: false }),
		JSON.stringify({ ...JSON.parse(setupResult()), result: { status: "not_needed", code: "already_ready" } })]) {
		await assert.rejects(verifyInstalledWindowsSandbox({ setup: true,
			runStatus: async () => status("setup_required"), runSetup: async () => setup,
		}), /not_ready|setup_not_completed/u);
	}
	await assert.rejects(verifyInstalledWindowsSandbox({ setup: true,
		runStatus: async () => status("setup_required"), runSetup: async () => setupResult(),
	}), /not_ready/u);
});

test("complete Windows acceptance rejects skipped, missing, failed, cancelled, and todo tests", () => {
	const valid = { tests: 13, passed: 13, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
	assert.doesNotThrow(() => assertWindowsSuiteSummary(valid));
	for (const counts of [undefined, { ...valid, tests: 12, passed: 12 },
		{ ...valid, passed: 12, skipped: 1 }, { ...valid, passed: 12, failed: 1 },
		{ ...valid, cancelled: 1 }, { ...valid, todo: 1 }]) {
		assert.throws(() => assertWindowsSuiteSummary(counts), /suite_incomplete/u);
	}
});

test("the release gate requires all seven parity tests only on a ready PSEC backend", () => {
	const base = { name: "mycli-windows-sandbox", protocol_version: 2, setup_complete: true, sandbox_ready: true };
	assert.deepEqual(windowsSandboxSuites({ ...base, backend: "restricted_token" }).map((s) => s.count), [13]);
	assert.deepEqual(windowsSandboxSuites({ ...base, backend: "psec" }).map((s) => s.count), [13, 7]);
	for (const invalid of [{ ...base }, { ...base, backend: "unknown" }, { ...base, backend: "psec", sandbox_ready: false }]) {
		assert.throws(() => windowsSandboxSuites(invalid), /handshake_invalid/u);
	}
	const valid = { tests: 7, passed: 7, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
	assert.doesNotThrow(() => assertWindowsSuiteSummary(valid, 7));
	for (const invalid of [{ ...valid, passed: 6, skipped: 1 }, { ...valid, tests: 6, passed: 6 }, { ...valid, failed: 1 }]) {
		assert.throws(() => assertWindowsSuiteSummary(invalid, 7), /suite_incomplete/u);
	}
});

test("the local Windows release runner refuses missing destructive-test opt-ins before discovery", () => {
	const result = spawnSync(process.execPath, ["scripts/run-windows-sandbox-tests.mjs"], {
		cwd: new URL("../../", import.meta.url), encoding: "utf8",
		env: { ...process.env, MYCLI_WINDOWS_SANDBOX_SETUP_TESTS: "", MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS: "" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /requires_windows_and_both_maintenance_opt_ins/u);
	assert.equal(result.stdout, "");
});

test("publication requires fresh Windows evidence matching the commit, version, and both artifacts", () => {
	const expected = { commit: "a".repeat(40), version: "0.1.1",
		candidateHash: "b".repeat(64), helperHash: "c".repeat(64) };
	const sandbox = { state: "ready", isolation: "windows_restricted_token", fresh_setup: true,
		source_dirty: false, source_commit: expected.commit, candidate_version: expected.version,
		candidate_sha256: expected.candidateHash, helper_sha256: expected.helperHash };
	const evidence = { status: "completed", windows_sandbox: sandbox };
	assert.doesNotThrow(() => assertWindowsPackageEvidence(evidence, expected));
	for (const changes of [{ state: "unavailable" }, { fresh_setup: false }, { source_dirty: true },
		{ source_commit: "d".repeat(40) }, { candidate_version: "0.1.0" },
		{ candidate_sha256: "e".repeat(64) }, { helper_sha256: "f".repeat(64) }]) {
		assert.throws(() => assertWindowsPackageEvidence({ ...evidence,
			windows_sandbox: { ...sandbox, ...changes } }, expected), /evidence_invalid/u);
	}
	assert.throws(() => assertWindowsPackageEvidence({ status: "completed" }, expected), /evidence_invalid/u);
});

test("the publisher verifies files before accepting evidence and rejects replaced tarballs", async () => {
	const root = await mkdtemp(join(tmpdir(), "mycli-windows-evidence-"));
	try {
		const git = (...args) => {
			const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		git("init", "-b", "main");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
			"-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
		const candidate = join(root, "candidate.tgz");
		const windowsEvidence = join(root, "windows.json");
		const helperDir = join(root, "backend/packages/tools/native/windows");
		await mkdir(helperDir, { recursive: true });
		await writeFile(candidate, "candidate-bytes");
		await writeFile(join(helperDir, "mycli-windows-sandbox.exe"), "helper-bytes");
		const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
		await writeFile(windowsEvidence, "\uFEFF" + JSON.stringify({ status: "completed", windows_sandbox: {
			state: "ready", isolation: "windows_restricted_token", fresh_setup: true,
			source_dirty: false, source_commit: git("rev-parse", "HEAD"), candidate_version: "0.1.1",
			candidate_sha256: hash("candidate-bytes"), helper_sha256: hash("helper-bytes"),
		} }));
		await verifyWindowsPackageEvidence({ candidate, windowsEvidence }, "0.1.1", root);
		await writeFile(candidate, "replacement-bytes");
		await assert.rejects(verifyWindowsPackageEvidence({ candidate, windowsEvidence }, "0.1.1", root),
			{ message: "release_windows_package_evidence_invalid" });
		await assert.rejects(verifyWindowsPackageEvidence({}, "0.1.1", root), /evidence_required/u);
		await writeFile(windowsEvidence, "private-sentinel".repeat(2000));
		await assert.rejects(verifyWindowsPackageEvidence({ candidate, windowsEvidence }, "0.1.1", root),
			{ message: "release_windows_package_evidence_invalid" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
