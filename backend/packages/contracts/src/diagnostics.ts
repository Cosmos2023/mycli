import { createHash } from "node:crypto";
import type { RuntimeErrorCode } from "./generated/runtime-turn-record.ts";

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
	"review_access",
	"retry",
	"run_doctor",
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

const RUNTIME_ERROR_CATEGORIES = Object.freeze({
	config_error: "config",
	auth_error: "auth",
	permission_denied: "auth",
	invalid_request: "provider",
	provider_error: "provider",
	connection_error: "provider",
	response_stream_error: "provider",
	server_overloaded: "provider",
	rate_limited: "provider",
	quota_exceeded: "provider",
	context_window_exceeded: "runtime",
	retry_exhausted: "provider",
	persistence_error: "storage",
	interrupted: "runtime",
	unsupported_capability: "provider",
	tool_budget_exceeded: "runtime",
	tool_protocol_error: "runtime",
} satisfies Readonly<Record<RuntimeErrorCode, DiagnosticCategory>>);

const RUNTIME_ERROR_RECOVERY_ACTIONS = Object.freeze({
	config_error: ["inspect_configuration"],
	auth_error: ["configure_credentials"],
	permission_denied: ["review_access"],
	invalid_request: [],
	provider_error: ["retry"],
	connection_error: ["retry"],
	response_stream_error: ["retry"],
	server_overloaded: ["wait_and_retry"],
	rate_limited: ["wait_and_retry"],
	quota_exceeded: ["check_billing"],
	context_window_exceeded: ["compact_session", "start_new_session"],
	retry_exhausted: ["retry"],
	persistence_error: ["run_doctor"],
	interrupted: [],
	unsupported_capability: ["inspect_configuration"],
	tool_budget_exceeded: ["start_new_session"],
	tool_protocol_error: ["retry"],
} satisfies Readonly<Record<RuntimeErrorCode, readonly DiagnosticRecoveryActionId[]>>);

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
	return RUNTIME_ERROR_CATEGORIES[code];
}

export function runtimeErrorRecoveryActions(
	code: RuntimeErrorCode,
): readonly DiagnosticRecoveryAction[] {
	return Object.freeze(
		RUNTIME_ERROR_RECOVERY_ACTIONS[code].map((id) => diagnosticRecoveryAction(id)),
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
