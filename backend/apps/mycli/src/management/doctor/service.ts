import type { ConfigShowResponse } from "../config.ts";
import type { WorkspaceTrustState } from "@mycli/config";
import type { SandboxReadiness } from "@mycli/tools";
import type { DoctorManagementCommand } from "../types.ts";
import type {
	SandboxManagementResponse,
	SandboxStatusManagementResponse,
} from "../sandbox.ts";
import {
	buildDoctorSupportBundle,
	writeDoctorSupportBundle,
	type DoctorSupportBundleInput,
} from "./support-bundle.ts";
import {
	configMigrationRepairHandler,
	DoctorRepairService,
	type DoctorConfigMigrationContract,
} from "./repair.ts";
import { doctorResponseFromReport } from "./runner.ts";
import type {
	DoctorManagementResponse,
	DoctorReport,
	DoctorSupportBundle,
	DoctorSupportBundleReceipt,
} from "./types.ts";

type MaybePromise<T> = T | Promise<T>;

interface DoctorConfigContract extends DoctorConfigMigrationContract {
	show(signal: AbortSignal): MaybePromise<ConfigShowResponse>;
}

interface DoctorSandboxContract {
	execute(
		command: Readonly<{ kind: "sandbox"; action: "status"; json: boolean }>,
		signal: AbortSignal,
	): MaybePromise<SandboxManagementResponse>;
}

interface DoctorManagementServiceOptions {
	readonly homeDir: string;
	readonly workspaceTrust: WorkspaceTrustState;
	readonly config: DoctorConfigContract;
	readonly sandbox: DoctorSandboxContract;
	readonly runReport: (signal: AbortSignal) => MaybePromise<DoctorReport>;
	readonly repairService?: DoctorRepairService;
	readonly buildBundle?: (input: DoctorSupportBundleInput) => DoctorSupportBundle;
	readonly writeBundle?: (
		homeDir: string,
		bundle: DoctorSupportBundle,
	) => Promise<DoctorSupportBundleReceipt>;
}

export class DoctorManagementService {
	readonly #options: DoctorManagementServiceOptions;
	readonly #repairService: DoctorRepairService;

	constructor(options: DoctorManagementServiceOptions) {
		this.#options = options;
		this.#repairService = options.repairService ?? new DoctorRepairService([
			configMigrationRepairHandler(options.config),
		]);
	}

	async execute(
		command: DoctorManagementCommand,
		signal: AbortSignal,
	): Promise<DoctorManagementResponse> {
		const report = await this.#options.runReport(signal);
		if (command.operation === "check") return doctorResponseFromReport(report);
		if (command.operation === "fix") {
			try {
				const repair = await this.#repairService.execute(command.expectedPlanId, signal);
				const changed = repair.results.some((result) => result.changed);
				const finalReport = changed ? await this.#options.runReport(signal) : report;
				return doctorResponseFromReport(finalReport, { operation: "fix", repair });
			} catch (error) {
				if (signal.aborted || isAbortError(error)) throw abortError();
				return doctorResponseFromReport(report, {
					operation: "fix",
					issue: "repair_preview_failed",
				});
			}
		}

		try {
			const [config, sandbox] = await Promise.all([
				this.#supportConfig(signal),
				this.#supportSandbox(signal),
			]);
			const bundle = (this.#options.buildBundle ?? buildDoctorSupportBundle)({
				report,
				config,
				sandbox,
			});
			const receipt = await (this.#options.writeBundle ?? writeDoctorSupportBundle)(
				this.#options.homeDir,
				bundle,
			);
			return doctorResponseFromReport(report, { operation: "support", bundle: receipt });
		} catch (error) {
			if (signal.aborted || isAbortError(error)) throw abortError();
			return doctorResponseFromReport(report, {
				operation: "support",
				issue: "support_bundle_write_failed",
			});
		}
	}

	async #supportConfig(signal: AbortSignal): Promise<DoctorSupportBundleInput["config"]> {
		try {
			const config = await this.#options.config.show(signal);
			return Object.freeze({
				workspaceTrust: config.workspaceTrust,
				layers: config.layers,
			});
		} catch (error) {
			if (signal.aborted || isAbortError(error)) throw abortError();
			return Object.freeze({
				workspaceTrust: this.#options.workspaceTrust,
				layers: Object.freeze([]),
			});
		}
	}

	async #supportSandbox(signal: AbortSignal): Promise<SandboxReadiness> {
		try {
			const response = await this.#options.sandbox.execute(
				{ kind: "sandbox", action: "status", json: true },
				signal,
			);
			if (response.action !== "status") throw new Error("invalid_sandbox_status_response");
			return (response as SandboxStatusManagementResponse).readiness;
		} catch (error) {
			if (signal.aborted || isAbortError(error)) throw abortError();
			return Object.freeze({
				state: "unavailable",
				code: "handshake_failed",
				platform: process.platform,
				isolation: "none",
			});
		}
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}
