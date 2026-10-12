import {
	SHELL_SETTING_DESCRIPTORS,
	type ShellSettingSource,
} from "@mycli/config";

type JsonObject = Record<string, unknown>;

const SETTINGS_CATALOG_VERSION = 1 as const;

type SettingsCategoryId = "appearance";

interface BuildNodeSettingsCatalogInput {
	readonly settings: Readonly<JsonObject>;
	readonly sources?: Readonly<Record<string, ShellSettingSource>>;
	readonly terminalCapabilities?: Readonly<JsonObject>;
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
	category("appearance", "Appearance and accessibility", "Terminal presentation and interaction preferences"),
]);

/**
 * `/settings` holds the preferences that actually change behaviour. Everything else — model,
 * credentials, permissions, sessions, integrations, updates — already has its own command, so
 * the panel shows one read-only summary line instead of duplicating those commands as rows.
 */
export function buildNodeSettingsCatalog(input: BuildNodeSettingsCatalogInput): JsonObject {
	const permissionActive = textValue(input.permissions.active) ?? "workspace";
	const trustState = textValue(input.trust.state) ?? "unknown";
	const usedTokens = numericValue(input.context.used_tokens);
	const maxTokens = numericValue(input.context.max_tokens);
	const contextValue = maxTokens > 0
		? `${usedTokens.toLocaleString("en-US")}/${maxTokens.toLocaleString("en-US")} tokens`
		: "no context data";
	const items: SettingsItem[] = [
		...visualItems(input.settings, input.sources),
		terminalCapabilityItem(input.terminalCapabilities),
		actionItem({
			id: "keymap.reset",
			category: "appearance",
			label: "Reset keymap",
			description: "Remove user key overrides and restore the effective layered defaults",
			value: "Reset",
			source: "user_config",
			scope: "user",
			action: "reset_keymap",
			searchTerms: ["keyboard", "shortcuts", "bindings", "defaults"],
		}),
	];
	return Object.freeze({
		version: SETTINGS_CATALOG_VERSION,
		// Ordered so the line reads like a statusline: model, thinking, permissions, trust, context.
		summary: boundedText([
			`${boundedText(input.provider, 64)}/${boundedText(input.model, 128)}`,
			...(input.reasoningEffort ? [boundedText(input.reasoningEffort, 24)] : []),
			boundedText(permissionActive, 32),
			boundedText(trustState, 32),
			boundedText(contextValue, 40),
			...(input.credential && input.credential.ready !== true ? ["credentials missing"] : []),
		].join(" · "), 400),
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

function terminalCapabilityItem(
	capabilities: Readonly<JsonObject> | undefined,
): SettingsItem {
	const value = recordValue(capabilities);
	const colorMode = textValue(value.color_mode) ?? "unknown color";
	const glyphMode = textValue(value.glyph_mode) ?? "unknown glyphs";
	const progress = value.progress_visible === false
		? "progress hidden"
		: value.progress_animated === false
			? "static progress"
			: "animated progress";
	const guidance = Array.isArray(value.guidance)
		? value.guidance
			.filter((item): item is string => typeof item === "string")
			.slice(0, 2)
			.map((item) => boundedText(item, 256))
			.filter(Boolean)
		: [];
	return statusItem({
		id: "terminal.capabilities",
		category: "appearance",
		label: "Terminal capabilities",
		description: guidance.length > 0
			? guidance.join(" ")
			: "Effective color, glyph, and progress behavior for this terminal",
		value: `${colorMode} / ${glyphMode} / ${progress}`,
		source: textValue(value.terminal_kind) ?? "runtime",
		scope: "runtime",
		searchTerms: ["color", "unicode", "ascii", "motion", "contrast", "terminal"],
	});
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
	readonly command?: string;
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
		...(input.command ? { command: input.command } : {}),
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
