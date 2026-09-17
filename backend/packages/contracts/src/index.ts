export { gatewayContractCatalog } from "./catalog.ts";
export { ERROR_DEFINITIONS, ERROR_REASONS, errorDefinition, isErrorReason } from "./errors/catalog.ts";
export type { ErrorDefinition, ErrorReason } from "./errors/catalog.ts";
export { createErrorContext, parseErrorContext, readErrorContext, errorOccurrence, failureScope, safeErrorToken, errorContextSchema, ERROR_CONTEXT_VERSION, ERROR_CONTEXT_MAX_BYTES } from "./errors/error-context.ts";
export type { ErrorContext, ErrorOccurrence, ErrorContextInput, ErrorContextIssue } from "./errors/error-context.ts";
export type { FailureOutcome, FailureScope, FailureSource, ErrorReasonDetails, IntegrationErrorDetails } from "./generated/error-context.ts";
export { errorSummary, errorPublicDetails } from "./errors/presentation.ts";
export { LEGACY_RUNTIME_ERRORS, LEGACY_TOOL_REASONS, LEGACY_GATEWAY_REASONS, legacyRuntimeReason, legacyToolReason, legacyGatewayReason } from "./errors/legacy.ts";
export { parseProviderAttemptUpdate, parseProviderAttemptRecord, parseRuntimeFailure } from "./provider-attempt.ts";
export type {
	ProviderAttemptPolicy,
	ProviderAttemptUpdate,
	ProviderAttemptRecord,
	ProviderAttemptState,
	ProviderAttemptSource,
} from "./provider-attempt.ts";
export { GATEWAY_RPC_METHODS, GatewayRpcValidationError, isGatewayMethod, parseGatewayParams, parseGatewayResult } from "./gateway/rpc.ts";
export type { GatewayMethod, GatewayParams, GatewayResult, GatewayTranscriptItem } from "./gateway/rpc.ts";
export type { GatewayRpcMethods } from "./generated/gateway-rpc.ts";
export type { PluginCatalog, PluginCatalogEntry, PluginMarketplaceEntry, PluginChange, PluginOperation, PluginCapabilitySummary, PluginDetail } from "./generated/gateway-rpc.ts";
export type { GatewayToolRecord, GatewayShellRecord, GatewayTerminalInteraction } from "./generated/gateway-tool-record.ts";
export { terminalInteractionFromArguments, projectTerminalInteraction } from "./gateway/terminal-interaction.ts";
export { GATEWAY_TOOL_PREVIEW_MAX_CHARS, projectGatewayToolRecord, gatewayToolLifecycleRecord } from "./gateway/tool-record.ts";
export {
	diagnosticRecoveryAction,
	DIAGNOSTIC_CATEGORIES,
	DIAGNOSTIC_RECOVERY_ACTION_IDS,
	isDiagnosticCategory,
	isDiagnosticRecoveryActionId,
	requestFailureNoticeId,
	runtimeErrorCategory,
	runtimeErrorRecoveryActions,
} from "./gateway/diagnostics.ts";
export type {
	DiagnosticCategory,
	DiagnosticRecoveryAction,
	DiagnosticRecoveryActionId,
	DiagnosticSeverity,
} from "./gateway/diagnostics.ts";
export { parsePackageVersion } from "./package-version.ts";
export type { PackageVersionManifest } from "./package-version.ts";
export {
	isModelSelectionScope,
	modelSelectionNotice,
	MODEL_SELECTION_SCOPES,
} from "./gateway/model-selection.ts";
export type { ModelSelectionScope } from "./gateway/model-selection.ts";
export { slashCommandArguments } from "./gateway/slash-command.ts";
export {
	normalizeTuiKeySpec,
	TUI_KEYMAP_ACTIONS,
	TUI_KEYMAP_CONTEXTS,
	tuiKeymapAction,
	tuiKeymapActionForConfig,
	tuiKeymapConfigPath,
} from "./gateway/tui-keymap.ts";
export type {
	TuiKeymapActionDescriptor,
	TuiKeymapActionId,
	TuiKeymapContext,
} from "./gateway/tui-keymap.ts";
export {
	canonicalRuntimeFailureMessage,
	canonicalTurnFailureMessage,
	isRuntimeErrorCode,
	RUNTIME_ERROR_CODES,
	RUNTIME_RETRY_AFTER_MAX_SECONDS,
	runtimeErrorNoticeSeverity,
	runtimeErrorPublicMessage,
	runtimeErrorRecoveryHint,
	runtimeRetryStatusText,
	sanitizeRuntimeErrorDetail,
	turnFailedNoticeId,
	turnFailureNotice,
} from "./gateway/runtime-errors.ts";
export type {
	RuntimeFailure,
	RuntimeFailureDiagnostics,
	RuntimeFailureDiagnosticValue,
	RuntimeErrorNoticeSeverity,
} from "./gateway/runtime-errors.ts";
export {
	TURN_INTERRUPTED_NOTICE,
	turnInterruptionNotice,
	isTurnInterruptionReason,
	type TurnInterruptionReason,
	turnCompletedDurationId,
	turnInterruptedNoticeId,
} from "./gateway/transcript-messages.ts";
export {
	ContractValidationError,
	isGatewayErrorCode,
	parseGatewayContractCatalog,
	parseGatewayEvent,
	parseGatewayToolRecord,
	parseJsonRpcMessage,
	parsePluginV2Manifest,
	parsePluginV2ProtocolMessage,
	parseRuntimeState,
	parseRuntimeTurnRecord,
} from "./validation.ts";
export type { GatewayContractCatalog } from "./generated/catalog.ts";
export type { GatewayEventNotification } from "./generated/gateway-event-notification.ts";
export type { JsonRpcMessage } from "./generated/json-rpc-message.ts";
export type { PluginV2Manifest } from "./generated/plugin-v2-manifest.ts";
export type { PluginV2ProtocolMessage } from "./generated/plugin-v2-protocol.ts";
export type { RuntimeStateRecord } from "./generated/runtime-state-record.ts";
export type { SessionGoal } from "./generated/session-goal.ts";
export { parseSessionGoal } from "./validation.ts";
export type {
	RuntimeErrorCode,
	RuntimeTurnRecord,
} from "./generated/runtime-turn-record.ts";
export { providerAttemptId } from "./provider-attempt.ts";
export { projectGatewayErrorData, projectGatewayErrorPayload } from "./gateway/error-context-projection.ts";
export { LOCAL_CONNECTION_REASONS, localConnectionReason, storageErrorReason } from "./errors/boundaries.ts";
export type { McpElicitationRequest, McpElicitationField } from "./generated/mcp-elicitation.ts";
export { MAX_SKILL_REFERENCES, parseSkillReferences, skillReferencesInText } from "./gateway/skill-reference.ts";
export type { SkillReference } from "./gateway/skill-reference.ts";

export type { ReviewSelection } from "./generated/gateway-rpc.ts";
