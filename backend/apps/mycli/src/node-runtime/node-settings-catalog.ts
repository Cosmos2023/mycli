import {
	SHELL_SETTING_DESCRIPTORS,
	type ShellSettingSource,
} from "@mycli/config";

type JsonObject = Record<string, unknown>;

export const SETTINGS_CATALOG_VERSION = 1 as const;

export type SettingsCategoryId =
	| "appearance"
	| "diagnostics"
	| "integrations"
	| "model"
	| "permissions"
	| "providers"
	| "sessions";

export interface BuildNodeSettingsCatalogInput {
	readonly settings: Readonly<JsonObject>;
	readonly sources?: Readonly<Record<string, ShellSettingSource>>;
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort?: string;
	readonly credential?: Readonly<{
		readonly ready: boolean;
		readonly source: string;
	}>;
	readonly permissions: Readonly<JsonObject>;
	readonly trust: Readonly<JsonObject>;
	readonly context: Readonly<JsonObject>;
	readonly integrationsAvailable: boolean;
}

interface SettingsCategory {
	readonly id: SettingsCategoryId;
	readonly label: string;
	readonly description: string;
}

type SettingsItemKind = "action" | "choice" | "status";

interface SettingsItem {
	readonly id: string;
	readonly category: SettingsCategoryId;
	readonly kind: SettingsItemKind;
	readonly label: string;
	readonly description: string;
	readonly value: string;
	readonly source: string;
	readonly scope: string;
	readonly allowed_values?: readonly string[];
	readonly client_key?: string;
	readonly config_key?: string;
	readonly action?: string;
	readonly action_args?: string;
	readonly command?: string;
	readonly locked: boolean;
	readonly lock_reason?: string;
	readonly restart_required: boolean;
	readonly search_terms: readonly string[];
}

const CATEGORIES: readonly SettingsCategory[] = Object.freeze([
	category("model", "Model and reasoning", "Active model, provider, and reasoning effort"),
	category("providers", "Providers and credentials", "Provider authentication readiness"),
	category("permissions", "Permissions and sandbox", "Workspace trust, access profile, and isolation readiness"),
	category("appearance", "Appearance and accessibility", "Terminal presentation and interaction preferences"),
	category("sessions", "Sessions and context", "Saved sessions and context-window state"),
	category("integrations", "Integrations", "Skills, plugins, hooks, MCP, and runtime resources"),
	category("diagnostics", "Updates and diagnostics", "Runtime health, traces, and update readiness"),
]);

export function buildNodeSettingsCatalog(input: BuildNodeSettingsCatalogInput): JsonObject {
	const permission = recordValue(input.permissions.effective);
	const sandbox = recordValue(input.permissions.sandbox_readiness);
	const permissionSource = textValue(permission.source) ?? "runtime";
	const permissionActive = textValue(input.permissions.active) ?? "workspace";
	const trustState = textValue(input.trust.state) ?? "unknown";
	const trustSource = textValue(input.trust.source) ?? "runtime";
	const credentialValue = input.credential?.ready === true ? "Configured" : "Missing";
	const credentialSource = boundedText(input.credential?.source ?? "missing", 64);
	const usedTokens = numericValue(input.context.used_tokens);
	const maxTokens = numericValue(input.context.max_tokens);
	const contextValue = maxTokens > 0
		? `${usedTokens.toLocaleString("en-US")} / ${maxTokens.toLocaleString("en-US")} tokens`
		: "Unavailable";
	const items: SettingsItem[] = [
		actionItem({
			id: "model.selection",
			category: "model",
			label: "Model",
			description: "Choose the model and whether it applies to this session or future sessions",
			value: `${boundedText(input.provider, 96)} / ${boundedText(input.model, 160)}`,
			source: "session",
			scope: "session",
			action: "open_model_selector",
			command: "/model",
			searchTerms: ["provider", "thinking", "reasoning"],
		}),
		actionItem({
			id: "reasoning.effort",
			category: "model",
			label: "Reasoning effort",
			description: "Select a reasoning effort supported by the active model",
			value: boundedText(input.reasoningEffort ?? "default", 32),
			source: "session",
			scope: "session",
			action: "open_model_selector",
			command: "/model",
			searchTerms: ["thinking", "effort"],
		}),
		actionItem({
			id: "providers.credentials",
			category: "providers",
			label: "Credentials",
			description: "Configure a provider credential without exposing its value",
			value: credentialValue,
			source: credentialSource,
			scope: "user",
			action: "open_login",
			command: "/login",
			searchTerms: ["api key", "authentication", input.provider],
		}),
		actionItem({
			id: "permissions.profile",
			category: "permissions",
			label: "Permission profile",
			description: permissionSource === "managed"
				? "Choose access within the managed policy boundary"
				: "Choose filesystem, network, and approval behavior",
			value: boundedText(permissionActive, 64),
			source: permissionSource,
			scope: "session",
			action: "open_permissions",
			command: "/permissions",
			searchTerms: ["read only", "workspace", "full access", "approval"],
		}),
		statusItem({
			id: "permissions.sandbox",
			category: "permissions",
			label: "Sandbox readiness",
			description: "Reports whether restricted command isolation is ready without running setup",
			value: textValue(sandbox.state) ?? "unknown",
			source: textValue(sandbox.isolation) ?? "runtime",
			scope: "runtime",
			command: "/sandbox",
			searchTerms: ["isolation", "seatbelt", "bubblewrap", "windows sandbox"],
		}),
		actionItem({
			id: "permissions.trust",
			category: "permissions",
			label: "Workspace trust",
			description: "Review whether repository-owned configuration and integrations may load",
			value: trustState,
			source: trustSource,
			scope: "workspace",
			action: "open_trust",
			command: "/trust",
			searchTerms: ["project config", "repository"],
		}),
		...visualItems(input.settings, input.sources),
		actionItem({
			id: "sessions.saved",
			category: "sessions",
			label: "Saved sessions",
			description: "Browse and resume sessions in the current workspace",
			value: "Browse",
			source: "storage",
			scope: "workspace",
			action: "open_session_selector",
			command: "/resume",
			searchTerms: ["history", "resume", "fork"],
		}),
		actionItem({
			id: "sessions.context",
			category: "sessions",
			label: "Context window",
			description: "Inspect current prompt usage and compaction readiness",
			value: contextValue,
			source: textValue(input.context.source) ?? "runtime",
			scope: "session",
			action: "run_command",
			actionArgs: "/context",
			command: "/context",
			searchTerms: ["tokens", "compact", "usage"],
		}),
		actionItem({
			id: "integrations.resources",
			category: "integrations",
			label: "Runtime resources",
			description: "Browse skills, plugins, hooks, prompts, and themes",
			value: input.integrationsAvailable ? "Available" : "Not configured",
			source: "runtime",
			scope: "workspace",
			action: "open_resources",
			command: "/resources",
			locked: !input.integrationsAvailable,
			lockReason: input.integrationsAvailable ? undefined : "No integration resource service is configured",
			searchTerms: ["skills", "plugins", "hooks", "mcp"],
		}),
		actionItem({
			id: "diagnostics.status",
			category: "diagnostics",
			label: "Runtime status",
			description: "Inspect model, trust, permissions, sandbox, and active turn state",
			value: "Inspect",
			source: "runtime",
			scope: "session",
			action: "run_command",
			actionArgs: "/status",
			command: "/status",
			searchTerms: ["doctor", "health", "debug"],
		}),
		statusItem({
			id: "diagnostics.updates",
			category: "diagnostics",
			label: "Updates",
			description: "Automatic update management is not available in this build",
			value: "Manual",
			source: "package",
			scope: "user",
			locked: true,
			lockReason: "Use the package manager to update mycli",
			searchTerms: ["upgrade", "version", "npm"],
		}),
	];
	return Object.freeze({
		version: SETTINGS_CATALOG_VERSION,
		categories: CATEGORIES,
		items: Object.freeze(items),
	});
}

function visualItems(
	settings: Readonly<JsonObject>,
	sources: Readonly<Record<string, ShellSettingSource>> | undefined,
): SettingsItem[] {
	return SHELL_SETTING_DESCRIPTORS.map((item) => Object.freeze({
		id: item.key,
		category: "appearance" as const,
		kind: "choice" as const,
		label: item.label,
		description: item.description,
		value: boundedText(settings[item.settingKey] ?? item.defaultValue, 96),
		source: sources?.[item.settingKey] ?? "default",
		scope: sources?.[item.settingKey] === "user" ? "user" : "default",
		allowed_values: Object.freeze(item.allowedValues.map((value) => String(value))),
		client_key: item.clientKey,
		config_key: item.key,
		locked: false,
		restart_required: item.restartRequired,
		search_terms: Object.freeze([item.clientKey, item.settingKey, item.key]),
	}));
}

function actionItem(input: {
	readonly id: string;
	readonly category: SettingsCategoryId;
	readonly label: string;
	readonly description: string;
	readonly value: string;
	readonly source: string;
	readonly scope: string;
	readonly action: string;
	readonly actionArgs?: string;
	readonly command: string;
	readonly locked?: boolean;
	readonly lockReason?: string;
	readonly searchTerms: readonly string[];
}): SettingsItem {
	return Object.freeze({
		id: input.id,
		category: input.category,
		kind: "action",
		label: input.label,
		description: input.description,
		value: boundedText(input.value, 256),
		source: boundedText(input.source, 64),
		scope: boundedText(input.scope, 64),
		action: input.action,
		...(input.actionArgs ? { action_args: input.actionArgs } : {}),
		command: input.command,
		locked: input.locked ?? false,
		...(input.lockReason ? { lock_reason: boundedText(input.lockReason, 256) } : {}),
		restart_required: false,
		search_terms: Object.freeze(input.searchTerms.map((value) => boundedText(value, 128))),
	});
}

function statusItem(input: {
	readonly id: string;
	readonly category: SettingsCategoryId;
	readonly label: string;
	readonly description: string;
	readonly value: string;
	readonly source: string;
	readonly scope: string;
	readonly command?: string;
	readonly locked?: boolean;
	readonly lockReason?: string;
	readonly searchTerms: readonly string[];
}): SettingsItem {
	return Object.freeze({
		id: input.id,
		category: input.category,
		kind: "status",
		label: input.label,
		description: input.description,
		value: boundedText(input.value, 256),
		source: boundedText(input.source, 64),
		scope: boundedText(input.scope, 64),
		...(input.command ? { command: input.command } : {}),
		locked: input.locked ?? false,
		...(input.lockReason ? { lock_reason: boundedText(input.lockReason, 256) } : {}),
		restart_required: false,
		search_terms: Object.freeze(input.searchTerms.map((value) => boundedText(value, 128))),
	});
}

function category(id: SettingsCategoryId, label: string, description: string): SettingsCategory {
	return Object.freeze({ id, label, description });
}

function recordValue(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as JsonObject
		: {};
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? boundedText(value, 128) : undefined;
}

function numericValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function boundedText(value: unknown, limit: number): string {
	const sanitized = [...String(value ?? "")].map((character) => {
		const code = character.charCodeAt(0);
		return code < 0x20 || code === 0x7f ? " " : character;
	}).join("")
		.replace(/\s+/gu, " ")
		.trim();
	return [...sanitized].slice(0, limit).join("");
}
