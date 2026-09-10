import type { ErrorReasonDetails, FailureScope } from "../generated/error-context.ts";
import type { RuntimeErrorCode } from "../generated/runtime-turn-record.ts";
import type { DiagnosticCategory, DiagnosticRecoveryActionId, DiagnosticSeverity } from "../gateway/diagnostics.ts";

export type ErrorReason = ErrorReasonDetails["reason"];

export interface ErrorDefinition {
	readonly summary: string;
	readonly category: DiagnosticCategory;
	readonly severity: DiagnosticSeverity;
	readonly recovery: readonly DiagnosticRecoveryActionId[];
	readonly scopes: readonly FailureScope["kind"][];
	readonly runtimeCode?: RuntimeErrorCode;
}

const PROVIDER: readonly FailureScope["kind"][] = ["provider_attempt", "turn", "request", "application"];
const TOOL: readonly FailureScope["kind"][] = ["tool_call"];
const GATEWAY: readonly FailureScope["kind"][] = ["request", "connection", "application", "provider_attempt"];
const STORAGE: readonly FailureScope["kind"][] = ["session", "turn", "request", "tool_call", "application"];
const RUNTIME: readonly FailureScope["kind"][] = ["provider_attempt", "tool_call", "request", "turn", "session", "connection", "application"];
const POLICY: readonly FailureScope["kind"][] = ["tool_call", "request", "turn", "application"];

export const ERROR_DEFINITIONS = Object.freeze({
	"config.invalid": define("Configuration is invalid.", "config", ["inspect_configuration"], "config_error"),
	"config.model_unavailable": define("The selected model is unavailable in the configured catalog.", "config", ["select_compatible_model", "inspect_configuration"], "config_error"),
	"auth.credentials_missing": define("Provider credentials are missing.", "auth", ["configure_credentials"], "auth_error"),
	"auth.credentials_rejected": define("Provider authentication failed.", "auth", ["configure_credentials"], "auth_error"),
	"auth.model_access_denied": define("The account cannot access the selected model.", "auth", ["review_access", "select_compatible_model"], "permission_denied"),
	"capability.image_input_unsupported": define("The selected model cannot read images.", "provider", ["select_compatible_model"], "unsupported_capability", RUNTIME),
	"capability.tool_calls_unsupported": define("The selected model does not support tool calls.", "provider", ["select_compatible_model"], "unsupported_capability", RUNTIME),
	"capability.hosted_search_unsupported": define("The selected provider does not support hosted web search.", "provider", ["inspect_configuration", "select_compatible_model"], "unsupported_capability"),
	"capability.reasoning_unsupported": define("The selected model does not support this reasoning setting.", "config", ["select_compatible_model", "inspect_configuration"], "unsupported_capability"),
	"capability.deferred_response_unsupported": define("The provider returned a deferred response that mycli cannot continue.", "provider", ["select_compatible_model"], "unsupported_capability"),
	"capability.auth_flow_unavailable": define("This provider authentication flow is unavailable.", "auth", ["configure_credentials"], "unsupported_capability"),
	"capability.unspecified": define("A required capability is unavailable.", "runtime", [], "unsupported_capability", RUNTIME),
	"provider.invalid_request": define("The provider rejected the request.", "provider", [], "invalid_request"),
	"provider.context_limit": define("The request exceeds the available context window.", "runtime", ["compact_session", "start_new_session"], "context_window_exceeded"),
	"provider.rate_limited": define("The provider rate limit was reached.", "provider", ["wait_and_retry"], "rate_limited"),
	"provider.quota_exceeded": define("Provider quota is exhausted.", "provider", ["check_billing"], "quota_exceeded"),
	"provider.overloaded": define("The provider is overloaded.", "provider", ["wait_and_retry"], "server_overloaded", PROVIDER, "warning"),
	"provider.service_failed": define("The provider service failed.", "provider", ["retry"], "provider_error"),
	"provider.tool_protocol_invalid": define("The provider returned an invalid tool-call sequence.", "runtime", ["retry"], "tool_protocol_error"),
	"provider.failure_unclassified": define("The provider request failed.", "provider", [], "provider_error"),
	"transport.connect_failed": define("The connection could not be established.", "provider", ["retry"], "connection_error", RUNTIME),
	"transport.timed_out": define("The connection timed out.", "provider", ["retry"], "connection_error", RUNTIME),
	"transport.stream_interrupted": define("The response stream was interrupted.", "provider", ["retry"], "response_stream_error", RUNTIME),
	"transport.gateway_disconnected": define("The runtime connection was lost.", "runtime", ["inspect_execution"], undefined, GATEWAY),
	"transport.output_stalled": define("Runtime output stopped draining.", "runtime", ["inspect_execution", "run_doctor"], undefined, GATEWAY),
	"gateway.admission_rejected": define("The runtime could not accept this request yet.", "runtime", ["wait_and_retry"], undefined, GATEWAY, "warning"),
	"gateway.output_capacity_exceeded": define("Runtime output exceeded the delivery capacity.", "runtime", ["inspect_execution", "run_doctor"], undefined, GATEWAY),
	"gateway.message_too_large": define("The runtime message exceeds the transport size limit.", "runtime", [], undefined, GATEWAY),
	"gateway.protocol_incompatible": define("The runtime and client protocols are incompatible.", "runtime", ["run_doctor"], undefined, GATEWAY),
	"gateway.invalid_request": define("The request parameters are invalid.", "runtime", [], undefined, GATEWAY),
	"gateway.state_conflict": define("The request no longer matches the current session state.", "runtime", ["inspect_execution"], undefined, GATEWAY),
	"gateway.failure_unclassified": define("The gateway request failed.", "runtime", ["inspect_execution"], undefined, GATEWAY),
	"tool.invalid_arguments": define("The tool arguments are invalid.", "runtime", [], undefined, TOOL),
	"tool.not_found": define("The requested tool is unavailable.", "runtime", [], undefined, TOOL),
	"tool.path_not_found": define("The requested file or directory was not found.", "runtime", [], undefined, TOOL),
	"tool.path_unreadable": define("The requested file or directory cannot be read.", "runtime", [], undefined, TOOL),
	"tool.image_invalid": define("The image is invalid or exceeds supported limits.", "runtime", [], undefined, TOOL),
	"tool.image_decoder_unavailable": define("The image decoder is unavailable.", "runtime", ["run_doctor"], undefined, TOOL),
	"tool.process_start_failed": define("The Shell process could not start.", "runtime", ["run_doctor"], undefined, TOOL),
	"tool.process_exited": define("The Shell command exited unsuccessfully.", "runtime", [], undefined, TOOL),
	"tool.timed_out": define("The tool execution timed out.", "runtime", ["inspect_execution"], undefined, TOOL),
	"tool.failure_unclassified": define("The tool execution failed.", "runtime", [], undefined, TOOL),
	"policy.approval_denied": define("The requested operation was declined.", "sandbox", [], undefined, POLICY, "info"),
	"policy.access_denied": define("The execution policy does not allow this operation.", "sandbox", [], undefined, POLICY),
	"policy.sandbox_unavailable": define("The required sandbox is unavailable on this system.", "sandbox", ["run_doctor"], undefined, POLICY),
	"policy.sandbox_initialization_failed": define("Shell could not start its sandbox.", "sandbox", ["run_doctor"], undefined, POLICY),
	"storage.busy": define("Session storage is busy.", "storage", ["inspect_execution"], "persistence_error", STORAGE),
	"storage.capacity_exceeded": define("Session storage has insufficient space.", "storage", ["run_doctor"], "persistence_error", STORAGE),
	"storage.write_failed": define("Session state could not be saved.", "storage", ["run_doctor", "inspect_execution"], "persistence_error", STORAGE),
	"storage.data_invalid": define("Persisted session data is invalid.", "storage", ["run_doctor"], "persistence_error", STORAGE),
	"storage.version_unsupported": define("This session storage format is not supported by this version of mycli.", "storage", ["run_doctor"], "persistence_error", STORAGE),
	"storage.session_unavailable": define("The requested session is unavailable.", "storage", ["inspect_execution"], undefined, STORAGE),
	"storage.failure_unclassified": define("Session storage failed.", "storage", ["run_doctor"], "persistence_error", STORAGE),
	"runtime.user_cancelled": define("The turn was interrupted by the user.", "runtime", [], "interrupted", RUNTIME, "info"),
	"runtime.interruption_unspecified": define("The turn was interrupted.", "runtime", [], "interrupted", RUNTIME, "info"),
	"runtime.worker_exited": define("The runtime Worker exited unexpectedly.", "runtime", ["inspect_execution", "run_doctor"], "provider_error", RUNTIME),
	"runtime.retry_exhausted": define("The provider retry budget was exhausted.", "provider", [], "retry_exhausted", RUNTIME),
	"runtime.tool_budget_exceeded": define("The turn reached its tool-call limit.", "runtime", ["start_new_session"], "tool_budget_exceeded", RUNTIME),
	"runtime.continuation_unavailable": define("The runtime cannot continue this interactive operation.", "runtime", ["run_doctor"], "unsupported_capability", RUNTIME),
	"runtime.effect_outcome_unknown": define("The operation's execution outcome is unknown.", "runtime", ["inspect_execution"], "interrupted", RUNTIME, "warning"),
	"runtime.internal_error": define("An internal runtime error occurred.", "runtime", ["run_doctor", "inspect_execution"], "provider_error", RUNTIME),
	"integration.unavailable": define("The requested integration is unavailable.", "extension", ["inspect_configuration"], undefined, RUNTIME),
	"integration.protocol_invalid": define("The integration returned an invalid response.", "extension", ["inspect_configuration"], undefined, RUNTIME),
	"integration.failure_unclassified": define("The integration request failed.", "extension", [], undefined, RUNTIME),
	"tui.render_failed": define("The terminal interface could not be rendered.", "terminal", ["run_doctor"], undefined, ["application"]),
	"tui.terminal_unavailable": define("The terminal interface is unavailable.", "terminal", ["run_doctor"], undefined, ["application"]),
} satisfies Readonly<Record<ErrorReason, ErrorDefinition>>);

export const ERROR_REASONS: readonly ErrorReason[] = Object.freeze(Object.keys(ERROR_DEFINITIONS) as ErrorReason[]);

export function isErrorReason(value: unknown): value is ErrorReason {
	return typeof value === "string" && Object.hasOwn(ERROR_DEFINITIONS, value);
}

export function errorDefinition(reason: ErrorReason): ErrorDefinition {
	return ERROR_DEFINITIONS[reason];
}

function define(
	summary: string,
	category: DiagnosticCategory,
	recovery: readonly DiagnosticRecoveryActionId[],
	runtimeCode?: RuntimeErrorCode,
	scopes: readonly FailureScope["kind"][] = PROVIDER,
	severity: DiagnosticSeverity = "error",
): ErrorDefinition {
	return Object.freeze({ summary, category, severity, recovery: Object.freeze([...recovery]),
		scopes: Object.freeze([...scopes]), ...(runtimeCode ? { runtimeCode } : {}) });
}
