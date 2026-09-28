import { assertWindowsSuiteSummary, windowsSandboxSuites } from "./windows-sandbox-release-checks.mjs";

const FAILURE_CODES = new Set([
	"windows_sandbox_helper_manifest_stale", "windows_sandbox_source_helper_missing",
	"windows_sandbox_vendored_helper_stale", "windows_sandbox_gate_handshake_invalid",
	"windows_sandbox_backend_changed", "windows_sandbox_helper_changed",
	"windows_sandbox_suite_incomplete",
]);
const COUNTERS = ["tests", "passed", "failed", "skipped", "cancelled", "todo"];

function safeVersion(value) {
	return typeof value === "string" && /^v?\d+(?:\.\d+){1,3}$/u.test(value) && value.length <= 48
		? value : "unknown";
}

function helperHash(value) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
		throw new Error("windows_sandbox_source_helper_missing");
	}
	return value;
}

function safeCounts(value) {
	if (!value || !COUNTERS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) return undefined;
	return Object.fromEntries(COUNTERS.map((key) => [key, value[key]]));
}

/** Runs the strict gate; callbacks own native IO, this owner retains only bounded facts. */
export async function runWindowsSandboxAcceptance(options) {
	const evidence = {
		schema_version: 1,
		kind: "windows_sandbox_source_acceptance",
		status: "not_run",
		stage: "preflight",
		// This gate runs on an already initialized host. Installed-package smoke owns fresh setup.
		fresh_setup: false,
		platform: ["win32", "darwin", "linux"].includes(options.platform) ? options.platform : "unknown",
		os_release: safeVersion(options.osRelease),
		node_version: safeVersion(options.nodeVersion),
		arch: ["x64", "arm64", "ia32"].includes(options.arch) ? options.arch : "unknown",
		suites: [],
	};
	if (options.platform !== "win32" || options.setupOptIn !== true || options.maintenanceOptIn !== true) {
		return { ...evidence, code: "windows_sandbox_gate_requires_windows_and_both_maintenance_opt_ins" };
	}
	try {
		evidence.status = "failed";
		evidence.stage = "identity_before";
		evidence.helper_sha256 = helperHash(await options.verifyIdentity());
		evidence.stage = "readiness_before";
		const before = await options.handshake();
		const selected = windowsSandboxSuites(before);
		evidence.backend = before.backend;
		evidence.suites = selected.map((suite) => ({ ...suite, status: "not_run" }));
		evidence.stage = "suites";
		for (const suite of evidence.suites) {
			suite.status = "failed";
			const counts = await options.runSuite(suite.file);
			const bounded = safeCounts(counts);
			if (bounded) suite.counts = bounded;
			assertWindowsSuiteSummary(bounded, suite.count);
			suite.status = "passed";
		}
		evidence.stage = "readiness_after";
		const after = await options.handshake();
		windowsSandboxSuites(after);
		if (after.backend !== before.backend) throw new Error("windows_sandbox_backend_changed");
		evidence.stage = "identity_after";
		evidence.final_helper_sha256 = helperHash(await options.verifyIdentity());
		if (evidence.helper_sha256 !== evidence.final_helper_sha256) throw new Error("windows_sandbox_helper_changed");
		evidence.status = "completed";
		evidence.stage = "completed";
		return evidence;
	} catch (error) {
		return { ...evidence, code: error instanceof Error && FAILURE_CODES.has(error.message)
			? error.message : "windows_sandbox_suite_incomplete" };
	}
}
