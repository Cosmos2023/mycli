import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ProtocolId,
	ProviderId,
	ReasoningEffort,
} from "@mycli/core";
import { parse } from "smol-toml";
import { readApiKey } from "./auth-store.ts";
import {
	inferProviderFromBaseUrl,
	parseProtocol,
	resolveProviderProfile,
} from "./provider-profiles.ts";

type ConfigMap = Record<string, unknown>;

export interface NodeRuntimeConfig {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly apiKey?: string;
	readonly authRef: string;
	readonly sessionId: string;
	readonly sessionsDbPath: string;
	readonly maxPromptTokens: number;
	readonly modelContextWindowTokens?: number;
	readonly maxOutputTokens?: number;
	readonly store?: boolean;
	readonly requestMaxRetries: number;
	readonly streamMaxRetries: number;
	readonly reasoningEffort: ReasoningEffort;
	readonly thinkingEnabled: boolean;
	readonly supportsImages: boolean;
	readonly promptCacheKeyEnabled: boolean;
	readonly cacheControlEnabled: boolean;
	readonly memoryEnabled: boolean;
	readonly compressionThresholdTokens: number;
	readonly compactionTokenLimit: number;
	readonly compactionReservedOutputTokens: number;
	readonly compactionTailTurns: number;
	readonly compactionTailMaxTokens: number;
	readonly compactionTriggerRatio: number;
	readonly compactionBufferTokens: number;
	readonly compactionMinSavingsRatio?: number;
	readonly compactionInputCostPer1k: number;
	readonly compactionOutputCostPer1k: number;
	readonly compactionCarryCostPer1k: number;
	readonly compactionExpectedSummaryTokens: number;
	readonly compactionCarryTurns: number;
	readonly compactionSummarizerModel?: string;
	readonly compactionTriggerRatiosByModel: Readonly<Record<string, number>>;
	readonly compactionRehydrationFileMaxTotalTokens: number;
	readonly compactionRehydrationFileMaxItemTokens: number;
	readonly compactionRehydrationMaxFiles: number;
}

export const NODE_RUNTIME_CONTEXT_DEFAULTS = Object.freeze({
	cacheControlEnabled: false,
	memoryEnabled: false,
	compressionThresholdTokens: 8_000,
	compactionTokenLimit: 9_600,
	compactionReservedOutputTokens: 13_000,
	compactionTailTurns: 2,
	compactionTailMaxTokens: 8_000,
	compactionTriggerRatio: 0.9,
	compactionBufferTokens: 13_000,
	compactionInputCostPer1k: 0,
	compactionOutputCostPer1k: 0,
	compactionCarryCostPer1k: 0,
	compactionExpectedSummaryTokens: 500,
	compactionCarryTurns: 1,
	compactionTriggerRatiosByModel: Object.freeze({}) as Readonly<Record<string, number>>,
	compactionRehydrationFileMaxTotalTokens: 50_000,
	compactionRehydrationFileMaxItemTokens: 5_000,
	compactionRehydrationMaxFiles: 5,
} satisfies Pick<
	NodeRuntimeConfig,
	| "cacheControlEnabled"
	| "memoryEnabled"
	| "compressionThresholdTokens"
	| "compactionTokenLimit"
	| "compactionReservedOutputTokens"
	| "compactionTailTurns"
	| "compactionTailMaxTokens"
	| "compactionTriggerRatio"
	| "compactionBufferTokens"
	| "compactionInputCostPer1k"
	| "compactionOutputCostPer1k"
	| "compactionCarryCostPer1k"
	| "compactionExpectedSummaryTokens"
	| "compactionCarryTurns"
	| "compactionTriggerRatiosByModel"
	| "compactionRehydrationFileMaxTotalTokens"
	| "compactionRehydrationFileMaxItemTokens"
	| "compactionRehydrationMaxFiles"
>);

export interface ResolveConfigOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly env: NodeJS.ProcessEnv;
	readonly overrides?: {
		readonly model?: string;
		readonly session?: string;
	};
	readonly createSessionId?: () => string;
	readonly defaultMaxPromptTokens?: number;
	readonly maxPromptTokensCeiling?: number;
}

const SECTION_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
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

const MODEL_COMPACTION_RATIOS_KEY = "compaction_l4_trigger_ratios_by_model";

const REASONING_EFFORTS = new Set<string>([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);

export async function resolveConfig(options: ResolveConfigOptions): Promise<NodeRuntimeConfig> {
	const userConfig = await readToml(join(options.homeDir, ".mycli", "config.toml"), "user");
	const projectConfig = await readToml(
		join(options.workspaceRoot, ".mycli", "config.toml"),
		"project",
	);
	const legacyConfig = await readToml(
		join(options.homeDir, ".config", "mycli", "config.toml"),
		"legacy user",
	);
	const sources = [userConfig, projectConfig, legacyConfig] as const;
	const configuredBaseUrl = firstTruthy(
		options.env.MYCLI_BASE_URL,
		...sources.map((source) => source.api_base_url),
	);
	const inferenceUrl = stringValue(configuredBaseUrl) ?? "https://api.openai.com/v1";
	const providerValue = stringValue(firstTruthy(
		options.env.MYCLI_PROVIDER,
		...sources.map((source) => source.provider),
	)) ?? inferProviderFromBaseUrl(inferenceUrl);
	const initialProfile = resolveProviderProfile(providerValue);
	const protocolValue = stringValue(firstTruthy(
		options.env.MYCLI_PROTOCOL,
		...sources.map((source) => source.protocol),
	)) ?? initialProfile.defaultProtocol;
	const profile = resolveProviderProfile(providerValue, protocolValue);
	const protocol = parseProtocol(protocolValue);
	const model = stringValue(firstTruthy(
		options.overrides?.model,
		options.env.MYCLI_MODEL,
		...sources.map((source) => source.model),
		profile.defaultModel,
		"gpt-5",
	)) ?? "gpt-5";
	const apiBaseUrl = (stringValue(configuredBaseUrl) ?? profile.defaultBaseUrl).replace(/\/+$/, "");
	const authRef = stringValue(firstTruthy(
		options.env.MYCLI_AUTH_REF,
		...sources.map((source) => source.auth_ref),
	))?.trim() || providerValue;
	const storedApiKey = await readApiKey({ homeDir: options.homeDir, authRef });
	const apiKey = stringValue(firstTruthy(
		options.env.MYCLI_API_KEY,
		storedApiKey,
		...sources.map((source) => source.api_key),
	))?.trim() || undefined;
	const requestMaxRetries = integerSetting(
		setting(options.env, sources, "MYCLI_REQUEST_MAX_RETRIES", "request_max_retries"),
		4,
		"request_max_retries",
	);
	const transportRetryLimit = setting(
		options.env,
		sources,
		"MYCLI_TRANSPORT_RETRY_LIMIT",
		"transport_retry_limit",
	);
	const streamValue = setting(
		options.env,
		sources,
		"MYCLI_STREAM_MAX_RETRIES",
		"stream_max_retries",
	) ?? transportRetryLimit;
	const streamMaxRetries = integerSetting(streamValue, 5, "stream_max_retries");
	const configuredMaxPromptTokens = positiveIntegerSetting(
		firstTruthy(
			options.env.MYCLI_MAX_PROMPT_TOKENS,
			...sources.map((source) => source.max_prompt_tokens),
		),
		options.defaultMaxPromptTokens ?? 12000,
		"max_prompt_tokens",
	);
	const maxPromptTokensCeiling = options.maxPromptTokensCeiling === undefined
		? undefined
		: positiveSafeIntegerSetting(
			options.maxPromptTokensCeiling,
			1,
			"max_prompt_tokens_ceiling",
		);
	const maxPromptTokens = maxPromptTokensCeiling === undefined
		? configuredMaxPromptTokens
		: Math.min(configuredMaxPromptTokens, maxPromptTokensCeiling);
	const legacyReasoning = firstTruthy(
		options.env.MYCLI_REASONING_EFFORT,
		...sources.map((source) => source.reasoning_effort),
	);
	const thinkingEffort = firstTruthy(
		options.env.MYCLI_THINKING_EFFORT,
		...sources.map((source) => source.thinking_effort),
	);
	const reasoningEffort = reasoningEffortValue(thinkingEffort ?? legacyReasoning ?? "medium");
	const thinkingEnabled = optionalBoolean(setting(
		options.env,
		sources,
		"MYCLI_THINKING_ENABLED",
		"thinking_enabled",
	)) ?? true;
	if (!thinkingEnabled && thinkingEffort !== undefined) {
		throw new Error("config_error: thinking_effort requires thinking_enabled=true");
	}
	const supportsImagesOverride = optionalBoolean(setting(
		options.env,
		sources,
		"MYCLI_SUPPORTS_IMAGES",
		"supports_images",
	));
	const promptCacheOverride = optionalBoolean(setting(
		options.env,
		sources,
		"MYCLI_PROMPT_CACHE_KEY_ENABLED",
		"prompt_cache_key_enabled",
	));
	const cacheControlOverride = optionalBoolean(setting(
		options.env,
		sources,
		"MYCLI_CACHE_CONTROL_ENABLED",
		"cache_control_enabled",
	));
	const memoryEnabled = booleanSetting(
		setting(options.env, sources, "MYCLI_MEMORY_ENABLED", "memory_enabled"),
		NODE_RUNTIME_CONTEXT_DEFAULTS.memoryEnabled,
		"memory_enabled",
	);
	const compressionThresholdTokens = positiveSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPRESSION_THRESHOLD_TOKENS",
			"compression_threshold_tokens",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compressionThresholdTokens,
		"compression_threshold_tokens",
	);
	const compactionTriggerRatio = ratioSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_L4_TRIGGER_RATIO",
			"compaction_l4_trigger_ratio",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionTriggerRatio,
		"compaction_l4_trigger_ratio",
	);
	const compactionBufferTokens = nonNegativeSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_L4_BUFFER_TOKENS",
			"compaction_l4_buffer_tokens",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionBufferTokens,
		"compaction_l4_buffer_tokens",
	);
	const configuredCompactionLimit = setting(
		options.env,
		sources,
		"MYCLI_COMPACTION_TOKEN_LIMIT",
		"compaction_token_limit",
	);
	const compactionTokenLimit = configuredCompactionLimit === undefined
		? legacyCompactionTokenLimit(
			maxPromptTokens,
			compactionTriggerRatio,
			compactionBufferTokens,
		)
		: positiveSafeIntegerSetting(
			configuredCompactionLimit,
			1,
			"compaction_token_limit",
		);
	if (compactionTokenLimit > maxPromptTokens) {
		throw new Error("config_error: compaction_token_limit cannot exceed max_prompt_tokens");
	}
	const compactionReservedOutputTokens = nonNegativeSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_RESERVED_OUTPUT_TOKENS",
			"compaction_reserved_output_tokens",
		),
		compactionBufferTokens,
		"compaction_reserved_output_tokens",
	);
	const compactionTailTurns = nonNegativeSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_TAIL_TURNS",
			"compaction_tail_turns",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionTailTurns,
		"compaction_tail_turns",
	);
	const compactionTailMaxTokens = nonNegativeSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_TAIL_MAX_TOKENS",
			"compaction_tail_max_tokens",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionTailMaxTokens,
		"compaction_tail_max_tokens",
	);
	const compactionMinSavingsRatio = optionalRatioSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_L4_MIN_SAVINGS_RATIO",
			"compaction_l4_min_savings_ratio",
		),
		"compaction_l4_min_savings_ratio",
	);
	const compactionInputCostPer1k = nonNegativeFiniteSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_L4_INPUT_COST_PER_1K",
			"compaction_l4_input_cost_per_1k",
		),
		0,
		"compaction_l4_input_cost_per_1k",
	);
	const compactionOutputCostPer1k = nonNegativeFiniteSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_L4_OUTPUT_COST_PER_1K",
			"compaction_l4_output_cost_per_1k",
		),
		0,
		"compaction_l4_output_cost_per_1k",
	);
	const compactionCarryCostPer1k = nonNegativeFiniteSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_L4_CARRY_COST_PER_1K",
			"compaction_l4_carry_cost_per_1k",
		),
		0,
		"compaction_l4_carry_cost_per_1k",
	);
	const compactionExpectedSummaryTokens = positiveSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_L4_EXPECTED_SUMMARY_TOKENS",
			"compaction_l4_expected_summary_tokens",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionExpectedSummaryTokens,
		"compaction_l4_expected_summary_tokens",
	);
	const compactionCarryTurns = nonNegativeSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_L4_CARRY_TURNS",
			"compaction_l4_carry_turns",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionCarryTurns,
		"compaction_l4_carry_turns",
	);
	const compactionSummarizerModel = stringValue(setting(
		options.env,
		sources,
		"MYCLI_COMPACTION_L4_SUMMARIZER_MODEL",
		"compaction_l4_summarizer_model",
	))?.trim() || undefined;
	const configuredModelRatios = sources
		.map((source) => source[MODEL_COMPACTION_RATIOS_KEY])
		.find((value) => value !== undefined && (!isRecord(value) || Object.keys(value).length > 0));
	const compactionTriggerRatiosByModel = ratioMapSetting(
		configuredModelRatios,
		MODEL_COMPACTION_RATIOS_KEY,
	);
	const compactionRehydrationFileMaxTotalTokens = nonNegativeSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_REHYDRATION_FILE_MAX_TOTAL_TOKENS",
			"compaction_rehydration_file_max_total_tokens",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionRehydrationFileMaxTotalTokens,
		"compaction_rehydration_file_max_total_tokens",
	);
	const compactionRehydrationFileMaxItemTokens = nonNegativeSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_REHYDRATION_FILE_MAX_ITEM_TOKENS",
			"compaction_rehydration_file_max_item_tokens",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionRehydrationFileMaxItemTokens,
		"compaction_rehydration_file_max_item_tokens",
	);
	if (compactionRehydrationFileMaxItemTokens > compactionRehydrationFileMaxTotalTokens) {
		throw new Error(
			"config_error: compaction_rehydration_file_max_item_tokens cannot exceed total tokens",
		);
	}
	const compactionRehydrationMaxFiles = nonNegativeSafeIntegerSetting(
		setting(
			options.env,
			sources,
			"MYCLI_COMPACTION_REHYDRATION_MAX_FILES",
			"compaction_rehydration_max_files",
		),
		NODE_RUNTIME_CONTEXT_DEFAULTS.compactionRehydrationMaxFiles,
		"compaction_rehydration_max_files",
	);

	return {
		workspaceRoot: options.workspaceRoot,
		homeDir: options.homeDir,
		provider: providerValue as ProviderId,
		protocol,
		model,
		apiBaseUrl,
		...(apiKey ? { apiKey } : {}),
		authRef,
		sessionId: options.overrides?.session || options.createSessionId?.() || randomUUID(),
		sessionsDbPath: join(options.homeDir, ".mycli", "sessions.db"),
		maxPromptTokens,
		requestMaxRetries,
		streamMaxRetries,
		reasoningEffort,
		thinkingEnabled,
		supportsImages: supportsImagesOverride ?? profile.supportsImages,
		promptCacheKeyEnabled: promptCacheOverride ?? profile.promptCacheKeyEnabled,
		cacheControlEnabled: cacheControlOverride ?? profile.cacheControlEnabled,
		memoryEnabled,
		compressionThresholdTokens,
		compactionTokenLimit,
		compactionReservedOutputTokens,
		compactionTailTurns,
		compactionTailMaxTokens,
		compactionTriggerRatio,
		compactionBufferTokens,
		...(compactionMinSavingsRatio === undefined ? {} : { compactionMinSavingsRatio }),
		compactionInputCostPer1k,
		compactionOutputCostPer1k,
		compactionCarryCostPer1k,
		compactionExpectedSummaryTokens,
		compactionCarryTurns,
		...(compactionSummarizerModel ? { compactionSummarizerModel } : {}),
		compactionTriggerRatiosByModel,
		compactionRehydrationFileMaxTotalTokens,
		compactionRehydrationFileMaxItemTokens,
		compactionRehydrationMaxFiles,
	};
}

async function readToml(path: string, label: string): Promise<ConfigMap> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {};
		}
		throw new Error(`config_error: could not read ${label} config`);
	}
	try {
		return flattenConfig(parse(raw) as ConfigMap);
	} catch {
		throw new Error(`config_error: invalid TOML in ${label} config`);
	}
}

function flattenConfig(input: ConfigMap): ConfigMap {
	const flattened: ConfigMap = {};
	for (const [key, value] of Object.entries(input)) {
		if (!(key in SECTION_KEYS) && !isRecord(value)) {
			flattened[key] = value;
		}
	}
	for (const [section, mappings] of Object.entries(SECTION_KEYS)) {
		const table = input[section];
		if (!isRecord(table)) {
			continue;
		}
		for (const [sectionKey, flatKey] of Object.entries(mappings)) {
			if (sectionKey in table) {
				flattened[flatKey] = table[sectionKey];
			}
		}
	}
	if (isRecord(input[MODEL_COMPACTION_RATIOS_KEY])) {
		flattened[MODEL_COMPACTION_RATIOS_KEY] = input[MODEL_COMPACTION_RATIOS_KEY];
	}
	return flattened;
}

function setting(
	env: NodeJS.ProcessEnv,
	sources: readonly ConfigMap[],
	envKey: string,
	configKey: string,
): unknown {
	if (envKey in env) {
		return env[envKey];
	}
	for (const source of sources) {
		if (configKey in source) {
			return source[configKey];
		}
	}
	return undefined;
}

function firstTruthy(...values: readonly unknown[]): unknown {
	return values.find((value) => Boolean(value));
}

function stringValue(value: unknown): string | undefined {
	return value === undefined || value === null ? undefined : String(value);
}

function integerSetting(value: unknown, fallback: number, label: string): number {
	if (value === undefined || value === null) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) {
		throw new Error(`config_error: ${label} must be an integer`);
	}
	return Math.max(0, Math.min(100, parsed));
}

function positiveIntegerSetting(value: unknown, fallback: number, label: string): number {
	if (value === undefined || value === null) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`config_error: ${label} must be a positive integer`);
	}
	return parsed;
}

function positiveSafeIntegerSetting(value: unknown, fallback: number, label: string): number {
	const parsed = value === undefined || value === null ? fallback : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`config_error: ${label} must be a positive safe integer`);
	}
	return parsed;
}

function nonNegativeSafeIntegerSetting(
	value: unknown,
	fallback: number,
	label: string,
): number {
	const parsed = value === undefined || value === null ? fallback : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`config_error: ${label} must be a non-negative safe integer`);
	}
	return parsed;
}

function nonNegativeFiniteSetting(value: unknown, fallback: number, label: string): number {
	const parsed = value === undefined || value === null ? fallback : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`config_error: ${label} must be a non-negative finite number`);
	}
	return parsed;
}

function ratioSetting(value: unknown, fallback: number, label: string): number {
	const parsed = value === undefined || value === null ? fallback : Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
		throw new Error(`config_error: ${label} must be between 0 and 1`);
	}
	return parsed;
}

function optionalRatioSetting(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new Error(`config_error: ${label} must be between 0 and 1`);
	}
	return parsed;
}

function ratioMapSetting(value: unknown, label: string): Readonly<Record<string, number>> {
	if (value === undefined) return Object.freeze({});
	if (!isRecord(value)) throw new Error(`config_error: ${label} must be a table`);
	const ratios: Record<string, number> = {};
	for (const [model, ratio] of Object.entries(value)) {
		if (!model.trim()) throw new Error(`config_error: ${label} contains an empty model`);
		ratios[model] = ratioSetting(ratio, 1, `${label}.${model}`);
	}
	return Object.freeze(ratios);
}

function booleanSetting(value: unknown, fallback: boolean, label: string): boolean {
	if (value === undefined || value === null) return fallback;
	const parsed = optionalBoolean(value);
	if (parsed === undefined) throw new Error(`config_error: ${label} must be a boolean`);
	return parsed;
}

function legacyCompactionTokenLimit(
	maxTokens: number,
	triggerRatio: number,
	bufferTokens: number,
): number {
	let normalizedBuffer = bufferTokens;
	if (maxTokens <= normalizedBuffer) {
		normalizedBuffer = Math.max(0, Math.trunc(maxTokens * 0.2));
	}
	return Math.max(
		1,
		Math.min(Math.trunc(maxTokens * triggerRatio), maxTokens - normalizedBuffer),
	);
}

function optionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["false", "0", "no", "off"].includes(normalized)) {
		return false;
	}
	return undefined;
}

function reasoningEffortValue(value: unknown): ReasoningEffort {
	const normalized = String(value).trim().toLowerCase();
	if (!REASONING_EFFORTS.has(normalized)) {
		throw new Error(`config_error: unsupported reasoning effort '${normalized}'`);
	}
	return normalized as ReasoningEffort;
}

function isRecord(value: unknown): value is ConfigMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error;
}
