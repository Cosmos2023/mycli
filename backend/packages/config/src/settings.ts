import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ProtocolId,
	ProviderId,
	ReasoningEffort,
	WebSearchMode,
} from "@mycli/core";
import { parse, TomlError } from "smol-toml";
import { readApiKey } from "./auth-store.ts";
import {
	configError,
	type ConfigDiagnostic,
	type ConfigFileLayerId,
} from "./config-diagnostics.ts";
import {
	CONFIG_LAYER_STACK_VERSION,
	resolveConfigLayers,
	type ConfigLayerInput,
	type ConfigLayerMetadata,
	type ConfigLayerStack,
} from "./config-layers.ts";
import {
	MODEL_COMPACTION_RATIOS_KEY,
	validateConfigDocument,
	type ValidatedConfigDocument,
} from "./config-schema.ts";
import {
	inferProviderFromBaseUrl,
	parseProtocol,
	resolveProviderProfile,
} from "./provider-profiles.ts";
import type { WorkspaceTrustState } from "./workspace-trust-store.ts";

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
	readonly webSearchMode: WebSearchMode;
	readonly promptCacheKeyEnabled: boolean;
	readonly cacheControlEnabled: boolean;
	readonly memoryEnabled: boolean;
	readonly requestPermissionsToolEnabled: boolean;
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
		readonly provider?: ProviderId;
		readonly protocol?: ProtocolId;
		readonly model?: string;
		readonly apiBaseUrl?: string;
		readonly authRef?: string;
		readonly reasoningEffort?: ReasoningEffort;
		readonly thinkingEnabled?: boolean;
		readonly session?: string;
	};
	readonly createSessionId?: () => string;
	readonly defaultMaxPromptTokens?: number;
	readonly maxPromptTokensCeiling?: number;
	/**
	 * Omit only for compatibility callers that intentionally load project configuration without a
	 * runtime trust decision. Runtime callers must pass the persisted workspace trust state.
	 */
	readonly workspaceTrust?: WorkspaceTrustState;
}

export interface ResolvedConfig {
	readonly config: NodeRuntimeConfig;
	readonly layers: ConfigLayerStack;
	readonly diagnostics: readonly ConfigDiagnostic[];
}

const ENVIRONMENT_CONFIG_KEYS = Object.freeze({
	MYCLI_API_KEY: "api_key",
	MYCLI_AUTH_REF: "auth_ref",
	MYCLI_BASE_URL: "api_base_url",
	MYCLI_CACHE_CONTROL_ENABLED: "cache_control_enabled",
	MYCLI_COMPACTION_L4_BUFFER_TOKENS: "compaction_l4_buffer_tokens",
	MYCLI_COMPACTION_L4_CARRY_COST_PER_1K: "compaction_l4_carry_cost_per_1k",
	MYCLI_COMPACTION_L4_CARRY_TURNS: "compaction_l4_carry_turns",
	MYCLI_COMPACTION_L4_EXPECTED_SUMMARY_TOKENS: "compaction_l4_expected_summary_tokens",
	MYCLI_COMPACTION_L4_INPUT_COST_PER_1K: "compaction_l4_input_cost_per_1k",
	MYCLI_COMPACTION_L4_MIN_SAVINGS_RATIO: "compaction_l4_min_savings_ratio",
	MYCLI_COMPACTION_L4_OUTPUT_COST_PER_1K: "compaction_l4_output_cost_per_1k",
	MYCLI_COMPACTION_L4_SUMMARIZER_MODEL: "compaction_l4_summarizer_model",
	MYCLI_COMPACTION_L4_TRIGGER_RATIO: "compaction_l4_trigger_ratio",
	MYCLI_COMPACTION_REHYDRATION_FILE_MAX_ITEM_TOKENS:
		"compaction_rehydration_file_max_item_tokens",
	MYCLI_COMPACTION_REHYDRATION_FILE_MAX_TOTAL_TOKENS:
		"compaction_rehydration_file_max_total_tokens",
	MYCLI_COMPACTION_REHYDRATION_MAX_FILES: "compaction_rehydration_max_files",
	MYCLI_COMPACTION_RESERVED_OUTPUT_TOKENS: "compaction_reserved_output_tokens",
	MYCLI_COMPACTION_TAIL_MAX_TOKENS: "compaction_tail_max_tokens",
	MYCLI_COMPACTION_TAIL_TURNS: "compaction_tail_turns",
	MYCLI_COMPACTION_TOKEN_LIMIT: "compaction_token_limit",
	MYCLI_COMPRESSION_THRESHOLD_TOKENS: "compression_threshold_tokens",
	MYCLI_MAX_PROMPT_TOKENS: "max_prompt_tokens",
	MYCLI_MEMORY_ENABLED: "memory_enabled",
	MYCLI_MODEL: "model",
	MYCLI_PROMPT_CACHE_KEY_ENABLED: "prompt_cache_key_enabled",
	MYCLI_PROTOCOL: "protocol",
	MYCLI_PROVIDER: "provider",
	MYCLI_REASONING_EFFORT: "reasoning_effort",
	MYCLI_REQUEST_MAX_RETRIES: "request_max_retries",
	MYCLI_REQUEST_PERMISSIONS_TOOL: "request_permissions_tool",
	MYCLI_STREAM_MAX_RETRIES: "stream_max_retries",
	MYCLI_SUPPORTS_IMAGES: "supports_images",
	MYCLI_THINKING_EFFORT: "thinking_effort",
	MYCLI_THINKING_ENABLED: "thinking_enabled",
	MYCLI_TRANSPORT_RETRY_LIMIT: "transport_retry_limit",
} satisfies Readonly<Record<string, string>>);

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
	return (await resolveConfigWithMetadata(options)).config;
}

export async function resolveConfigWithMetadata(
	options: ResolveConfigOptions,
): Promise<ResolvedConfig> {
	const loaded = await loadConfigLayers(options);
	const config = await resolveConfigFromSources(options, loaded.sources);
	return Object.freeze({ config, layers: loaded.stack, diagnostics: loaded.diagnostics });
}

async function resolveConfigFromSources(
	options: ResolveConfigOptions,
	sources: readonly ConfigMap[],
): Promise<NodeRuntimeConfig> {
	const configuredBaseUrl = firstTruthy(
		options.overrides?.apiBaseUrl,
		options.env.MYCLI_BASE_URL,
		...sources.map((source) => source.api_base_url),
	);
	const inferenceUrl = stringValue(configuredBaseUrl) ?? "https://api.openai.com/v1";
	const providerValue = stringValue(firstTruthy(
		options.overrides?.provider,
		options.env.MYCLI_PROVIDER,
		...sources.map((source) => source.provider),
	)) ?? inferProviderFromBaseUrl(inferenceUrl);
	const initialProfile = providerProfileSetting(providerValue);
	const protocolValue = stringValue(firstTruthy(
		options.overrides?.protocol,
		options.env.MYCLI_PROTOCOL,
		...sources.map((source) => source.protocol),
	)) ?? initialProfile.defaultProtocol;
	const profile = providerProfileSetting(providerValue, protocolValue);
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
		options.overrides?.authRef,
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
		options.overrides?.reasoningEffort,
		options.env.MYCLI_THINKING_EFFORT,
		...sources.map((source) => source.thinking_effort),
	);
	const reasoningEffort = reasoningEffortValue(thinkingEffort ?? legacyReasoning ?? "medium");
	const thinkingEnabled = options.overrides?.thinkingEnabled ?? optionalBoolean(setting(
		options.env,
		sources,
		"MYCLI_THINKING_ENABLED",
		"thinking_enabled",
	)) ?? true;
	if (!thinkingEnabled && thinkingEffort !== undefined && thinkingEffort !== "none") {
		throw invalidConfigValue(
			"thinking_effort",
			"thinking_effort requires thinking_enabled=true",
			"Set reasoning.enabled=true or remove the configured reasoning effort.",
		);
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
	const requestPermissionsToolEnabled = booleanSetting(
		setting(
			options.env,
			sources,
			"MYCLI_REQUEST_PERMISSIONS_TOOL",
			"request_permissions_tool",
		),
		false,
		"features.request_permissions_tool",
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
		throw invalidConfigValue(
			"compaction_token_limit",
			"compaction_token_limit cannot exceed max_prompt_tokens",
			"Reduce context.compaction_token_limit or increase request.max_prompt_tokens.",
		);
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
		throw invalidConfigValue(
			"compaction_rehydration_file_max_item_tokens",
			"compaction_rehydration_file_max_item_tokens cannot exceed total tokens",
			"Reduce the per-file token limit or increase the total rehydration limit.",
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
		webSearchMode: profile.supportsHostedWebSearch && protocol === "responses"
			? "live"
			: "disabled",
		promptCacheKeyEnabled: promptCacheOverride ?? profile.promptCacheKeyEnabled,
		cacheControlEnabled: cacheControlOverride ?? profile.cacheControlEnabled,
		memoryEnabled,
		requestPermissionsToolEnabled,
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

async function loadConfigLayers(options: ResolveConfigOptions): Promise<{
	readonly sources: readonly ConfigMap[];
	readonly stack: ConfigLayerStack;
	readonly diagnostics: readonly ConfigDiagnostic[];
}> {
	const userPath = join(options.homeDir, ".mycli", "config.toml");
	const projectPath = join(options.workspaceRoot, ".mycli", "config.toml");
	const legacyPath = join(options.homeDir, ".config", "mycli", "config.toml");
	const projectEnabled = options.workspaceTrust === undefined
		|| options.workspaceTrust === "trusted";
	const [userDocument, projectDocument, legacyDocument] = await Promise.all([
		readToml(userPath, "user"),
		projectEnabled ? readToml(projectPath, "project") : Promise.resolve(emptyConfigDocument()),
		readToml(legacyPath, "legacy_user"),
	]);
	const userConfig = userDocument.values;
	const projectConfig = projectDocument.values;
	const legacyConfig = legacyDocument.values;
	const inputs: readonly ConfigLayerInput[] = [
		configLayer(
			"session",
			"session",
			"runtime overrides",
			sessionLayerValues(options),
		),
		configLayer(
			"environment",
			"environment",
			"process environment",
			environmentLayerValues(options.env),
		),
		configLayer(
			"project",
			"project",
			projectPath,
			projectConfig,
			projectEnabled,
		),
		configLayer("user", "user", userPath, userConfig),
		configLayer("legacy_user", "user", legacyPath, legacyConfig),
	];
	const resolution = resolveConfigLayers(inputs);
	return Object.freeze({
		sources: Object.freeze([
			...(projectEnabled ? [projectConfig] : []),
			userConfig,
			legacyConfig,
		]),
		stack: resolution.stack,
		diagnostics: Object.freeze([
			...(projectEnabled ? projectDocument.diagnostics : []),
			...userDocument.diagnostics,
			...legacyDocument.diagnostics,
		]),
	});
}

function configLayer(
	id: ConfigLayerMetadata["id"],
	scope: ConfigLayerMetadata["scope"],
	source: string,
	values: ConfigMap,
	enabled = true,
): ConfigLayerInput {
	return Object.freeze({
		metadata: Object.freeze({
			id,
			scope,
			source,
			version: CONFIG_LAYER_STACK_VERSION,
			enabled,
			...(enabled ? {} : { disabledReason: "workspace_not_trusted" as const }),
		}),
		values: Object.freeze({ ...values }),
	});
}

function sessionLayerValues(options: ResolveConfigOptions): ConfigMap {
	const overrides = options.overrides;
	if (!overrides) return {};
	return definedEntries({
		provider: overrides.provider,
		protocol: overrides.protocol,
		model: overrides.model,
		api_base_url: overrides.apiBaseUrl,
		auth_ref: overrides.authRef,
		thinking_effort: overrides.reasoningEffort,
		thinking_enabled: overrides.thinkingEnabled,
		session_id: overrides.session,
	});
}

function environmentLayerValues(env: NodeJS.ProcessEnv): ConfigMap {
	const values: ConfigMap = {};
	for (const [environmentKey, configKey] of Object.entries(ENVIRONMENT_CONFIG_KEYS)) {
		if (environmentKey in env) values[configKey] = env[environmentKey];
	}
	return values;
}

function definedEntries(values: ConfigMap): ConfigMap {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

async function readToml(
	path: string,
	layer: ConfigFileLayerId,
): Promise<ValidatedConfigDocument> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return emptyConfigDocument();
		}
		throw configError({
			code: "config_read_failed",
			severity: "error",
			layer,
			message: `${configLayerLabel(layer)} config could not be read`,
			remediation: "Check that the config file is readable and try again.",
		});
	}
	try {
		const parsed: unknown = parse(raw);
		if (!isRecord(parsed)) {
			throw configError({
				code: "invalid_value",
				severity: "error",
				layer,
				message: `${configLayerLabel(layer)} config must contain a TOML table`,
				remediation: "Replace the document root with TOML key-value entries.",
			});
		}
		return validateConfigDocument(parsed, layer);
	} catch (error) {
		if (error instanceof TomlError) {
			throw configError({
				code: "invalid_toml",
				severity: "error",
				layer,
				line: error.line,
				column: error.column,
				message: `${configLayerLabel(layer)} config contains invalid TOML`,
				remediation: "Fix the TOML syntax at the reported location.",
			});
		}
		throw error;
	}
}

function emptyConfigDocument(): ValidatedConfigDocument {
	return Object.freeze({ values: Object.freeze({}), diagnostics: Object.freeze([]) });
}

function configLayerLabel(layer: ConfigFileLayerId): string {
	return layer === "legacy_user" ? "legacy user" : layer;
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
		throw invalidConfigValue(label, `${label} must be an integer`);
	}
	return Math.max(0, Math.min(100, parsed));
}

function positiveIntegerSetting(value: unknown, fallback: number, label: string): number {
	if (value === undefined || value === null) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw invalidConfigValue(label, `${label} must be a positive integer`);
	}
	return parsed;
}

function positiveSafeIntegerSetting(value: unknown, fallback: number, label: string): number {
	const parsed = value === undefined || value === null ? fallback : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw invalidConfigValue(label, `${label} must be a positive safe integer`);
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
		throw invalidConfigValue(label, `${label} must be a non-negative safe integer`);
	}
	return parsed;
}

function nonNegativeFiniteSetting(value: unknown, fallback: number, label: string): number {
	const parsed = value === undefined || value === null ? fallback : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw invalidConfigValue(label, `${label} must be a non-negative finite number`);
	}
	return parsed;
}

function ratioSetting(value: unknown, fallback: number, label: string): number {
	const parsed = value === undefined || value === null ? fallback : Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
		throw invalidConfigValue(label, `${label} must be between 0 and 1`);
	}
	return parsed;
}

function optionalRatioSetting(value: unknown, label: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw invalidConfigValue(label, `${label} must be between 0 and 1`);
	}
	return parsed;
}

function ratioMapSetting(value: unknown, label: string): Readonly<Record<string, number>> {
	if (value === undefined) return Object.freeze({});
	if (!isRecord(value)) throw invalidConfigValue(label, `${label} must be a table`);
	const ratios: Record<string, number> = {};
	for (const [model, ratio] of Object.entries(value)) {
		if (!model.trim()) {
			throw invalidConfigValue(label, `${label} contains an empty model`);
		}
		ratios[model] = ratioSetting(ratio, 1, `${label}.${model}`);
	}
	return Object.freeze(ratios);
}

function booleanSetting(value: unknown, fallback: boolean, label: string): boolean {
	if (value === undefined || value === null) return fallback;
	const parsed = optionalBoolean(value);
	if (parsed === undefined) throw invalidConfigValue(label, `${label} must be a boolean`);
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
		throw invalidConfigValue(
			"thinking_effort",
			"unsupported reasoning effort",
			"Use one of: none, minimal, low, medium, high, xhigh, max, or ultra.",
		);
	}
	return normalized as ReasoningEffort;
}

function invalidConfigValue(
	keyPath: string,
	message: string,
	remediation = `Correct '${keyPath}' or remove it from configuration.`,
): Error {
	return configError({
		code: "invalid_value",
		severity: "error",
		keyPath,
		message,
		remediation,
	});
}

function providerProfileSetting(
	provider: string,
	protocol?: string,
): ReturnType<typeof resolveProviderProfile> {
	try {
		return resolveProviderProfile(provider, protocol);
	} catch {
		const keyPath = protocol === undefined ? "provider" : "protocol";
		throw invalidConfigValue(
			keyPath,
			`unsupported ${keyPath} configuration`,
			keyPath === "provider"
				? "Use a provider supported by this mycli installation."
				: "Use a protocol supported by the selected provider.",
		);
	}
}

function isRecord(value: unknown): value is ConfigMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error;
}
