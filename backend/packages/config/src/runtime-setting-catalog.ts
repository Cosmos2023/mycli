import type { NodeRuntimeConfig } from "./settings.ts";
import {
	shellSettingDescriptor,
	SHELL_SETTING_DESCRIPTORS,
} from "./shell-setting-catalog.ts";

export type RuntimeSettingValue =
	| string
	| number
	| boolean
	| null
	| Readonly<Record<string, number>>;

export type UserConfigScalar = string | number | boolean;

export type UserConfigValueKind = "boolean" | "integer" | "number" | "string";

export interface RuntimeSettingSnapshot {
	readonly key: string;
	readonly originKeys: readonly string[];
	readonly value: RuntimeSettingValue;
	readonly writable: boolean;
}

export interface WritableRuntimeSetting {
	readonly key: string;
	readonly path: readonly string[];
	readonly legacyPaths: readonly (readonly string[])[];
	readonly valueKind: UserConfigValueKind;
	readonly allowedValues?: readonly string[];
}

interface RuntimeSettingDefinition {
	readonly key: string;
	readonly originKeys: readonly string[];
	readonly value: (config: NodeRuntimeConfig) => RuntimeSettingValue;
	readonly write?: Omit<WritableRuntimeSetting, "key">;
}

const DEFINITIONS: readonly RuntimeSettingDefinition[] = Object.freeze([
	writable("context.compaction_l4_buffer_tokens", "compaction_l4_buffer_tokens", "integer", (config) => (
		config.compactionBufferTokens
	)),
	writable(
		"context.compaction_l4_carry_cost_per_1k",
		"compaction_l4_carry_cost_per_1k",
		"number",
		(config) => config.compactionCarryCostPer1k,
	),
	writable("context.compaction_l4_carry_turns", "compaction_l4_carry_turns", "integer", (config) => (
		config.compactionCarryTurns
	)),
	writable(
		"context.compaction_l4_expected_summary_tokens",
		"compaction_l4_expected_summary_tokens",
		"integer",
		(config) => config.compactionExpectedSummaryTokens,
	),
	writable(
		"context.compaction_l4_input_cost_per_1k",
		"compaction_l4_input_cost_per_1k",
		"number",
		(config) => config.compactionInputCostPer1k,
	),
	writable(
		"context.compaction_l4_min_savings_ratio",
		"compaction_l4_min_savings_ratio",
		"number",
		(config) => config.compactionMinSavingsRatio ?? null,
	),
	writable(
		"context.compaction_l4_output_cost_per_1k",
		"compaction_l4_output_cost_per_1k",
		"number",
		(config) => config.compactionOutputCostPer1k,
	),
	writable(
		"context.compaction_l4_summarizer_model",
		"compaction_l4_summarizer_model",
		"string",
		(config) => config.compactionSummarizerModel ?? null,
	),
	writable("context.compaction_l4_trigger_ratio", "compaction_l4_trigger_ratio", "number", (config) => (
		config.compactionTriggerRatio
	)),
	readOnly(
		"context.compaction_l4_trigger_ratios_by_model",
		"compaction_l4_trigger_ratios_by_model",
		(config) => config.compactionTriggerRatiosByModel,
	),
	writable(
		"context.compaction_rehydration_file_max_item_tokens",
		"compaction_rehydration_file_max_item_tokens",
		"integer",
		(config) => config.compactionRehydrationFileMaxItemTokens,
	),
	writable(
		"context.compaction_rehydration_file_max_total_tokens",
		"compaction_rehydration_file_max_total_tokens",
		"integer",
		(config) => config.compactionRehydrationFileMaxTotalTokens,
	),
	writable(
		"context.compaction_rehydration_max_files",
		"compaction_rehydration_max_files",
		"integer",
		(config) => config.compactionRehydrationMaxFiles,
	),
	writable(
		"context.compaction_reserved_output_tokens",
		"compaction_reserved_output_tokens",
		"integer",
		(config) => config.compactionReservedOutputTokens,
	),
	writable("context.compaction_tail_max_tokens", "compaction_tail_max_tokens", "integer", (config) => (
		config.compactionTailMaxTokens
	)),
	writable("context.compaction_tail_turns", "compaction_tail_turns", "integer", (config) => (
		config.compactionTailTurns
	)),
	writable("context.compaction_token_limit", "compaction_token_limit", "integer", (config) => (
		config.compactionTokenLimit
	)),
	writable(
		"context.compression_threshold_tokens",
		"compression_threshold_tokens",
		"integer",
		(config) => config.compressionThresholdTokens,
	),
	writable(
		"features.request_permissions_tool",
		"request_permissions_tool",
		"boolean",
		(config) => config.requestPermissionsToolEnabled,
	),
	writable("memory.enabled", "memory_enabled", "boolean", (config) => config.memoryEnabled),
	writable("model.api_base_url", "api_base_url", "string", (config) => config.apiBaseUrl),
	writable("model.auth_ref", "auth_ref", "string", (config) => config.authRef),
	writable("model.name", "model", "string", (config) => config.model),
	writable("model.protocol", "protocol", "string", (config) => config.protocol),
	writable("model.provider", "provider", "string", (config) => config.provider),
	writable("model.supports_images", "supports_images", "boolean", (config) => config.supportsImages),
	readOnly("model.web_search_mode", "web_search_mode", (config) => config.webSearchMode),
	writable(
		"reasoning.effort",
		["thinking_effort", "reasoning_effort"],
		"string",
		(config) => config.reasoningEffort,
		[["reasoning", "reasoning_effort"]],
	),
	writable("reasoning.enabled", "thinking_enabled", "boolean", (config) => config.thinkingEnabled),
	writable(
		"request.cache_control_enabled",
		"cache_control_enabled",
		"boolean",
		(config) => config.cacheControlEnabled,
	),
	writable("request.max_prompt_tokens", "max_prompt_tokens", "integer", (config) => (
		config.maxPromptTokens
	)),
	writable(
		"request.prompt_cache_key_enabled",
		"prompt_cache_key_enabled",
		"boolean",
		(config) => config.promptCacheKeyEnabled,
	),
	writable("request.request_max_retries", "request_max_retries", "integer", (config) => (
		config.requestMaxRetries
	)),
	writable(
		"request.stream_max_retries",
		["stream_max_retries", "transport_retry_limit"],
		"integer",
		(config) => config.streamMaxRetries,
	),
	writable(
		"updates.check_on_startup",
		"updates_check_on_startup",
		"boolean",
		(config) => config.updatesCheckOnStartup,
	),
].sort((left, right) => compareText(left.key, right.key)));

const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

export function runtimeSettingSnapshots(
	config: NodeRuntimeConfig,
): readonly RuntimeSettingSnapshot[] {
	return Object.freeze(DEFINITIONS.map((definition) => Object.freeze({
		key: definition.key,
		originKeys: definition.originKeys,
		value: definition.value(config),
		writable: definition.write !== undefined,
	})));
}

export function runtimeSettingOriginKeysForDiagnostic(
	keyPath: string,
): readonly string[] {
	const direct = BY_KEY.get(keyPath);
	if (direct) return direct.originKeys;
	const byOrigin = DEFINITIONS.find((definition) => definition.originKeys.includes(keyPath));
	if (byOrigin) return byOrigin.originKeys;
	const ratioKey = "compaction_l4_trigger_ratios_by_model";
	return Object.freeze([
		keyPath.startsWith(`${ratioKey}.`) ? ratioKey : keyPath,
	]);
}

export function writableRuntimeSetting(key: string): WritableRuntimeSetting | undefined {
	const definition = BY_KEY.get(key);
	if (definition?.write) return Object.freeze({ key: definition.key, ...definition.write });
	const shell = shellSettingDescriptor(key);
	if (!shell) return undefined;
	return Object.freeze({
		key: shell.key,
		path: shell.path,
		legacyPaths: shell.legacyPaths,
		valueKind: shell.valueKind,
		...(shell.valueKind === "string"
			? { allowedValues: Object.freeze(shell.allowedValues.filter((value): value is string => typeof value === "string")) }
			: {}),
	});
}

export function hasRuntimeSetting(key: string): boolean {
	return BY_KEY.has(key) || SHELL_SETTING_DESCRIPTORS.some((item) => item.key === key);
}

function writable(
	key: string,
	originKeys: string | readonly string[],
	valueKind: UserConfigValueKind,
	value: (config: NodeRuntimeConfig) => RuntimeSettingValue,
	extraLegacyPaths: readonly (readonly string[])[] = [],
): RuntimeSettingDefinition {
	const path = Object.freeze(key.split("."));
	const origins = stringList(originKeys);
	const legacyPaths = Object.freeze([
		...origins.map((origin) => Object.freeze([origin])),
		...extraLegacyPaths.map((legacyPath) => Object.freeze([...legacyPath])),
	]);
	return Object.freeze({
		key,
		originKeys: origins,
		value,
		write: Object.freeze({ path, legacyPaths, valueKind }),
	});
}

function readOnly(
	key: string,
	originKeys: string | readonly string[],
	value: (config: NodeRuntimeConfig) => RuntimeSettingValue,
): RuntimeSettingDefinition {
	return Object.freeze({ key, originKeys: stringList(originKeys), value });
}

function stringList(value: string | readonly string[]): readonly string[] {
	return Object.freeze(typeof value === "string" ? [value] : [...value]);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
