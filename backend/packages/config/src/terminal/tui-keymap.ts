import {
	normalizeTuiKeySpec,
	TUI_KEYMAP_ACTIONS,
	tuiKeymapConfigPath,
	type TuiKeymapActionDescriptor,
	type TuiKeymapActionId,
} from "@mycli/contracts";
import type { ConfigLayerId, ConfigLayerInput } from "../configuration/config-layers.ts";
import { configError } from "../configuration/config-diagnostics.ts";

export type TuiKeymapSource = ConfigLayerId | "default";

export interface LoadedTuiKeymap {
	readonly bindings: Readonly<Record<TuiKeymapActionId, readonly string[]>>;
	readonly sources: Readonly<Record<TuiKeymapActionId, TuiKeymapSource>>;
	readonly overridden: Readonly<Record<TuiKeymapActionId, readonly ConfigLayerId[]>>;
}

export function resolveTuiKeymapFromLayers(
	layers: readonly ConfigLayerInput[],
): LoadedTuiKeymap {
	const bindings = {} as Record<TuiKeymapActionId, readonly string[]>;
	const sources = {} as Record<TuiKeymapActionId, TuiKeymapSource>;
	const overridden = {} as Record<TuiKeymapActionId, readonly ConfigLayerId[]>;

	for (const action of TUI_KEYMAP_ACTIONS) {
		const candidates = layers.flatMap((layer) => {
			if (!layer.metadata.enabled) return [];
			const value = keymapLayerValue(layer.values, action);
			return value === undefined ? [] : [{ layer: layer.metadata.id, value }];
		});
		const winner = candidates[0];
		bindings[action.id] = winner
			? parseKeyList(action, winner.value, winner.layer)
			: Object.freeze([...action.defaultKeys]);
		sources[action.id] = winner?.layer ?? "default";
		overridden[action.id] = Object.freeze(candidates.slice(1).map((entry) => entry.layer));
	}

	validateEffectiveKeymap(bindings, sources);
	return Object.freeze({
		bindings: Object.freeze(bindings),
		sources: Object.freeze(sources),
		overridden: Object.freeze(overridden),
	});
}

function keymapLayerValue(
	values: Readonly<Record<string, unknown>>,
	action: TuiKeymapActionDescriptor,
): unknown {
	const flattened = tuiKeymapConfigPath(action);
	if (Object.hasOwn(values, flattened)) return values[flattened];
	return valueAtPath(values, ["tui", "keymap", action.context, action.configKey]);
}

function parseKeyList(
	action: TuiKeymapActionDescriptor,
	value: unknown,
	layer: ConfigLayerId,
): readonly string[] {
	const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
	if (!values || values.length > 8 || values.some((key) => typeof key !== "string")) {
		throw invalidKeymapValue(action, layer);
	}
	const normalized: string[] = [];
	for (const raw of values) {
		const key = normalizeTuiKeySpec(raw as string);
		if (!key) throw invalidKeymapValue(action, layer);
		if (!normalized.includes(key)) normalized.push(key);
	}
	if (action.required && normalized.length === 0) {
		throw configError({
			code: "invalid_value",
			severity: "error",
			layer,
			keyPath: tuiKeymapConfigPath(action),
			message: "required keymap action cannot be unbound",
			remediation: `Assign at least one supported key to '${action.id}'.`,
		});
	}
	return Object.freeze(normalized);
}

function validateEffectiveKeymap(
	bindings: Readonly<Record<TuiKeymapActionId, readonly string[]>>,
	sources: Readonly<Record<TuiKeymapActionId, TuiKeymapSource>>,
): void {
	const claims = new Map<string, TuiKeymapActionDescriptor[]>();
	for (const action of TUI_KEYMAP_ACTIONS) {
		for (const key of bindings[action.id]) {
			const claim = `${action.context}\0${key}`;
			const actions = claims.get(claim) ?? [];
			actions.push(action);
			claims.set(claim, actions);
		}
	}
	for (const actions of claims.values()) {
		if (actions.length < 2) continue;
		const source = actions.map((action) => sources[action.id as TuiKeymapActionId]).find(
			(candidate): candidate is ConfigLayerId => candidate !== "default",
		);
		const primary = actions[0]!;
		throw configError({
			code: "invalid_value",
			severity: "error",
			...(source ? { layer: source } : {}),
			keyPath: tuiKeymapConfigPath(primary),
			message: "keymap contains conflicting bindings in one context",
			remediation: `Assign distinct keys to ${actions.map((action) => `'${action.id}'`).join(" and ")}.`,
		});
	}
}

function invalidKeymapValue(
	action: TuiKeymapActionDescriptor,
	layer: ConfigLayerId,
): Error {
	return configError({
		code: "invalid_value",
		severity: "error",
		layer,
		keyPath: tuiKeymapConfigPath(action),
		message: "keymap action has an invalid key list",
		remediation: "Use one supported key string or an array containing at most eight key strings.",
	});
}

function valueAtPath(
	value: Readonly<Record<string, unknown>>,
	path: readonly string[],
): unknown {
	let current: unknown = value;
	for (const segment of path) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
