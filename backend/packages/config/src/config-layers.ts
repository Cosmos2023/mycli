export const CONFIG_LAYER_STACK_VERSION = 1 as const;

export type ConfigLayerId =
	| "session"
	| "environment"
	| "project"
	| "user"
	| "legacy_user";

export type ConfigLayerScope =
	| "session"
	| "environment"
	| "project"
	| "user";

export type ConfigLayerDisabledReason = "workspace_not_trusted";

export interface ConfigLayerMetadata {
	readonly id: ConfigLayerId;
	readonly scope: ConfigLayerScope;
	readonly source: string;
	readonly version: typeof CONFIG_LAYER_STACK_VERSION;
	readonly enabled: boolean;
	readonly disabledReason?: ConfigLayerDisabledReason;
}

export interface ConfigLayer {
	readonly metadata: ConfigLayerMetadata;
	readonly keys: readonly string[];
}

export interface ConfigOrigin {
	readonly key: string;
	readonly source: ConfigLayerMetadata;
	readonly overridden: readonly ConfigLayerMetadata[];
}

export interface ConfigLayerStack {
	readonly version: typeof CONFIG_LAYER_STACK_VERSION;
	readonly layers: readonly ConfigLayer[];
	readonly origins: Readonly<Record<string, ConfigOrigin>>;
}

export interface ConfigLayerInput {
	readonly metadata: ConfigLayerMetadata;
	readonly values: Readonly<Record<string, unknown>>;
}

export interface ConfigLayerResolution {
	readonly stack: ConfigLayerStack;
	readonly effectiveValues: Readonly<Record<string, unknown>>;
}

export function resolveConfigLayers(
	inputs: readonly ConfigLayerInput[],
): ConfigLayerResolution {
	const normalized = inputs.map((input) => Object.freeze({
		metadata: Object.freeze({ ...input.metadata }),
		values: Object.freeze({ ...input.values }),
	}));
	const keys = new Set(normalized.flatMap((input) => Object.keys(input.values)));
	const effectiveValues: Record<string, unknown> = {};
	const origins: Record<string, ConfigOrigin> = {};

	for (const key of [...keys].sort(compareText)) {
		const candidates = normalized.filter((input) => (
			input.metadata.enabled && Object.hasOwn(input.values, key)
		));
		const winner = candidates[0];
		if (!winner) continue;
		effectiveValues[key] = winner.values[key];
		origins[key] = Object.freeze({
			key,
			source: winner.metadata,
			overridden: Object.freeze(candidates.slice(1).map((input) => input.metadata)),
		});
	}

	const layers = Object.freeze(normalized.map((input) => Object.freeze({
		metadata: input.metadata,
		keys: Object.freeze(Object.keys(input.values).sort(compareText)),
	})));
	return Object.freeze({
		stack: Object.freeze({
			version: CONFIG_LAYER_STACK_VERSION,
			layers,
			origins: Object.freeze(origins),
		}),
		effectiveValues: Object.freeze(effectiveValues),
	});
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
