import type { SandboxCapabilities } from "@mycli/contracts";
import type { SandboxReadiness } from "./sandbox-readiness.ts";

/** Describes the known backend, independently of setup state and session grants. */
export function windowsSandboxCapabilities(readiness: SandboxReadiness): SandboxCapabilities | undefined {
	if (readiness.platform !== "win32" || readiness.state === "not_required") return undefined;
	const known = readiness.helperCompatible === true
		&& readiness.code !== "handshake_failed"
		&& (readiness.isolation === "windows_psec" || readiness.isolation === "windows_restricted_token");
	const advanced = known
		? readiness.isolation === "windows_psec" ? "supported" : "unsupported"
		: "unknown";
	return Object.freeze({
		filesystem_rules: advanced,
		denied_reads: known ? "supported" : "unknown",
		structured_egress: advanced,
		independent_policies: advanced,
		host_loopback_access: known && readiness.isolation === "windows_psec" ? "unsupported" : "unknown",
	});
}
