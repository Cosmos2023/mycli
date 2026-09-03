import {
	BUILTIN_MODEL_CATALOG,
	listProviderProfiles,
	loadModelProviderDeclarations,
	modelInputTokenLimit,
	modelCatalogEntryPayload,
	type ModelCatalogEntry,
	type ModelCatalogModelDeclaration,
	type ModelProviderDeclaration,
	type NodeRuntimeConfig,
	type ProviderProfile,
} from "@mycli/config";
import {
	isProviderId,
	type ProtocolId,
	type ProviderRouteId,
} from "@mycli/core";
import {
	loadPiAiProviderDirectory,
	validatePiAiCompatOverride,
	type ProviderDirectoryEntry,
	type ProviderDirectorySnapshot,
	type ProviderModelDirectoryEntry,
	type ProviderRouteDescriptor,
} from "@mycli/providers";

export type ProviderModelOrigin =
	| "current_custom"
	| "pi_ai_catalog"
	| "stable_fallback"
	| "user";

export interface ProviderScopedModelEntry extends ModelCatalogEntry {
	readonly origin: ProviderModelOrigin;
}

export type ProviderModelCurrentConfig = Pick<
	NodeRuntimeConfig,
	| "apiBaseUrl"
	| "authRef"
	| "maxOutputTokens"
	| "model"
	| "modelContextWindowTokens"
	| "protocol"
	| "provider"
	| "reasoningEffort"
	| "supportsImages"
	| "thinkingEnabled"
	| "webSearchMode"
>;

export interface ProviderModelDirectorySnapshot {
	readonly version: number;
	readonly catalog: ProviderDirectorySnapshot;
	readonly routes: readonly ProviderRouteDescriptor[];
	route(routeId: ProviderRouteId): ProviderRouteDescriptor | undefined;
	models(routeId: ProviderRouteId): readonly ProviderScopedModelEntry[];
}

export interface ProviderModelDirectoryOptions {
	readonly homeDir: string;
	readonly loadDeclarations?: (
		homeDir: string,
	) => Promise<readonly ModelProviderDeclaration[]>;
	readonly loadCatalog?: () => Promise<ProviderDirectorySnapshot>;
}

export interface AssembleProviderModelDirectoryInput {
	readonly version: number;
	readonly currentConfig: ProviderModelCurrentConfig;
	readonly profiles: readonly ProviderProfile[];
	readonly declarations: readonly ModelProviderDeclaration[];
	readonly catalog: ProviderDirectorySnapshot;
	readonly stableFallbackModels: readonly ModelCatalogEntry[];
}

export class ProviderModelDirectoryError extends Error {
	readonly code = "provider_model_directory_error";

	constructor(message: string) {
		super(message);
		this.name = "ProviderModelDirectoryError";
	}
}

export class ProviderModelDirectory {
	readonly #homeDir: string;
	readonly #loadDeclarations: NonNullable<ProviderModelDirectoryOptions["loadDeclarations"]>;
	readonly #loadCatalog: NonNullable<ProviderModelDirectoryOptions["loadCatalog"]>;
	#version = 0;
	#current: ProviderModelDirectorySnapshot | undefined;
	#loadQueue: Promise<void> = Promise.resolve();

	constructor(options: ProviderModelDirectoryOptions) {
		this.#homeDir = options.homeDir;
		this.#loadDeclarations = options.loadDeclarations ?? loadModelProviderDeclarations;
		this.#loadCatalog = options.loadCatalog ?? loadPiAiProviderDirectory;
	}

	current(): ProviderModelDirectorySnapshot | undefined {
		return this.#current;
	}

	load(currentConfig: ProviderModelCurrentConfig): Promise<ProviderModelDirectorySnapshot> {
		const operation = this.#loadQueue.then(async () => {
			const [declarations, catalog] = await Promise.all([
				this.#loadDeclarations(this.#homeDir),
				this.#loadCatalog(),
			]);
			const candidate = assembleProviderModelDirectory({
				version: this.#version + 1,
				currentConfig,
				profiles: listProviderProfiles(),
				declarations,
				catalog,
				stableFallbackModels: BUILTIN_MODEL_CATALOG,
			});
			this.#version = candidate.version;
			this.#current = candidate;
			return candidate;
		});
		this.#loadQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}
}

export function assembleProviderModelDirectory(
	input: AssembleProviderModelDirectoryInput,
): ProviderModelDirectorySnapshot {
	const catalogById = new Map(input.catalog.providers.map((provider) => [
		provider.catalogProviderId,
		provider,
	]));
	if (catalogById.size !== input.catalog.providers.length) {
		throw directoryError("The pi-ai provider catalog contains duplicate routes.");
	}
	const declarationsByRoute = new Map<ProviderRouteId, ModelProviderDeclaration>(input.declarations.map((declaration) => [
		declaration.provider,
		declaration,
	]));
	if (declarationsByRoute.size !== input.declarations.length) {
		throw directoryError("The configured provider routes are not unique.");
	}
	const profilesByRoute = new Map<ProviderRouteId, ProviderProfile>(input.profiles.map((profile) => [
		profile.provider,
		profile,
	]));
	const routeIds: ProviderRouteId[] = [
		...input.profiles.map((profile) => profile.provider),
		...input.declarations
			.map((declaration) => declaration.provider)
			.filter((routeId) => !profilesByRoute.has(routeId)),
	];
	if (!routeIds.includes(input.currentConfig.provider)) routeIds.push(input.currentConfig.provider);

	const routes: ProviderRouteDescriptor[] = [];
	const modelsByRoute = new Map<ProviderRouteId, readonly ProviderScopedModelEntry[]>();
	for (const routeId of routeIds) {
		const profile = profilesByRoute.get(routeId);
		const declaration = declarationsByRoute.get(routeId);
		const descriptor = assembleRouteDescriptor({
			routeId,
			profile,
			declaration,
			catalogById,
			currentConfig: input.currentConfig,
			version: input.version,
			stableFallbackModels: input.stableFallbackModels,
		});
		const catalogProvider = descriptor.catalogProviderId === undefined
			? undefined
			: catalogById.get(descriptor.catalogProviderId);
		const declarationForProtocol = declaration?.protocol === descriptor.protocol
			? declaration
			: undefined;
		const models = assembleRouteModels({
			descriptor,
			profile,
			declaration: declarationForProtocol,
			catalogProvider,
			currentConfig: input.currentConfig,
			stableFallbackModels: input.stableFallbackModels,
		});
		routes.push(descriptor);
		modelsByRoute.set(routeId, models);
	}

	const frozenRoutes = Object.freeze(routes);
	return Object.freeze({
		version: input.version,
		catalog: input.catalog,
		routes: frozenRoutes,
		route: (routeId: ProviderRouteId) => frozenRoutes.find((route) => route.routeId === routeId),
		models: (routeId: ProviderRouteId) => modelsByRoute.get(routeId) ?? Object.freeze([]),
	});
}

export function findProviderScopedModelEntry(
	snapshot: ProviderModelDirectorySnapshot,
	selection: {
		readonly provider: ProviderRouteId;
		readonly protocol: ProtocolId;
		readonly model: string;
		readonly baseUrl: string;
	},
): ProviderScopedModelEntry | undefined {
	return snapshot.models(selection.provider).find((entry) =>
		entry.protocol === selection.protocol
		&& entry.model === selection.model
		&& normalizedBaseUrl(entry.baseUrl) === normalizedBaseUrl(selection.baseUrl));
}

export function providerScopedModelPayload(
	entry: ProviderScopedModelEntry,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		...modelCatalogEntryPayload(entry),
		origin: entry.origin,
	});
}

export function applyProviderScopedModelConfig(
	config: NodeRuntimeConfig,
	entry: ProviderScopedModelEntry,
): NodeRuntimeConfig {
	const inputTokenLimit = modelInputTokenLimit(entry);
	return Object.freeze({
		...config,
		provider: entry.provider,
		protocol: entry.protocol,
		model: entry.model,
		apiBaseUrl: entry.baseUrl,
		authRef: entry.authRef,
		...(inputTokenLimit === undefined
			? {}
			: { maxPromptTokens: Math.min(config.maxPromptTokens, inputTokenLimit) }),
		...(entry.contextWindowTokens === undefined
			? {}
			: { modelContextWindowTokens: entry.contextWindowTokens }),
		...(entry.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: entry.maxOutputTokens }),
		...(entry.supportsImages === undefined
			? {}
			: { supportsImages: entry.supportsImages }),
		webSearchMode: entry.supportsHostedWebSearch === true ? "live" : "disabled",
	});
}

function assembleRouteDescriptor(input: {
	readonly routeId: ProviderRouteId;
	readonly profile?: ProviderProfile;
	readonly declaration?: ModelProviderDeclaration;
	readonly catalogById: ReadonlyMap<ProviderRouteId, ProviderDirectoryEntry>;
	readonly currentConfig: ProviderModelCurrentConfig;
	readonly version: number;
	readonly stableFallbackModels: readonly ModelCatalogEntry[];
}): ProviderRouteDescriptor {
	const isCurrentRoute = input.currentConfig.provider === input.routeId;
	const protocol = isCurrentRoute
		? input.currentConfig.protocol
		: input.declaration?.protocol ?? input.profile?.defaultProtocol;
	if (protocol === undefined) throw directoryError("A configured provider route has no protocol.");
	const catalogProviderId = input.declaration?.catalogProvider ?? input.routeId;
	const catalogProvider = input.catalogById.get(catalogProviderId);
	const catalogModels = catalogProvider?.models.filter((model) => model.protocol === protocol) ?? [];
	const source = routeSource({
		routeId: input.routeId,
		profile: input.profile,
		declaration: input.declaration,
		catalogProvider,
		catalogModelCount: catalogModels.length,
	});
	const apiBaseUrl = routeBaseUrl({
		isCurrentRoute,
		currentConfig: input.currentConfig,
		declaration: input.declaration,
		profile: input.profile,
		catalogProvider,
		catalogModels,
	});
	const declaredModels = input.declaration?.protocol === protocol
		? input.declaration.models
		: undefined;
	const fallbackModelIds = stableFallbackModelIds(
		input.routeId,
		protocol,
		input.profile,
		input.stableFallbackModels,
	);
	if (source === "pi_ai_builtin"
		&& input.declaration?.modelPolicy === "subset"
		&& (declaredModels === undefined || declaredModels.length === 0)) {
		throw directoryError("A catalog subset requires at least one declared model.");
	}
	const modelPolicy = source === "pi_ai_builtin"
		? input.declaration?.modelPolicy === "subset"
			? Object.freeze({
				kind: "subset" as const,
				modelIds: Object.freeze(declaredModels?.map((model) => model.model) ?? []),
			})
			: Object.freeze({ kind: "catalog" as const })
		: Object.freeze({
			kind: "declared" as const,
			modelIds: Object.freeze(declaredModels?.map((model) => model.model) ?? fallbackModelIds),
		});
	const compat = validatedCompat(protocol, input.declaration?.compat);
	const modelCompatEntries = (declaredModels ?? []).flatMap((model) => {
		const override = validatedCompat(protocol, model.compat);
		return override === undefined ? [] : [[model.model, override] as const];
	});
	const modelCompat = modelCompatEntries.length === 0
		? undefined
		: Object.freeze(Object.fromEntries(modelCompatEntries));
	return Object.freeze({
		routeId: input.routeId,
		displayName: catalogProvider?.name ?? input.profile?.displayName ?? input.routeId,
		supportTier: input.routeId === "compatible"
			? "compatible"
			: isProviderId(input.routeId) ? "stable" : source === "pi_ai_builtin" ? "experimental" : "compatible",
		source,
		...(source === "pi_ai_builtin" ? { catalogProviderId } : {}),
		protocol,
		apiBaseUrl,
		authRef: isCurrentRoute
			? input.currentConfig.authRef
			: input.declaration?.authRef ?? input.routeId,
		activation: "active",
		modelPolicy,
		...(compat === undefined ? {} : { compat }),
		...(modelCompat === undefined ? {} : { modelCompat }),
		snapshotVersion: input.version,
	});
}

function routeSource(input: {
	readonly routeId: ProviderRouteId;
	readonly profile?: ProviderProfile;
	readonly declaration?: ModelProviderDeclaration;
	readonly catalogProvider?: ProviderDirectoryEntry;
	readonly catalogModelCount: number;
}): ProviderRouteDescriptor["source"] {
	if (input.declaration?.source === "pi_ai_declared") {
		if (input.declaration.modelPolicy !== undefined) {
			throw directoryError("A declared provider route cannot use a catalog model policy.");
		}
		return "pi_ai_declared";
	}
	const catalogBacked = input.catalogProvider?.apiKeyServiceable === true
		&& input.catalogModelCount > 0;
	if (catalogBacked) return "pi_ai_builtin";
	const explicitlyCatalogBacked = input.declaration?.source === "pi_ai_builtin"
		|| input.declaration?.catalogProvider !== undefined
		|| input.declaration?.modelPolicy !== undefined
		|| (!isProviderId(input.routeId) && input.catalogProvider !== undefined);
	if (explicitlyCatalogBacked) {
		throw directoryError("A configured pi-ai route is not serviceable for its selected protocol.");
	}
	if (input.profile !== undefined) return "pi_ai_declared";
	return "pi_ai_declared";
}

function routeBaseUrl(input: {
	readonly isCurrentRoute: boolean;
	readonly currentConfig: ProviderModelCurrentConfig;
	readonly declaration?: ModelProviderDeclaration;
	readonly profile?: ProviderProfile;
	readonly catalogProvider?: ProviderDirectoryEntry;
	readonly catalogModels: readonly ProviderModelDirectoryEntry[];
}): string {
	if (input.isCurrentRoute) return normalizedBaseUrl(input.currentConfig.apiBaseUrl);
	const explicit = input.declaration?.baseUrl
		?? input.catalogProvider?.baseUrl
		?? commonModelBaseUrl(input.catalogModels)
		?? input.profile?.defaultBaseUrl;
	if (explicit === undefined) {
		throw directoryError("A configured provider route requires an explicit base URL.");
	}
	return normalizedBaseUrl(explicit);
}

function commonModelBaseUrl(models: readonly ProviderModelDirectoryEntry[]): string | undefined {
	const baseUrls = [...new Set(models.flatMap((model) => model.baseUrl ? [normalizedBaseUrl(model.baseUrl)] : []))];
	return baseUrls.length === 1 ? baseUrls[0] : undefined;
}

function assembleRouteModels(input: {
	readonly descriptor: ProviderRouteDescriptor;
	readonly profile?: ProviderProfile;
	readonly declaration?: ModelProviderDeclaration;
	readonly catalogProvider?: ProviderDirectoryEntry;
	readonly currentConfig: ProviderModelCurrentConfig;
	readonly stableFallbackModels: readonly ModelCatalogEntry[];
}): readonly ProviderScopedModelEntry[] {
	const models = input.descriptor.source === "pi_ai_builtin"
		? catalogRouteModels(input)
		: declaredRouteModels(input);
	const identities = new Set<string>();
	for (const model of models) {
		if (identities.has(model.model)) {
			throw directoryError("A provider route contains duplicate model ids.");
		}
		identities.add(model.model);
	}
	const current = currentModelEntry(input.descriptor, input.currentConfig, input.profile);
	if (current === undefined) return Object.freeze(models);
	const currentIndex = models.findIndex((model) => sameModelIdentity(model, current));
	if (currentIndex < 0) return Object.freeze([current, ...models]);
	const selected = Object.freeze({ ...models[currentIndex]!, isCurrent: true });
	return Object.freeze([
		selected,
		...models
			.filter((_, index) => index !== currentIndex)
			.map((model) => Object.freeze({ ...model, isCurrent: false })),
	]);
}

function catalogRouteModels(input: {
	readonly descriptor: ProviderRouteDescriptor;
	readonly profile?: ProviderProfile;
	readonly declaration?: ModelProviderDeclaration;
	readonly catalogProvider?: ProviderDirectoryEntry;
	readonly currentConfig: ProviderModelCurrentConfig;
	readonly stableFallbackModels: readonly ModelCatalogEntry[];
}): readonly ProviderScopedModelEntry[] {
	if (input.catalogProvider === undefined) {
		throw directoryError("A catalog-backed route has no pi-ai provider metadata.");
	}
	const catalogModels = input.catalogProvider.models.filter((model) =>
		model.protocol === input.descriptor.protocol);
	const declaredModels = input.declaration?.models ?? [];
	if (declaredModels.length === 0) {
		return catalogModels.map((model) => catalogModelEntry(model, input.descriptor, input.profile));
	}
	const declaredDescriptor = declarationModelDescriptor(input.descriptor, input.declaration);
	const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
	const fallbackById = new Map(input.stableFallbackModels
		.filter((model) => model.provider === input.descriptor.routeId
			&& model.protocol === input.descriptor.protocol)
		.map((model) => [model.model, stableFallbackEntry(model, declaredDescriptor)]));
	const current = currentModelEntry(input.descriptor, input.currentConfig, input.profile);
	const resolveDeclaration = (
		declaration: ModelCatalogModelDeclaration,
	): ProviderScopedModelEntry => {
		const catalogModel = catalogById.get(declaration.model);
		if (catalogModel !== undefined) {
			return mergeModelDeclaration(
				catalogModelEntry(catalogModel, declaredDescriptor, input.profile),
				declaration,
			);
		}
		const fallback = fallbackById.get(declaration.model);
		if (fallback !== undefined) return mergeModelDeclaration(fallback, declaration);
		if (current !== undefined && declaration.model === current.model) {
			return Object.freeze({
				...mergeModelDeclaration(current, declaration),
				origin: "current_custom" as const,
			});
		}
		assertCompleteUncataloguedModel(declaration);
		return declaredModelEntry(declaration, declaredDescriptor, input.profile);
	};
	if (input.descriptor.modelPolicy.kind === "subset") {
		return declaredModels.map(resolveDeclaration);
	}
	const declarationsById = new Map(declaredModels.map((declaration) => [declaration.model, declaration]));
	return [
		...catalogModels.map((model) => {
			const declaration = declarationsById.get(model.id);
			return declaration === undefined
				? catalogModelEntry(model, declaredDescriptor, input.profile)
				: resolveDeclaration(declaration);
		}),
		...declaredModels
			.filter((declaration) => !catalogById.has(declaration.model))
			.map(resolveDeclaration),
	];
}

function declaredRouteModels(input: {
	readonly descriptor: ProviderRouteDescriptor;
	readonly profile?: ProviderProfile;
	readonly declaration?: ModelProviderDeclaration;
	readonly stableFallbackModels: readonly ModelCatalogEntry[];
}): readonly ProviderScopedModelEntry[] {
	const declaredDescriptor = declarationModelDescriptor(input.descriptor, input.declaration);
	const fallback = input.stableFallbackModels
		.filter((model) => model.provider === input.descriptor.routeId
			&& model.protocol === input.descriptor.protocol)
		.map((model) => stableFallbackEntry(model, declaredDescriptor));
	const fallbackById = new Map(fallback.map((model) => [model.model, model]));
	if (input.declaration?.models !== undefined) {
		return input.declaration.models.map((declaration) => {
			const base = fallbackById.get(declaration.model);
			return base === undefined
				? declaredModelEntry(declaration, declaredDescriptor, input.profile)
				: mergeModelDeclaration(base, declaration);
		});
	}
	if (fallback.length > 0) return fallback;
	const defaultModel = input.profile?.defaultModel;
	return defaultModel === undefined
		? []
		: [declaredModelEntry({ model: defaultModel }, input.descriptor, input.profile, "stable_fallback")];
}

function declarationModelDescriptor(
	descriptor: ProviderRouteDescriptor,
	declaration: ModelProviderDeclaration | undefined,
): ProviderRouteDescriptor {
	if (declaration === undefined) return descriptor;
	return Object.freeze({
		...descriptor,
		...(declaration.baseUrl === undefined
			? {}
			: { apiBaseUrl: normalizedBaseUrl(declaration.baseUrl) }),
		authRef: declaration.authRef,
	});
}

function catalogModelEntry(
	model: ProviderModelDirectoryEntry,
	descriptor: ProviderRouteDescriptor,
	profile?: ProviderProfile,
): ProviderScopedModelEntry {
	return Object.freeze({
		provider: descriptor.routeId,
		protocol: descriptor.protocol,
		model: model.id,
		displayName: model.name,
		description: "",
		baseUrl: descriptor.apiBaseUrl,
		authRef: descriptor.authRef,
		supportedReasoningEfforts: Object.freeze([...model.reasoningEfforts]),
		contextWindowTokens: model.contextWindowTokens,
		maxOutputTokens: model.maxOutputTokens,
		supportsImages: model.input.includes("image"),
		...(supportsStableHostedSearch(descriptor)
			? { supportsHostedWebSearch: true }
			: {}),
		isDefault: profile?.defaultModel === model.id,
		isCurrent: false,
		origin: "pi_ai_catalog",
	});
}

function stableFallbackEntry(
	model: ModelCatalogEntry,
	descriptor: ProviderRouteDescriptor,
): ProviderScopedModelEntry {
	return Object.freeze({
		...model,
		provider: descriptor.routeId,
		protocol: descriptor.protocol,
		baseUrl: descriptor.apiBaseUrl,
		authRef: descriptor.authRef,
		supportedReasoningEfforts: Object.freeze([...model.supportedReasoningEfforts]),
		isCurrent: false,
		origin: "stable_fallback",
	});
}

function declaredModelEntry(
	declaration: ModelCatalogModelDeclaration,
	descriptor: ProviderRouteDescriptor,
	profile?: ProviderProfile,
	origin: ProviderModelOrigin = "user",
): ProviderScopedModelEntry {
	return Object.freeze({
		provider: descriptor.routeId,
		protocol: descriptor.protocol,
		model: declaration.model,
		displayName: declaration.displayName ?? declaration.model,
		description: declaration.description ?? "",
		baseUrl: descriptor.apiBaseUrl,
		authRef: descriptor.authRef,
		supportedReasoningEfforts: Object.freeze([...(declaration.supportedReasoningEfforts ?? [])]),
		...(declaration.defaultReasoningEffort === undefined
			? {}
			: { defaultReasoningEffort: declaration.defaultReasoningEffort }),
		...(declaration.contextWindowTokens === undefined
			? {}
			: { contextWindowTokens: declaration.contextWindowTokens }),
		...(declaration.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: declaration.maxOutputTokens }),
		...(declaration.supportsImages === undefined
			? {}
			: { supportsImages: declaration.supportsImages }),
		...(declaration.supportsHostedWebSearch === undefined
			? {}
			: { supportsHostedWebSearch: declaration.supportsHostedWebSearch }),
		isDefault: profile?.defaultModel === declaration.model,
		isCurrent: false,
		origin,
	});
}

function mergeModelDeclaration(
	base: ProviderScopedModelEntry,
	override: ModelCatalogModelDeclaration,
): ProviderScopedModelEntry {
	const replacesReasoning = override.supportedReasoningEfforts !== undefined;
	return Object.freeze({
		...base,
		displayName: override.displayName ?? base.displayName,
		description: override.description ?? base.description,
		supportedReasoningEfforts: replacesReasoning
			? Object.freeze([...override.supportedReasoningEfforts])
			: base.supportedReasoningEfforts,
		...(replacesReasoning
			? override.defaultReasoningEffort === undefined
				? { defaultReasoningEffort: undefined }
				: { defaultReasoningEffort: override.defaultReasoningEffort }
			: {}),
		...(override.contextWindowTokens === undefined
			? {}
			: { contextWindowTokens: override.contextWindowTokens }),
		...(override.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: override.maxOutputTokens }),
		...(override.supportsImages === undefined
			? {}
			: { supportsImages: override.supportsImages }),
		...(override.supportsHostedWebSearch === undefined
			? {}
			: { supportsHostedWebSearch: override.supportsHostedWebSearch }),
		origin: "user",
	});
}

function currentModelEntry(
	descriptor: ProviderRouteDescriptor,
	currentConfig: ProviderModelCurrentConfig,
	profile?: ProviderProfile,
): ProviderScopedModelEntry | undefined {
	if (descriptor.routeId !== currentConfig.provider || descriptor.protocol !== currentConfig.protocol) {
		return undefined;
	}
	const efforts = currentConfig.thinkingEnabled
		? Object.freeze([currentConfig.reasoningEffort])
		: Object.freeze([]);
	return Object.freeze({
		provider: descriptor.routeId,
		protocol: descriptor.protocol,
		model: currentConfig.model,
		displayName: currentConfig.model,
		description: "Current configured model",
		baseUrl: normalizedBaseUrl(currentConfig.apiBaseUrl),
		authRef: currentConfig.authRef,
		supportedReasoningEfforts: efforts,
		...(currentConfig.thinkingEnabled
			? { defaultReasoningEffort: currentConfig.reasoningEffort }
			: {}),
		...(currentConfig.modelContextWindowTokens === undefined
			? {}
			: { contextWindowTokens: currentConfig.modelContextWindowTokens }),
		...(currentConfig.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: currentConfig.maxOutputTokens }),
		supportsImages: currentConfig.supportsImages,
		supportsHostedWebSearch: currentConfig.webSearchMode === "live",
		isDefault: profile?.defaultModel === currentConfig.model,
		isCurrent: true,
		origin: "current_custom",
	});
}

function stableFallbackModelIds(
	routeId: ProviderRouteId,
	protocol: ProtocolId,
	profile: ProviderProfile | undefined,
	models: readonly ModelCatalogEntry[],
): readonly string[] {
	const ids = models
		.filter((model) => model.provider === routeId && model.protocol === protocol)
		.map((model) => model.model);
	if (ids.length === 0 && profile?.defaultModel !== undefined) ids.push(profile.defaultModel);
	return Object.freeze(ids);
}

function assertCompleteUncataloguedModel(model: ModelCatalogModelDeclaration): void {
	if (model.contextWindowTokens === undefined
		|| model.maxOutputTokens === undefined
		|| model.supportsImages === undefined) {
		throw directoryError("An uncatalogued model declaration is incomplete.");
	}
}

function sameModelIdentity(
	left: Pick<ModelCatalogEntry, "provider" | "protocol" | "model" | "baseUrl">,
	right: Pick<ModelCatalogEntry, "provider" | "protocol" | "model" | "baseUrl">,
): boolean {
	return left.provider === right.provider
		&& left.protocol === right.protocol
		&& left.model === right.model
		&& normalizedBaseUrl(left.baseUrl) === normalizedBaseUrl(right.baseUrl);
}

function normalizedBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/u, "");
}

function validatedCompat(
	protocol: ProtocolId,
	value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
	try {
		return validatePiAiCompatOverride(protocol, value);
	} catch (error) {
		throw directoryError(error instanceof Error ? error.message : "A provider compat override is invalid.");
	}
}

function supportsStableHostedSearch(descriptor: ProviderRouteDescriptor): boolean {
	return descriptor.protocol === "responses"
		&& (descriptor.routeId === "openai" || descriptor.routeId === "codex");
}

function directoryError(message: string): ProviderModelDirectoryError {
	return new ProviderModelDirectoryError(message);
}
