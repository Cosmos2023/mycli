import { execFile } from "node:child_process";
import {
	inspectSandboxReadiness,
	packagedWindowsSandboxHelper,
	type SandboxReadiness,
	type SandboxReadinessProbes,
} from "./sandbox-readiness.ts";

const WINDOWS_OPERATION_TIMEOUT_MS = 300_000;
const WINDOWS_OPERATION_MAX_BYTES = 16_384;

export type SandboxRecoveryAction = "setup" | "reset" | "repair" | "uninstall";
export type SandboxRecoveryPrivilege = "none" | "windows_uac" | "manual_install";
export type SandboxRecoveryEffect =
	| "initialize_windows_identity"
	| "configure_windows_firewall"
	| "clear_windows_setup_state"
	| "stop_windows_sandbox_processes"
	| "clean_windows_sandbox_acls"
	| "remove_windows_sandbox_accounts"
	| "remove_windows_sandbox_network_rules"
	| "install_platform_dependency";
export type SandboxRecoveryStatus =
	| "confirmation_required"
	| "completed"
	| "partial"
	| "not_needed"
	| "manual_action_required"
	| "unsupported"
	| "canceled"
	| "failed";
export type SandboxRecoveryCode =
	| "confirmation_required"
	| "setup_completed"
	| "reset_completed"
	| "repair_completed"
	| "uninstall_completed"
	| "already_ready"
	| "no_managed_state"
	| "dependency_install_required"
	| "helper_missing"
	| "helper_version_mismatch"
	| "handshake_failed"
	| "enforcement_unavailable"
	| "unsupported_platform"
	| "operation_canceled"
	| "interrupted"
	| "operation_failed"
	| "verification_failed";

export interface SandboxRecoveryPreview {
	readonly action: SandboxRecoveryAction;
	readonly confirmationRequired: boolean;
	readonly confirmationFlag?: "--confirm";
	readonly privilege: SandboxRecoveryPrivilege;
	readonly effects: readonly SandboxRecoveryEffect[];
}

export interface SandboxRecoveryResult {
	readonly status: SandboxRecoveryStatus;
	readonly code: SandboxRecoveryCode;
	readonly preview: SandboxRecoveryPreview;
	readonly before: SandboxReadiness;
	readonly after: SandboxReadiness;
}

export type WindowsSandboxOperationOutcome = "completed" | "canceled" | "failed";

export interface WindowsSandboxOperationInput {
	readonly helperPath: string;
	readonly action: SandboxRecoveryAction;
	readonly signal?: AbortSignal;
}

export interface SandboxRecoveryProbes extends SandboxReadinessProbes {
	readonly runWindowsOperation?: (
		input: WindowsSandboxOperationInput,
	) => Promise<WindowsSandboxOperationOutcome>;
}

export async function runSandboxRecovery(
	action: SandboxRecoveryAction,
	confirmed: boolean,
	probes: SandboxRecoveryProbes = {},
	signal?: AbortSignal,
): Promise<SandboxRecoveryResult> {
	const before = await inspectSandboxReadiness(probes, signal);
	const plan = planSandboxRecovery(action, before);
	if (plan.terminal) return result(plan.terminal.status, plan.terminal.code, plan.preview, before);
	if (!confirmed) {
		return result("confirmation_required", "confirmation_required", plan.preview, before);
	}

	const helperPath = probes.windowsHelperPath ?? packagedWindowsSandboxHelper();
	const outcome = await (probes.runWindowsOperation ?? runWindowsSandboxOperation)({
		helperPath,
		action,
		...(signal ? { signal } : {}),
	});
	const after = await inspectSandboxReadiness(probes, signal);
	if (outcome === "canceled") {
		return result("canceled", "operation_canceled", plan.preview, before, after);
	}
	if (outcome === "failed") {
		return result("failed", "operation_failed", plan.preview, before, after);
	}
	if (action === "reset" || action === "uninstall") {
		const resetVerified = after.state === "setup_required"
			&& after.code === "setup_incomplete"
			&& after.helperCompatible === true
			&& after.setupComplete === false
			&& after.sandboxReady === false
			&& (action !== "uninstall" || after.managedStatePresent === false);
		return resetVerified
			? result("completed", action === "uninstall" ? "uninstall_completed" : "reset_completed", plan.preview, before, after)
			: result("failed", "verification_failed", plan.preview, before, after);
	}
	if (after.state === "ready") {
		return result("completed", action === "repair" ? "repair_completed" : "setup_completed", plan.preview, before, after);
	}
	if (after.setupComplete === true && after.code === "enforcement_unavailable") {
		return result("partial", "enforcement_unavailable", plan.preview, before, after);
	}
	return result("failed", "verification_failed", plan.preview, before, after);
}

export function planSandboxRecovery(
	action: SandboxRecoveryAction,
	readiness: SandboxReadiness,
): Readonly<{
	readonly preview: SandboxRecoveryPreview;
	readonly terminal?: Readonly<{
		readonly status: Exclude<SandboxRecoveryStatus, "confirmation_required" | "completed">;
		readonly code: SandboxRecoveryCode;
	}>;
}> {
	if (readiness.platform === "darwin" || readiness.platform === "linux") {
		if (action === "reset" || action === "uninstall") {
			return terminalPlan(action, "not_needed", "no_managed_state", "none", []);
		}
		return readiness.state === "ready"
			? terminalPlan(action, "not_needed", "already_ready", "none", [])
			: terminalPlan(
				action,
				"manual_action_required",
				"dependency_install_required",
				"manual_install",
				["install_platform_dependency"],
			);
	}
	if (readiness.platform !== "win32") {
		return terminalPlan(action, "unsupported", "unsupported_platform", "none", []);
	}
	if (readiness.code === "helper_missing") {
		return terminalPlan(action, "failed", "helper_missing", "none", []);
	}
	if (readiness.helperCompatible === false) {
		return terminalPlan(action, "failed", "helper_version_mismatch", "none", []);
	}
	if (readiness.code === "handshake_failed") {
		return terminalPlan(action, "failed", "handshake_failed", "none", []);
	}
	if (action === "repair" || action === "uninstall") {
		return executablePlan(action, "windows_uac", [
			"stop_windows_sandbox_processes",
			"clean_windows_sandbox_acls",
			...(action === "uninstall" ? ["remove_windows_sandbox_network_rules", "remove_windows_sandbox_accounts", "clear_windows_setup_state"] as const
				: ["initialize_windows_identity", "configure_windows_firewall"] as const),
		]);
	}
	if (action === "setup") {
		if (readiness.state === "ready") {
			return terminalPlan(action, "not_needed", "already_ready", "none", []);
		}
		if (readiness.code === "enforcement_unavailable") {
			return terminalPlan(
				action,
				"manual_action_required",
				"enforcement_unavailable",
				"none",
				[],
			);
		}
		return executablePlan(action, "windows_uac", [
			"initialize_windows_identity",
			"configure_windows_firewall",
		]);
	}
	return executablePlan(action, "none", ["clean_windows_sandbox_acls", "clear_windows_setup_state"]);
}

function executablePlan(
	action: SandboxRecoveryAction,
	privilege: SandboxRecoveryPrivilege,
	effects: readonly SandboxRecoveryEffect[],
): ReturnType<typeof planSandboxRecovery> {
	return Object.freeze({
		preview: preview(action, true, privilege, effects),
	});
}

function terminalPlan(
	action: SandboxRecoveryAction,
	status: Exclude<SandboxRecoveryStatus, "confirmation_required" | "completed">,
	code: SandboxRecoveryCode,
	privilege: SandboxRecoveryPrivilege,
	effects: readonly SandboxRecoveryEffect[],
): ReturnType<typeof planSandboxRecovery> {
	return Object.freeze({
		preview: preview(action, false, privilege, effects),
		terminal: Object.freeze({ status, code }),
	});
}

function preview(
	action: SandboxRecoveryAction,
	confirmationRequired: boolean,
	privilege: SandboxRecoveryPrivilege,
	effects: readonly SandboxRecoveryEffect[],
): SandboxRecoveryPreview {
	return Object.freeze({
		action,
		confirmationRequired,
		...(confirmationRequired ? { confirmationFlag: "--confirm" as const } : {}),
		privilege,
		effects: Object.freeze([...effects]),
	});
}

function result(
	status: SandboxRecoveryStatus,
	code: SandboxRecoveryCode,
	previewValue: SandboxRecoveryPreview,
	before: SandboxReadiness,
	after: SandboxReadiness = before,
): SandboxRecoveryResult {
	return Object.freeze({ status, code, preview: previewValue, before, after });
}

function runWindowsSandboxOperation(
	input: WindowsSandboxOperationInput,
): Promise<WindowsSandboxOperationOutcome> {
	return new Promise((resolve, reject) => {
		execFile(input.helperPath, [input.action === "setup" ? "--ensure-setup" : `--${input.action}`], {
			encoding: "utf8",
			maxBuffer: WINDOWS_OPERATION_MAX_BYTES,
			timeout: WINDOWS_OPERATION_TIMEOUT_MS,
			windowsHide: true,
			...(input.signal ? { signal: input.signal } : {}),
		}, (error) => {
			if (!error) {
				resolve("completed");
				return;
			}
			if (input.signal?.aborted || error.name === "AbortError") {
				reject(error);
				return;
			}
			resolve(error.code === 2 ? "canceled" : "failed");
		});
	});
}
