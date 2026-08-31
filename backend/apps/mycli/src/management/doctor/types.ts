import type {
	DiagnosticCategory,
	DiagnosticRecoveryAction,
} from "@mycli/contracts";

export type DoctorStatus = "ok" | "warning" | "failed";

export interface DoctorCheck {
	readonly name: string;
	readonly status: DoctorStatus;
	readonly message: string;
	readonly detail?: string;
	readonly category?: DiagnosticCategory;
	readonly code?: string;
	readonly summary?: string;
	readonly details?: readonly string[];
	readonly remediation?: string;
	readonly recoveryActions?: readonly DiagnosticRecoveryAction[];
}

export interface DoctorDiagnosticCheck extends DoctorCheck {
	readonly category: DiagnosticCategory;
	readonly code: string;
	readonly summary: string;
	readonly details: readonly string[];
	readonly recoveryActions: readonly DiagnosticRecoveryAction[];
	readonly durationMs: number;
}

export interface DoctorSupportManifest {
	readonly schemaVersion: 1;
	readonly mycliVersion: string;
	readonly nodeVersion: string;
	readonly platform: NodeJS.Platform;
	readonly architecture: string;
	readonly diagnosticCodes: readonly string[];
	readonly logReferences: readonly string[];
}

export interface DoctorReport {
	readonly schemaVersion: 1;
	readonly checks: readonly DoctorDiagnosticCheck[];
	readonly okCount: number;
	readonly warningCount: number;
	readonly failedCount: number;
	readonly support: DoctorSupportManifest;
}

export type DoctorCollectorResult = DoctorCheck | readonly DoctorCheck[];

export interface DoctorCollector {
	readonly name: string;
	collect(signal: AbortSignal): DoctorCollectorResult | Promise<DoctorCollectorResult>;
}

export interface DoctorManagementResponse extends DoctorReport {
	readonly ok: boolean;
	readonly action: "doctor";
	readonly message: "mycli doctor";
	readonly exitCode: 0 | 1;
}
