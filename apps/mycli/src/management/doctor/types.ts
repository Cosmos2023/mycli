export type DoctorStatus = "ok" | "warning" | "failed";

export interface DoctorCheck {
	readonly name: string;
	readonly status: DoctorStatus;
	readonly message: string;
	readonly detail?: string;
}

export interface DoctorReport {
	readonly checks: readonly DoctorCheck[];
	readonly okCount: number;
	readonly warningCount: number;
	readonly failedCount: number;
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
