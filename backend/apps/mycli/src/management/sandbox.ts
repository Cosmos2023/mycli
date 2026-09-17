import {
	inspectSandboxReadiness,
	planSandboxRecovery,
	runSandboxRecovery,
	type SandboxReadiness,
	type SandboxReadinessProbes,
	type SandboxRecoveryCode,
	type SandboxRecoveryPreview,
	type SandboxRecoveryProbes,
	type SandboxRecoveryResult,
	type SandboxRecoveryStatus,
} from "@mycli/tools";
import type {
	ManagementResponse,
	SandboxManagementCommand,
} from "./types.ts";

export interface SandboxManagementResponse extends ManagementResponse {
	readonly action: SandboxManagementCommand["action"];
	readonly message: string;
	readonly readiness: SandboxReadiness;
	readonly preview?: SandboxRecoveryPreview;
	readonly result?: Readonly<{
		readonly status: SandboxRecoveryStatus;
		readonly code: SandboxRecoveryCode;
	}>;
	readonly remediation?: string;
	readonly exitCode: 0 | 1;
}

export interface SandboxStatusManagementResponse extends SandboxManagementResponse {
	readonly action: "status";
	readonly message: "mycli sandbox status";
}

export class SandboxManagementService {
	readonly #probes: SandboxRecoveryProbes;

	constructor(probes: SandboxRecoveryProbes = {}) {
		this.#probes = probes;
	}

	async execute(
		command: SandboxManagementCommand,
		signal?: AbortSignal,
	): Promise<SandboxManagementResponse> {
		if (command.action === "status") return inspectSandboxStatus(this.#probes, signal);
		try {
			return sandboxOperationResponse(await runSandboxRecovery(
				command.action,
				command.confirmed,
				this.#probes,
				signal,
			));
		} catch (error) {
			const readiness = await inspectSandboxReadiness(this.#probes);
			const preview = planSandboxRecovery(command.action, readiness).preview;
			const interrupted = signal?.aborted === true || isAbortError(error);
			return sandboxOperationResponse(Object.freeze({
				status: interrupted ? "canceled" : "failed",
				code: interrupted ? "interrupted" : "operation_failed",
				preview,
				before: readiness,
				after: readiness,
			}));
		}
	}
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
	const remediation = sandboxReadinessRemediation(readiness);
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

export function sandboxOperationResponse(
	recovery: SandboxRecoveryResult,
): SandboxManagementResponse {
	const ok = recovery.status === "completed" || recovery.status === "not_needed";
	const remediation = sandboxRecoveryRemediation(recovery);
	return Object.freeze({
		ok,
		action: recovery.preview.action,
		message: `mycli sandbox ${recovery.preview.action}`,
		readiness: recovery.after,
		preview: recovery.preview,
		result: Object.freeze({ status: recovery.status, code: recovery.code }),
		...(remediation ? { remediation } : {}),
		...(ok ? {} : { issues: Object.freeze([recovery.code]) }),
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

export function sandboxReadinessRemediation(readiness: SandboxReadiness): string | undefined {
	if (readiness.helperCompatible === false) {
		return "Reinstall or update mycli so the packaged sandbox helper matches this runtime.";
	}
	switch (readiness.code) {
		case "setup_incomplete":
			return "Run `mycli sandbox setup`, review the preview, then confirm the setup.";
		case "helper_missing":
			return readiness.platform === "linux"
				? "Install bubblewrap with the operating system package manager, then check again."
				: readiness.platform === "darwin"
					? "Restore the macOS sandbox-exec system component, then check again."
					: "Reinstall mycli so the packaged Windows sandbox helper is restored.";
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

function sandboxRecoveryRemediation(recovery: SandboxRecoveryResult): string | undefined {
	switch (recovery.code) {
		case "confirmation_required":
			return `Review the effects and rerun \`mycli sandbox ${recovery.preview.action} --confirm\`.`;
		case "dependency_install_required":
			return sandboxReadinessRemediation(recovery.after);
		case "helper_missing":
		case "helper_version_mismatch":
		case "handshake_failed":
			return sandboxReadinessRemediation(recovery.after);
		case "enforcement_unavailable":
			return "Setup state exists, but this helper does not advertise enforcement readiness; update or repair mycli before using a restricted profile.";
		case "operation_canceled":
			return "Windows sandbox maintenance was canceled; rerun the command and approve the UAC prompt.";
		case "interrupted":
			return "The sandbox operation was interrupted; check status before retrying.";
		case "operation_failed":
		case "verification_failed":
			return "The sandbox operation did not complete; run `mycli sandbox status` and `mycli doctor --verbose` before retrying.";
		case "unsupported_platform":
			return sandboxReadinessRemediation(recovery.after);
		case "setup_completed":
		case "reset_completed":
		case "repair_completed":
		case "uninstall_completed":
		case "already_ready":
		case "no_managed_state":
			return undefined;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
