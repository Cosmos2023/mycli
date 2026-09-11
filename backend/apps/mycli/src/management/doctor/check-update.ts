import type { CachedUpdateStatus } from "@mycli/config";
import { diagnosticRecoveryAction } from "@mycli/contracts";
import type { DoctorCheck } from "./types.ts";

export async function collectUpdateChecks(
	loadStatus: () => CachedUpdateStatus | Promise<CachedUpdateStatus>,
): Promise<readonly DoctorCheck[]> {
	const status = await loadStatus();
	const detail = [
		`cache=${status.cacheState}`,
		`current=${status.currentVersion}`,
		...(status.latestVersion ? [`latest=${status.latestVersion}`] : []),
		`startup_check=${status.checkOnStartup ? "enabled" : "disabled"}`,
	].join(" ");
	if (status.availability === "disabled") {
		return Object.freeze([check("ok", "update checks disabled by user configuration", detail)]);
	}
	if (status.availability === "available") {
		return Object.freeze([check(
			"warning",
			`mycli ${status.latestVersion ?? "update"} is available`,
			detail,
			`Run ${status.install.command} manually, or dismiss this exact version.`,
		)]);
	}
	if (status.availability === "dismissed") {
		return Object.freeze([check("ok", "cached update was dismissed", detail)]);
	}
	if (status.cacheState === "invalid" || status.cacheState === "unreadable") {
		return Object.freeze([check(
			"warning",
			"update cache is unavailable",
			detail,
			"Run mycli update check to replace the cache with a validated result.",
		)]);
	}
	if (status.cacheState === "missing" || status.cacheState === "stale") {
		return Object.freeze([check(
			"warning",
			status.cacheState === "missing" ? "update cache has not been initialized" : "update cache is stale",
			detail,
			"Run mycli update check or restart mycli with startup checks enabled.",
		)]);
	}
	return Object.freeze([check("ok", "mycli is up to date", detail)]);
}

function check(
	status: DoctorCheck["status"],
	message: string,
	detail: string,
	remediation?: string,
): DoctorCheck {
	return Object.freeze({
		name: "updates",
		status,
		message,
		detail,
		category: "update",
		code: status === "ok" ? "update_ready" : "update_attention_required",
		...(remediation ? { remediation } : {}),
		...(status === "ok"
			? {}
			: { recoveryActions: Object.freeze([diagnosticRecoveryAction("check_for_updates")]) }),
	});
}
