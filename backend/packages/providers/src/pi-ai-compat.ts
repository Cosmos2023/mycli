import type {
	AnthropicMessagesCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "@earendil-works/pi-ai";
import type { ProtocolId } from "@mycli/core";
import { ProviderFailure } from "./errors.ts";
import type { PiAiCompatOverride } from "./provider-directory-types.ts";

type CompatValue = string | number | boolean | null | readonly CompatValue[] | {
	readonly [key: string]: CompatValue;
};

const COMPLETIONS_BOOLEAN_KEYS = new Set<keyof OpenAICompletionsCompat>([
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"supportsFinishReason",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages",
	"zaiToolStream",
	"supportsThinkingTokenBudget",
	"supportsOpenAIGrammarTools",
	"supportsStrictMode",
	"sendSessionAffinityHeaders",
	"supportsLongCacheRetention",
]);

const RESPONSES_BOOLEAN_KEYS = new Set<keyof OpenAIResponsesCompat>([
	"supportsDeveloperRole",
	"supportsLongCacheRetention",
	"supportsStrictMode",
	"supportsOpenAIGrammarTools",
	"supportsAdditionalTools",
	"supportsToolSearch",
	"supportsExplicitPromptCacheMode",
]);

const ANTHROPIC_BOOLEAN_KEYS = new Set<keyof AnthropicMessagesCompat>([
	"supportsEagerToolInputStreaming",
	"supportsLongCacheRetention",
	"sendSessionAffinityHeaders",
	"supportsCacheControlOnTools",
	"supportsTemperature",
	"forceAdaptiveThinking",
	"allowEmptySignature",
	"supportsStrictTools",
	"supportsToolReferences",
]);

const THINKING_FORMATS = new Set([
	"openai",
	"openrouter",
	"deepseek",
	"together",
	"baseten",
	"zai",
	"qwen",
	"chat-template",
	"qwen-chat-template",
	"string-thinking",
	"ant-ling",
]);
const SESSION_AFFINITY_FORMATS = new Set(["openai", "openai-nosession", "openrouter"]);

export function validatePiAiCompatOverride(
	protocol: ProtocolId,
	value: Readonly<Record<string, unknown>> | undefined,
): PiAiCompatOverride | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw compatFailure("compat must be an object");
	const copy: Record<string, CompatValue> = {};
	for (const [key, item] of Object.entries(value)) {
		copy[key] = validateCompatField(protocol, key, item);
	}
	return deepFreeze(copy);
}

export function mergePiAiCompatOverrides(
	protocol: ProtocolId,
	...overrides: readonly (Readonly<Record<string, unknown>> | undefined)[]
): PiAiCompatOverride | undefined {
	const merged = Object.assign({}, ...overrides.flatMap((override) => {
		const validated = validatePiAiCompatOverride(protocol, override);
		return validated === undefined ? [] : [validated];
	}));
	return Object.keys(merged).length === 0 ? undefined : deepFreeze(merged);
}

function validateCompatField(protocol: ProtocolId, key: string, value: unknown): CompatValue {
	switch (protocol) {
		case "responses":
			if (RESPONSES_BOOLEAN_KEYS.has(key as keyof OpenAIResponsesCompat)) {
				return booleanValue(key, value);
			}
			if (key === "sessionAffinityFormat") return enumValue(key, value, SESSION_AFFINITY_FORMATS);
			throw compatFailure(`compat field '${boundedKey(key)}' is not valid for Responses`);
		case "anthropic_messages":
			if (ANTHROPIC_BOOLEAN_KEYS.has(key as keyof AnthropicMessagesCompat)) {
				return booleanValue(key, value);
			}
			throw compatFailure(`compat field '${boundedKey(key)}' is not valid for Anthropic Messages`);
		case "chat_completions":
			return validateCompletionsField(key, value);
	}
}

function validateCompletionsField(key: string, value: unknown): CompatValue {
	if (COMPLETIONS_BOOLEAN_KEYS.has(key as keyof OpenAICompletionsCompat)) {
		return booleanValue(key, value);
	}
	switch (key) {
		case "maxTokensField":
			return enumValue(key, value, new Set(["max_completion_tokens", "max_tokens"]));
		case "thinkingFormat":
			return enumValue(key, value, THINKING_FORMATS);
		case "cacheControlFormat":
			return enumValue(key, value, new Set(["anthropic"]));
		case "deferredToolsMode":
			return enumValue(key, value, new Set(["kimi"]));
		case "sessionAffinityFormat":
			return enumValue(key, value, SESSION_AFFINITY_FORMATS);
		case "chatTemplateKwargs":
		case "chatTemplateArgs":
			return templateArguments(key, value);
		case "openRouterRouting":
			return openRouterRouting(value);
		case "vercelGatewayRouting":
			return stringArrayRecord(value, ["only", "order"], key);
		default:
			throw compatFailure(`compat field '${boundedKey(key)}' is not valid for Chat Completions`);
	}
}

function templateArguments(label: string, value: unknown): CompatValue {
	if (!isRecord(value)) throw invalidValue(label);
	const result: Record<string, CompatValue> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === null || typeof item === "string" || typeof item === "boolean"
			|| typeof item === "number" && Number.isFinite(item)) {
			result[key] = item;
			continue;
		}
		if (!isRecord(item)
			|| Object.keys(item).some((field) => field !== "$var" && field !== "omitWhenOff")
			|| (item.$var !== "thinking.enabled" && item.$var !== "thinking.effort")
			|| (item.omitWhenOff !== undefined && typeof item.omitWhenOff !== "boolean")) {
			throw invalidValue(label);
		}
		result[key] = deepFreeze({
			$var: item.$var,
			...(item.omitWhenOff === undefined ? {} : { omitWhenOff: item.omitWhenOff }),
		});
	}
	return deepFreeze(result);
}

function openRouterRouting(value: unknown): CompatValue {
	if (!isRecord(value)) throw invalidValue("openRouterRouting");
	const allowed = new Set([
		"allow_fallbacks", "require_parameters", "data_collection", "zdr",
		"enforce_distillable_text", "order", "only", "ignore", "quantizations",
		"sort", "max_price", "preferred_min_throughput", "preferred_max_latency",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw invalidValue("openRouterRouting");
	}
	const result: Record<string, CompatValue> = {};
	for (const key of ["allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text"] as const) {
		if (value[key] !== undefined) result[key] = booleanValue(key, value[key]);
	}
	if (value.data_collection !== undefined) {
		result.data_collection = enumValue(
			"data_collection",
			value.data_collection,
			new Set(["deny", "allow"]),
		);
	}
	for (const key of ["order", "only", "ignore", "quantizations"] as const) {
		if (value[key] !== undefined) result[key] = stringArray(key, value[key]);
	}
	if (value.sort !== undefined) result.sort = routingSort(value.sort);
	if (value.max_price !== undefined) {
		result.max_price = numericRecord(
			value.max_price,
			["prompt", "completion", "image", "audio", "request"],
			"max_price",
			true,
		);
	}
	for (const key of ["preferred_min_throughput", "preferred_max_latency"] as const) {
		if (value[key] === undefined) continue;
		result[key] = typeof value[key] === "number" && Number.isFinite(value[key])
			? value[key]
			: numericRecord(value[key], ["p50", "p75", "p90", "p99"], key, false);
	}
	return deepFreeze(result);
}

function routingSort(value: unknown): CompatValue {
	if (typeof value === "string") return value;
	if (!isRecord(value)
		|| Object.keys(value).some((key) => key !== "by" && key !== "partition")
		|| (value.by !== undefined && typeof value.by !== "string")
		|| (value.partition !== undefined && value.partition !== null && typeof value.partition !== "string")) {
		throw invalidValue("sort");
	}
	return deepFreeze({
		...(value.by === undefined ? {} : { by: value.by }),
		...(value.partition === undefined ? {} : { partition: value.partition }),
	});
}

function numericRecord(
	value: unknown,
	keys: readonly string[],
	label: string,
	allowString: boolean,
): CompatValue {
	if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
		throw invalidValue(label);
	}
	const result: Record<string, CompatValue> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "number" && Number.isFinite(item) || allowString && typeof item === "string") {
			result[key] = item;
			continue;
		}
		throw invalidValue(label);
	}
	return deepFreeze(result);
}

function stringArrayRecord(value: unknown, keys: readonly string[], label: string): CompatValue {
	if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
		throw invalidValue(label);
	}
	return deepFreeze(Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, stringArray(`${label}.${key}`, item)]),
	));
}

function stringArray(label: string, value: unknown): readonly CompatValue[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw invalidValue(label);
	}
	return Object.freeze([...value]);
}

function booleanValue(key: string, value: unknown): boolean {
	if (typeof value !== "boolean") throw invalidValue(key);
	return value;
}

function enumValue(key: string, value: unknown, values: ReadonlySet<string>): string {
	if (typeof value !== "string" || !values.has(value)) throw invalidValue(key);
	return value;
}

function invalidValue(key: string): ProviderFailure {
	return compatFailure(`compat field '${boundedKey(key)}' has an invalid value`);
}

function boundedKey(key: string): string {
	return key.slice(0, 128);
}

function compatFailure(message: string): ProviderFailure {
	return new ProviderFailure({ code: "config_error", message });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((entry) => deepFreeze(entry))) as T;
	}
	if (typeof value === "object" && value !== null) {
		return Object.freeze(Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, deepFreeze(entry)]),
		)) as T;
	}
	return value;
}
