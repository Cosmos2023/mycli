import type { RuntimeErrorCode } from "../generated/runtime-turn-record.ts";
import type { ErrorReason } from "./catalog.ts";

interface LegacyRuntimeDefinition {
	readonly reason: ErrorReason;
	readonly message: string;
	readonly hint: boolean;
}

export const LEGACY_RUNTIME_ERRORS = Object.freeze({
	config_error: legacy("config.invalid", "provider configuration failed", true),
	auth_error: legacy("auth.credentials_rejected", "provider authentication failed", true),
	permission_denied: legacy("auth.model_access_denied", "provider access was denied", true),
	invalid_request: legacy("provider.invalid_request", "provider rejected the request"),
	provider_error: legacy("provider.failure_unclassified", "provider request failed"),
	connection_error: legacy("transport.connect_failed", "provider connection failed"),
	response_stream_error: legacy("transport.stream_interrupted", "provider response stream failed"),
	server_overloaded: legacy("provider.overloaded", "provider is overloaded"),
	rate_limited: legacy("provider.rate_limited", "provider rate limit exceeded", true),
	quota_exceeded: legacy("provider.quota_exceeded", "provider quota exceeded", true),
	context_window_exceeded: legacy("provider.context_limit", "provider context window exceeded", true),
	retry_exhausted: legacy("runtime.retry_exhausted", "provider retry budget exhausted"),
	persistence_error: legacy("storage.failure_unclassified", "session persistence failed"),
	interrupted: legacy("runtime.interruption_unspecified", "turn interrupted"),
	unsupported_capability: legacy("capability.unspecified", "provider requested an unsupported capability"),
	tool_budget_exceeded: legacy("runtime.tool_budget_exceeded", "tool turn budget exceeded"),
	tool_protocol_error: legacy("provider.tool_protocol_invalid", "provider tool protocol failed"),
} satisfies Readonly<Record<RuntimeErrorCode, LegacyRuntimeDefinition>>);

export const LEGACY_TOOL_REASONS: Readonly<Record<string, ErrorReason>> = Object.freeze({
	invalid_arguments: "tool.invalid_arguments", invalid_path: "tool.invalid_arguments",
	invalid_background: "tool.invalid_arguments", invalid_chars: "tool.invalid_arguments",
	invalid_cwd: "tool.invalid_arguments", invalid_output_budget: "tool.invalid_arguments",
	invalid_timeout: "tool.invalid_arguments", invalid_tty: "tool.invalid_arguments",
	invalid_yield_time: "tool.invalid_arguments", missing_shell_id: "tool.invalid_arguments",
	not_directory: "tool.invalid_arguments", invalid_url: "tool.invalid_arguments",
	resource_too_large: "tool.invalid_arguments",
	invalid_plan: "tool.invalid_arguments", invalid_justification: "tool.invalid_arguments",
	invalid_sandbox_permissions: "tool.invalid_arguments", invalid_encoding: "tool.invalid_arguments",
	invalid_delimited_data: "tool.invalid_arguments", unsupported_file_type: "tool.invalid_arguments",
	file_too_large: "tool.invalid_arguments", content_too_large: "tool.invalid_arguments",
	binary_file: "tool.invalid_arguments", empty_file: "tool.invalid_arguments",
	already_exists: "tool.invalid_arguments", string_not_found: "tool.invalid_arguments",
	edit_existing_content: "tool.invalid_arguments", no_op: "tool.invalid_arguments",
	not_found: "tool.path_not_found", ENOENT: "tool.path_not_found",
	is_directory: "tool.path_unreadable", read_failed: "tool.path_unreadable",
	image_read_failed: "tool.path_unreadable", permission_path_unavailable: "tool.path_unreadable",
	unknown_tool: "tool.not_found", tool_not_found: "tool.not_found",
	unsupported_tool: "tool.not_found",
	invalid_image: "tool.image_invalid", mcp_invalid_image: "tool.image_invalid",
	image_decoder_unavailable: "tool.image_decoder_unavailable",
	unsupported_capability: "capability.unspecified",
	permission_denied: "policy.access_denied", workspace_escape: "policy.access_denied",
	sandbox_override_not_approved: "policy.access_denied", secret_like_content: "policy.access_denied",
	permission_grant_not_approved: "policy.access_denied", tool_not_allowed_in_plan_mode: "policy.access_denied",
	network_disabled: "policy.access_denied", network_domain_denied: "policy.access_denied",
	unsafe_address: "policy.access_denied", unsafe_redirect: "policy.access_denied",
	approval_denied: "policy.approval_denied", rejected: "policy.approval_denied",
	approval_rejected: "policy.approval_denied",
	sandbox_unavailable: "policy.sandbox_unavailable", unavailable_platform: "policy.sandbox_unavailable",
	network_proxy_unavailable: "policy.sandbox_unavailable",
	sandbox_initialization_failed: "policy.sandbox_initialization_failed",
	sandbox_setup_failed: "policy.sandbox_initialization_failed",
	spawn_failed: "tool.process_start_failed", shell_start_failed: "tool.process_start_failed",
	command_not_found: "tool.process_start_failed", pty_unavailable: "tool.process_start_failed", conpty_unavailable: "tool.process_start_failed",
	nonzero_exit: "tool.process_exited", shell_exit_nonzero: "tool.process_exited",
	timeout: "tool.timed_out", timed_out: "tool.timed_out", shell_timeout: "tool.timed_out",
	fetch_timeout: "tool.timed_out",
	interrupted: "runtime.interruption_unspecified", cancelled: "runtime.interruption_unspecified",
	killed: "runtime.interruption_unspecified",
	effect_outcome_unknown: "runtime.effect_outcome_unknown",
	tool_result_unavailable: "runtime.effect_outcome_unknown",
	agent_interrupt_unavailable: "runtime.continuation_unavailable", agent_wait_unavailable: "runtime.continuation_unavailable",
	skill_not_found: "integration.unavailable", mcp_unavailable: "integration.unavailable",
	mcp_resource_error: "integration.failure_unclassified", mcp_tool_error: "integration.failure_unclassified",
	mcp_protocol_error: "integration.protocol_invalid",
	mcp_schema_error: "integration.protocol_invalid",
	mcp_server_startup: "integration.unavailable", mcp_transport_error: "integration.unavailable",
	mcp_timeout: "integration.unavailable", unknown_mcp_server: "integration.unavailable",
	mcp_execution_error: "integration.failure_unclassified",
	protocol_invalid: "integration.protocol_invalid",
});

export const LEGACY_GATEWAY_REASONS: Readonly<Record<string, ErrorReason>> = Object.freeze({
	config_error: "config.invalid",
	auth_required: "auth.credentials_missing", model_catalog_error: "config.model_unavailable",
	invalid_params: "gateway.invalid_request", invalid_arguments: "gateway.invalid_request",
	method_not_found: "gateway.invalid_request", unavailable_feature: "gateway.invalid_request",
	incompatible_protocol: "gateway.protocol_incompatible", missing_rpc_methods: "gateway.protocol_incompatible",
	missing_event_streams: "gateway.protocol_incompatible", provider_protocol_invalid: "gateway.protocol_incompatible",
	gateway_message_too_large: "gateway.message_too_large", gateway_output_stalled: "transport.output_stalled",
	pipe_closed: "transport.gateway_disconnected", gateway_closed: "transport.gateway_disconnected",
	session_state_invalid: "storage.data_invalid", session_state_version_unsupported: "storage.version_unsupported",
	session_not_found: "storage.session_unavailable", session_in_use: "storage.session_unavailable",
	session_ambiguous: "storage.session_unavailable", session_deleted: "storage.session_unavailable",
	session_changed: "gateway.state_conflict", session_metadata_conflict: "gateway.state_conflict",
	queue_conflict: "gateway.state_conflict", queue_capacity: "gateway.admission_rejected",
	approval_not_pending: "gateway.state_conflict", approval_conflict: "gateway.state_conflict",
	clarification_not_pending: "gateway.state_conflict", turn_in_progress: "gateway.state_conflict",
	turn_id_mismatch: "gateway.state_conflict", message_id_conflict: "gateway.state_conflict",
	repair_not_available: "gateway.state_conflict", repair_unavailable: "storage.session_unavailable",
	repair_failed: "storage.write_failed", persistence_error: "storage.failure_unclassified",
	unavailable_platform: "policy.sandbox_unavailable", internal_error: "gateway.failure_unclassified",
});

export function legacyRuntimeReason(code: RuntimeErrorCode): ErrorReason {
	return LEGACY_RUNTIME_ERRORS[code].reason;
}

export function legacyToolReason(kind: string | undefined): ErrorReason {
	return kind && Object.hasOwn(LEGACY_TOOL_REASONS, kind) ? LEGACY_TOOL_REASONS[kind]! : "tool.failure_unclassified";
}

export function legacyGatewayReason(code: string, dispatched?: boolean): ErrorReason {
	if (code === "gateway_overloaded") return dispatched === false
		? "gateway.admission_rejected" : dispatched === true
			? "gateway.output_capacity_exceeded" : "gateway.failure_unclassified";
	return Object.hasOwn(LEGACY_GATEWAY_REASONS, code) ? LEGACY_GATEWAY_REASONS[code]! : "gateway.failure_unclassified";
}

function legacy(reason: ErrorReason, message: string, hint = false): LegacyRuntimeDefinition {
	return Object.freeze({ reason, message, hint });
}
