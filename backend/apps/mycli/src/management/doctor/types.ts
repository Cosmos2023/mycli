import type {
	DiagnosticCategory,
	DiagnosticRecoveryAction,
} from "@mycli/contracts";
import type {
	ConfigLayerDisabledReason,
	ConfigLayerId,
	ConfigLayerScope,
	WorkspaceTrustState,
} from "@mycli/config";

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

export type DoctorRepairActionId = "migrate_user_config";
type DoctorRepairResultStatus = "applied" | "failed" | "not_needed" | "version_conflict";

interface DoctorRepairChange {
	readonly kind: "import" | "normalize";
	readonly key: string;
	readonly source: "legacy_user" | "user";
	readonly effectiveSource: string;
	readonly overridden: readonly string[];
}

export interface DoctorRepairAction {
	readonly id: DoctorRepairActionId;
	readonly category: DiagnosticCategory;
	readonly code: string;
	readonly summary: string;
	readonly expectedVersion: string;
	readonly effects: readonly string[];
	readonly changes: readonly DoctorRepairChange[];
	readonly truncated: boolean;
}

export interface DoctorRepairPlan {
	readonly schemaVersion: 1;
	readonly planId: string;
	readonly confirmationRequired: boolean;
	readonly actions: readonly DoctorRepairAction[];
}

export interface DoctorRepairResult {
	readonly id: DoctorRepairActionId;
	readonly status: DoctorRepairResultStatus;
	readonly code: string;
	readonly changed: boolean;
	readonly backupId?: string;
}

export interface DoctorRepairExecution {
	readonly schemaVersion: 1;
	readonly mode: "apply" | "preview";
	readonly status: "completed" | "failed" | "not_needed" | "partial_failure" | "preview" | "version_conflict";
	readonly code: string;
	readonly plan: DoctorRepairPlan;
	readonly results: readonly DoctorRepairResult[];
}

export interface DoctorSupportDiagnostic {
	readonly category: DiagnosticCategory;
	readonly code: string;
	readonly status: DoctorStatus;
	readonly summary: string;
	readonly details: readonly string[];
	readonly remediation?: string;
	readonly recoveryActionIds: readonly string[];
}

interface DoctorSupportConfigLayer {
	readonly id: ConfigLayerId;
	readonly scope: ConfigLayerScope;
	readonly enabled: boolean;
	readonly disabledReason?: ConfigLayerDisabledReason;
}

export interface DoctorSupportReadinessSummary {
	readonly status: DoctorStatus;
	readonly codes: readonly string[];
}

export interface DoctorSupportBundle {
	readonly schemaVersion: 1;
	readonly runtime: DoctorSupportManifest;
	readonly configuration: Readonly<{
		readonly workspaceTrust: WorkspaceTrustState;
		readonly layers: readonly DoctorSupportConfigLayer[];
	}>;
	readonly readiness: Readonly<{
		readonly sandbox: Readonly<{
			readonly state: string;
			readonly code: string;
			readonly platform: NodeJS.Platform;
			readonly isolation: string;
			readonly helperVersion?: number;
			readonly helperCompatible?: boolean;
			readonly setupComplete?: boolean;
			readonly sandboxReady?: boolean;
		}>;
		readonly sessions: DoctorSupportReadinessSummary;
		readonly extensions: DoctorSupportReadinessSummary;
	}>;
	readonly diagnostics: readonly DoctorSupportDiagnostic[];
}

export interface DoctorSupportBundleReceipt {
	readonly schemaVersion: 1;
	readonly location: ".mycli/support/diagnostic-support.json";
	readonly bytes: number;
	readonly sha256: string;
}

export type DoctorCollectorResult = DoctorCheck | readonly DoctorCheck[];

export interface DoctorCollector {
	readonly name: string;
	collect(signal: AbortSignal): DoctorCollectorResult | Promise<DoctorCollectorResult>;
}

export interface DoctorManagementResponse extends DoctorReport {
	readonly ok: boolean;
	readonly action: "doctor";
	readonly operation: "check" | "fix" | "support";
	readonly message: "mycli doctor";
	readonly issues?: readonly string[];
	readonly exitCode: 0 | 1;
	readonly repair?: DoctorRepairExecution;
	readonly bundle?: DoctorSupportBundleReceipt;
}
