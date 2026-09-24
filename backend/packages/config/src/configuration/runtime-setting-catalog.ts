import { PROVIDER_IDS } from "@mycli/core";
import type { NodeRuntimeConfig } from "./settings.ts";
import {
	shellSettingDescriptor,
	SHELL_SETTING_DESCRIPTORS,
} from "../terminal/shell-setting-catalog.ts";

export type RuntimeSettingValue =
	| string
	| number
	| boolean
	| null
	| Readonly<Record<string, number>>;

export type UserConfigScalar = string | number | boolean;

export type UserConfigValueKind = "boolean" | "integer" | "number" | "string";

export type ConfigSettingValueKind = UserConfigValueKind | "number_map";

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

export interface ConfigSettingDescriptor {
	readonly key: string;
	readonly description: string;
	readonly path: readonly string[];
	readonly legacyPaths: readonly (readonly string[])[];
	readonly valueKind: ConfigSettingValueKind;
	readonly writable: boolean;
	readonly allowedValues?: readonly (boolean | string)[];
	readonly restartRequired: boolean;
}

interface RuntimeSettingDefinition {
	readonly key: string;
	readonly originKeys: readonly string[];
	readonly value: (config: NodeRuntimeConfig) => RuntimeSettingValue;
	readonly write?: Omit<WritableRuntimeSetting, "key">;
	readonly readOnlyValueKind?: ConfigSettingValueKind;
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
		"number_map",
		(config) => config.compactionTriggerRatiosByModel,
	),
	writable(
		"context.compaction_limit_scope",
		"compaction_limit_scope",
		"string",
		(config) => config.compactionLimitScope,
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
	readOnly("model.web_search_mode", "web_search_mode", "string", (config) => config.webSearchMode),
	writable(
		"reasoning.effort",
		["thinking_effort", "reasoning_effort"],
		"string",
		(config) => config.reasoningEffort,
		[["reasoning", "reasoning_effort"]],
	),
	writable("reasoning.enabled", "thinking_enabled", "boolean", (config) => config.thinkingEnabled),
	writable(
		"request.cache_retention",
		"cache_retention",
		"string",
		(config) => config.cacheRetention,
	),
	writable("request.max_prompt_tokens", "max_prompt_tokens", "integer", (config) => (
		config.maxPromptTokens
	)),
	writable("request.request_max_retries", "request_max_retries", "integer", (config) => (
		config.requestMaxRetries
	)),
	readOnly(
		"request.request_max_retries_by_provider",
		"request_max_retries_by_provider",
		"number_map",
		(config) => config.requestMaxRetriesByProvider ?? Object.freeze({}),
	),
	writable(
		"request.stream_max_retries",
		["stream_max_retries", "transport_retry_limit"],
		"integer",
		(config) => config.streamMaxRetries,
	),
	readOnly(
		"request.stream_max_retries_by_provider",
		"stream_max_retries_by_provider",
		"number_map",
		(config) => config.streamMaxRetriesByProvider ?? Object.freeze({}),
	),
	writable(
		"updates.check_on_startup",
		"updates_check_on_startup",
		"boolean",
		(config) => config.updatesCheckOnStartup,
	),
].sort((left, right) => compareText(left.key, right.key)));

const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

const RUNTIME_SETTING_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
	"context.compaction_l4_buffer_tokens": "Keeps this many prompt tokens free when deciding whether automatic compaction should run.",
	"context.compaction_l4_carry_cost_per_1k": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_l4_carry_turns": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_l4_expected_summary_tokens": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_l4_input_cost_per_1k": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_l4_min_savings_ratio": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_l4_output_cost_per_1k": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_l4_summarizer_model": "Selects an optional model override for compaction summaries.",
	"context.compaction_l4_trigger_ratio": "Starts automatic compaction when estimated prompt use reaches this fraction of the active context window.",
	"context.compaction_l4_trigger_ratios_by_model": "Reports per-model compaction trigger overrides; this structured setting is read-only through config commands.",
	"context.compaction_limit_scope": "Selects whether the compaction trigger counts the full prompt or only the tokens added after the carried prefix.",
	"context.compaction_rehydration_file_max_item_tokens": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_rehydration_file_max_total_tokens": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_rehydration_max_files": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_reserved_output_tokens": "Reserves context capacity for the next model response during compaction budgeting.",
	"context.compaction_tail_max_tokens": "Caps retained user-message text after compaction (default 20000 tokens); the boundary message is truncated with a marker.",
	"context.compaction_tail_turns": "Legacy compatibility setting; unused by local context compaction.",
	"context.compaction_token_limit": "Sets the prompt-token ceiling used to trigger compaction.",
	"context.compression_threshold_tokens": "Caps one model-visible tool result (estimated at four bytes per token, capped at 8000 characters); longer results are truncated with a marker before they are recorded.",
	"features.request_permissions_tool": "Exposes the structured permission-request tool when the active runtime supports it.",
	"memory.enabled": "Enables durable memory discovery and injection for the active agent runtime.",
	"model.api_base_url": "Sets the HTTP(S) API endpoint used by the configured provider.",
	"model.auth_ref": "Selects the credential-store reference without placing a credential in TOML.",
	"model.name": "Selects the provider model used for new runtime requests.",
	"model.protocol": "Selects the provider wire protocol used for model requests.",
	"model.provider": "Selects a stable profile or an explicitly configured provider route.",
	"model.supports_images": "Overrides whether the selected compatible endpoint accepts image inputs.",
	"model.web_search_mode": "Reports the web-search mode derived from provider capabilities; this setting is read-only.",
	"reasoning.effort": "Selects the reasoning effort requested from models that support effort controls.",
	"reasoning.enabled": "Enables or disables model reasoning for providers that expose this capability.",
	"request.cache_retention": "Selects the provider-neutral prompt-cache retention preference passed to pi-ai.",
	"request.max_prompt_tokens": "Caps the prompt tokens assembled for each model request.",
	"request.request_max_retries": "Limits retries for failures that occur before model output begins.",
	"request.request_max_retries_by_provider": "Overrides request retry budgets by provider route with integers from 0 to 100; omitted routes use the global budget. Read-only through config commands.",
	"request.stream_max_retries": "Limits retries for interrupted model response streams.",
	"request.stream_max_retries_by_provider": "Overrides stream retry budgets by provider route with integers from 0 to 100; omitted routes use the global budget. Read-only through config commands.",
	"updates.check_on_startup": "Enables the background cached update check after interactive startup.",
});

const RUNTIME_ALLOWED_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	"context.compaction_limit_scope": Object.freeze(["total", "body_after_prefix"]),
	"model.provider": PROVIDER_IDS,
	"model.protocol": Object.freeze(["responses", "chat_completions", "anthropic_messages"]),
	"reasoning.effort": Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
	"request.cache_retention": Object.freeze(["none", "short", "long"]),
});

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

export function writableRuntimeSettings(): readonly WritableRuntimeSetting[] {
	return Object.freeze(configSettingDescriptors().flatMap((descriptor) => (
		descriptor.writable
			? [Object.freeze({
				key: descriptor.key,
				path: descriptor.path,
				legacyPaths: descriptor.legacyPaths,
				valueKind: descriptor.valueKind as UserConfigValueKind,
				...(descriptor.allowedValues && descriptor.valueKind === "string"
					? { allowedValues: Object.freeze(descriptor.allowedValues.filter(
						(value): value is string => typeof value === "string",
					)) }
					: {}),
			})]
			: []
	)));
}

export function configSettingDescriptors(): readonly ConfigSettingDescriptor[] {
	const runtime = DEFINITIONS.map((definition): ConfigSettingDescriptor => {
		const description = RUNTIME_SETTING_DESCRIPTIONS[definition.key];
		if (!description) throw new Error(`missing_config_setting_description:${definition.key}`);
		return Object.freeze({
			key: definition.key,
			description,
			path: definition.write?.path ?? Object.freeze(definition.key.split(".")),
			legacyPaths: definition.write?.legacyPaths ?? Object.freeze([]),
			valueKind: definition.write?.valueKind ?? definition.readOnlyValueKind ?? "string",
			writable: definition.write !== undefined,
			...(RUNTIME_ALLOWED_VALUES[definition.key]
				? { allowedValues: RUNTIME_ALLOWED_VALUES[definition.key] }
				: {}),
			restartRequired: false,
		});
	});
	const shell = SHELL_SETTING_DESCRIPTORS.map((definition): ConfigSettingDescriptor => Object.freeze({
		key: definition.key,
		description: definition.description,
		path: definition.path,
		legacyPaths: definition.legacyPaths,
		valueKind: definition.valueKind,
		writable: true,
		allowedValues: definition.allowedValues,
		restartRequired: definition.restartRequired,
	}));
	return Object.freeze([...runtime, ...shell].sort((left, right) => compareText(left.key, right.key)));
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
	valueKind: ConfigSettingValueKind,
	value: (config: NodeRuntimeConfig) => RuntimeSettingValue,
): RuntimeSettingDefinition {
	return Object.freeze({
		key,
		originKeys: stringList(originKeys),
		value,
		readOnlyValueKind: valueKind,
	});
}

function stringList(value: string | readonly string[]): readonly string[] {
	return Object.freeze(typeof value === "string" ? [value] : [...value]);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
