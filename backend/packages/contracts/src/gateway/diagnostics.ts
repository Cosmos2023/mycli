import { createHash } from "node:crypto";
import type { RuntimeErrorCode } from "../generated/runtime-turn-record.ts";
import { errorDefinition } from "../errors/catalog.ts";
import { legacyRuntimeReason } from "../errors/legacy.ts";

export const DIAGNOSTIC_CATEGORIES = Object.freeze([
	"auth",
	"config",
	"extension",
	"migration",
	"provider",
	"runtime",
	"sandbox",
	"storage",
	"terminal",
	"update",
] as const);

export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];
export type DiagnosticSeverity = "info" | "warning" | "error";

export const DIAGNOSTIC_RECOVERY_ACTION_IDS = Object.freeze([
	"check_billing",
	"check_for_updates",
	"compact_session",
	"configure_credentials",
	"inspect_configuration",
	"inspect_execution",
	"review_access",
	"retry",
	"run_doctor",
	"select_compatible_model",
	"start_new_session",
	"wait_and_retry",
] as const);

export type DiagnosticRecoveryActionId = (typeof DIAGNOSTIC_RECOVERY_ACTION_IDS)[number];

export interface DiagnosticRecoveryAction {
	readonly id: DiagnosticRecoveryActionId;
	readonly label: string;
	readonly command?: string;
}

const RECOVERY_ACTIONS = Object.freeze({
	inspect_execution: action("inspect_execution", "Check session and Shell status before submitting the operation again.", "/status"),
	select_compatible_model: action("select_compatible_model", "Select a model that supports the required input or operation.", "/model"),
	check_billing: action(
		"check_billing",
		"Check the provider billing plan or quota.",
	),
	check_for_updates: action(
		"check_for_updates",
		"Refresh the cached update status.",
		"mycli update check",
	),
	compact_session: action(
		"compact_session",
		"Compact this conversation or start a new session.",
		"/compact",
	),
	configure_credentials: action(
		"configure_credentials",
		"Check the configured provider credentials.",
		"/login",
	),
	inspect_configuration: action(
		"inspect_configuration",
		"Update the provider configuration, then retry.",
		"mycli config validate",
	),
	review_access: action(
		"review_access",
		"Check that the account can access this model.",
	),
	retry: action("retry", "Retry the request."),
	run_doctor: action("run_doctor", "Run mycli doctor for local recovery guidance.", "mycli doctor"),
	start_new_session: action("start_new_session", "Start a new session.", "/new"),
	wait_and_retry: action("wait_and_retry", "Wait for the cooldown, then retry."),
} satisfies Readonly<Record<DiagnosticRecoveryActionId, DiagnosticRecoveryAction>>);

const DIAGNOSTIC_CATEGORY_SET = new Set<string>(DIAGNOSTIC_CATEGORIES);
const DIAGNOSTIC_RECOVERY_ACTION_ID_SET = new Set<string>(DIAGNOSTIC_RECOVERY_ACTION_IDS);

export function isDiagnosticCategory(value: unknown): value is DiagnosticCategory {
	return typeof value === "string" && DIAGNOSTIC_CATEGORY_SET.has(value);
}

export function isDiagnosticRecoveryActionId(value: unknown): value is DiagnosticRecoveryActionId {
	return typeof value === "string" && DIAGNOSTIC_RECOVERY_ACTION_ID_SET.has(value);
}

export function diagnosticRecoveryAction(
	id: DiagnosticRecoveryActionId,
): DiagnosticRecoveryAction {
	return RECOVERY_ACTIONS[id];
}

export function runtimeErrorCategory(code: RuntimeErrorCode): DiagnosticCategory {
	return errorDefinition(legacyRuntimeReason(code)).category;
}

export function runtimeErrorRecoveryActions(
	code: RuntimeErrorCode,
): readonly DiagnosticRecoveryAction[] {
	return Object.freeze(
		errorDefinition(legacyRuntimeReason(code)).recovery.map((id) => diagnosticRecoveryAction(id)),
	);
}

export function requestFailureNoticeId(occurrenceId: string): string {
	const identity = createHash("sha256").update(occurrenceId).digest("hex");
	return `request-failed:${identity}`;
}

function action(
	id: DiagnosticRecoveryActionId,
	label: string,
	command?: string,
): DiagnosticRecoveryAction {
	return Object.freeze({ id, label, ...(command ? { command } : {}) });
}
