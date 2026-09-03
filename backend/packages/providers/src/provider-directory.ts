import type {
	Api,
	Model,
	ModelThinkingLevel,
	Provider,
} from "@earendil-works/pi-ai";
import type * as PiAiProviderDirectoryModule from "@earendil-works/pi-ai/providers/all";
import type { BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import {
	parseProviderRouteId,
	type ProtocolId,
	type ProviderRouteId,
	type ReasoningEffort,
} from "@mycli/core";
import { ProviderFailure } from "./errors.ts";
import type {
	ProviderDirectoryDisabledReason,
	ProviderDirectoryEntry,
	ProviderDirectorySnapshot,
	ProviderInputModality,
	ProviderModelDirectoryEntry,
} from "./provider-directory-types.ts";

interface PiAiProviderCatalogState {
	readonly directory: typeof PiAiProviderDirectoryModule;
	readonly providers: readonly Provider[];
	readonly providerIndex: ReadonlyMap<string, Provider>;
}

const MODEL_ID_MAX_CHARS = 512;
const DISPLAY_NAME_MAX_CHARS = 512;
const BASE_URL_MAX_CHARS = 2_048;

const API_PROTOCOLS = Object.freeze<Readonly<Record<string, ProtocolId>>>({
	"openai-completions": "chat_completions",
	"openai-responses": "responses",
	"anthropic-messages": "anthropic_messages",
});

const PROTOCOL_ORDER = Object.freeze<readonly ProtocolId[]>([
	"responses",
	"chat_completions",
	"anthropic_messages",
]);

const THINKING_LEVEL_EFFORTS = Object.freeze<Readonly<Record<string, ReasoningEffort>>>({
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
});

const DEFAULT_THINKING_LEVELS = Object.freeze<readonly ModelThinkingLevel[]>([
	"minimal",
	"low",
	"medium",
	"high",
]);

let providerCatalogPromise: Promise<PiAiProviderCatalogState> | undefined;
let providerDirectoryPromise: Promise<ProviderDirectorySnapshot> | undefined;

export function loadPiAiProviderDirectory(): Promise<ProviderDirectorySnapshot> {
	providerDirectoryPromise ??= buildProviderDirectory();
	return providerDirectoryPromise;
}

export async function loadPiAiBuiltinProvider(
	providerId: ProviderRouteId,
): Promise<Provider | undefined> {
	try {
		return (await loadProviderCatalog()).providerIndex.get(providerId);
	} catch (error) {
		if (error instanceof ProviderFailure) throw error;
		throw directoryFailure();
	}
}

async function buildProviderDirectory(): Promise<ProviderDirectorySnapshot> {
	try {
		return sanitizeDirectory(await loadProviderCatalog());
	} catch (error) {
		if (error instanceof ProviderFailure) throw error;
		throw directoryFailure();
	}
}

function loadProviderCatalog(): Promise<PiAiProviderCatalogState> {
	providerCatalogPromise ??= buildProviderCatalog();
	return providerCatalogPromise;
}

async function buildProviderCatalog(): Promise<PiAiProviderCatalogState> {
	const directory = await import("@earendil-works/pi-ai/providers/all");
	const providers = Object.freeze(directory.builtinProviders());
	const providerIndex = new Map<string, Provider>();
	for (const provider of providers) {
		if (providerIndex.has(provider.id)) throw directoryFailure();
		providerIndex.set(provider.id, provider);
	}
	return Object.freeze({ directory, providers, providerIndex });
}

function sanitizeDirectory(
	catalog: PiAiProviderCatalogState,
): ProviderDirectorySnapshot {
	const { directory, providers } = catalog;
	const generatedProviderIds = new Set<string>(directory.getBuiltinProviders());
	const providerIds = new Set<string>();
	const entries = providers.map((provider) => {
		if (providerIds.has(provider.id)) throw directoryFailure();
		providerIds.add(provider.id);
		const models = generatedProviderIds.has(provider.id)
			? directory.getBuiltinModels(provider.id as BuiltinProvider) as readonly Model<Api>[]
			: provider.getModels();
		return sanitizeProvider(provider, models);
	});
	if ([...generatedProviderIds].some((providerId) => !providerIds.has(providerId))) {
		throw directoryFailure();
	}
	const generatedAt = directory.getBuiltinModelDataGeneratedAt();
	return Object.freeze({
		...(generatedAt === undefined ? {} : {
			generatedAt: positiveSafeInteger(generatedAt),
		}),
		providers: Object.freeze(entries),
	});
}

function sanitizeProvider(
	provider: Provider,
	models: readonly Model<Api>[],
): ProviderDirectoryEntry {
	const catalogProviderId = routeId(provider.id);
	const baseUrl = optionalBaseUrl(provider.baseUrl);
	const sanitizedModels = models.flatMap((model) => {
		if (model.provider !== provider.id) throw directoryFailure();
		const protocol = API_PROTOCOLS[model.api];
		return protocol === undefined
			? []
			: [sanitizeModel(catalogProviderId, model, protocol)];
	});
	const protocols = PROTOCOL_ORDER.filter((protocol) =>
		sanitizedModels.some((model) => model.protocol === protocol));
	const apiKeyServiceable = provider.auth.apiKey !== undefined;
	const endpointRequired = optionalBaseUrl(provider.baseUrl) === undefined;
	const disabledReason = providerDisabledReason({
		apiKeyServiceable,
		totalModelCount: models.length,
		supportedModelCount: sanitizedModels.length,
	});
	const status = disabledReason !== undefined
		? "unsupported"
		: endpointRequired || protocols.length !== 1
			? "configuration_required"
			: "serviceable";
	return Object.freeze({
		catalogProviderId,
		name: boundedDisplayName(provider.name),
		...(baseUrl === undefined ? {} : { baseUrl }),
		protocols: Object.freeze(protocols),
		apiKeyServiceable,
		endpointRequired,
		status,
		models: Object.freeze(sanitizedModels),
		...(disabledReason === undefined ? {} : { disabledReason }),
	});
}

function sanitizeModel(
	catalogProviderId: ProviderRouteId,
	model: Model<Api>,
	protocol: ProtocolId,
): ProviderModelDirectoryEntry {
	const baseUrl = optionalBaseUrl(model.baseUrl);
	return Object.freeze({
		catalogProviderId,
		id: boundedIdentity(model.id, MODEL_ID_MAX_CHARS),
		name: boundedDisplayName(model.name),
		protocol,
		...(baseUrl === undefined ? {} : { baseUrl }),
		input: sanitizedInput(model.input),
		reasoningEfforts: reasoningEfforts(model),
		contextWindowTokens: positiveSafeInteger(model.contextWindow),
		maxOutputTokens: positiveSafeInteger(model.maxTokens),
	});
}

function reasoningEfforts(model: Model<Api>): readonly ReasoningEffort[] {
	if (!model.reasoning) return Object.freeze([]);
	const levels: ModelThinkingLevel[] = [...DEFAULT_THINKING_LEVELS];
	if (model.thinkingLevelMap?.xhigh !== undefined) levels.push("xhigh");
	if (model.thinkingLevelMap?.max !== undefined) levels.push("max");
	const efforts = levels.flatMap((level) => {
		const effort = THINKING_LEVEL_EFFORTS[level];
		return effort === undefined || model.thinkingLevelMap?.[level] === null ? [] : [effort];
	});
	return Object.freeze(efforts);
}

function sanitizedInput(input: readonly string[]): readonly ProviderInputModality[] {
	const modalities = input.flatMap<ProviderInputModality>((modality) => {
		if (modality === "text" || modality === "image") return [modality];
		throw directoryFailure();
	});
	return Object.freeze([...new Set(modalities)]);
}

function providerDisabledReason(input: {
	readonly apiKeyServiceable: boolean;
	readonly totalModelCount: number;
	readonly supportedModelCount: number;
}): ProviderDirectoryDisabledReason | undefined {
	if (!input.apiKeyServiceable) return "unsupported_auth";
	if (input.totalModelCount === 0) return "no_supported_models";
	if (input.supportedModelCount === 0) return "unsupported_protocol";
	return undefined;
}

function routeId(value: string): ProviderRouteId {
	try {
		return parseProviderRouteId(value);
	} catch {
		throw directoryFailure();
	}
}

function boundedIdentity(value: string, maxChars: number): string {
	if (value.length === 0
		|| value.length > maxChars
		|| value.trim() !== value
		|| hasControlCharacter(value)) {
		throw directoryFailure();
	}
	return value;
}

function boundedDisplayName(value: string): string {
	const normalized = value.trim();
	if (normalized.length === 0
		|| normalized.length > DISPLAY_NAME_MAX_CHARS
		|| hasControlCharacter(normalized)) {
		throw directoryFailure();
	}
	return normalized;
}

function optionalBaseUrl(value: string | undefined): string | undefined {
	if (value === undefined || value === "") return undefined;
	const baseUrl = boundedIdentity(value, BASE_URL_MAX_CHARS);
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw directoryFailure();
	}
	if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
		|| parsed.username
		|| parsed.password
		|| parsed.search
		|| parsed.hash) {
		throw directoryFailure();
	}
	return baseUrl;
}

function positiveSafeInteger(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw directoryFailure();
	return value;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0)!;
		if (codePoint <= 0x1f || codePoint === 0x7f) return true;
	}
	return false;
}

function directoryFailure(): ProviderFailure {
	return new ProviderFailure({
		code: "config_error",
		message: "pi-ai provider directory metadata is unavailable",
	});
}
