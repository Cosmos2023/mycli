import {
	CachedUpdateError,
	type CachedUpdateService,
	type CachedUpdateStatus,
	type UpdateRefreshOutcome,
} from "@mycli/config";
import type { ManagementResponse } from "./types.ts";

export const UPDATE_MANAGEMENT_RESPONSE_VERSION = 1 as const;

export type UpdateManagementAction = "check" | "dismiss" | "status";

export interface UpdateManagementResponse extends ManagementResponse {
	readonly version: typeof UPDATE_MANAGEMENT_RESPONSE_VERSION;
	readonly action: UpdateManagementAction;
	readonly status: CachedUpdateStatus;
	readonly dismissedVersion?: string;
	readonly refreshOutcome?: UpdateRefreshOutcome;
}

export interface UpdateManagementServiceOptions {
	readonly cache: CachedUpdateService;
	readonly checkOnStartup: () => boolean | Promise<boolean>;
}

export class UpdateManagementService {
	readonly #options: UpdateManagementServiceOptions;

	constructor(options: UpdateManagementServiceOptions) {
		this.#options = options;
	}

	async status(signal: AbortSignal): Promise<UpdateManagementResponse> {
		const status = await this.readStatus(signal);
		return response("status", status, updateStatusMessage(status));
	}

	async check(signal: AbortSignal): Promise<UpdateManagementResponse> {
		signal.throwIfAborted();
		const checkOnStartup = await this.#options.checkOnStartup();
		const refreshed = await this.#options.cache.refreshNow(checkOnStartup);
		signal.throwIfAborted();
		return response(
			"check",
			refreshed.status,
			refreshed.outcome === "failed"
				? "update check failed; cached state was preserved"
				: updateStatusMessage(refreshed.status),
			{
				refreshOutcome: refreshed.outcome,
				...(refreshed.outcome === "failed"
					? { ok: false, issues: Object.freeze(["update_check_failed"]), exitCode: 1 }
					: {}),
			},
		);
	}

	async dismiss(version: string, signal: AbortSignal): Promise<UpdateManagementResponse> {
		signal.throwIfAborted();
		const checkOnStartup = await this.#options.checkOnStartup();
		try {
			const status = await this.#options.cache.dismiss(version, checkOnStartup);
			signal.throwIfAborted();
			return response("dismiss", status, `dismissed update ${version}`, {
				dismissedVersion: version,
			});
		} catch (error) {
			if (!(error instanceof CachedUpdateError)) throw error;
			const status = await this.#options.cache.status(checkOnStartup);
			return response("dismiss", status, updateErrorMessage(error.code), {
				ok: false,
				issues: Object.freeze([error.code]),
				exitCode: 1,
			});
		}
	}

	async readStatus(signal = new AbortController().signal): Promise<CachedUpdateStatus> {
		signal.throwIfAborted();
		const checkOnStartup = await this.#options.checkOnStartup();
		const status = await this.#options.cache.status(checkOnStartup);
		signal.throwIfAborted();
		return status;
	}
}

function response(
	action: UpdateManagementAction,
	status: CachedUpdateStatus,
	message: string,
	extra: Partial<UpdateManagementResponse> = {},
): UpdateManagementResponse {
	return Object.freeze({
		version: UPDATE_MANAGEMENT_RESPONSE_VERSION,
		ok: true,
		action,
		message,
		status,
		...extra,
	});
}

function updateStatusMessage(status: CachedUpdateStatus): string {
	if (status.availability === "available") return `mycli ${status.latestVersion ?? "update"} is available`;
	if (status.availability === "dismissed") return `update ${status.latestVersion ?? ""} is dismissed`.trim();
	if (status.availability === "current") return "mycli is up to date";
	if (status.availability === "disabled") return "startup update checks are disabled";
	return "no cached update status is available";
}

function updateErrorMessage(code: CachedUpdateError["code"]): string {
	if (code === "invalid_update_version") return "update version must be a stable semantic version";
	if (code === "update_version_unavailable") return "that update version is not currently advertised";
	return "update dismissal could not be saved";
}
