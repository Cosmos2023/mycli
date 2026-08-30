import {
	configDiagnostic,
	configError,
	type ConfigDiagnostic,
	type ConfigFileLayerId,
} from "./config-diagnostics.ts";

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
		prompt_cache_key_enabled: "prompt_cache_key_enabled",
		cache_control_enabled: "cache_control_enabled",
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

const SHELL_SETTING_KEYS = new Set([
	"clearOnShrink",
	"clear_on_shrink",
	"hardwareCursor",
	"hardware_cursor",
	"hideThinking",
	"hide_thinking",
	"statusbarMode",
	"statusbar_mode",
	"statusline_enabled",
	"subagentDensity",
	"subagent_density",
	"terminalProgress",
	"terminal_progress",
	"theme",
	"toolDetailsDefault",
	"tool_details_default",
	"tui_clear_on_shrink",
	"tui_hardware_cursor",
	"tui_hide_thinking",
	"tui_statusbar_mode",
	"tui_subagent_density",
	"tui_terminal_progress",
	"tui_theme",
	"tui_tool_details_default",
	"viewMode",
	"view_mode",
]);

const PLUGIN_KEYS = new Set(["disabled", "enabled"]);
const INLINE_SECRET_KEYS = new Set(["access_token", "api_key", "password", "secret", "token"]);

export function validateConfigDocument(
	payload: ConfigMap,
	layer: ConfigFileLayerId,
): ValidatedConfigDocument {
	const values: ConfigMap = {};
	const diagnostics: ConfigDiagnostic[] = [];

	for (const key of Object.keys(payload).sort(compareText)) {
		const value = payload[key];
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
		if (SHELL_SETTING_KEYS.has(key)) continue;
		diagnostics.push(unknownDiagnostic(layer, key, isRecord(value)));
	}

	return Object.freeze({
		values: Object.freeze(values),
		diagnostics: Object.freeze(diagnostics),
	});
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
		if (INLINE_SECRET_KEYS.has(key)) {
			handleInlineSecret(keyPath, value[key], layer, values, diagnostics, false);
			continue;
		}
		diagnostics.push(unknownDiagnostic(layer, keyPath, isRecord(value[key])));
	}
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
	if (layer === "project" || keyPath !== "api_key") {
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
