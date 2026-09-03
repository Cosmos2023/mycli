import {
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type ApiKeyAuth,
	type Model,
	type Models,
	type Provider,
	type ProviderStreams,
	type SimpleStreamOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ProviderRequest, ReasoningEffort } from "@mycli/core";
import type { ProviderRouteId } from "@mycli/core";
import {
	loadPiAiBuiltinProvider,
} from "./provider-directory.ts";
import { ProviderFailure } from "./errors.ts";

export type PiAiApi = "openai-responses" | "openai-completions" | "anthropic-messages";

export interface PiAiModelConfig {
	readonly provider: ProviderRequest["provider"];
	readonly protocol: ProviderRequest["protocol"];
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly apiKey: string;
	readonly supportsImages: boolean;
	readonly modelContextWindowTokens?: number;
	readonly maxOutputTokens?: number;
	readonly maxPromptTokens?: number;
	readonly routeSource?: "pi_ai_builtin" | "pi_ai_declared";
	readonly catalogProviderId?: ProviderRouteId;
	readonly compat?: Readonly<Record<string, unknown>>;
}

export interface PiAiSnapshot {
	readonly api: PiAiApi;
	readonly catalogProviderId?: ProviderRouteId;
	readonly model: Model<PiAiApi>;
	readonly models: Models;
	readonly catalogued: boolean;
}

export interface PiAiRequestModel {
	readonly model: Model<PiAiApi>;
	readonly reasoning: ThinkingLevel | undefined;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

const API_FACTORIES: Readonly<Record<PiAiApi, () => ProviderStreams>> = Object.freeze({
	"openai-responses": openAIResponsesApi,
	"openai-completions": openAICompletionsApi,
	"anthropic-messages": anthropicMessagesApi,
});

export async function createPiAiSnapshot(config: PiAiModelConfig): Promise<PiAiSnapshot> {
	const api = piAiApi(config.protocol);
	const builtinProvider = config.routeSource === "pi_ai_declared"
		? undefined
		: await loadPiAiBuiltinProvider(config.catalogProviderId ?? config.provider);
	const catalogModels = builtinProvider === undefined
		? []
		: builtinProvider.getModels().filter((model): model is Model<PiAiApi> =>
			model.api === api);
	if (builtinProvider !== undefined && catalogModels.length > 0) {
		return catalogPiAiSnapshot(config, api, builtinProvider, catalogModels);
	}
	return genericPiAiSnapshot(config, api);
}

function genericPiAiSnapshot(config: PiAiModelConfig, api: PiAiApi): PiAiSnapshot {
	const transportProvider = piAiTransportProvider(config);
	const model = declaredPiAiModel(config, api, transportProvider);
	const models = createModels();
	models.setProvider(createProvider({
		id: transportProvider,
		name: config.provider,
		baseUrl: config.apiBaseUrl,
		auth: { apiKey: requestApiKeyAuth(config.provider) },
		models: [model],
		api: API_FACTORIES[api](),
	}));
	return Object.freeze({
		api,
		model,
		models,
		catalogued: false,
	});
}

function catalogPiAiSnapshot(
	config: PiAiModelConfig,
	api: PiAiApi,
	provider: Provider,
	catalogModels: readonly Model<PiAiApi>[],
): PiAiSnapshot {
	const catalogued = catalogModels.find((candidate) => candidate.id === config.model);
	const model = catalogued
		? cloneCataloguedModel(catalogued, config)
		: declaredPiAiModel(config, api, config.provider);
	const routeModels = Object.freeze([model]);
	const routeProvider = Object.freeze<Provider<PiAiApi>>({
		id: config.provider,
		name: provider.name,
		baseUrl: config.apiBaseUrl,
		auth: Object.freeze({ apiKey: requestApiKeyAuth(config.provider) }),
		getModels: () => routeModels,
		stream: (requestModel, context, options) =>
			provider.stream(requestModel, context, options),
		streamSimple: (requestModel, context, options) =>
			provider.streamSimple(requestModel, context, options),
	});
	const models = createModels();
	models.setProvider(routeProvider);
	return Object.freeze({
		api,
		catalogProviderId: config.catalogProviderId ?? config.provider,
		model,
		models,
		catalogued: catalogued !== undefined,
	});
}

function cloneCataloguedModel(
	model: Model<PiAiApi>,
	config: PiAiModelConfig,
): Model<PiAiApi> {
	const input = model.input.filter((modality) =>
		modality === "text" || config.supportsImages);
	Object.freeze(input);
	return Object.freeze({
		...model,
		provider: config.provider,
		baseUrl: config.apiBaseUrl,
		input,
		cost: immutableMetadata(model.cost),
		...(model.headers ? { headers: Object.freeze({ ...model.headers }) } : {}),
		...(model.samplingParams ? {
			samplingParams: immutableMetadata(model.samplingParams),
		} : {}),
		...(model.thinkingLevelMap ? {
			thinkingLevelMap: Object.freeze({ ...model.thinkingLevelMap }),
		} : {}),
		...mergedModelCompat(model, config),
		contextWindow: positiveInteger(
			config.modelContextWindowTokens,
			model.contextWindow,
		),
		maxTokens: positiveInteger(config.maxOutputTokens, model.maxTokens),
	});
}

function declaredPiAiModel(
	config: PiAiModelConfig,
	api: PiAiApi,
	provider: string,
): Model<PiAiApi> {
	const input: Model<PiAiApi>["input"] = config.supportsImages
		? ["text", "image"]
		: ["text"];
	Object.freeze(input);
	return Object.freeze({
		id: config.model,
		name: config.model,
		api,
		provider,
		baseUrl: config.apiBaseUrl,
		reasoning: false,
		input,
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		...(config.compat === undefined
			? {}
			: { compat: immutableMetadata(config.compat) as Model<PiAiApi>["compat"] }),
		contextWindow: positiveInteger(
			config.modelContextWindowTokens ?? config.maxPromptTokens,
			DEFAULT_CONTEXT_WINDOW_TOKENS,
		),
		maxTokens: positiveInteger(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
	});
}

function piAiTransportProvider(config: PiAiModelConfig): string {
	// These are mycli route identities over the OpenAI Responses wire protocol. Pi-ai keys
	// native function-call replay behavior by its provider id, so keep that private dialect id
	// separate from the canonical provider identity stored by mycli.
	return config.protocol === "responses" ? "openai" : config.provider;
}

export function piAiRequestModel(
	snapshot: PiAiSnapshot,
	request: ProviderRequest,
): PiAiRequestModel {
	if (request.protocol !== protocolForApi(snapshot.api)) {
		throw new ProviderFailure({
			code: "config_error",
			message: "provider request protocol does not match pi-ai transport",
		});
	}
	if (request.webSearchMode === "live" && snapshot.api !== "openai-responses") {
		throw new ProviderFailure({
			code: "unsupported_capability",
			message: "provider protocol does not support hosted web search",
		});
	}
	const effort = request.reasoningEffort;
	const mapped = piAiReasoningForRequest(request, snapshot);
	const enabled = mapped !== undefined;
	const model = Object.freeze<Model<PiAiApi>>({
		...snapshot.model,
		id: request.model,
		name: request.model,
		reasoning: enabled,
		...(enabled ? {
			thinkingLevelMap: request.reasoningEffort === "ultra"
				? Object.freeze({ ...snapshot.model.thinkingLevelMap, max: "ultra" })
				: snapshot.catalogued
					? snapshot.model.thinkingLevelMap
					: thinkingLevelMap(effort),
		} : {}),
	});
	return Object.freeze({ model, reasoning: mapped });
}

export function piAiStreamOptions(
	config: PiAiModelConfig,
	request: ProviderRequest,
	requestModel: PiAiRequestModel,
	signal: AbortSignal,
): SimpleStreamOptions {
	return {
		apiKey: config.apiKey,
		signal,
		maxRetries: 0,
		temperature: 0,
		...(requestModel.reasoning === undefined ? {} : { reasoning: requestModel.reasoning }),
		...(request.protocol === "anthropic_messages" && requestModel.reasoning !== undefined
			? { thinkingBudgets: anthropicThinkingBudgets(request.reasoningEffort) }
			: {}),
		...(request.maxOutputTokens === undefined
			? {}
			: { maxTokens: request.maxOutputTokens }),
		...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
		...(request.cacheRetention === undefined ? {} : { cacheRetention: request.cacheRetention }),
	};
}

export function piAiApi(protocol: ProviderRequest["protocol"]): PiAiApi {
	switch (protocol) {
		case "responses":
			return "openai-responses";
		case "chat_completions":
			return "openai-completions";
		case "anthropic_messages":
			return "anthropic-messages";
	}
}

function protocolForApi(api: PiAiApi): ProviderRequest["protocol"] {
	switch (api) {
		case "openai-responses":
			return "responses";
		case "openai-completions":
			return "chat_completions";
		case "anthropic-messages":
			return "anthropic_messages";
	}
}

function requestApiKeyAuth(provider: string): ApiKeyAuth {
	return {
		name: `${provider} API key`,
		resolve: ({ credential }) => Promise.resolve({
			auth: credential?.key === undefined ? {} : { apiKey: credential.key },
			source: `${provider} API key`,
		}),
	};
}

function piAiReasoning(effort: ReasoningEffort | undefined): ThinkingLevel | undefined {
	if (effort === undefined || effort === "none") return undefined;
	return effort === "ultra" ? "max" : effort;
}

function piAiReasoningForRequest(
	request: ProviderRequest,
	snapshot: PiAiSnapshot,
): ThinkingLevel | undefined {
	const reasoning = piAiReasoning(request.reasoningEffort);
	if (reasoning === undefined) return undefined;
	if (snapshot.catalogued
		&& (!snapshot.model.reasoning
			|| !supportsReasoningLevel(snapshot, reasoning))) {
		throw unsupportedReasoning(request.reasoningEffort);
	}
	if (request.protocol !== "anthropic_messages") return reasoning;
	const budget = anthropicThinkingBudget(request.reasoningEffort);
	const maxOutputTokens = request.maxOutputTokens ?? snapshot.model.maxTokens;
	return budget !== undefined && maxOutputTokens <= budget ? undefined : reasoning;
}

function supportsReasoningLevel(
	snapshot: PiAiSnapshot,
	level: ThinkingLevel,
): boolean {
	return getSupportedThinkingLevels(snapshot.model).includes(level);
}

function unsupportedReasoning(effort: ReasoningEffort | undefined): ProviderFailure {
	return new ProviderFailure({
		code: "unsupported_capability",
		message: `provider model does not support reasoning effort '${effort ?? "none"}'`,
	});
}

function anthropicThinkingBudget(effort: ReasoningEffort | undefined): number | undefined {
	switch (effort) {
		case "minimal":
		case "low":
			return 1_024;
		case "medium":
			return 1_536;
		case "high":
			return 3_072;
		case "xhigh":
		case "max":
		case "ultra":
			return 6_144;
		case "none":
		case undefined:
			return undefined;
	}
}

function anthropicThinkingBudgets(effort: ReasoningEffort | undefined): Readonly<{
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}> {
	const budget = anthropicThinkingBudget(effort);
	if (budget === undefined) return Object.freeze({});
	switch (effort) {
		case "minimal":
			return Object.freeze({ minimal: budget });
		case "low":
			return Object.freeze({ low: budget });
		case "medium":
			return Object.freeze({ medium: budget });
		case "high":
		case "xhigh":
		case "max":
		case "ultra":
			return Object.freeze({ high: budget });
		case "none":
		case undefined:
			return Object.freeze({});
	}
}

function thinkingLevelMap(effort: ReasoningEffort | undefined): Readonly<Record<string, string | null>> {
	return Object.freeze({
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: effort === "ultra" ? "ultra" : "max",
	});
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: fallback;
}

function mergedModelCompat(
	model: Model<PiAiApi>,
	config: PiAiModelConfig,
): Readonly<{ compat?: Model<PiAiApi>["compat"] }> {
	if (model.compat === undefined && config.compat === undefined) return Object.freeze({});
	return Object.freeze({
		compat: immutableMetadata({
			...(model.compat ?? {}),
			...(config.compat ?? {}),
		}) as Model<PiAiApi>["compat"],
	});
}

function immutableMetadata<T>(value: T): T {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((entry) => immutableMetadata(entry))) as T;
	}
	if (typeof value === "object" && value !== null) {
		return Object.freeze(Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, immutableMetadata(entry)]),
		)) as T;
	}
	return value;
}
