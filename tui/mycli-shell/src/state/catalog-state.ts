import type {
	MycliShellAuthProvider,
	MycliShellCredentialReadiness,
	MycliShellCredentialSource,
	MycliShellModel,
	MycliShellProviderRoute,
	MycliShellResource,
	MycliShellResumeRepairAction,
	MycliShellResumeRepairIssue,
	MycliShellResumeRepairPreview,
	MycliShellSession,
	MycliShellSessionTree,
	MycliShellSessionTreeNode,
} from "../model.ts";
import {
	booleanValue,
	collaborationModeValue,
	numberValue,
	recordValue,
	stringArrayValue,
	stringValue,
} from "./payload-values.ts";
import type { RuntimeShellState } from "./runtime-state-model.ts";

const PROVIDER_ROUTE_ID_MAX_CHARS = 64;

const PROVIDER_ROUTE_TEXT_MAX_CHARS = 512;

const PROVIDER_ROUTE_URL_MAX_CHARS = 2_048;

const PROVIDER_ROUTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const PROVIDER_ROUTE_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export function resourcesFromResult(payload: Record<string, unknown>): MycliShellResource[] {
	const resources = Array.isArray(payload.resources) ? payload.resources : [];
	return resources.map(resourceFromUnknown).filter((resource): resource is MycliShellResource => resource !== null);
}

export function sessionsFromResult(result: Record<string, unknown>): MycliShellSession[] {
	const raw = Array.isArray(result.sessions) ? result.sessions : Array.isArray(result.items) ? result.items : [];
	return raw.map(sessionFromUnknown).filter((session): session is MycliShellSession => session !== null);
}

export function sessionResumePreviewFromResult(
	result: Record<string, unknown>,
): MycliShellResumeRepairPreview | null {
	const session = sessionFromUnknown(result.session);
	const ready = booleanValue(result.ready);
	const requiresConfirmation = booleanValue(result.requires_confirmation ?? result.requiresConfirmation);
	if (!session || ready === null || requiresConfirmation === null) return null;
	const issues = Array.isArray(result.issues)
		? result.issues.map(resumeRepairIssueFromUnknown).filter(
			(issue): issue is MycliShellResumeRepairIssue => issue !== null,
		)
		: [];
	const actions = Array.isArray(result.actions)
		? result.actions.map(resumeRepairActionFromUnknown).filter(
			(action): action is MycliShellResumeRepairAction => action !== null,
		)
		: [];
	return {
		version: 1,
		session,
		ready,
		requiresConfirmation,
		issues,
		actions,
	};
}

export function sessionTreeFromResult(result: Record<string, unknown>): MycliShellSessionTree {
	const rawNodes = Array.isArray(result.nodes) ? result.nodes : [];
	return {
		sessionId: stringValue(result.session_id) ?? stringValue(result.sessionId) ?? "",
		activePath: stringArrayValue(result.active_path ?? result.activePath),
		nodes: rawNodes.map(sessionTreeNodeFromUnknown).filter((node): node is MycliShellSessionTreeNode => node !== null),
	};
}

function sessionFromUnknown(value: unknown): MycliShellSession | null {
	const record = recordValue(value);
	const id = stringValue(record.id) ?? stringValue(record.session_id) ?? stringValue(record.path);
	if (!id) return null;
	return {
		id,
		title: stringValue(record.title) ?? stringValue(record.name) ?? undefined,
		cwd: stringValue(record.cwd) ?? stringValue(record.workspace) ?? undefined,
		workspace: stringValue(record.workspace) ?? stringValue(record.workspace_root) ?? undefined,
		modified: stringValue(record.modified) ?? stringValue(record.last_active) ?? stringValue(record.updated_at) ?? undefined,
		created: stringValue(record.created) ?? stringValue(record.created_at) ?? undefined,
		updated: stringValue(record.updated) ?? stringValue(record.updated_at) ?? undefined,
		lastActive: stringValue(record.last_active) ?? stringValue(record.lastActive) ?? undefined,
		messageCount: numberValue(record.message_count) ?? numberValue(record.messageCount) ?? undefined,
		firstMessage: stringValue(record.first_message) ?? stringValue(record.firstMessage) ?? undefined,
		allMessagesText: stringValue(record.all_messages_text) ?? stringValue(record.allMessagesText) ?? undefined,
		parentSessionId: stringValue(record.parent_session_id) ?? stringValue(record.parentSessionId) ?? undefined,
		parentSessionPath: stringValue(record.parent_session_path) ?? stringValue(record.parentSessionPath) ?? undefined,
		model: stringValue(record.model) ?? undefined,
		provider: stringValue(record.provider) ?? undefined,
		reasoningEffort: stringValue(record.reasoning_effort) ?? stringValue(record.reasoningEffort) ?? undefined,
		collaborationMode: collaborationModeValue(record.collaboration_mode ?? record.collaborationMode) ?? undefined,
		permissionProfile: permissionProfileValue(record.permission_profile ?? record.permissionProfile),
		lifecycleStatus: sessionLifecycleStatusValue(record.status ?? record.lifecycle_status ?? record.lifecycleStatus),
		storageStatus: stringValue(record.storage_status) ?? stringValue(record.storageStatus) ?? undefined,
		lockState: sessionLockStateValue(record.lock_state ?? record.lockState),
		pendingState: sessionPendingStateValue(record.pending_state ?? record.pendingState),
		metadataRevision: numberValue(record.metadata_revision) ?? numberValue(record.metadataRevision) ?? undefined,
		forkPoint: numberValue(record.fork_point) ?? numberValue(record.forkPoint) ?? undefined,
		preferenceIssue: stringValue(record.preference_issue) ?? stringValue(record.preferenceIssue) ?? undefined,
		metadataIssue: stringValue(record.metadata_issue) ?? stringValue(record.metadataIssue) ?? undefined,
		named: booleanValue(record.named) ?? undefined,
		current: booleanValue(record.current) ?? undefined,
	};
}

function resumeRepairIssueFromUnknown(value: unknown): MycliShellResumeRepairIssue | null {
	const record = recordValue(value);
	const code = stringValue(record.code);
	const blocking = booleanValue(record.blocking);
	const message = stringValue(record.message);
	if (!code || blocking === null || !message) return null;
	const action = resumeRepairActionFromUnknown(record.action);
	return { code, blocking, message, ...(action ? { action } : {}) };
}

function resumeRepairActionFromUnknown(value: unknown): MycliShellResumeRepairAction | null {
	return value === "takeover_stale_owner" || value === "unarchive" || value === "fork_with_current_settings"
		? value
		: null;
}

function permissionProfileValue(value: unknown): "read-only" | "workspace" | "full-access" | undefined {
	return value === "read-only" || value === "workspace" || value === "full-access" ? value : undefined;
}

function sessionLifecycleStatusValue(value: unknown): MycliShellSession["lifecycleStatus"] {
	return value === "active" || value === "archived" || value === "deleted"
		|| value === "waiting_approval" || value === "waiting_clarification" || value === "interrupted"
		? value
		: undefined;
}

function sessionLockStateValue(value: unknown): MycliShellSession["lockState"] {
	return value === "unlocked" || value === "owned" || value === "active" || value === "stale"
		? value
		: undefined;
}

function sessionPendingStateValue(value: unknown): MycliShellSession["pendingState"] {
	return value === "none" || value === "approval" || value === "clarification" || value === "interrupted"
		? value
		: undefined;
}

function sessionTreeNodeFromUnknown(value: unknown): MycliShellSessionTreeNode | null {
	const record = recordValue(value);
	const id = stringValue(record.id);
	const kind = stringValue(record.kind);
	const sessionId = stringValue(record.session_id) ?? stringValue(record.sessionId);
	if (!id || !sessionId || (kind !== "session" && kind !== "message")) return null;
	return {
		id,
		kind,
		sessionId,
		parentId: stringValue(record.parent_id) ?? stringValue(record.parentId) ?? undefined,
		depth: numberValue(record.depth) ?? 0,
		role: stringValue(record.role) ?? kind,
		summary: stringValue(record.summary) ?? "",
		timestamp: stringValue(record.timestamp) ?? undefined,
		label: stringValue(record.label) ?? undefined,
		messageIndex: numberValue(record.message_index) ?? numberValue(record.messageIndex) ?? undefined,
		anchorId: stringValue(record.anchor_id) ?? stringValue(record.anchorId) ?? undefined,
		toolName: stringValue(record.tool_name) ?? stringValue(record.toolName) ?? undefined,
		active: booleanValue(record.active) ?? undefined,
		onActivePath: booleanValue(record.on_active_path) ?? booleanValue(record.onActivePath) ?? undefined,
		messageCount: numberValue(record.message_count) ?? numberValue(record.messageCount) ?? undefined,
		preview: stringValue(record.preview) ?? undefined,
	};
}

export function trustFromPayload(payload: unknown, workspace: string): RuntimeShellState["trust"] {
	const record = recordValue(payload);
	return {
		state: stringValue(record.state) ?? "unknown",
		workspace: stringValue(record.workspace) ?? workspace,
	};
}

export function runtimeStateWithModelCatalog(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	const models = modelCatalogFromPayload(payload);
	const provider = stringValue(payload.provider);
	const nextState = models === null
		? state
		: { ...state, models, modelsProvider: provider ?? state.modelsProvider };
	return runtimeStateWithCredentialReadiness(nextState, payload);
}

export function runtimeStateWithProviderDirectory(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	return { ...state, providerRoutes: providerRoutesFromResult(payload) };
}

export function providerRoutesFromResult(payload: Record<string, unknown>): MycliShellProviderRoute[] {
	const providers = Array.isArray(payload.providers) ? payload.providers : [];
	return providers
		.map(providerRouteFromUnknown)
		.filter((provider): provider is MycliShellProviderRoute => provider !== null);
}

export function modelsFromResult(payload: Record<string, unknown>): MycliShellModel[] {
	return modelCatalogFromPayload(payload) ?? [];
}

export function runtimeStateWithCredentialReadiness(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	const readiness = credentialReadinessFromUnknown(payload.auth_status);
	const authProviders = Array.isArray(payload.auth_providers)
		? authProvidersFromUnknown(payload.auth_providers)
		: undefined;
	if (!readiness && !authProviders) return state;
	return {
		...state,
		...(readiness ? { authReadiness: readiness } : {}),
		...(authProviders ? { authProviders, providerRoutes: [] } : {}),
	};
}

export function modelCatalogFromPayload(payload: Record<string, unknown>): MycliShellModel[] | null {
	const raw = Array.isArray(payload.models)
		? payload.models
		: Array.isArray(payload.available_models)
			? payload.available_models
			: null;
	if (raw === null) return null;
	return raw.map(modelFromUnknown).filter((item): item is MycliShellModel => item !== null);
}

function modelFromUnknown(value: unknown): MycliShellModel | null {
	const record = recordValue(value);
	const model = stringValue(record.model);
	if (!model) return null;
	const contextWindowTokens = numberValue(
		record.context_window_tokens ?? record.contextWindowTokens,
	);
	const maxOutputTokens = numberValue(record.max_output_tokens ?? record.maxOutputTokens);
	return {
		model,
		provider: stringValue(record.provider) ?? "",
		protocol: stringValue(record.protocol) ?? undefined,
		name: stringValue(record.name) ?? undefined,
		description: stringValue(record.description) ?? undefined,
		baseUrl: stringValue(record.base_url) ?? stringValue(record.baseUrl) ?? undefined,
		supportedReasoningEfforts: stringArrayValue(
			record.supported_reasoning_efforts ?? record.supportedReasoningEfforts,
		),
		defaultReasoningEffort:
			stringValue(record.default_reasoning_effort) ?? stringValue(record.defaultReasoningEffort) ?? undefined,
		...(contextWindowTokens === null ? {} : { contextWindowTokens }),
		...(maxOutputTokens === null ? {} : { maxOutputTokens }),
		current: booleanValue(record.current) ?? undefined,
		default: booleanValue(record.default) ?? undefined,
	};
}

function providerRouteFromUnknown(value: unknown): MycliShellProviderRoute | null {
	const record = recordValue(value);
	const id = providerRouteIdValue(record.id);
	const name = record.name === undefined
		? id
		: boundedProviderRouteText(record.name, PROVIDER_ROUTE_TEXT_MAX_CHARS);
	const activation = providerActivationValue(record.activation);
	if (!id || !name || !activation
		|| typeof record.configured !== "boolean"
		|| typeof record.ready !== "boolean"
		|| typeof record.current !== "boolean") return null;
	const catalogProviderValue = record.catalog_provider_id ?? record.catalogProviderId;
	const catalogProviderId = catalogProviderValue === undefined
		? undefined
		: providerRouteIdValue(catalogProviderValue);
	const protocols = providerProtocolsValue(record.protocols);
	const protocolValue = record.protocol;
	const protocol = protocolValue === undefined ? undefined : providerProtocolValue(protocolValue);
	const baseUrlValue = record.base_url ?? record.baseUrl;
	const baseUrl = baseUrlValue === undefined
		? undefined
		: boundedProviderRouteText(baseUrlValue, PROVIDER_ROUTE_URL_MAX_CHARS);
	const authRefValue = record.auth_ref ?? record.authRef;
	const authRef = authRefValue === undefined
		? undefined
		: boundedProviderRouteText(authRefValue, PROVIDER_ROUTE_TEXT_MAX_CHARS);
	const disabledReasonValue = record.disabled_reason ?? record.disabledReason;
	const disabledReason = disabledReasonValue === undefined
		? undefined
		: boundedProviderRouteText(disabledReasonValue, PROVIDER_ROUTE_TEXT_MAX_CHARS);
	const modelCountValue = record.model_count ?? record.modelCount;
	const modelCount = modelCountValue === undefined ? undefined : nonNegativeIntegerValue(modelCountValue);
	if ((catalogProviderValue !== undefined && !catalogProviderId)
		|| protocols === null
		|| (protocolValue !== undefined && !protocol)
		|| (baseUrlValue !== undefined && !baseUrl)
		|| (authRefValue !== undefined && !authRef)
		|| (disabledReasonValue !== undefined && !disabledReason)
		|| (modelCountValue !== undefined && modelCount === null)) return null;
	const supportTier = providerSupportTierValue(record.support_tier ?? record.supportTier);
	const source = providerSourceValue(record.source);
	const credentialSource = credentialSourceValue(record.credential_source ?? record.credentialSource);
	return {
		id,
		name,
		...(supportTier ? { supportTier } : {}),
		...(source ? { source } : {}),
		catalogProviderId: catalogProviderId ?? undefined,
		protocols,
		protocol: protocol ?? undefined,
		baseUrl: baseUrl ?? undefined,
		authRef: authRef ?? undefined,
		...(credentialSource ? { credentialSource } : {}),
		activation,
		configured: record.configured,
		ready: record.ready,
		current: record.current,
		endpointRequired: booleanValue(record.endpoint_required ?? record.endpointRequired) ?? undefined,
		modelCount: modelCount ?? undefined,
		disabledReason: disabledReason ?? undefined,
	};
}

function providerRouteIdValue(value: unknown): string | null {
	return typeof value === "string"
		&& value.length <= PROVIDER_ROUTE_ID_MAX_CHARS
		&& PROVIDER_ROUTE_ID_PATTERN.test(value)
		? value
		: null;
}

function boundedProviderRouteText(value: unknown, maxChars: number): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0
		&& normalized.length <= maxChars
		&& !PROVIDER_ROUTE_CONTROL_CHARACTER.test(normalized)
		? normalized
		: null;
}

function providerProtocolsValue(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > 3) return null;
	const protocols = value.map(providerProtocolValue);
	if (protocols.some((protocol) => protocol === null)) return null;
	return [...new Set(protocols as string[])];
}

function providerProtocolValue(value: unknown): string | null {
	return value === "responses" || value === "chat_completions" || value === "anthropic_messages"
		? value
		: null;
}

function nonNegativeIntegerValue(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function providerActivationValue(value: unknown): MycliShellProviderRoute["activation"] | null {
	return value === "active" || value === "inactive" || value === "unserviceable" ? value : null;
}

function providerSupportTierValue(value: unknown): MycliShellProviderRoute["supportTier"] | null {
	return value === "stable" || value === "experimental" || value === "compatible" ? value : null;
}

function providerSourceValue(value: unknown): MycliShellProviderRoute["source"] | null {
	return value === "pi_ai_builtin" || value === "pi_ai_declared" ? value : null;
}

export function authProvidersFromUnknown(value: unknown): MycliShellAuthProvider[] {
	if (!Array.isArray(value)) return [];
	return value.map(authProviderFromUnknown).filter((item): item is MycliShellAuthProvider => item !== null);
}

function authProviderFromUnknown(value: unknown): MycliShellAuthProvider | null {
	const record = recordValue(value);
	const id = stringValue(record.id) ?? stringValue(record.provider_id);
	if (!id) return null;
	return {
		id,
		name: stringValue(record.name) ?? id,
		configured: typeof record.configured === "boolean" ? record.configured : undefined,
		defaultModel: stringValue(record.default_model) ?? stringValue(record.defaultModel) ?? undefined,
		authRef: stringValue(record.auth_ref) ?? stringValue(record.authRef) ?? undefined,
		credentialSource: credentialSourceValue(
			record.credential_source ?? record.credentialSource,
		) ?? undefined,
	};
}

export function credentialReadinessFromUnknown(value: unknown): MycliShellCredentialReadiness | null {
	const record = recordValue(value);
	const providerId = stringValue(record.provider_id) ?? stringValue(record.providerId);
	const authRef = stringValue(record.auth_ref) ?? stringValue(record.authRef);
	const source = credentialSourceValue(record.source);
	if (!providerId || !authRef || !source || typeof record.ready !== "boolean") return null;
	return { ready: record.ready, providerId, authRef, source };
}

function credentialSourceValue(value: unknown): MycliShellCredentialSource | null {
	return value === "environment"
		|| value === "stored"
		|| value === "legacy_config"
		|| value === "missing"
		? value
		: null;
}

function resourceFromUnknown(value: unknown): MycliShellResource | null {
	const record = recordValue(value);
	const id = stringValue(record.id);
	const type = resourceTypeValue(record.type);
	const name = stringValue(record.name);
	if (!id || !type || !name) return null;
	return {
		id,
		type,
		name,
		source: resourceSourceValue(record.source) ?? undefined,
		enabled: booleanValue(record.enabled) ?? undefined,
		status: stringValue(record.status) ?? undefined,
		detail: stringValue(record.detail) ?? undefined,
		command: stringValue(record.command) ?? undefined,
	};
}

export function currentModel(provider: string, model: string, thinkingLevel?: string): MycliShellModel {
	const [providerId = provider, protocol] = provider.split("/", 2);
	return {
		provider: providerId,
		...(protocol ? { protocol } : {}),
		model: model || "no-model",
		supportedReasoningEfforts: thinkingLevel ? [thinkingLevel] : [],
		current: true,
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

function resourceTypeValue(value: unknown): MycliShellResource["type"] | null {
	return value === "hook" || value === "plugin" || value === "skill" || value === "prompt" || value === "theme" ? value : null;
}

function resourceSourceValue(value: unknown): MycliShellResource["source"] | null {
	return value === "user" || value === "repo" || value === "builtin" || value === "package" || value === "runtime" || value === "unknown"
		? value
		: null;
}
