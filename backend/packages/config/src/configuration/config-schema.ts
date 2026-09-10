import {
	configDiagnostic,
	configError,
	type ConfigDiagnostic,
	type ConfigFileLayerId,
} from "./config-diagnostics.ts";
import {
	TUI_KEYMAP_CONTEXTS,
	tuiKeymapActionForConfig,
	tuiKeymapConfigPath,
} from "@mycli/contracts";
import { configSettingDescriptors } from "./runtime-setting-catalog.ts";
import { SHELL_SETTING_DESCRIPTORS } from "../terminal/shell-setting-catalog.ts";
import { valueAtPath } from "./config-value.ts";

type ConfigMap = Record<string, unknown>;

export interface ValidatedConfigDocument {
	readonly values: Readonly<ConfigMap>;
	readonly diagnostics: readonly ConfigDiagnostic[];
}

export const CONFIG_SECTION_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	model: {
		provider: "provider",
		protocol: "protocol",
		name: "model",
		api_base_url: "api_base_url",
		auth_ref: "auth_ref",
		supports_images: "supports_images",
	},
	request: {
		max_prompt_tokens: "max_prompt_tokens",
		request_max_retries: "request_max_retries",
		stream_max_retries: "stream_max_retries",
		request_max_retries_by_provider: "request_max_retries_by_provider",
		stream_max_retries_by_provider: "stream_max_retries_by_provider",
		cache_retention: "cache_retention",
	},
	reasoning: {
		enabled: "thinking_enabled",
		effort: "thinking_effort",
		reasoning_effort: "reasoning_effort",
	},
	memory: {
		enabled: "memory_enabled",
	},
	features: {
		request_permissions_tool: "request_permissions_tool",
	},
	updates: {
		check_on_startup: "updates_check_on_startup",
	},
	context: {
		compression_threshold_tokens: "compression_threshold_tokens",
		compaction_token_limit: "compaction_token_limit",
		compaction_reserved_output_tokens: "compaction_reserved_output_tokens",
		compaction_tail_turns: "compaction_tail_turns",
		compaction_tail_max_tokens: "compaction_tail_max_tokens",
		compaction_l4_trigger_ratio: "compaction_l4_trigger_ratio",
		compaction_l4_buffer_tokens: "compaction_l4_buffer_tokens",
		compaction_l4_min_savings_ratio: "compaction_l4_min_savings_ratio",
		compaction_l4_input_cost_per_1k: "compaction_l4_input_cost_per_1k",
		compaction_l4_output_cost_per_1k: "compaction_l4_output_cost_per_1k",
		compaction_l4_carry_cost_per_1k: "compaction_l4_carry_cost_per_1k",
		compaction_l4_expected_summary_tokens: "compaction_l4_expected_summary_tokens",
		compaction_l4_carry_turns: "compaction_l4_carry_turns",
		compaction_l4_summarizer_model: "compaction_l4_summarizer_model",
		compaction_rehydration_file_max_total_tokens:
			"compaction_rehydration_file_max_total_tokens",
		compaction_rehydration_file_max_item_tokens:
			"compaction_rehydration_file_max_item_tokens",
		compaction_rehydration_max_files: "compaction_rehydration_max_files",
	},
};

export const MODEL_COMPACTION_RATIOS_KEY = "compaction_l4_trigger_ratios_by_model";

const LEGACY_RUNTIME_KEYS = new Set([
	"api_key",
	"transport_retry_limit",
	...Object.values(CONFIG_SECTION_KEYS).flatMap((section) => Object.values(section)),
]);

const SHELL_SETTING_KEYS = new Set(SHELL_SETTING_DESCRIPTORS.flatMap((item) => [
	...item.inputKeys,
	...item.legacyPaths.flatMap((path) => path.length === 1 ? [path[0]!] : []),
]));

const PLUGIN_KEYS = new Set(["disabled", "enabled"]);
const INLINE_SECRET_KEYS = new Set(["access_token", "api_key", "password", "secret", "token"]);
const REMOVED_CACHE_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
	"request.prompt_cache_key_enabled": "request.cache_retention",
	"request.cache_control_enabled": "request.cache_retention",
	prompt_cache_key_enabled: "request.cache_retention",
	cache_control_enabled: "request.cache_retention",
});

export function validateConfigDocument(
	payload: ConfigMap,
	layer: ConfigFileLayerId,
): ValidatedConfigDocument {
	const values: ConfigMap = {};
	const diagnostics: ConfigDiagnostic[] = layer === "legacy_user"
		? [configDiagnostic({
			code: "deprecated_config_file",
			severity: "warning",
			layer,
			message: "legacy user configuration is still in use",
			remediation: "Run 'mycli config migrate --dry-run' to preview importing supported settings.",
		})]
		: [];

	for (const key of Object.keys(payload).sort(compareText)) {
		const value = payload[key];
		if (key === "tui") {
			validateTuiSection(value, layer, values, diagnostics);
			continue;
		}
		const section = CONFIG_SECTION_KEYS[key];
		if (section && isRecord(value)) {
			validateRuntimeSection(key, value, section, layer, values, diagnostics);
			continue;
		}
		if (section && !LEGACY_RUNTIME_KEYS.has(key)) {
			throw configError({
				code: "invalid_value",
				severity: "error",
				layer,
				keyPath: key,
				message: `${layerLabel(layer)} config '${key}' must be a table`,
				remediation: `Replace '${key}' with a TOML table or remove it.`,
			});
		}
		if (key === "plugins") {
			validatePluginSection(value, layer, diagnostics);
			continue;
		}
		if (key === MODEL_COMPACTION_RATIOS_KEY) {
			values[key] = value;
			continue;
		}
		if (INLINE_SECRET_KEYS.has(key)) {
			handleInlineSecret(key, value, layer, values, diagnostics, true);
			continue;
		}
		if (LEGACY_RUNTIME_KEYS.has(key)) {
			values[key] = value;
			continue;
		}
		if (REMOVED_CACHE_SETTINGS[key]) {
			diagnostics.push(removedCacheSettingDiagnostic(layer, key));
			continue;
		}
		if (SHELL_SETTING_KEYS.has(key)) {
			values[key] = value;
			continue;
		}
		diagnostics.push(unknownDiagnostic(layer, key, isRecord(value)));
	}
	diagnostics.push(...deprecatedAliasDiagnostics(payload, layer));

	return Object.freeze({
		values: Object.freeze(values),
		diagnostics: Object.freeze(diagnostics),
	});
}

function validateTuiSection(
	value: unknown,
	layer: ConfigFileLayerId,
	values: ConfigMap,
	diagnostics: ConfigDiagnostic[],
): void {
	if (!isRecord(value)) {
		throw configError({
			code: "invalid_value",
			severity: "error",
			layer,
			keyPath: "tui",
			message: `${layerLabel(layer)} config 'tui' must be a table`,
			remediation: "Use [tui.keymap.<context>] tables or remove the setting.",
		});
	}
	for (const key of Object.keys(value).sort(compareText)) {
		if (key === "keymap") {
			validateTuiKeymap(value[key], layer, values);
			continue;
		}
		diagnostics.push(unknownDiagnostic(layer, `tui.${key}`, isRecord(value[key])));
	}
}

function validateTuiKeymap(
	value: unknown,
	layer: ConfigFileLayerId,
	values: ConfigMap,
): void {
	if (!isRecord(value)) throw invalidKeymapTable(layer, "tui.keymap");
	for (const context of Object.keys(value).sort(compareText)) {
		if (!TUI_KEYMAP_CONTEXTS.includes(context as typeof TUI_KEYMAP_CONTEXTS[number])) {
			throw invalidKeymapEntry(layer, `tui.keymap.${context}`, "keymap context is not supported");
		}
		const table = value[context];
		if (!isRecord(table)) throw invalidKeymapTable(layer, `tui.keymap.${context}`);
		for (const configKey of Object.keys(table).sort(compareText)) {
			const action = tuiKeymapActionForConfig(context, configKey);
			if (!action) {
				throw invalidKeymapEntry(
					layer,
					`tui.keymap.${context}.${configKey}`,
					"keymap action is not supported",
				);
			}
			values[tuiKeymapConfigPath(action)] = table[configKey];
		}
	}
}

function invalidKeymapTable(layer: ConfigFileLayerId, keyPath: string): Error {
	return invalidKeymapEntry(layer, keyPath, "keymap entry must be a table");
}

function invalidKeymapEntry(
	layer: ConfigFileLayerId,
	keyPath: string,
	message: string,
): Error {
	return configError({
		code: "invalid_value",
		severity: "error",
		layer,
		keyPath,
		message,
		remediation: "Use an action and context listed by the effective keymap viewer.",
	});
}

function deprecatedAliasDiagnostics(
	payload: ConfigMap,
	layer: ConfigFileLayerId,
): readonly ConfigDiagnostic[] {
	const paths = new Set<string>();
	for (const setting of configSettingDescriptors()) {
		for (const legacyPath of setting.legacyPaths) {
			if (samePath(legacyPath, setting.path)) continue;
			const value = valueAtPath(payload, legacyPath);
			if (value === undefined) continue;
			if (isPathPrefix(legacyPath, setting.path) && isRecord(value)) continue;
			paths.add(legacyPath.join("."));
		}
	}
	return Object.freeze([...paths].sort(compareText).map((keyPath) => configDiagnostic({
		code: "deprecated_key",
		severity: "warning",
		layer,
		keyPath,
		message: `${layerLabel(layer)} config uses a deprecated setting alias`,
		remediation: "Run 'mycli config migrate --dry-run' to preview the canonical replacement.",
	})));
}

function validateRuntimeSection(
	sectionName: string,
	value: unknown,
	mappings: Readonly<Record<string, string>>,
	layer: ConfigFileLayerId,
	values: ConfigMap,
	diagnostics: ConfigDiagnostic[],
): void {
	if (!isRecord(value)) return;
	for (const key of Object.keys(value).sort(compareText)) {
		const keyPath = `${sectionName}.${key}`;
		const flattened = mappings[key];
		if (flattened) {
			values[flattened] = value[key];
			continue;
		}
		if (REMOVED_CACHE_SETTINGS[keyPath]) {
			diagnostics.push(removedCacheSettingDiagnostic(layer, keyPath));
			continue;
		}
		if (INLINE_SECRET_KEYS.has(key)) {
			handleInlineSecret(keyPath, value[key], layer, values, diagnostics, false);
			continue;
		}
		diagnostics.push(unknownDiagnostic(layer, keyPath, isRecord(value[key])));
	}
}

function removedCacheSettingDiagnostic(
	layer: ConfigFileLayerId,
	keyPath: string,
): ConfigDiagnostic {
	return configDiagnostic({
		code: "deprecated_key",
		severity: "warning",
		layer,
		keyPath,
		message: `${layerLabel(layer)} config uses a retired provider cache setting`,
		remediation: "Replace it with request.cache_retention = \"none\", \"short\", or \"long\".",
	});
}

function validatePluginSection(
	value: unknown,
	layer: ConfigFileLayerId,
	diagnostics: ConfigDiagnostic[],
): void {
	if (!isRecord(value)) {
		diagnostics.push(configDiagnostic({
			code: "invalid_value",
			severity: "warning",
			layer,
			keyPath: "plugins",
			message: `${layerLabel(layer)} config 'plugins' should be a table`,
			remediation: "Use [plugins] with enabled and disabled arrays.",
		}));
		return;
	}
	for (const key of Object.keys(value).sort(compareText)) {
		if (!PLUGIN_KEYS.has(key)) {
			diagnostics.push(unknownDiagnostic(layer, `plugins.${key}`, isRecord(value[key])));
		}
	}
}

function handleInlineSecret(
	keyPath: string,
	value: unknown,
	layer: ConfigFileLayerId,
	values: ConfigMap,
	diagnostics: ConfigDiagnostic[],
	root: boolean,
): void {
	if ((layer !== "user" && layer !== "legacy_user") || keyPath !== "api_key") {
		throw configError({
			code: "forbidden_inline_secret",
			severity: "error",
			layer,
			keyPath,
			message: `${layerLabel(layer)} config contains a forbidden credential field`,
			remediation: "Move credentials to ~/.mycli/auth.json or the process environment.",
		});
	}
	diagnostics.push(configDiagnostic({
		code: "deprecated_inline_secret",
		severity: "warning",
		layer,
		keyPath,
		message: `${layerLabel(layer)} config uses a deprecated inline API key`,
		remediation: "Move the API key to ~/.mycli/auth.json and remove it from config.toml.",
	}));
	if (root) values.api_key = value;
}

function unknownDiagnostic(
	layer: ConfigFileLayerId,
	keyPath: string,
	table: boolean,
): ConfigDiagnostic {
	return configDiagnostic({
		code: table ? "unknown_table" : "unknown_key",
		severity: "warning",
		layer,
		keyPath,
		message: `${layerLabel(layer)} config contains an unknown ${table ? "table" : "key"}`,
		remediation: "Remove the entry or replace it with a supported configuration key.",
	});
}

function layerLabel(layer: ConfigFileLayerId): string {
	return layer === "legacy_user" ? "legacy user" : layer;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is ConfigMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
	return prefix.length < path.length && prefix.every((segment, index) => segment === path[index]);
}
