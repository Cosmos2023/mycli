import {
	isConfigError,
	resolveConfigWithMetadata,
	type ConfigDiagnostic,
	type ConfigLayerDisabledReason,
	type ConfigLayerId,
	type ConfigLayerScope,
	type ConfigLayerStack,
	type NodeRuntimeConfig,
	type WorkspaceTrustState,
} from "@mycli/config";
import { redactDoctorText } from "./doctor/redaction.ts";
import type { ManagementResponse } from "./types.ts";

export const CONFIG_MANAGEMENT_RESPONSE_VERSION = 1 as const;

export type ConfigSettingSource = ConfigLayerId | "default";
export type ConfigSettingValue = string | number | boolean | null | Readonly<Record<string, number>>;

export interface ConfigSettingRow {
	readonly key: string;
	readonly value: ConfigSettingValue;
	readonly source: ConfigSettingSource;
	readonly overridden: readonly ConfigLayerId[];
	readonly truncated?: boolean;
}

export interface ConfigLayerRow {
	readonly id: ConfigLayerId;
	readonly scope: ConfigLayerScope;
	readonly enabled: boolean;
	readonly disabledReason?: ConfigLayerDisabledReason;
}

export interface ConfigCredentialState {
	readonly apiKey: "present" | "missing";
}

interface ConfigManagementResponseBase extends ManagementResponse {
	readonly version: typeof CONFIG_MANAGEMENT_RESPONSE_VERSION;
	readonly action: "validate" | "show";
	readonly diagnostics: readonly ConfigDiagnostic[];
}

export interface ConfigValidateResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "validate";
}

export interface ConfigShowResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "show";
	readonly workspaceTrust: WorkspaceTrustState;
	readonly credentials: ConfigCredentialState;
	readonly layers: readonly ConfigLayerRow[];
	readonly settings: readonly ConfigSettingRow[];
}

export interface ConfigFailureResponse extends ConfigManagementResponseBase {
	readonly ok: false;
	readonly action: "validate" | "show";
}

export type ConfigManagementResponse =
	| ConfigValidateResponse
	| ConfigShowResponse
	| ConfigFailureResponse;

export interface ConfigManagementServiceOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly workspaceTrust: WorkspaceTrustState;
}

interface ConfigSettingDefinition {
	readonly key: string;
	readonly originKeys: readonly string[];
	readonly value: (config: NodeRuntimeConfig) => ConfigSettingValue;
}

const MAX_RATIO_ROWS = 64;

const CONFIG_SETTING_DEFINITIONS: readonly ConfigSettingDefinition[] = Object.freeze([
	setting("context.compaction_l4_buffer_tokens", "compaction_l4_buffer_tokens", (config) => (
		config.compactionBufferTokens
	)),
	setting("context.compaction_l4_carry_cost_per_1k", "compaction_l4_carry_cost_per_1k", (config) => (
		config.compactionCarryCostPer1k
	)),
	setting("context.compaction_l4_carry_turns", "compaction_l4_carry_turns", (config) => (
		config.compactionCarryTurns
	)),
	setting(
		"context.compaction_l4_expected_summary_tokens",
		"compaction_l4_expected_summary_tokens",
		(config) => config.compactionExpectedSummaryTokens,
	),
	setting("context.compaction_l4_input_cost_per_1k", "compaction_l4_input_cost_per_1k", (config) => (
		config.compactionInputCostPer1k
	)),
	setting("context.compaction_l4_min_savings_ratio", "compaction_l4_min_savings_ratio", (config) => (
		config.compactionMinSavingsRatio ?? null
	)),
	setting("context.compaction_l4_output_cost_per_1k", "compaction_l4_output_cost_per_1k", (config) => (
		config.compactionOutputCostPer1k
	)),
	setting("context.compaction_l4_summarizer_model", "compaction_l4_summarizer_model", (config) => (
		config.compactionSummarizerModel ?? null
	)),
	setting("context.compaction_l4_trigger_ratio", "compaction_l4_trigger_ratio", (config) => (
		config.compactionTriggerRatio
	)),
	setting(
		"context.compaction_l4_trigger_ratios_by_model",
		"compaction_l4_trigger_ratios_by_model",
		(config) => boundedRatioMap(config.compactionTriggerRatiosByModel),
	),
	setting(
		"context.compaction_rehydration_file_max_item_tokens",
		"compaction_rehydration_file_max_item_tokens",
		(config) => config.compactionRehydrationFileMaxItemTokens,
	),
	setting(
		"context.compaction_rehydration_file_max_total_tokens",
		"compaction_rehydration_file_max_total_tokens",
		(config) => config.compactionRehydrationFileMaxTotalTokens,
	),
	setting("context.compaction_rehydration_max_files", "compaction_rehydration_max_files", (config) => (
		config.compactionRehydrationMaxFiles
	)),
	setting("context.compaction_reserved_output_tokens", "compaction_reserved_output_tokens", (config) => (
		config.compactionReservedOutputTokens
	)),
	setting("context.compaction_tail_max_tokens", "compaction_tail_max_tokens", (config) => (
		config.compactionTailMaxTokens
	)),
	setting("context.compaction_tail_turns", "compaction_tail_turns", (config) => (
		config.compactionTailTurns
	)),
	setting("context.compaction_token_limit", "compaction_token_limit", (config) => (
		config.compactionTokenLimit
	)),
	setting("context.compression_threshold_tokens", "compression_threshold_tokens", (config) => (
		config.compressionThresholdTokens
	)),
	setting("features.request_permissions_tool", "request_permissions_tool", (config) => (
		config.requestPermissionsToolEnabled
	)),
	setting("memory.enabled", "memory_enabled", (config) => config.memoryEnabled),
	setting("model.api_base_url", "api_base_url", (config) => safeBaseUrl(config.apiBaseUrl)),
	setting("model.auth_ref", "auth_ref", (config) => config.authRef),
	setting("model.name", "model", (config) => config.model),
	setting("model.protocol", "protocol", (config) => config.protocol),
	setting("model.provider", "provider", (config) => config.provider),
	setting("model.supports_images", "supports_images", (config) => config.supportsImages),
	setting("model.web_search_mode", "web_search_mode", (config) => config.webSearchMode),
	setting(
		"reasoning.effort",
		["thinking_effort", "reasoning_effort"],
		(config) => config.reasoningEffort,
	),
	setting("reasoning.enabled", "thinking_enabled", (config) => config.thinkingEnabled),
	setting("request.cache_control_enabled", "cache_control_enabled", (config) => (
		config.cacheControlEnabled
	)),
	setting("request.max_prompt_tokens", "max_prompt_tokens", (config) => config.maxPromptTokens),
	setting("request.prompt_cache_key_enabled", "prompt_cache_key_enabled", (config) => (
		config.promptCacheKeyEnabled
	)),
	setting("request.request_max_retries", "request_max_retries", (config) => (
		config.requestMaxRetries
	)),
	setting("request.stream_max_retries", ["stream_max_retries", "transport_retry_limit"], (config) => (
		config.streamMaxRetries
	)),
]);

export class ConfigManagementService {
	readonly #options: ConfigManagementServiceOptions;

	constructor(options: ConfigManagementServiceOptions) {
		this.#options = options;
	}

	async validate(signal: AbortSignal): Promise<ConfigValidateResponse> {
		const resolved = await this.#resolve(signal);
		return Object.freeze({
			version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
			ok: true,
			action: "validate",
			message: resolved.diagnostics.length > 0
				? "configuration valid with warnings"
				: "configuration valid",
			diagnostics: Object.freeze([...resolved.diagnostics]),
		});
	}

	async show(signal: AbortSignal): Promise<ConfigShowResponse> {
		const resolved = await this.#resolve(signal);
		return Object.freeze({
			version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
			ok: true,
			action: "show",
			message: "effective configuration",
			workspaceTrust: this.#options.workspaceTrust,
			credentials: Object.freeze({ apiKey: resolved.config.apiKey ? "present" : "missing" }),
			layers: projectLayers(resolved.layers),
			settings: projectSettings(resolved.config, resolved.layers),
			diagnostics: Object.freeze([...resolved.diagnostics]),
		});
	}

	async #resolve(signal: AbortSignal): ReturnType<typeof resolveConfigWithMetadata> {
		signal.throwIfAborted();
		try {
			const resolved = await resolveConfigWithMetadata({
				...this.#options,
				createSessionId: () => "config-management",
			});
			signal.throwIfAborted();
			return resolved;
		} catch (error) {
			if (!isConfigError(error)) throw error;
			throw new ConfigManagementError(error.diagnostic);
		}
	}
}

export class ConfigManagementError extends Error {
	readonly diagnostic: ConfigDiagnostic;

	constructor(diagnostic: ConfigDiagnostic) {
		super("configuration invalid");
		this.name = "ConfigManagementError";
		this.diagnostic = diagnostic;
	}
}

export function configFailureResponse(
	action: "validate" | "show",
	error: ConfigManagementError,
): ConfigFailureResponse {
	return Object.freeze({
		version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
		ok: false,
		action,
		message: "configuration invalid",
		issues: Object.freeze([error.diagnostic.code]),
		exitCode: 1,
		diagnostics: Object.freeze([error.diagnostic]),
	});
}

function setting(
	key: string,
	originKeys: string | readonly string[],
	value: (config: NodeRuntimeConfig) => ConfigSettingValue,
): ConfigSettingDefinition {
	return Object.freeze({
		key,
		originKeys: Object.freeze(typeof originKeys === "string" ? [originKeys] : [...originKeys]),
		value,
	});
}

function projectLayers(layers: ConfigLayerStack): readonly ConfigLayerRow[] {
	return Object.freeze(layers.layers.map((layer) => Object.freeze({
		id: layer.metadata.id,
		scope: layer.metadata.scope,
		enabled: layer.metadata.enabled,
		...(layer.metadata.disabledReason === undefined
			? {}
			: { disabledReason: layer.metadata.disabledReason }),
	})));
}

function projectSettings(
	config: NodeRuntimeConfig,
	layers: ConfigLayerStack,
): readonly ConfigSettingRow[] {
	return Object.freeze(CONFIG_SETTING_DEFINITIONS.map((definition) => {
		const origin = definition.originKeys
			.map((key) => layers.origins[key])
			.find((candidate) => candidate !== undefined);
		const value = definition.value(config);
		const truncated = definition.key === "context.compaction_l4_trigger_ratios_by_model"
			&& Object.keys(config.compactionTriggerRatiosByModel).length > MAX_RATIO_ROWS;
		return Object.freeze({
			key: definition.key,
			value: safeSettingValue(value),
			source: origin?.source.id ?? "default",
			overridden: Object.freeze(origin?.overridden.map((layer) => layer.id) ?? []),
			...(truncated ? { truncated: true } : {}),
		});
	}));
}

function boundedRatioMap(value: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
	return Object.freeze(Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => compareText(left, right))
			.slice(0, MAX_RATIO_ROWS)
			.map(([key, ratio]) => [safeText(key, 128), ratio]),
	));
}

function safeSettingValue(value: ConfigSettingValue): ConfigSettingValue {
	if (typeof value === "string") return safeText(value, 512);
	if (value === null || typeof value !== "object") return value;
	return Object.freeze(Object.fromEntries(
		Object.entries(value).map(([key, ratio]) => [safeText(key, 128), ratio]),
	));
}

function safeBaseUrl(value: string): string {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "configured";
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString().replace(/\/$/u, "");
	} catch {
		return "configured";
	}
}

function safeText(value: string, limit: number): string {
	return redactDoctorText(value).slice(0, limit);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
