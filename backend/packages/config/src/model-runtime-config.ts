import {
	findModelCatalogEntry,
	loadModelCatalog,
	modelInputTokenLimit,
} from "./model-catalog.ts";
import {
	resolveConfig,
	type NodeRuntimeConfig,
	type ResolveConfigOptions,
} from "./settings.ts";

export async function resolveModelRuntimeConfig(
	options: ResolveConfigOptions,
): Promise<NodeRuntimeConfig> {
	const preliminary = await resolveConfig(options);
	const catalog = await loadModelCatalog({
		homeDir: options.homeDir,
		currentConfig: preliminary,
	});
	const entry = findModelCatalogEntry(catalog, {
		provider: preliminary.provider,
		protocol: preliminary.protocol,
		model: preliminary.model,
		baseUrl: preliminary.apiBaseUrl,
	});
	if (!entry) return preliminary;

	const inputTokenLimit = modelInputTokenLimit(entry);
	const resolved = inputTokenLimit === undefined
		? preliminary
		: await resolveConfig({
			...options,
			defaultMaxPromptTokens: Math.min(
				options.defaultMaxPromptTokens ?? inputTokenLimit,
				inputTokenLimit,
			),
			maxPromptTokensCeiling: Math.min(
				options.maxPromptTokensCeiling ?? inputTokenLimit,
				inputTokenLimit,
			),
		});

	return Object.freeze({
		...resolved,
		...(entry.contextWindowTokens === undefined
			? {}
			: { modelContextWindowTokens: entry.contextWindowTokens }),
		...(entry.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: entry.maxOutputTokens }),
		...(entry.store === undefined ? {} : { store: entry.store }),
		...(entry.supportsHostedWebSearch === undefined
			? {}
			: { webSearchMode: entry.supportsHostedWebSearch ? "live" : "disabled" }),
	});
}
