import {
	parseProtocol,
	resolveProviderProfile,
	type NodeRuntimeConfig,
} from "@mycli/config";
import type { ProtocolId, ProviderId, ReasoningEffort } from "@mycli/core";
import { SessionTransitionError } from "@mycli/runtime";
import type { RuntimeSessionStore } from "@mycli/storage";
import type { PermissionProfile } from "@mycli/tools";

export const SESSION_PREFERENCES_STATE_KEY = "session_preferences" as const;

export interface SessionPreferences {
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly authRef: string;
	readonly reasoningEffort: ReasoningEffort;
	readonly collaborationMode: "default" | "plan";
	readonly permissionProfile?: PermissionProfile;
}

export type SessionPreferenceConfig = Pick<
	NodeRuntimeConfig,
	| "workspaceRoot"
	| "provider"
	| "protocol"
	| "model"
	| "apiBaseUrl"
	| "authRef"
	| "reasoningEffort"
	| "thinkingEnabled"
>;

const REASONING_EFFORTS = new Set<ReasoningEffort>([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);

export function sessionPreferencesFromConfig(
	config: SessionPreferenceConfig,
	collaborationMode: SessionPreferences["collaborationMode"],
	permissionProfile?: PermissionProfile,
): SessionPreferences {
	return Object.freeze({
		provider: config.provider,
		protocol: config.protocol,
		model: config.model,
		apiBaseUrl: config.apiBaseUrl,
		authRef: config.authRef,
		reasoningEffort: config.thinkingEnabled ? config.reasoningEffort : "none",
		collaborationMode,
		...(permissionProfile ? { permissionProfile } : {}),
	});
}

export function loadSessionPreferences(
	store: RuntimeSessionStore,
	sessionId: string,
): SessionPreferences | undefined {
	const payload = store.loadState(sessionId, SESSION_PREFERENCES_STATE_KEY);
	if (payload === undefined) return undefined;
	try {
		return parseSessionPreferences(payload);
	} catch {
		throw new SessionTransitionError("session_state_invalid", "session preferences are not usable");
	}
}

export function saveSessionPreferences(
	store: RuntimeSessionStore,
	input: {
		readonly sessionId: string;
		readonly workspaceRoot: string;
		readonly threadId: string;
		readonly preferences: SessionPreferences;
	},
): void {
	store.saveState({
		sessionId: input.sessionId,
		workspaceRoot: input.workspaceRoot,
		threadId: input.threadId,
		key: SESSION_PREFERENCES_STATE_KEY,
		payload: {
			state_version: 1,
			provider: input.preferences.provider,
			protocol: input.preferences.protocol,
			model: input.preferences.model,
			api_base_url: input.preferences.apiBaseUrl,
			auth_ref: input.preferences.authRef,
			reasoning_effort: input.preferences.reasoningEffort,
			collaboration_mode: input.preferences.collaborationMode,
			...(input.preferences.permissionProfile
				? { permission_profile: input.preferences.permissionProfile }
				: {}),
		},
	});
}

export function sameSessionPreferences(
	left: SessionPreferences | undefined,
	right: SessionPreferences,
): boolean {
	return left !== undefined
		&& left.provider === right.provider
		&& left.protocol === right.protocol
		&& left.model === right.model
		&& left.apiBaseUrl === right.apiBaseUrl
		&& left.authRef === right.authRef
		&& left.reasoningEffort === right.reasoningEffort
		&& left.collaborationMode === right.collaborationMode
		&& left.permissionProfile === right.permissionProfile;
}

export function parseSessionPreferences(value: unknown): SessionPreferences {
	if (!isRecord(value) || value.state_version !== 1) throw new Error("invalid session preferences");
	const provider = boundedIdentity(value.provider, "provider") as ProviderId;
	const protocol = parseProtocol(boundedIdentity(value.protocol, "protocol"));
	resolveProviderProfile(provider, protocol);
	const model = boundedIdentity(value.model, "model");
	const apiBaseUrl = normalizedBaseUrl(value.api_base_url);
	const authRef = boundedIdentity(value.auth_ref, "auth ref");
	const reasoningEffort = value.reasoning_effort;
	if (typeof reasoningEffort !== "string" || !REASONING_EFFORTS.has(reasoningEffort as ReasoningEffort)) {
		throw new Error("invalid reasoning effort");
	}
	const collaborationMode = value.collaboration_mode;
	if (collaborationMode !== "default" && collaborationMode !== "plan") {
		throw new Error("invalid collaboration mode");
	}
	const permissionProfile = optionalPermissionProfile(value.permission_profile);
	return Object.freeze({
		provider,
		protocol,
		model,
		apiBaseUrl,
		authRef,
		reasoningEffort: reasoningEffort as ReasoningEffort,
		collaborationMode,
		...(permissionProfile ? { permissionProfile } : {}),
	});
}

function optionalPermissionProfile(value: unknown): PermissionProfile | undefined {
	if (value === undefined) return undefined;
	if (value !== "read-only" && value !== "workspace" && value !== "full-access") {
		throw new Error("invalid permission profile");
	}
	return value;
}

function boundedIdentity(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`invalid ${label}`);
	const normalized = value.trim();
	if (!normalized || normalized.length > 512 || /[\r\n\0]/u.test(normalized)) {
		throw new Error(`invalid ${label}`);
	}
	return normalized;
}

function normalizedBaseUrl(value: unknown): string {
	const raw = boundedIdentity(value, "base URL").replace(/\/+$/u, "");
	const parsed = new URL(raw);
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
		|| parsed.username || parsed.password) {
		throw new Error("invalid base URL");
	}
	return raw;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
