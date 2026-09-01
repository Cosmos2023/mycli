import { createHash } from "node:crypto";
import type { ConfigMigrationResponse } from "../config.ts";
import { ConfigManagementError } from "../config.ts";
import type {
	DoctorRepairAction,
	DoctorRepairActionId,
	DoctorRepairExecution,
	DoctorRepairPlan,
	DoctorRepairResult,
} from "./types.ts";

const MIGRATION_VERSION = /^migration-v1-[a-f0-9]{64}$/u;
const SAFE_BACKUP_ID = /^[A-Za-z0-9-]{1,128}$/u;
const SAFE_CONFIG_KEY = /^[a-z][a-z0-9_.-]{0,127}$/u;

type MaybePromise<T> = T | Promise<T>;

export interface DoctorConfigMigrationContract {
	previewMigration(signal: AbortSignal): MaybePromise<ConfigMigrationResponse>;
	applyMigration(expectedVersion: string, signal: AbortSignal): MaybePromise<ConfigMigrationResponse>;
}

export interface DoctorRepairHandler {
	readonly id: DoctorRepairActionId;
	preview(signal: AbortSignal): MaybePromise<DoctorRepairAction | undefined>;
	apply(action: DoctorRepairAction, signal: AbortSignal): MaybePromise<DoctorRepairResult>;
}

export class DoctorRepairService {
	readonly #handlers: readonly DoctorRepairHandler[];

	constructor(handlers: readonly DoctorRepairHandler[]) {
		const ids = handlers.map((handler) => handler.id);
		if (new Set(ids).size !== ids.length) throw new Error("duplicate_doctor_repair_handler");
		this.#handlers = Object.freeze([...handlers]);
	}

	async preview(signal: AbortSignal): Promise<DoctorRepairPlan> {
		const actions: DoctorRepairAction[] = [];
		for (const handler of this.#handlers) {
			signal.throwIfAborted();
			const action = await handler.preview(signal);
			if (action) actions.push(action);
		}
		return repairPlan(actions);
	}

	async execute(
		expectedPlanId: string | undefined,
		signal: AbortSignal,
	): Promise<DoctorRepairExecution> {
		const plan = await this.preview(signal);
		if (expectedPlanId === undefined) {
			return repairExecution("preview", plan.actions.length === 0 ? "not_needed" : "preview", plan, []);
		}
		if (expectedPlanId !== plan.planId) {
			return repairExecution("apply", "version_conflict", plan, []);
		}
		if (plan.actions.length === 0) return repairExecution("apply", "not_needed", plan, []);

		const handlers = new Map(this.#handlers.map((handler) => [handler.id, handler]));
		const results: DoctorRepairResult[] = [];
		for (const action of plan.actions) {
			signal.throwIfAborted();
			const handler = handlers.get(action.id);
			if (!handler) {
				results.push(repairResult(action.id, "failed", "repair_handler_unavailable", false));
				continue;
			}
			try {
				results.push(await handler.apply(action, signal));
			} catch (error) {
				if (signal.aborted || isAbortError(error)) throw abortError();
				results.push(repairResult(action.id, "failed", "repair_failed", false));
			}
		}
		return repairExecution("apply", aggregateDoctorRepairStatus(results), plan, results);
	}
}

export function configMigrationRepairHandler(
	config: DoctorConfigMigrationContract,
): DoctorRepairHandler {
	return Object.freeze({
		id: "migrate_user_config",
		preview: async (signal: AbortSignal): Promise<DoctorRepairAction | undefined> => {
			let preview: ConfigMigrationResponse;
			try {
				preview = await config.previewMigration(signal);
			} catch (error) {
				if (error instanceof ConfigManagementError) return undefined;
				throw error;
			}
			if (!preview.ok || preview.operation !== "preview" || preview.needed !== true) return undefined;
			if (!preview.expectedVersion || !MIGRATION_VERSION.test(preview.expectedVersion)) {
				throw new Error("invalid_doctor_repair_version");
			}
			if (preview.truncated || !preview.changes || preview.changes.length === 0) {
				throw new Error("incomplete_doctor_repair_preview");
			}
			return Object.freeze({
				id: "migrate_user_config",
				category: "migration",
				code: "config_migration_available",
				summary: "Migrate legacy user configuration into the canonical user layer.",
				expectedVersion: preview.expectedVersion,
				effects: Object.freeze([
					"Create a private backup of the current user configuration.",
					"Normalize or import only the listed configuration keys.",
					"Leave credentials and the legacy configuration file unchanged.",
				]),
				changes: Object.freeze(preview.changes.map((change) => Object.freeze({
					kind: change.kind,
					key: SAFE_CONFIG_KEY.test(change.key) ? change.key : "configuration.setting",
					source: change.source,
					effectiveSource: String(change.effectiveSource).slice(0, 64),
					overridden: Object.freeze(change.overridden.map((value) => String(value).slice(0, 64)).slice(0, 8)),
				}))),
				truncated: false,
			});
		},
		apply: async (
			action: DoctorRepairAction,
			signal: AbortSignal,
		): Promise<DoctorRepairResult> => {
			try {
				const response = await config.applyMigration(action.expectedVersion, signal);
				if (!response.ok || response.operation !== "apply") {
					return repairResult(action.id, "failed", "config_migration_failed", false);
				}
				const changed = response.applied === true;
				return repairResult(
					action.id,
					changed ? "applied" : "not_needed",
					changed ? "config_migration_applied" : "config_migration_not_needed",
					changed,
					response.backupId,
				);
			} catch (error) {
				if (signal.aborted || isAbortError(error)) throw abortError();
				if (error instanceof ConfigManagementError && error.diagnostic.code === "version_conflict") {
					return repairResult(action.id, "version_conflict", "version_conflict", false);
				}
				return repairResult(action.id, "failed", "config_migration_failed", false);
			}
		},
	});
}

function repairPlan(actions: readonly DoctorRepairAction[]): DoctorRepairPlan {
	const frozenActions = Object.freeze([...actions]);
	const digest = createHash("sha256")
		.update(JSON.stringify({ schemaVersion: 1, actions: frozenActions }), "utf8")
		.digest("hex");
	return Object.freeze({
		schemaVersion: 1,
		planId: `doctor-plan-v1-${digest}`,
		confirmationRequired: frozenActions.length > 0,
		actions: frozenActions,
	});
}

function repairExecution(
	mode: DoctorRepairExecution["mode"],
	status: DoctorRepairExecution["status"],
	plan: DoctorRepairPlan,
	results: readonly DoctorRepairResult[],
): DoctorRepairExecution {
	return Object.freeze({
		schemaVersion: 1,
		mode,
		status,
		code: repairExecutionCode(status),
		plan,
		results: Object.freeze([...results]),
	});
}

function repairExecutionCode(status: DoctorRepairExecution["status"]): string {
	switch (status) {
		case "preview": return "repair_preview_ready";
		case "completed": return "repair_completed";
		case "not_needed": return "repair_not_needed";
		case "partial_failure": return "repair_partially_failed";
		case "version_conflict": return "version_conflict";
		case "failed": return "repair_failed";
	}
}

export function aggregateDoctorRepairStatus(
	results: readonly DoctorRepairResult[],
): DoctorRepairExecution["status"] {
	const changed = results.some((result) => result.status === "applied");
	const conflicted = results.some((result) => result.status === "version_conflict");
	const failed = results.some((result) => result.status === "failed");
	if ((conflicted || failed) && changed) return "partial_failure";
	if (conflicted) return "version_conflict";
	if (failed) return "failed";
	return changed ? "completed" : "not_needed";
}

function repairResult(
	id: DoctorRepairActionId,
	status: DoctorRepairResult["status"],
	code: string,
	changed: boolean,
	backupId?: string,
): DoctorRepairResult {
	return Object.freeze({
		id,
		status,
		code,
		changed,
		...(backupId && SAFE_BACKUP_ID.test(backupId) ? { backupId } : {}),
	});
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}
