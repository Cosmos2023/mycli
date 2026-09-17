import { TUI_KEYMAP_ACTIONS, normalizeTuiKeySpec } from "@mycli/contracts";
import type {
	MycliShellEffectiveKeymap,
	MycliShellSettingsCatalog,
	MycliShellSettingsCategory,
	MycliShellSettingsCategoryId,
	MycliShellSettingsItem,
	MycliShellSettingsSnapshot,
	MycliShellTerminalCapabilities,
	MycliShellVisualSettings,
} from "../model.ts";
import {
	booleanValue,
	boundedCatalogText,
	recordValue,
	slashCatalogText,
	stringArray,
	stringValue,
} from "./payload-values.ts";
import { defaultVisualSettings, type RuntimeShellState } from "./runtime-state-model.ts";

export function runtimeStateWithSettings(state: RuntimeShellState, settings: MycliShellVisualSettings): RuntimeShellState {
	const nextSettings = normalizeVisualSettings(settings, state.settings);
	return {
		...state,
		settings: nextSettings,
		viewMode: nextSettings.viewMode ?? state.viewMode,
		statusbarMode: nextSettings.statusbarMode ?? state.statusbarMode,
	};
}

export function runtimeStateWithSettingsSnapshot(
	state: RuntimeShellState,
	snapshot: MycliShellSettingsSnapshot,
): RuntimeShellState {
	return {
		...runtimeStateWithSettings(state, snapshot.settings),
		settingsCatalog: snapshot.catalog ?? state.settingsCatalog,
		keymap: snapshot.keymap ?? state.keymap,
		terminalCapabilities: snapshot.terminalCapabilities ?? state.terminalCapabilities,
	};
}

export function settingsFromResult(payload: Record<string, unknown>): MycliShellVisualSettings {
	const settings = recordValue(payload.settings);
	return normalizeVisualSettings(Object.keys(settings).length > 0 ? settings : payload);
}

export function settingsSnapshotFromResult(payload: Record<string, unknown>): MycliShellSettingsSnapshot {
	const catalog = settingsCatalogFromUnknown(payload.catalog);
	const keymap = effectiveKeymapFromUnknown(payload.keymap);
	const terminalCapabilities = terminalCapabilitiesFromUnknown(payload.terminal_capabilities);
	return {
		settings: settingsFromResult(payload),
		...(catalog ? { catalog } : {}),
		...(keymap ? { keymap } : {}),
		...(terminalCapabilities ? { terminalCapabilities } : {}),
	};
}

function effectiveKeymapFromUnknown(value: unknown): MycliShellEffectiveKeymap | null {
	const keymap = recordValue(value);
	if (keymap.version !== 1) return null;
	const rawBindings = recordValue(keymap.bindings);
	const rawSources = recordValue(keymap.sources);
	const rawOverridden = recordValue(keymap.overridden);
	const bindings = {} as MycliShellEffectiveKeymap["bindings"];
	const sources = {} as MycliShellEffectiveKeymap["sources"];
	const overridden = {} as MycliShellEffectiveKeymap["overridden"];
	for (const action of TUI_KEYMAP_ACTIONS) {
		const rawKeys = rawBindings[action.id];
		if (!Array.isArray(rawKeys) || rawKeys.length > 8) return null;
		const normalized = rawKeys.map((key) => typeof key === "string" ? normalizeTuiKeySpec(key) : undefined);
		if (normalized.some((key) => key === undefined)) return null;
		const keys = normalized.filter((key): key is string => key !== undefined);
		if (action.required && keys.length === 0) return null;
		bindings[action.id] = [...new Set(keys)];
		sources[action.id] = boundedCatalogText(rawSources[action.id], 64) ?? "default";
		overridden[action.id] = stringArray(rawOverridden[action.id], 8, 64);
	}
	return { version: 1, bindings, sources, overridden };
}

function terminalCapabilitiesFromUnknown(value: unknown): MycliShellTerminalCapabilities | null {
	const capabilities = recordValue(value);
	const colorMode = capabilities.color_mode;
	const glyphMode = capabilities.glyph_mode;
	const terminalKind = capabilities.terminal_kind;
	if (
		capabilities.version !== 1
		|| !(colorMode === "truecolor" || colorMode === "256" || colorMode === "16" || colorMode === "none")
		|| !(glyphMode === "unicode" || glyphMode === "ascii")
		|| !(terminalKind === "dumb" || terminalKind === "standard" || terminalKind === "windows_terminal")
		|| typeof capabilities.color_forced_off !== "boolean"
		|| typeof capabilities.progress_visible !== "boolean"
		|| typeof capabilities.progress_animated !== "boolean"
		|| typeof capabilities.reduced_motion !== "boolean"
		|| typeof capabilities.high_contrast !== "boolean"
	) return null;
	return {
		version: 1,
		colorMode,
		colorForcedOff: capabilities.color_forced_off,
		glyphMode,
		terminalKind,
		progressVisible: capabilities.progress_visible,
		progressAnimated: capabilities.progress_animated,
		reducedMotion: capabilities.reduced_motion,
		highContrast: capabilities.high_contrast,
		guidance: stringArray(capabilities.guidance, 2, 256),
	};
}

function settingsCatalogFromUnknown(value: unknown): MycliShellSettingsCatalog | null {
	const catalog = recordValue(value);
	if (catalog.version !== 1 || !Array.isArray(catalog.categories) || !Array.isArray(catalog.items)) {
		return null;
	}
	const categories = catalog.categories
		.map(settingsCategoryFromUnknown)
		.filter((item): item is MycliShellSettingsCategory => item !== null);
	const categoryIds = new Set(categories.map((category) => category.id));
	const items = catalog.items
		.map((item) => settingsItemFromUnknown(item, categoryIds))
		.filter((item): item is MycliShellSettingsItem => item !== null);
	if (categories.length === 0 || categories.length !== catalog.categories.length || items.length !== catalog.items.length) {
		return null;
	}
	return { version: 1, categories, items };
}

function settingsCategoryFromUnknown(value: unknown): MycliShellSettingsCategory | null {
	const item = recordValue(value);
	const id = settingsCategoryId(item.id);
	const label = boundedCatalogText(item.label, 96);
	const description = boundedCatalogText(item.description, 256);
	return id && label && description ? { id, label, description } : null;
}

function settingsItemFromUnknown(
	value: unknown,
	categories: ReadonlySet<MycliShellSettingsCategoryId>,
): MycliShellSettingsItem | null {
	const item = recordValue(value);
	const id = boundedCatalogText(item.id, 128);
	const category = settingsCategoryId(item.category);
	const kind = item.kind;
	const label = boundedCatalogText(item.label, 96);
	const description = boundedCatalogText(item.description, 256);
	const currentValue = boundedCatalogText(item.value, 256);
	const source = boundedCatalogText(item.source, 64);
	const scope = boundedCatalogText(item.scope, 64);
	if (
		!id || !category || !categories.has(category)
		|| !(["action", "choice", "status"] as unknown[]).includes(kind)
		|| !label || !description || !currentValue || !source || !scope
		|| typeof item.locked !== "boolean" || typeof item.restart_required !== "boolean"
	) return null;
	const allowedValues = stringArray(item.allowed_values, 32, 96);
	const searchTerms = stringArray(item.search_terms, 32, 128);
	const clientKey = shellSettingClientKey(item.client_key);
	const lockReason = boundedCatalogText(item.lock_reason, 256);
	const action = boundedCatalogText(item.action, 96);
	const actionArgs = boundedCatalogText(item.action_args, 256);
	const command = slashCatalogText(item.command);
	const configKey = boundedCatalogText(item.config_key, 128);
	return {
		id,
		category,
		kind: kind as MycliShellSettingsItem["kind"],
		label,
		description,
		value: currentValue,
		source,
		scope,
		allowedValues,
		...(clientKey ? { clientKey } : {}),
		...(configKey ? { configKey } : {}),
		...(action ? { action } : {}),
		...(actionArgs ? { actionArgs } : {}),
		...(command ? { command } : {}),
		locked: item.locked,
		...(lockReason ? { lockReason } : {}),
		restartRequired: item.restart_required,
		searchTerms,
	};
}

function settingsCategoryId(value: unknown): MycliShellSettingsCategoryId | null {
	return (["appearance", "diagnostics", "integrations", "model", "permissions", "providers", "sessions"] as unknown[])
		.includes(value) ? value as MycliShellSettingsCategoryId : null;
}

function shellSettingClientKey(value: unknown): keyof MycliShellVisualSettings | null {
	return ([
		"statusbarMode", "viewMode", "theme", "hideThinking", "toolDetailsDefault",
		"hardwareCursor", "clearOnShrink", "terminalProgress", "terminalNotifications", "subagentDensity",
		"colorMode", "reducedMotion", "glyphMode", "highContrast",
	] as unknown[]).includes(value) ? value as keyof MycliShellVisualSettings : null;
}

function normalizeVisualSettings(
	settings: MycliShellVisualSettings,
	fallback: MycliShellVisualSettings = defaultVisualSettings(),
): MycliShellVisualSettings {
	const raw = settings as Record<string, unknown>;
	return {
		statusbarMode: statusbarModeValue(raw.statusbarMode ?? raw.statusbar_mode) ?? fallback.statusbarMode ?? "full",
		viewMode: viewModeValue(raw.viewMode ?? raw.view_mode) ?? fallback.viewMode ?? "default",
		theme: stringValue(raw.theme) ?? fallback.theme ?? "dark",
		hideThinking: booleanValue(raw.hideThinking ?? raw.hide_thinking) ?? fallback.hideThinking ?? true,
		toolDetailsDefault:
			toolDetailsDefaultValue(raw.toolDetailsDefault ?? raw.tool_details_default) ?? fallback.toolDetailsDefault ?? "collapsed",
		hardwareCursor: booleanValue(raw.hardwareCursor ?? raw.hardware_cursor) ?? fallback.hardwareCursor ?? false,
		clearOnShrink: booleanValue(raw.clearOnShrink ?? raw.clear_on_shrink) ?? fallback.clearOnShrink ?? true,
		terminalNotifications: booleanValue(raw.terminalNotifications ?? raw.terminal_notifications) ?? fallback.terminalNotifications ?? true,
		terminalProgress: booleanValue(raw.terminalProgress ?? raw.terminal_progress) ?? fallback.terminalProgress ?? true,
		subagentDensity: subagentDensityValue(raw.subagentDensity ?? raw.subagent_density) ?? fallback.subagentDensity ?? "normal",
		colorMode: colorModeValue(raw.colorMode ?? raw.color_mode) ?? fallback.colorMode ?? "auto",
		reducedMotion: booleanValue(raw.reducedMotion ?? raw.reduced_motion) ?? fallback.reducedMotion ?? false,
		glyphMode: glyphModeValue(raw.glyphMode ?? raw.glyph_mode) ?? fallback.glyphMode ?? "auto",
		highContrast: booleanValue(raw.highContrast ?? raw.high_contrast) ?? fallback.highContrast ?? false,
	};
}

function statusbarModeValue(value: unknown): MycliShellVisualSettings["statusbarMode"] | null {
	return value === "off" || value === "compact" || value === "full" ? value : null;
}

function viewModeValue(value: unknown): MycliShellVisualSettings["viewMode"] | null {
	return value === "default" || value === "verbose" || value === "focus" ? value : null;
}

function toolDetailsDefaultValue(value: unknown): MycliShellVisualSettings["toolDetailsDefault"] | null {
	return value === "collapsed" || value === "expanded" ? value : null;
}

function subagentDensityValue(value: unknown): MycliShellVisualSettings["subagentDensity"] | null {
	return value === "compact" || value === "normal" || value === "detailed" ? value : null;
}

function colorModeValue(value: unknown): MycliShellVisualSettings["colorMode"] | null {
	return value === "auto" || value === "truecolor" || value === "256" || value === "16" || value === "none"
		? value
		: null;
}

function glyphModeValue(value: unknown): MycliShellVisualSettings["glyphMode"] | null {
	return value === "auto" || value === "unicode" || value === "ascii" ? value : null;
}
