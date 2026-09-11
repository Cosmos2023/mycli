import {
	inspectSandboxReadiness,
	type SandboxReadinessProbes,
} from "@mycli/tools";
import {
	sandboxReadinessMessage,
	sandboxReadinessRemediation,
} from "../sandbox.ts";
import type { DoctorCheck } from "./types.ts";

interface ProcessDoctorOptions extends SandboxReadinessProbes {
	readonly workspaceRoot: string;
}

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);

export async function collectProcessChecks(
	options: ProcessDoctorOptions,
	signal?: AbortSignal,
): Promise<readonly DoctorCheck[]> {
	const platform = options.platform ?? process.platform;
	const supported = SUPPORTED_PLATFORMS.has(platform);
	const readiness = await inspectSandboxReadiness(options, signal);
	const sandboxReady = readiness.state === "ready" || readiness.state === "not_required";
	const remediation = sandboxReadinessRemediation(readiness);
	const sandbox = check(
		"process_sandbox",
		sandboxReady ? "ok" : "failed",
		sandboxReadinessMessage(readiness),
		remediation,
	);
	return Object.freeze([
		check(
			"process_support",
			supported ? "ok" : "failed",
			supported ? `platform=${platform} process_tree_cleanup=available` : "platform unsupported",
		),
		sandbox,
	]);
}

function check(
	name: string,
	status: DoctorCheck["status"],
	message: string,
	detail?: string,
): DoctorCheck {
	return Object.freeze({ name, status, message, ...(detail ? { detail } : {}) });
}
