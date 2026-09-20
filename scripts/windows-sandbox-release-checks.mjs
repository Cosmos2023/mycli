const MAX_RESPONSE_BYTES = 16_384;
const WINDOWS_ISOLATIONS = new Set(["windows_restricted_token", "windows_psec"]);
export const WINDOWS_SANDBOX_TEST_COUNT = 13;
export const WINDOWS_PSEC_PARITY_TEST_COUNT = 7;
export const WINDOWS_SANDBOX_SETUP_TIMEOUT_MS = 330_000;

/**
 * The M7 smoke imports the vendored application tree, so a promoted helper can be
 * silently ignored when that copy is stale. Absence is allowed: the packed smoke
 * re-vendors before it runs.
 */
export function assertVendoredSandboxHelperIdentity(sourceHash, vendoredHash) {
	if (vendoredHash === undefined) return false;
	if (sourceHash === undefined) throw new Error("windows_sandbox_source_helper_missing");
	if (sourceHash !== vendoredHash) throw new Error("windows_sandbox_vendored_helper_stale");
	return true;
}

export function packedSandboxOptions(argv, platform = process.platform) {
	const supported = new Set(["--all-platforms", "--app-only", "--require-windows-helper",
		"--require-windows-ready", "--setup-windows-sandbox"]);
	const flags = new Set();
	let artifactDirectory;
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--artifacts-dir") {
			artifactDirectory = argv[++index];
			if (!artifactDirectory || artifactDirectory.startsWith("--")) {
				throw new Error("packed_smoke_artifacts_directory_required");
			}
		} else {
			if (!supported.has(value)) throw new Error("packed_smoke_unknown_option");
			flags.add(value);
		}
	}
	const requireReady = flags.has("--require-windows-ready");
	const setup = flags.has("--setup-windows-sandbox");
	const requireHelper = flags.has("--require-windows-helper") || requireReady;
	if (setup && !requireReady) throw new Error("windows_setup_requires_readiness_gate");
	if (requireReady && platform !== "win32") throw new Error("windows_readiness_requires_windows");
	if (flags.has("--app-only") && (flags.has("--all-platforms") || requireHelper)) {
		throw new Error("app_only_incompatible_with_platform_gates");
	}
	return { requireReady, requireHelper, setup, ...(artifactDirectory ? { artifactDirectory } : {}) };
}

function response(output, action) {
	if (typeof output !== "string" || Buffer.byteLength(output) > MAX_RESPONSE_BYTES) {
		throw new Error("windows_sandbox_response_invalid");
	}
	let value;
	try { value = JSON.parse(output); } catch { throw new Error("windows_sandbox_response_invalid"); }
	if (!value || value.action !== action || typeof value.ok !== "boolean"
		|| value.readiness?.platform !== "win32"
		|| !WINDOWS_ISOLATIONS.has(value.readiness.isolation)) {
		throw new Error("windows_sandbox_response_invalid");
	}
	return value;
}

export function assertWindowsReady(output, action = "status") {
	const value = response(output, action);
	const readiness = value.readiness;
	if (value.ok !== true || value.exitCode !== 0 || readiness.state !== "ready"
		|| readiness.code !== "ready" || readiness.helperCompatible !== true
		|| readiness.setupComplete !== true || readiness.sandboxReady !== true) {
		throw new Error("windows_sandbox_not_ready");
	}
	if (action === "setup" && (value.result?.status !== "completed"
		|| value.result.code !== "setup_completed")) {
		throw new Error("windows_sandbox_setup_not_completed");
	}
	return readiness;
}

export async function verifyInstalledWindowsSandbox({ runStatus, runSetup, setup = false }) {
	let selectedIsolation;
	if (setup) {
		const before = response(await runStatus(false), "status");
		const readiness = before.readiness;
		selectedIsolation = readiness.isolation;
		if (before.ok !== false || before.exitCode !== 1
			|| readiness.state !== "setup_required" || readiness.code !== "setup_incomplete"
			|| readiness.helperCompatible !== true || readiness.setupComplete !== false
			|| readiness.sandboxReady !== false || readiness.managedStatePresent !== false) {
			throw new Error("windows_sandbox_clean_setup_required");
		}
		if (assertWindowsReady(await runSetup(), "setup").isolation !== selectedIsolation) {
			throw new Error("windows_sandbox_backend_changed");
		}
	}
	const readiness = assertWindowsReady(await runStatus(true));
	if (selectedIsolation !== undefined && readiness.isolation !== selectedIsolation) {
		throw new Error("windows_sandbox_backend_changed");
	}
	return { state: "ready", isolation: readiness.isolation, fresh_setup: setup };
}

export function windowsSandboxSuites(handshake) {
	if (handshake?.name !== "mycli-windows-sandbox" || handshake.protocol_version !== 2
		|| handshake.setup_complete !== true || handshake.sandbox_ready !== true
		|| !["restricted_token", "psec"].includes(handshake.backend)) {
		throw new Error("windows_sandbox_gate_handshake_invalid");
	}
	return [
		{ file: "windows-sandbox.platform.test.ts", count: WINDOWS_SANDBOX_TEST_COUNT },
		...(handshake.backend === "psec"
			? [{ file: "windows-psec-parity.platform.test.ts", count: WINDOWS_PSEC_PARITY_TEST_COUNT }] : []),
	];
}

export function assertWindowsSuiteSummary(counts, expected = WINDOWS_SANDBOX_TEST_COUNT) {
	if (![WINDOWS_SANDBOX_TEST_COUNT, WINDOWS_PSEC_PARITY_TEST_COUNT].includes(expected)
		|| !counts || counts.tests !== expected
		|| counts.passed !== expected || counts.failed !== 0
		|| counts.skipped !== 0 || counts.cancelled !== 0 || counts.todo !== 0) {
		throw new Error("windows_sandbox_suite_incomplete");
	}
}

export function assertWindowsPackageEvidence(evidence, expected) {
	const sandbox = evidence?.windows_sandbox;
	if (evidence?.status !== "completed" || sandbox?.state !== "ready"
		|| !WINDOWS_ISOLATIONS.has(sandbox.isolation) || sandbox.fresh_setup !== true
		|| sandbox.source_dirty !== false || sandbox.source_commit !== expected.commit
		|| sandbox.candidate_version !== expected.version
		|| sandbox.candidate_sha256 !== expected.candidateHash
		|| sandbox.helper_sha256 !== expected.helperHash
		|| !/^[a-f0-9]{64}$/u.test(sandbox.candidate_sha256)
		|| !/^[a-f0-9]{64}$/u.test(sandbox.helper_sha256)) {
		throw new Error("release_windows_package_evidence_invalid");
	}
}
