import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	isProviderId,
	parseProviderRouteId,
	type ProtocolId,
	type ProviderId,
	type ProviderRouteId,
	type ReasoningEffort,
} from "@mycli/core";
import { atomicPrivateFileUpdate } from "../private-file-writer.ts";
import {
	parseProtocol,
	resolveProviderProfile,
} from "./provider-profiles.ts";

export interface ModelCatalogEntry {
	readonly provider: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly displayName: string;
	readonly description: string;
	readonly baseUrl: string;
	readonly authRef: string;
	readonly supportedReasoningEfforts: readonly ReasoningEffort[];
	readonly defaultReasoningEffort?: ReasoningEffort;
	readonly contextWindowTokens?: number;
	readonly maxOutputTokens?: number;
	readonly supportsImages?: boolean;
	readonly supportsImageDetailOriginal?: boolean;
	readonly supportsHostedWebSearch?: boolean;
	readonly isDefault: boolean;
	readonly isCurrent: boolean;
}

export type ModelProviderDeclarationSource = "pi_ai_builtin" | "pi_ai_declared";
export type ModelProviderDeclarationModelPolicy = "catalog" | "subset";

export interface ModelCatalogModelDeclaration {
	readonly model: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly supportedReasoningEfforts?: readonly ReasoningEffort[];
	readonly defaultReasoningEffort?: ReasoningEffort;
	readonly contextWindowTokens?: number;
	readonly maxOutputTokens?: number;
	readonly supportsImages?: boolean;
	readonly supportsHostedWebSearch?: boolean;
	readonly compat?: Readonly<Record<string, unknown>>;
}

export interface ModelProviderDeclaration {
	readonly provider: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly baseUrl?: string;
	readonly authRef: string;
	readonly source?: ModelProviderDeclarationSource;
	readonly catalogProvider?: ProviderRouteId;
	readonly modelPolicy?: ModelProviderDeclarationModelPolicy;
	readonly compat?: Readonly<Record<string, unknown>>;
	readonly models?: readonly ModelCatalogModelDeclaration[];
}

export interface ModelCatalogCurrentConfig {
	readonly provider: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly authRef: string;
}

export interface ModelCatalogSelection {
	readonly provider: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly baseUrl: string;
}

export interface ModelReasoningDefaults {
	readonly reasoningEffort: ReasoningEffort;
	readonly thinkingEnabled: boolean;
}

export class ModelCatalogError extends Error {
	readonly code = "model_catalog_error";

	constructor(message: string) {
		super(message);
		this.name = "ModelCatalogError";
	}
}

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

const OPENAI_EFFORTS = Object.freeze<readonly ReasoningEffort[]>([
	"low",
	"medium",
	"high",
	"xhigh",
]);

const OPENAI_MAX_EFFORTS = Object.freeze<readonly ReasoningEffort[]>([
	...OPENAI_EFFORTS,
	"max",
]);

const OPENAI_ULTRA_EFFORTS = Object.freeze<readonly ReasoningEffort[]>([
	...OPENAI_MAX_EFFORTS,
	"ultra",
]);

const DEEPSEEK_EFFORTS = Object.freeze<readonly ReasoningEffort[]>([
	"high",
	"max",
]);

function builtinEntry(
	provider: ProviderId,
	model: string,
	description: string,
	options: {
		readonly displayName?: string;
		readonly efforts?: readonly ReasoningEffort[];
		readonly defaultEffort?: ReasoningEffort;
		readonly contextWindowTokens?: number;
		readonly maxOutputTokens?: number;
		readonly supportsImageDetailOriginal?: boolean;
	} = {},
): ModelCatalogEntry {
	const profile = resolveProviderProfile(provider);
	return Object.freeze({
		provider,
		protocol: profile.defaultProtocol,
		model,
		displayName: options.displayName ?? model,
		description,
		baseUrl: profile.defaultBaseUrl,
		authRef: provider,
		supportedReasoningEfforts: Object.freeze([...(options.efforts ?? [])]),
		...(options.defaultEffort ? { defaultReasoningEffort: options.defaultEffort } : {}),
		...(options.contextWindowTokens === undefined
			? {}
			: { contextWindowTokens: options.contextWindowTokens }),
		...(options.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: options.maxOutputTokens }),
		isDefault: model === profile.defaultModel,
		isCurrent: false,
		...(options.supportsImageDetailOriginal ? { supportsImageDetailOriginal: true } : {}),
	});
}

const OPENAI_LARGE_CONTEXT = Object.freeze({
	contextWindowTokens: 1_050_000,
	maxOutputTokens: 128_000,
});

const OPENAI_STANDARD_CONTEXT = Object.freeze({
	contextWindowTokens: 400_000,
	maxOutputTokens: 128_000,
});

export const BUILTIN_MODEL_CATALOG: readonly ModelCatalogEntry[] = Object.freeze([
	builtinEntry("openai", "gpt-5", "OpenAI general-purpose reasoning model", {
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
	}),
	builtinEntry("openai", "gpt-5.2", "OpenAI GPT-5.2 reasoning model", {
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
		...OPENAI_STANDARD_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.4", "OpenAI frontier coding and reasoning model", {
		supportsImageDetailOriginal: true,
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
		...OPENAI_LARGE_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.5", "OpenAI frontier coding and reasoning model", {
		supportsImageDetailOriginal: true,
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
		...OPENAI_LARGE_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.6", "OpenAI GPT-5.6 Sol reasoning model", {
		efforts: OPENAI_MAX_EFFORTS,
		defaultEffort: "low",
		...OPENAI_LARGE_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.6-luna", "OpenAI GPT-5.6 Luna reasoning model", {
		efforts: OPENAI_MAX_EFFORTS,
		defaultEffort: "medium",
		...OPENAI_LARGE_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.6-terra", "OpenAI GPT-5.6 Terra reasoning model", {
		efforts: OPENAI_ULTRA_EFFORTS,
		defaultEffort: "medium",
		...OPENAI_LARGE_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.6-sol", "OpenAI GPT-5.6 Sol reasoning model", {
		efforts: OPENAI_ULTRA_EFFORTS,
		defaultEffort: "low",
		...OPENAI_LARGE_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.4-mini", "OpenAI small, fast, cost-efficient coding model", {
		supportsImageDetailOriginal: true,
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
		...OPENAI_STANDARD_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.3-codex", "OpenAI coding model", {
		supportsImageDetailOriginal: true,
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
	}),
	builtinEntry("openai", "gpt-5.3-codex-spark", "OpenAI fast coding model", {
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
		contextWindowTokens: 128_000,
		maxOutputTokens: 32_000,
	}),
	builtinEntry("openai", "codex-mini-latest", "OpenAI compact coding model", {
		efforts: ["low", "medium", "high"],
		defaultEffort: "medium",
		contextWindowTokens: 200_000,
		maxOutputTokens: 100_000,
	}),
	builtinEntry("deepseek", "deepseek-chat", "DeepSeek chat model"),
	builtinEntry("deepseek", "deepseek-reasoner", "DeepSeek reasoning model", {
		efforts: DEEPSEEK_EFFORTS,
		defaultEffort: "high",
	}),
	builtinEntry("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash fast reasoning model", {
		efforts: DEEPSEEK_EFFORTS,
		defaultEffort: "high",
	}),
	builtinEntry("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro reasoning model", {
		efforts: DEEPSEEK_EFFORTS,
		defaultEffort: "high",
	}),
	builtinEntry("qwen", "qwen3.6-plus", "Qwen general-purpose model"),
	builtinEntry("qwen", "qwen3-coder-plus", "Qwen coding model"),
	builtinEntry("anthropic", "claude-sonnet-4-6", "Anthropic Sonnet model"),
	builtinEntry("anthropic", "claude-opus-4-7", "Anthropic Opus model"),
	builtinEntry("openrouter", "openrouter/auto", "OpenRouter automatic model routing", {
		displayName: "Auto Router",
		efforts: ["none", "minimal", "low", "medium", "high"],
		defaultEffort: "medium",
		contextWindowTokens: 2_000_000,
		maxOutputTokens: 4_096,
	}),
	builtinEntry("groq", "openai/gpt-oss-120b", "Groq GPT OSS reasoning model", {
		displayName: "GPT OSS 120B",
		efforts: ["low", "medium", "high"],
		defaultEffort: "medium",
		contextWindowTokens: 131_072,
		maxOutputTokens: 65_536,
	}),
	builtinEntry("together", "moonshotai/Kimi-K2.7-Code", "Together Kimi coding model", {
		displayName: "Kimi K2.7 Code",
		efforts: ["none", "high"],
		defaultEffort: "high",
		contextWindowTokens: 262_144,
		maxOutputTokens: 131_072,
	}),
	builtinEntry("moonshotai", "kimi-k2.7-code", "Moonshot AI Kimi coding model", {
		displayName: "Kimi K2.7 Code",
		efforts: ["high"],
		defaultEffort: "high",
		contextWindowTokens: 262_144,
		maxOutputTokens: 131_072,
	}),
	builtinEntry("nvidia", "openai/gpt-oss-120b", "NVIDIA GPT OSS coding model", {
		displayName: "GPT-OSS-120B",
		contextWindowTokens: 128_000,
		maxOutputTokens: 8_192,
	}),
	builtinEntry("cerebras", "gpt-oss-120b", "Cerebras GPT OSS reasoning model", {
		displayName: "GPT OSS 120B",
		efforts: ["low", "medium", "high"],
		defaultEffort: "medium",
		contextWindowTokens: 131_072,
		maxOutputTokens: 40_960,
	}),
]);

export function canRequestOriginalImageDetail(selection: { readonly protocol: ProtocolId; readonly model?: string }): boolean {
	if (selection.protocol !== "responses" || !selection.model) return false;
	const model = selection.model.replace(/-\d{4}-\d{2}-\d{2}$/u, "");
	return BUILTIN_MODEL_CATALOG.some((entry) => entry.model === model && entry.supportsImageDetailOriginal === true);
}

export function builtinModelReasoningDefaults(selection: {
	readonly provider: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly model: string;
}): ModelReasoningDefaults {
	const provider = selection.provider === "codex" ? "openai" : selection.provider;
	const entry = BUILTIN_MODEL_CATALOG.find((candidate) =>
		candidate.provider === provider
		&& candidate.protocol === selection.protocol
		&& candidate.model === selection.model);
	const effort = entry?.defaultReasoningEffort
		?? (entry?.supportedReasoningEfforts.length === 1
			? entry.supportedReasoningEfforts[0]
			: undefined);
	return Object.freeze({
		reasoningEffort: effort ?? "none",
		thinkingEnabled: effort !== undefined && effort !== "none",
	});
}

export async function loadModelCatalog(options: {
	readonly homeDir: string;
	readonly currentConfig: ModelCatalogCurrentConfig;
}): Promise<readonly ModelCatalogEntry[]> {
	const raw = await readModelCatalogRaw(options.homeDir);
	const entries = mergeCompiledCatalog(
		parseCatalog(raw, "~/.mycli/models.json"),
		options.currentConfig,
	);
	const currentUrl = normalizedBaseUrl(options.currentConfig.apiBaseUrl);
	const current = entries.filter((entry) =>
		entry.provider === options.currentConfig.provider
		&& entry.protocol === options.currentConfig.protocol
		&& entry.model === options.currentConfig.model
		&& normalizedBaseUrl(entry.baseUrl) === currentUrl);
	const remaining = entries
		.filter((entry) => !current.includes(entry))
		.sort((left, right) =>
			left.provider.localeCompare(right.provider)
			|| left.model.localeCompare(right.model)
			|| left.baseUrl.localeCompare(right.baseUrl));
	return Object.freeze([
		...current.map((entry) => Object.freeze({ ...entry, isCurrent: true })),
		...remaining,
	]);
}

export async function loadModelProviderDeclarations(
	homeDir: string,
): Promise<readonly ModelProviderDeclaration[]> {
	const raw = await readExistingModelCatalogRaw(homeDir);
	if (raw === undefined) return Object.freeze([]);
	return parseCatalogDeclarations(raw, "~/.mycli/models.json");
}

async function readExistingModelCatalogRaw(homeDir: string): Promise<string | undefined> {
	const path = join(homeDir, ".mycli", "models.json");
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return undefined;
		throw new ModelCatalogError("Could not read ~/.mycli/models.json.");
	}
}

async function readModelCatalogRaw(homeDir: string): Promise<string> {
	const path = join(homeDir, ".mycli", "models.json");
	const displayPath = "~/.mycli/models.json";
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) {
			throw new ModelCatalogError(`Could not read ${displayPath}.`);
		}
		await bootstrapModelCatalog(homeDir);
		try {
			return await readFile(path, "utf8");
		} catch {
			throw new ModelCatalogError(`Could not read ${displayPath}.`);
		}
	}
}

function mergeCompiledCatalog(
	userEntries: readonly ModelCatalogEntry[],
	currentConfig: ModelCatalogCurrentConfig,
): readonly ModelCatalogEntry[] {
	const entries = [...userEntries];
	const userIdentities = new Set(entries.map(modelCatalogIdentity));
	const identities = new Set(userIdentities);
	for (const builtin of BUILTIN_MODEL_CATALOG) {
		const identity = modelCatalogIdentity(builtin);
		if (identities.has(identity)) continue;
		identities.add(identity);
		entries.push(builtin);
	}
	const currentIdentity = modelCatalogIdentity(currentConfig);
	const currentIndex = entries.findIndex((entry) => modelCatalogIdentity(entry) === currentIdentity);
	if (currentIndex >= 0 && !userIdentities.has(currentIdentity)) {
		entries[currentIndex] = Object.freeze({
			...entries[currentIndex]!,
			baseUrl: normalizedBaseUrl(currentConfig.apiBaseUrl),
			authRef: currentConfig.authRef,
		});
	} else if (currentIndex < 0) {
		const profile = resolveProviderProfile(currentConfig.provider, currentConfig.protocol);
		entries.push(Object.freeze({
			provider: currentConfig.provider,
			protocol: currentConfig.protocol,
			model: currentConfig.model,
			displayName: currentConfig.model,
			description: "Current configured model",
			baseUrl: normalizedBaseUrl(currentConfig.apiBaseUrl),
			authRef: currentConfig.authRef,
			supportedReasoningEfforts: Object.freeze([]),
			isDefault: currentConfig.model === profile.defaultModel,
			isCurrent: false,
		}));
	}
	return Object.freeze(entries);
}

function modelCatalogIdentity(entry: {
	readonly provider: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly baseUrl?: string;
	readonly apiBaseUrl?: string;
}): string {
	return [
		entry.provider,
		entry.protocol,
		entry.model,
		normalizedBaseUrl(entry.baseUrl ?? entry.apiBaseUrl ?? ""),
	].join("\0");
}

export function findModelCatalogEntry(
	entries: readonly ModelCatalogEntry[],
	selection: ModelCatalogSelection,
): ModelCatalogEntry | undefined {
	const baseUrl = normalizedBaseUrl(selection.baseUrl);
	return entries.find((entry) =>
		entry.provider === selection.provider
		&& entry.protocol === selection.protocol
		&& entry.model === selection.model
		&& normalizedBaseUrl(entry.baseUrl) === baseUrl);
}

export function modelCatalogEntryPayload(entry: ModelCatalogEntry): Readonly<Record<string, unknown>> {
	return Object.freeze({
		provider: entry.provider,
		protocol: entry.protocol,
		model: entry.model,
		name: entry.displayName,
		description: entry.description,
		base_url: entry.baseUrl,
		supported_reasoning_efforts: [...entry.supportedReasoningEfforts],
		default_reasoning_effort: entry.defaultReasoningEffort ?? null,
		context_window_tokens: entry.contextWindowTokens ?? null,
		max_output_tokens: entry.maxOutputTokens ?? null,
		supports_images: entry.supportsImages ?? null,
		default: entry.isDefault,
		current: entry.isCurrent,
	});
}

export function modelInputTokenLimit(entry: ModelCatalogEntry): number | undefined {
	if (entry.contextWindowTokens === undefined) return undefined;
	const outputTokens = entry.maxOutputTokens ?? 0;
	// A full-context SDK output ceiling is not a fixed reservation. Pi-ai fits
	// completion tokens to the remaining context on each request.
	return outputTokens >= entry.contextWindowTokens
		? entry.contextWindowTokens
		: entry.contextWindowTokens - outputTokens;
}

async function bootstrapModelCatalog(
	homeDir: string,
): Promise<void> {
	const content = `${JSON.stringify(serializedCatalog(BUILTIN_MODEL_CATALOG), null, 2)}\n`;
	await atomicPrivateFileUpdate({
		directory: join(homeDir, ".mycli"),
		fileName: "models.json",
		buildContent: (existing) => existing ?? content,
	});
}

function serializedModel(entry: ModelCatalogEntry): Record<string, unknown> {
	return {
		...(entry.displayName === entry.model ? {} : { name: entry.displayName }),
		...(entry.description ? { description: entry.description } : {}),
		...(entry.contextWindowTokens !== undefined || entry.maxOutputTokens !== undefined
			? {
				limits: {
					...(entry.contextWindowTokens === undefined
						? {}
						: { context_window_tokens: entry.contextWindowTokens }),
					...(entry.maxOutputTokens === undefined
						? {}
						: { max_output_tokens: entry.maxOutputTokens }),
				},
			}
			: {}),
		...(entry.supportedReasoningEfforts.length > 0 ? {
			reasoning: {
				efforts: [...entry.supportedReasoningEfforts],
				...(entry.defaultReasoningEffort
					? { default: entry.defaultReasoningEffort }
					: {}),
			},
		} : {}),
		...(entry.supportsImages === undefined && entry.supportsHostedWebSearch === undefined
			? {}
			: {
				capabilities: {
					...(entry.supportsImages === undefined
						? {}
						: { images: entry.supportsImages }),
					...(entry.supportsHostedWebSearch === undefined
						? {}
						: { web_search: entry.supportsHostedWebSearch }),
				},
			}),
	};
}

function serializedCatalog(
	entries: readonly ModelCatalogEntry[],
): Record<string, unknown> {
	const providers: Record<string, unknown> = {};
	for (const provider of [...new Set(entries.map((entry) => entry.provider))]) {
		const providerEntries = entries.filter((entry) => entry.provider === provider);
		const first = providerEntries[0]!;
		providers[provider] = {
			protocol: first.protocol,
			base_url: first.baseUrl,
			auth_ref: first.authRef,
			models: Object.fromEntries(providerEntries.map((entry) => [
				entry.model,
				serializedModel(entry),
			])),
		};
	}
	return { version: 2, providers };
}

function parseCatalog(raw: string, path: string): readonly ModelCatalogEntry[] {
	return Object.freeze(parseCatalogDeclarations(raw, path).flatMap(declarationEntries));
}

function parseCatalogDeclarations(
	raw: string,
	path: string,
): readonly ModelProviderDeclaration[] {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new ModelCatalogError(`Invalid JSON in ${path}.`);
	}
	if (!isRecord(payload)) throw new ModelCatalogError(`${path} must contain an object.`);
	if (payload.version === 2 || payload.providers !== undefined) {
		return parseProviderDeclarations(payload, path);
	}
	if (!Array.isArray(payload.models)) {
		throw new ModelCatalogError(`${path} must contain a 'models' array or v2 'providers'.`);
	}
	const entries: ModelCatalogEntry[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < payload.models.length; index += 1) {
		const entry = parseLegacyEntry(payload.models[index], path, index);
		const key = [entry.provider, entry.protocol, entry.model, normalizedBaseUrl(entry.baseUrl)].join("\0");
		if (seen.has(key)) {
			throw new ModelCatalogError(`Duplicate model entry ${index} in ${path}.`);
		}
		seen.add(key);
		entries.push(entry);
	}
	return declarationsFromEntries(entries);
}

function parseProviderDeclarations(
	payload: Readonly<Record<string, unknown>>,
	path: string,
): readonly ModelProviderDeclaration[] {
	if (payload.version !== 2 || !isRecord(payload.providers)) {
		throw new ModelCatalogError(`${path} v2 requires version 2 and a 'providers' object.`);
	}
	const declarations: ModelProviderDeclaration[] = [];
	for (const [providerValue, providerValueRaw] of Object.entries(payload.providers)) {
		if (!isRecord(providerValueRaw)) {
			throw new ModelCatalogError(`Provider '${providerValue}' in ${path} must be an object.`);
		}
		let provider: ProviderRouteId;
		try {
			provider = parseProviderRouteId(providerValue);
		} catch {
			throw new ModelCatalogError(`Provider '${providerValue}' in ${path} is unsupported.`);
		}
		const protocolValue = optionalString(providerValueRaw.protocol);
		const profile = isProviderId(provider) ? resolveProviderProfile(provider) : undefined;
		let protocol: ProtocolId;
		try {
			if (profile !== undefined) resolveProviderProfile(provider, protocolValue);
			protocol = parseProtocol(protocolValue ?? profile?.defaultProtocol ?? "");
		} catch {
			throw new ModelCatalogError(`Provider '${providerValue}' in ${path} is unsupported.`);
		}
		const location = `Provider '${providerValue}' in ${path}`;
		const source = parseProviderDeclarationSource(providerValueRaw.source, location);
		const modelPolicy = parseProviderDeclarationModelPolicy(
			providerValueRaw.model_policy,
			location,
		);
		const catalogProvider = parseOptionalProviderRouteId(
			providerValueRaw.catalog_provider,
			location,
		);
		if (source === "pi_ai_declared"
			&& (catalogProvider !== undefined || modelPolicy !== undefined)) {
			throw new ModelCatalogError(
				`${location} cannot combine source 'pi_ai_declared' with catalog settings.`,
			);
		}
		const baseUrlValue = optionalString(providerValueRaw.base_url) ?? profile?.defaultBaseUrl;
		const baseUrl = baseUrlValue === undefined ? undefined : parseBaseUrl(baseUrlValue, location);
		const explicitAuthRef = optionalString(providerValueRaw.auth_ref);
		const authRef = explicitAuthRef ?? provider;
		parseRetiredStoreOption(providerValueRaw.options, location);
		const providerCompat = parseCompatOverride(providerValueRaw.compat, location);
		const providerCapabilities = parseCapabilities(
			providerValueRaw.capabilities,
			location,
		);
		let models: readonly ModelCatalogModelDeclaration[] | undefined;
		if (providerValueRaw.models !== undefined) {
			if (!isRecord(providerValueRaw.models) || Object.keys(providerValueRaw.models).length === 0) {
				throw new ModelCatalogError(`${location} has an invalid 'models' object.`);
			}
			models = Object.freeze(Object.entries(providerValueRaw.models).map(([model, modelValue]) => {
				if (!model.trim() || !isRecord(modelValue)) {
					throw new ModelCatalogError(
						`Model '${model}' for provider '${providerValue}' in ${path} must be an object.`,
					);
				}
				const modelLocation = `Model '${model}' for provider '${providerValue}' in ${path}`;
				const reasoning = parseReasoning(modelValue.reasoning, modelLocation);
				const limits = parseLimits(modelValue.limits, modelLocation);
				parseRetiredStoreOption(modelValue.options, modelLocation);
				const compat = parseCompatOverride(modelValue.compat, modelLocation);
				const modelCapabilities = parseCapabilities(modelValue.capabilities, modelLocation);
				const displayName = optionalString(modelValue.name);
				const description = optionalString(modelValue.description);
				const supportsHostedWebSearch = modelCapabilities.supportsHostedWebSearch
					?? providerCapabilities.supportsHostedWebSearch;
				const supportsImages = modelCapabilities.supportsImages
					?? providerCapabilities.supportsImages;
				if (supportsHostedWebSearch === true && protocol !== "responses") {
					throw new ModelCatalogError(`${modelLocation} requires protocol 'responses' for web_search.`);
				}
				return Object.freeze({
					model: model.trim(),
					...(displayName === undefined ? {} : { displayName }),
					...(description === undefined ? {} : { description }),
					...(modelValue.reasoning === undefined
						? {}
						: { supportedReasoningEfforts: reasoning.efforts }),
					...(reasoning.defaultEffort
						? { defaultReasoningEffort: reasoning.defaultEffort }
						: {}),
					...limits,
					...(supportsImages === undefined ? {} : { supportsImages }),
					...(supportsHostedWebSearch === undefined ? {} : { supportsHostedWebSearch }),
					...(compat === undefined ? {} : { compat }),
				});
			}));
		}
		if (modelPolicy === "subset" && models === undefined) {
			throw new ModelCatalogError(`${location} requires 'models' when model_policy is 'subset'.`);
		}
		const requiresCompleteDeclaration = source === "pi_ai_declared"
			|| (!isProviderId(provider)
				&& source !== "pi_ai_builtin"
				&& catalogProvider === undefined);
		if (requiresCompleteDeclaration
			&& (baseUrl === undefined
				|| explicitAuthRef === undefined
				|| models === undefined
				|| models.some((model) => model.contextWindowTokens === undefined
					|| model.maxOutputTokens === undefined
					|| model.supportsImages === undefined))) {
			throw new ModelCatalogError(`${location} is an incomplete declared route.`);
		}
		declarations.push(Object.freeze({
			provider,
			protocol,
			...(baseUrl === undefined ? {} : { baseUrl }),
			authRef,
			...(source === undefined ? {} : { source }),
			...(catalogProvider === undefined ? {} : { catalogProvider }),
			...(modelPolicy === undefined ? {} : { modelPolicy }),
			...(providerCompat === undefined ? {} : { compat: providerCompat }),
			...(models === undefined ? {} : { models }),
		}));
	}
	return Object.freeze(declarations);
}

function declarationEntries(declaration: ModelProviderDeclaration): readonly ModelCatalogEntry[] {
	if (declaration.baseUrl === undefined || declaration.models === undefined) return [];
	const baseUrl = declaration.baseUrl;
	return declaration.models.map((model) => Object.freeze({
		provider: declaration.provider,
		protocol: declaration.protocol,
		model: model.model,
		displayName: model.displayName ?? model.model,
		description: model.description ?? "",
		baseUrl,
		authRef: declaration.authRef,
		supportedReasoningEfforts: model.supportedReasoningEfforts ?? Object.freeze([]),
		...(model.defaultReasoningEffort === undefined
			? {}
			: { defaultReasoningEffort: model.defaultReasoningEffort }),
		...(model.contextWindowTokens === undefined
			? {}
			: { contextWindowTokens: model.contextWindowTokens }),
		...(model.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: model.maxOutputTokens }),
		...(model.supportsImages === undefined
			? {}
			: { supportsImages: model.supportsImages }),
		...(model.supportsHostedWebSearch === undefined
			? {}
			: { supportsHostedWebSearch: model.supportsHostedWebSearch }),
		isDefault: isDefaultModel(declaration.provider, model.model),
		isCurrent: false,
	}));
}

function declarationsFromEntries(
	entries: readonly ModelCatalogEntry[],
): readonly ModelProviderDeclaration[] {
	const groups = new Map<string, ModelProviderDeclaration>();
	for (const entry of entries) {
		const key = [entry.provider, entry.protocol, entry.baseUrl, entry.authRef].join("\0");
		const model = modelDeclarationFromEntry(entry);
		const existing = groups.get(key);
		groups.set(key, Object.freeze({
			provider: entry.provider,
			protocol: entry.protocol,
			baseUrl: entry.baseUrl,
			authRef: entry.authRef,
			modelPolicy: "subset",
			models: Object.freeze([...(existing?.models ?? []), model]),
		}));
	}
	return Object.freeze([...groups.values()]);
}

function modelDeclarationFromEntry(entry: ModelCatalogEntry): ModelCatalogModelDeclaration {
	return Object.freeze({
		model: entry.model,
		displayName: entry.displayName,
		description: entry.description,
		supportedReasoningEfforts: entry.supportedReasoningEfforts,
		...(entry.defaultReasoningEffort === undefined
			? {}
			: { defaultReasoningEffort: entry.defaultReasoningEffort }),
		...(entry.contextWindowTokens === undefined
			? {}
			: { contextWindowTokens: entry.contextWindowTokens }),
		...(entry.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: entry.maxOutputTokens }),
		...(entry.supportsImages === undefined
			? {}
			: { supportsImages: entry.supportsImages }),
		...(entry.supportsHostedWebSearch === undefined
			? {}
			: { supportsHostedWebSearch: entry.supportsHostedWebSearch }),
	});
}

function parseProviderDeclarationSource(
	value: unknown,
	location: string,
): ModelProviderDeclarationSource | undefined {
	if (value === undefined) return undefined;
	if (value === "pi_ai_builtin" || value === "pi_ai_declared") return value;
	throw new ModelCatalogError(`${location} has an unsupported source.`);
}

function parseProviderDeclarationModelPolicy(
	value: unknown,
	location: string,
): ModelProviderDeclarationModelPolicy | undefined {
	if (value === undefined) return undefined;
	if (value === "catalog" || value === "subset") return value;
	throw new ModelCatalogError(`${location} has an unsupported model_policy.`);
}

function parseOptionalProviderRouteId(
	value: unknown,
	location: string,
): ProviderRouteId | undefined {
	if (value === undefined) return undefined;
	try {
		return parseProviderRouteId(value);
	} catch {
		throw new ModelCatalogError(`${location} has an invalid catalog_provider.`);
	}
}

function isDefaultModel(provider: ProviderRouteId, model: string): boolean {
	return isProviderId(provider) && model === resolveProviderProfile(provider).defaultModel;
}

function parseLegacyEntry(value: unknown, path: string, index: number): ModelCatalogEntry {
	if (!isRecord(value)) {
		throw new ModelCatalogError(`Entry ${index} in ${path} must be an object.`);
	}
	const model = requiredString(value, "model", path, index);
	const providerValue = requiredString(value, "provider", path, index);
	const protocolValue = requiredString(value, "protocol", path, index);
	let profile;
	let protocol: ProtocolId;
	try {
		profile = resolveProviderProfile(providerValue, protocolValue);
		protocol = parseProtocol(protocolValue);
	} catch {
		throw new ModelCatalogError(`Entry ${index} in ${path} has an unsupported provider/protocol.`);
	}
	const location = `Entry ${index} in ${path}`;
	const baseUrl = parseBaseUrl(requiredString(value, "base_url", path, index), location);
	const reasoning = parseReasoning({
		efforts: value.reasoning_efforts,
		default: value.default_reasoning_effort,
	}, location);
	const limits = parseLimits(value.limits, location);
	parseRetiredStoreOption(value.options, location);
	const capabilities = parseCapabilities(value.capabilities, location);
	if (capabilities.supportsHostedWebSearch === true && protocol !== "responses") {
		throw new ModelCatalogError(`${location} requires protocol 'responses' for web_search.`);
	}
	return Object.freeze({
		provider: profile.provider,
		protocol,
		model,
		displayName: optionalString(value.name) ?? model,
		description: optionalString(value.description) ?? "",
		baseUrl,
		authRef: optionalString(value.auth_ref) ?? profile.provider,
		supportedReasoningEfforts: reasoning.efforts,
		...(reasoning.defaultEffort ? { defaultReasoningEffort: reasoning.defaultEffort } : {}),
		...limits,
		...(capabilities.supportsImages === undefined
			? {}
			: { supportsImages: capabilities.supportsImages }),
		...(capabilities.supportsHostedWebSearch === undefined
			? {}
			: { supportsHostedWebSearch: capabilities.supportsHostedWebSearch }),
		isDefault: model === profile.defaultModel,
		isCurrent: false,
	});
}

function parseReasoning(
	value: unknown,
	location: string,
): {
	readonly efforts: readonly ReasoningEffort[];
	readonly defaultEffort?: ReasoningEffort;
} {
	if (value === undefined) return { efforts: Object.freeze([]) };
	if (!isRecord(value)) {
		throw new ModelCatalogError(`${location} has invalid reasoning settings.`);
	}
	const effortsValue = value.efforts ?? [];
	if (!Array.isArray(effortsValue) || effortsValue.some((effort) =>
		typeof effort !== "string" || !REASONING_EFFORTS.has(effort.trim().toLowerCase()))) {
		throw new ModelCatalogError(`${location} has invalid reasoning efforts.`);
	}
	const efforts = effortsValue.map((effort) =>
		String(effort).trim().toLowerCase() as ReasoningEffort);
	if (new Set(efforts).size !== efforts.length) {
		throw new ModelCatalogError(`${location} repeats a reasoning effort.`);
	}
	const defaultValue = optionalString(value.default)?.toLowerCase();
	if (defaultValue && !REASONING_EFFORTS.has(defaultValue)) {
		throw new ModelCatalogError(`${location} has an invalid default reasoning effort.`);
	}
	const defaultEffort = defaultValue as ReasoningEffort | undefined;
	if (defaultEffort && !efforts.includes(defaultEffort)) {
		throw new ModelCatalogError(`${location} has an unlisted default reasoning effort.`);
	}
	return {
		efforts: Object.freeze(efforts),
		...(defaultEffort ? { defaultEffort } : {}),
	};
}

function parseLimits(
	value: unknown,
	location: string,
): Pick<ModelCatalogEntry, "contextWindowTokens" | "maxOutputTokens"> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new ModelCatalogError(`${location} has invalid limits.`);
	const allowed = new Set(["context_window_tokens", "max_output_tokens"]);
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw new ModelCatalogError(`${location} has unsupported limit settings.`);
	}
	const contextWindowTokens = optionalPositiveSafeInteger(
		value.context_window_tokens,
		`${location} context_window_tokens`,
	);
	const maxOutputTokens = optionalPositiveSafeInteger(
		value.max_output_tokens,
		`${location} max_output_tokens`,
	);
	if (contextWindowTokens !== undefined
		&& maxOutputTokens !== undefined
		&& maxOutputTokens >= contextWindowTokens) {
		throw new ModelCatalogError(
			`${location} max_output_tokens must be smaller than context_window_tokens.`,
		);
	}
	return {
		...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
		...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
	};
}

function parseRetiredStoreOption(value: unknown, location: string): void {
	if (value === undefined) return;
	if (!isRecord(value)
		|| Object.keys(value).some((key) => key !== "store")
		|| (value.store !== undefined && typeof value.store !== "boolean")) {
		throw new ModelCatalogError(`${location} has invalid provider request options.`);
	}
}

const COMPAT_MAX_JSON_CHARS = 64 * 1024;
const COMPAT_MAX_KEYS = 128;
const COMPAT_MAX_DEPTH = 8;

function parseCompatOverride(
	value: unknown,
	location: string,
): Readonly<Record<string, unknown>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).length === 0) {
		throw new ModelCatalogError(`${location} has an invalid compat object.`);
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new ModelCatalogError(`${location} has an invalid compat object.`);
	}
	if (serialized.length > COMPAT_MAX_JSON_CHARS) {
		throw new ModelCatalogError(`${location} compat object is too large.`);
	}
	let keys = 0;
	const copy = (item: unknown, depth: number): unknown => {
		if (depth > COMPAT_MAX_DEPTH) {
			throw new ModelCatalogError(`${location} compat object is too deeply nested.`);
		}
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (Array.isArray(item)) return Object.freeze(item.map((entry) => copy(entry, depth + 1)));
		if (!isRecord(item)) {
			throw new ModelCatalogError(`${location} has an invalid compat value.`);
		}
		const entries = Object.entries(item).map(([key, entry]) => {
			keys += 1;
			if (keys > COMPAT_MAX_KEYS) {
				throw new ModelCatalogError(`${location} compat object has too many keys.`);
			}
			return [key, copy(entry, depth + 1)] as const;
		});
		return Object.freeze(Object.fromEntries(entries));
	};
	return copy(value, 0) as Readonly<Record<string, unknown>>;
}

function parseCapabilities(
	value: unknown,
	location: string,
): Pick<ModelCatalogEntry, "supportsHostedWebSearch" | "supportsImages"> {
	if (value === undefined) return {};
	if (!isRecord(value)
		|| Object.keys(value).some((key) => key !== "web_search" && key !== "images")
		|| (value.web_search !== undefined && typeof value.web_search !== "boolean")
		|| (value.images !== undefined && typeof value.images !== "boolean")) {
		throw new ModelCatalogError(`${location} has invalid model capabilities.`);
	}
	return {
		...(value.web_search === undefined ? {} : { supportsHostedWebSearch: value.web_search }),
		...(value.images === undefined ? {} : { supportsImages: value.images }),
	};
}

function optionalPositiveSafeInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new ModelCatalogError(`${label} must be a positive safe integer.`);
	}
	return value;
}

function parseBaseUrl(value: string, location: string): string {
	const baseUrl = normalizedBaseUrl(value);
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new ModelCatalogError(`${location} has an invalid base_url.`);
	}
	if (!(["http:", "https:"] as string[]).includes(url.protocol)
		|| !url.host
		|| url.username
		|| url.password
		|| url.search
		|| url.hash) {
		throw new ModelCatalogError(`${location} has an invalid base_url.`);
	}
	return baseUrl;
}

function requiredString(
	value: Readonly<Record<string, unknown>>,
	key: string,
	path: string,
	index: number,
): string {
	const result = optionalString(value[key]);
	if (!result) throw new ModelCatalogError(`Entry ${index} in ${path} requires '${key}'.`);
	return result;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
