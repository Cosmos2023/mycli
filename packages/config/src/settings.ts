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
	readonly requestMaxRetries: number;
	readonly streamMaxRetries: number;
	readonly reasoningEffort: ReasoningEffort;
	readonly thinkingEnabled: boolean;
	readonly promptCacheKeyEnabled: boolean;
}

export interface ResolveConfigOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly env: NodeJS.ProcessEnv;
	readonly overrides?: {
		readonly model?: string;
		readonly session?: string;
	};
	readonly createSessionId?: () => string;
}

const SECTION_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	model: {
		provider: "provider",
		protocol: "protocol",
		name: "model",
		api_base_url: "api_base_url",
		auth_ref: "auth_ref",
	},
	request: {
		max_prompt_tokens: "max_prompt_tokens",
		request_max_retries: "request_max_retries",
		stream_max_retries: "stream_max_retries",
		prompt_cache_key_enabled: "prompt_cache_key_enabled",
	},
	reasoning: {
		enabled: "thinking_enabled",
		effort: "thinking_effort",
		reasoning_effort: "reasoning_effort",
	},
};

const REASONING_EFFORTS = new Set<string>([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
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
	const maxPromptTokens = positiveIntegerSetting(
		firstTruthy(
			options.env.MYCLI_MAX_PROMPT_TOKENS,
			...sources.map((source) => source.max_prompt_tokens),
		),
		12000,
		"max_prompt_tokens",
	);
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
	const promptCacheOverride = optionalBoolean(setting(
		options.env,
		sources,
		"MYCLI_PROMPT_CACHE_KEY_ENABLED",
		"prompt_cache_key_enabled",
	));

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
		promptCacheKeyEnabled: promptCacheOverride ?? profile.promptCacheKeyEnabled,
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
