import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProtocolId, ProviderId, ReasoningEffort } from "@mycli/core";
import { atomicPrivateFileUpdate } from "./private-file-writer.ts";
import {
	parseProtocol,
	resolveProviderProfile,
} from "./provider-profiles.ts";

export interface ModelCatalogEntry {
	readonly provider: ProviderId;
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
	readonly store?: boolean;
	readonly supportsHostedWebSearch?: boolean;
	readonly isDefault: boolean;
	readonly isCurrent: boolean;
}

export interface ModelCatalogCurrentConfig {
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly authRef: string;
}

export interface ModelCatalogSelection {
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly baseUrl: string;
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
		readonly efforts?: readonly ReasoningEffort[];
		readonly defaultEffort?: ReasoningEffort;
		readonly contextWindowTokens?: number;
		readonly maxOutputTokens?: number;
	} = {},
): ModelCatalogEntry {
	const profile = resolveProviderProfile(provider);
	return Object.freeze({
		provider,
		protocol: profile.defaultProtocol,
		model,
		displayName: model,
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
		...(provider === "openai" && profile.defaultProtocol === "responses"
			? { store: false }
			: {}),
		isDefault: model === profile.defaultModel,
		isCurrent: false,
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
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
		...OPENAI_LARGE_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.5", "OpenAI frontier coding and reasoning model", {
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
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
		...OPENAI_STANDARD_CONTEXT,
	}),
	builtinEntry("openai", "gpt-5.3-codex", "OpenAI coding model", {
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
]);

export async function loadModelCatalog(options: {
	readonly homeDir: string;
	readonly currentConfig: ModelCatalogCurrentConfig;
}): Promise<readonly ModelCatalogEntry[]> {
	const path = join(options.homeDir, ".mycli", "models.json");
	const displayPath = "~/.mycli/models.json";
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) {
			throw new ModelCatalogError(`Could not read ${displayPath}.`);
		}
		await bootstrapModelCatalog(options.homeDir, options.currentConfig);
		try {
			raw = await readFile(path, "utf8");
		} catch {
			throw new ModelCatalogError(`Could not read ${displayPath}.`);
		}
	}

	const entries = parseCatalog(raw, displayPath);
	const currentUrl = normalizedBaseUrl(options.currentConfig.apiBaseUrl);
	const current = entries.filter((entry) =>
		entry.provider === options.currentConfig.provider
		&& entry.protocol === options.currentConfig.protocol
		&& entry.model === options.currentConfig.model
		&& normalizedBaseUrl(entry.baseUrl) === currentUrl
		&& entry.authRef === options.currentConfig.authRef);
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
		default: entry.isDefault,
		current: entry.isCurrent,
	});
}

export function modelInputTokenLimit(entry: ModelCatalogEntry): number | undefined {
	if (entry.contextWindowTokens === undefined) return undefined;
	return entry.contextWindowTokens - (entry.maxOutputTokens ?? 0);
}

async function bootstrapModelCatalog(
	homeDir: string,
	currentConfig: ModelCatalogCurrentConfig,
): Promise<void> {
	const currentUrl = normalizedBaseUrl(currentConfig.apiBaseUrl);
	const entries = BUILTIN_MODEL_CATALOG.map((entry) => ({ ...entry }));
	const currentIndex = entries.findIndex((entry) =>
		entry.provider === currentConfig.provider
		&& entry.protocol === currentConfig.protocol
		&& entry.model === currentConfig.model
		&& normalizedBaseUrl(entry.baseUrl) === currentUrl);
	if (currentIndex >= 0) {
		entries[currentIndex] = {
			...entries[currentIndex]!,
			baseUrl: currentUrl,
			authRef: currentConfig.authRef,
		};
	} else {
		const profile = resolveProviderProfile(currentConfig.provider, currentConfig.protocol);
		entries.push({
			provider: currentConfig.provider,
			protocol: currentConfig.protocol,
			model: currentConfig.model,
			displayName: currentConfig.model,
			description: "Current configured model",
			baseUrl: currentUrl,
			authRef: currentConfig.authRef,
			supportedReasoningEfforts: [],
			isDefault: currentConfig.model === profile.defaultModel,
			isCurrent: false,
		});
	}
	const content = `${JSON.stringify(serializedCatalog(entries, currentConfig), null, 2)}\n`;
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
	};
}

function serializedCatalog(
	entries: readonly ModelCatalogEntry[],
	currentConfig: ModelCatalogCurrentConfig,
): Record<string, unknown> {
	const providers: Record<string, unknown> = {};
	for (const provider of [...new Set(entries.map((entry) => entry.provider))]) {
		const providerEntries = entries.filter((entry) => entry.provider === provider);
		const first = providerEntries[0]!;
		const currentProvider = provider === currentConfig.provider;
		const protocol = currentProvider ? currentConfig.protocol : first.protocol;
		const baseUrl = currentProvider
			? normalizedBaseUrl(currentConfig.apiBaseUrl)
			: first.baseUrl;
		const authRef = currentProvider ? currentConfig.authRef : first.authRef;
		const store = providerEntries.find((entry) => entry.store !== undefined)?.store;
		providers[provider] = {
			protocol,
			base_url: baseUrl,
			auth_ref: authRef,
			...(store === undefined ? {} : { options: { store } }),
			models: Object.fromEntries(providerEntries.map((entry) => [
				entry.model,
				serializedModel(entry),
			])),
		};
	}
	return { version: 2, providers };
}

function parseCatalog(raw: string, path: string): readonly ModelCatalogEntry[] {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new ModelCatalogError(`Invalid JSON in ${path}.`);
	}
	if (!isRecord(payload)) throw new ModelCatalogError(`${path} must contain an object.`);
	if (payload.version === 2 || payload.providers !== undefined) {
		return parseProviderCatalog(payload, path);
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
	return Object.freeze(entries);
}

function parseProviderCatalog(
	payload: Readonly<Record<string, unknown>>,
	path: string,
): readonly ModelCatalogEntry[] {
	if (payload.version !== 2 || !isRecord(payload.providers)) {
		throw new ModelCatalogError(`${path} v2 requires version 2 and a 'providers' object.`);
	}
	const entries: ModelCatalogEntry[] = [];
	for (const [providerValue, providerValueRaw] of Object.entries(payload.providers)) {
		if (!isRecord(providerValueRaw)) {
			throw new ModelCatalogError(`Provider '${providerValue}' in ${path} must be an object.`);
		}
		let profile;
		let protocol: ProtocolId;
		const protocolValue = optionalString(providerValueRaw.protocol);
		try {
			profile = resolveProviderProfile(providerValue, protocolValue);
			protocol = parseProtocol(protocolValue ?? profile.defaultProtocol);
		} catch {
			throw new ModelCatalogError(`Provider '${providerValue}' in ${path} is unsupported.`);
		}
		const baseUrl = parseBaseUrl(
			optionalString(providerValueRaw.base_url) ?? profile.defaultBaseUrl,
			`Provider '${providerValue}' in ${path}`,
		);
		const authRef = optionalString(providerValueRaw.auth_ref) ?? profile.provider;
		const providerStore = parseStoreOption(
			providerValueRaw.options,
			`Provider '${providerValue}' in ${path}`,
		);
		const providerCapabilities = parseCapabilities(
			providerValueRaw.capabilities,
			`Provider '${providerValue}' in ${path}`,
		);
		if (providerStore !== undefined && protocol === "anthropic_messages") {
			throw new ModelCatalogError(
				`Provider '${providerValue}' in ${path} does not support the 'store' option.`,
			);
		}
		if (!isRecord(providerValueRaw.models)) {
			throw new ModelCatalogError(`Provider '${providerValue}' in ${path} requires a 'models' object.`);
		}
		for (const [model, modelValue] of Object.entries(providerValueRaw.models)) {
			if (!model.trim() || !isRecord(modelValue)) {
				throw new ModelCatalogError(
					`Model '${model}' for provider '${providerValue}' in ${path} must be an object.`,
				);
			}
			const location = `Model '${model}' for provider '${providerValue}' in ${path}`;
			const reasoning = parseReasoning(modelValue.reasoning, location);
			const limits = parseLimits(modelValue.limits, location);
			const modelStore = parseStoreOption(modelValue.options, location);
			const modelCapabilities = parseCapabilities(modelValue.capabilities, location);
			const store = modelStore ?? providerStore;
			const supportsHostedWebSearch = modelCapabilities.supportsHostedWebSearch
				?? providerCapabilities.supportsHostedWebSearch;
			if (store !== undefined && protocol === "anthropic_messages") {
				throw new ModelCatalogError(`${location} does not support the 'store' option.`);
			}
			if (supportsHostedWebSearch === true && protocol !== "responses") {
				throw new ModelCatalogError(`${location} requires protocol 'responses' for web_search.`);
			}
			entries.push(Object.freeze({
				provider: profile.provider,
				protocol,
				model: model.trim(),
				displayName: optionalString(modelValue.name) ?? model.trim(),
				description: optionalString(modelValue.description) ?? "",
				baseUrl,
				authRef,
				supportedReasoningEfforts: reasoning.efforts,
				...(reasoning.defaultEffort
					? { defaultReasoningEffort: reasoning.defaultEffort }
					: {}),
				...limits,
				...(store === undefined ? {} : { store }),
				...(supportsHostedWebSearch === undefined ? {} : { supportsHostedWebSearch }),
				isDefault: model.trim() === profile.defaultModel,
				isCurrent: false,
			}));
		}
	}
	return Object.freeze(entries);
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
	const store = parseStoreOption(value.options, location);
	const capabilities = parseCapabilities(value.capabilities, location);
	if (store !== undefined && protocol === "anthropic_messages") {
		throw new ModelCatalogError(`${location} does not support the 'store' option.`);
	}
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
		...(store === undefined ? {} : { store }),
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

function parseStoreOption(value: unknown, location: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)
		|| Object.keys(value).some((key) => key !== "store")
		|| (value.store !== undefined && typeof value.store !== "boolean")) {
		throw new ModelCatalogError(`${location} has invalid provider request options.`);
	}
	return value.store;
}

function parseCapabilities(
	value: unknown,
	location: string,
): Pick<ModelCatalogEntry, "supportsHostedWebSearch"> {
	if (value === undefined) return {};
	if (!isRecord(value)
		|| Object.keys(value).some((key) => key !== "web_search")
		|| (value.web_search !== undefined && typeof value.web_search !== "boolean")) {
		throw new ModelCatalogError(`${location} has invalid model capabilities.`);
	}
	return value.web_search === undefined
		? {}
		: { supportsHostedWebSearch: value.web_search };
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
	if (!(["http:", "https:"] as string[]).includes(url.protocol) || !url.host) {
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
