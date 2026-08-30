import {
	inspectSandboxReadiness,
	type SandboxReadiness,
	type SandboxReadinessCode,
	type SandboxReadinessProbes,
} from "@mycli/tools";
import type { ManagementResponse } from "./types.ts";

export interface SandboxStatusManagementResponse extends ManagementResponse {
	readonly action: "status";
	readonly message: "mycli sandbox status";
	readonly readiness: SandboxReadiness;
	readonly remediation?: string;
	readonly exitCode: 0 | 1;
}

export async function inspectSandboxStatus(
	probes: SandboxReadinessProbes = {},
	signal?: AbortSignal,
): Promise<SandboxStatusManagementResponse> {
	return sandboxStatusResponse(await inspectSandboxReadiness(probes, signal));
}

export function sandboxStatusResponse(
	readiness: SandboxReadiness,
): SandboxStatusManagementResponse {
	const ok = readiness.state === "ready" || readiness.state === "not_required";
	const remediation = sandboxReadinessRemediation(readiness.code);
	return Object.freeze({
		ok,
		action: "status",
		message: "mycli sandbox status",
		readiness,
		...(remediation ? { remediation } : {}),
		...(ok ? {} : { issues: Object.freeze([readiness.code]) }),
		exitCode: ok ? 0 : 1,
	});
}

export function sandboxReadinessMessage(readiness: SandboxReadiness): string {
	switch (readiness.state) {
		case "ready":
			return `state=ready code=${readiness.code} isolation=${readiness.isolation}`;
		case "not_required":
			return `state=not_required code=${readiness.code} isolation=none`;
		case "setup_required":
			return `state=setup_required code=${readiness.code} isolation=${readiness.isolation}`;
		case "unavailable":
			return `state=unavailable code=${readiness.code} isolation=${readiness.isolation}`;
	}
}

export function sandboxReadinessRemediation(code: SandboxReadinessCode): string | undefined {
	switch (code) {
		case "setup_incomplete":
			return "Complete the platform sandbox setup from an elevated terminal, then check again.";
		case "helper_missing":
			return "Reinstall mycli or install the required platform sandbox helper, then check again.";
		case "handshake_failed":
			return "Restart the terminal and reinstall mycli if the sandbox handshake still fails.";
		case "enforcement_unavailable":
			return "Repair the platform sandbox setup before using a restricted permission profile.";
		case "unsupported_platform":
			return "Use a supported platform or select Full Access explicitly.";
		case "ready":
		case "not_required":
			return undefined;
	}
}
