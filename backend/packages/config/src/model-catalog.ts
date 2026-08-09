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
]);

const OPENAI_EFFORTS = Object.freeze<readonly ReasoningEffort[]>([
	"low",
	"medium",
	"high",
	"xhigh",
]);

const DEEPSEEK_EFFORTS = Object.freeze<readonly ReasoningEffort[]>([
	"high",
	"xhigh",
]);

function builtinEntry(
	provider: ProviderId,
	model: string,
	description: string,
	options: {
		readonly efforts?: readonly ReasoningEffort[];
		readonly defaultEffort?: ReasoningEffort;
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
		isDefault: model === profile.defaultModel,
		isCurrent: false,
	});
}

export const BUILTIN_MODEL_CATALOG: readonly ModelCatalogEntry[] = Object.freeze([
	builtinEntry("openai", "gpt-5", "OpenAI general-purpose reasoning model", {
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
	}),
	builtinEntry("openai", "gpt-5.4", "OpenAI frontier coding and reasoning model", {
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
	}),
	builtinEntry("openai", "gpt-5.3-codex", "OpenAI coding model", {
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
	}),
	builtinEntry("codex", "gpt-5", "Codex general-purpose reasoning model", {
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
	}),
	builtinEntry("codex", "gpt-5.4", "Codex frontier coding and reasoning model", {
		efforts: OPENAI_EFFORTS,
		defaultEffort: "medium",
	}),
	builtinEntry("deepseek", "deepseek-chat", "DeepSeek chat model"),
	builtinEntry("deepseek", "deepseek-reasoner", "DeepSeek reasoning model", {
		efforts: DEEPSEEK_EFFORTS,
		defaultEffort: "high",
	}),
	builtinEntry("deepseek", "deepseek-v4-flash", "DeepSeek fast reasoning model", {
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
		default: entry.isDefault,
		current: entry.isCurrent,
	});
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
	const content = `${JSON.stringify({
		models: entries.map(serializedEntry),
	}, null, 2)}\n`;
	await atomicPrivateFileUpdate({
		directory: join(homeDir, ".mycli"),
		fileName: "models.json",
		buildContent: (existing) => existing ?? content,
	});
}

function serializedEntry(entry: ModelCatalogEntry): Record<string, unknown> {
	return {
		model: entry.model,
		provider: entry.provider,
		protocol: entry.protocol,
		base_url: entry.baseUrl,
		auth_ref: entry.authRef,
		...(entry.displayName === entry.model ? {} : { name: entry.displayName }),
		...(entry.description ? { description: entry.description } : {}),
		...(entry.supportedReasoningEfforts.length > 0
			? { reasoning_efforts: [...entry.supportedReasoningEfforts] }
			: {}),
		...(entry.defaultReasoningEffort
			? { default_reasoning_effort: entry.defaultReasoningEffort }
			: {}),
	};
}

function parseCatalog(raw: string, path: string): readonly ModelCatalogEntry[] {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new ModelCatalogError(`Invalid JSON in ${path}.`);
	}
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new ModelCatalogError(`${path} must contain a 'models' array.`);
	}
	const entries: ModelCatalogEntry[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < payload.models.length; index += 1) {
		const entry = parseEntry(payload.models[index], path, index);
		const key = [entry.provider, entry.protocol, entry.model, normalizedBaseUrl(entry.baseUrl)].join("\0");
		if (seen.has(key)) {
			throw new ModelCatalogError(`Duplicate model entry ${index} in ${path}.`);
		}
		seen.add(key);
		entries.push(entry);
	}
	return Object.freeze(entries);
}

function parseEntry(value: unknown, path: string, index: number): ModelCatalogEntry {
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
	const baseUrl = normalizedBaseUrl(requiredString(value, "base_url", path, index));
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new ModelCatalogError(`Entry ${index} in ${path} has an invalid base_url.`);
	}
	if (!(["http:", "https:"] as string[]).includes(url.protocol) || !url.host) {
		throw new ModelCatalogError(`Entry ${index} in ${path} has an invalid base_url.`);
	}

	const effortsValue = value.reasoning_efforts ?? [];
	if (!Array.isArray(effortsValue) || effortsValue.some((effort) =>
		typeof effort !== "string" || !REASONING_EFFORTS.has(effort.trim().toLowerCase()))) {
		throw new ModelCatalogError(`Entry ${index} in ${path} has invalid reasoning_efforts.`);
	}
	const efforts = effortsValue.map((effort) =>
		String(effort).trim().toLowerCase() as ReasoningEffort);
	if (new Set(efforts).size !== efforts.length) {
		throw new ModelCatalogError(`Entry ${index} in ${path} repeats a reasoning effort.`);
	}
	const defaultValue = optionalString(value.default_reasoning_effort)?.toLowerCase();
	if (defaultValue && !REASONING_EFFORTS.has(defaultValue)) {
		throw new ModelCatalogError(`Entry ${index} in ${path} has an invalid default reasoning effort.`);
	}
	const defaultEffort = defaultValue as ReasoningEffort | undefined;
	if (defaultEffort && !efforts.includes(defaultEffort)) {
		throw new ModelCatalogError(`Entry ${index} in ${path} has an unlisted default reasoning effort.`);
	}
	return Object.freeze({
		provider: profile.provider,
		protocol,
		model,
		displayName: optionalString(value.name) ?? model,
		description: optionalString(value.description) ?? "",
		baseUrl,
		authRef: optionalString(value.auth_ref) ?? profile.provider,
		supportedReasoningEfforts: Object.freeze(efforts),
		...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
		isDefault: model === profile.defaultModel,
		isCurrent: false,
	});
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
