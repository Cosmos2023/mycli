import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWindowsSandboxAcceptance } from "../windows-sandbox-acceptance.mjs";

const HASH = "a".repeat(64);
const handshake = (backend = "psec") => ({ name: "mycli-windows-sandbox", protocol_version: 2,
	setup_complete: true, sandbox_ready: true, backend });
const counts = (passed) => ({ tests: passed, passed, failed: 0, skipped: 0, cancelled: 0, todo: 0 });
const options = (overrides = {}) => ({
	platform: "win32", osRelease: "10.0.26200", nodeVersion: "v24.0.0", arch: "x64",
	setupOptIn: true, maintenanceOptIn: true,
	verifyIdentity: async () => HASH, handshake: async () => handshake(),
	runSuite: async (file) => counts(file.includes("parity") ? 7 : 13), ...overrides,
});

test("source acceptance records exact suites, pinned helper and OS without claiming fresh setup", async () => {
	for (const backend of ["psec", "restricted_token"]) {
		let identityChecks = 0;
		const evidence = await runWindowsSandboxAcceptance(options({
			handshake: async () => handshake(backend),
			verifyIdentity: async () => { identityChecks += 1; return HASH; },
		}));
		assert.equal(evidence.status, "completed");
		assert.equal(evidence.stage, "completed");
		assert.equal(evidence.backend, backend);
		assert.equal(evidence.fresh_setup, false);
		assert.equal(evidence.os_release, "10.0.26200");
		assert.equal(evidence.helper_sha256, HASH);
		assert.equal(evidence.final_helper_sha256, HASH);
		assert.equal(identityChecks, 2);
		assert.deepEqual(evidence.suites.map((suite) => suite.count), backend === "psec" ? [13, 7] : [13]);
		assert.ok(evidence.suites.every((suite) => suite.status === "passed"));
	}
});

test("no opt-in or wrong host records not-run before any native IO", async () => {
	for (const override of [{ platform: "darwin" }, { setupOptIn: false }, { maintenanceOptIn: false }]) {
		const evidence = await runWindowsSandboxAcceptance(options({ ...override,
			verifyIdentity: () => assert.fail("preflight must precede native IO"),
		}));
		assert.equal(evidence.status, "not_run");
		assert.deepEqual(evidence.suites, []);
	}
});

test("partial or skipped suites retain bounded counts and never pass", async () => {
	for (const broken of [undefined, { ...counts(13), skipped: 1 }, { ...counts(12) },
		{ ...counts(13), failed: 1 }, { ...counts(13), cancelled: 1 }, { ...counts(13), todo: 1 }]) {
		const evidence = await runWindowsSandboxAcceptance(options({ runSuite: async () => broken }));
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.stage, "suites");
		assert.equal(evidence.code, "windows_sandbox_suite_incomplete");
		assert.deepEqual(evidence.suites.map((suite) => suite.status), ["failed", "not_run"]);
		assert.equal(evidence.final_helper_sha256, undefined);
	}
});

test("a successful suite cannot hide backend, readiness or helper identity drift", async () => {
	for (const drift of ["backend", "readiness", "helper"]) {
		let handshakes = 0;
		let identities = 0;
		const evidence = await runWindowsSandboxAcceptance(options({
			handshake: async () => {
				handshakes += 1;
				return { ...handshake(drift === "backend" && handshakes > 1 ? "restricted_token" : "psec"),
					...(drift === "readiness" && handshakes > 1 ? { sandbox_ready: false } : {}) };
			},
			verifyIdentity: async () => { identities += 1; return drift === "helper" && identities > 1 ? "b".repeat(64) : HASH; },
		}));
		assert.equal(evidence.status, "failed");
		assert.equal(evidence.stage, drift === "helper" ? "identity_after" : "readiness_after");
		assert.equal(evidence.code, drift === "helper" ? "windows_sandbox_helper_changed"
			: drift === "backend" ? "windows_sandbox_backend_changed" : "windows_sandbox_gate_handshake_invalid");
	}
});

test("evidence drops injected paths, raw errors and unknown test fields", async () => {
	const privateText = "C:\\private\\secret-token";
	const evidence = await runWindowsSandboxAcceptance(options({ osRelease: privateText, nodeVersion: privateText,
		runSuite: async () => ({ ...counts(13), skipped: 1, stderr: privateText }),
	}));
	assert.doesNotMatch(JSON.stringify(evidence), /private|secret-token|stderr/u);
	const failed = await runWindowsSandboxAcceptance(options({ handshake: () => { throw new Error(privateText); } }));
	assert.equal(failed.code, "windows_sandbox_suite_incomplete");
	assert.doesNotMatch(JSON.stringify(failed), /private|secret-token/u);
});

test("the CLI writes not-run evidence on refusal and fails when evidence cannot be saved", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-sandbox-acceptance-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "nested", "acceptance.json");
	const run = (evidencePath) => spawnSync(process.execPath, ["scripts/run-windows-sandbox-tests.mjs"], {
		cwd: new URL("../../", import.meta.url), encoding: "utf8",
		env: { ...process.env, MYCLI_WINDOWS_SANDBOX_SETUP_TESTS: "", MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS: "",
			MYCLI_WINDOWS_SANDBOX_EVIDENCE: evidencePath },
	});
	assert.equal(run(path).status, 1);
	const evidence = JSON.parse(await readFile(path, "utf8"));
	assert.equal(evidence.status, "not_run");
	assert.equal(evidence.fresh_setup, false);
	const failed = run(root);
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /windows_sandbox_evidence_write_failed/u);
	assert.ok(!failed.stderr.includes(root));
});
