import type { ConfigLayerId, ConfigLayerInput } from "./config-layers.ts";
import { configError } from "./config-diagnostics.ts";
import { resolveTuiKeymapFromLayers, type LoadedTuiKeymap } from "./tui-keymap.ts";

export interface ShellSettings {
	readonly statusbar_mode: "off" | "compact" | "full";
	readonly view_mode: "default" | "verbose" | "focus";
	readonly theme: "dark" | "light";
	readonly hide_thinking: boolean;
	readonly tool_details_default: "collapsed" | "expanded";
	readonly hardware_cursor: boolean;
	readonly clear_on_shrink: boolean;
	readonly terminal_progress: boolean;
	readonly subagent_density: "compact" | "normal" | "detailed";
	readonly color_mode: "auto" | "truecolor" | "256" | "16" | "none";
	readonly reduced_motion: boolean;
	readonly glyph_mode: "auto" | "unicode" | "ascii";
	readonly high_contrast: boolean;
}

export type ShellSettingName = keyof ShellSettings;
export type ShellSettingSource = ConfigLayerId | "default";

export interface LoadedShellSettings {
	readonly settings: ShellSettings;
	readonly sources: Readonly<Record<ShellSettingName, ShellSettingSource>>;
	readonly overridden: Readonly<Record<ShellSettingName, readonly ConfigLayerId[]>>;
	readonly keymap: LoadedTuiKeymap;
}

export type ShellSettingClientKey =
	| "statusbarMode"
	| "viewMode"
	| "theme"
	| "hideThinking"
	| "toolDetailsDefault"
	| "hardwareCursor"
	| "clearOnShrink"
	| "terminalProgress"
	| "subagentDensity"
	| "colorMode"
	| "reducedMotion"
	| "glyphMode"
	| "highContrast";

export interface ShellSettingDescriptor {
	readonly key: `tui.${string}`;
	readonly settingKey: ShellSettingName;
	readonly clientKey: ShellSettingClientKey;
	readonly label: string;
	readonly description: string;
	readonly valueKind: "boolean" | "string";
	readonly allowedValues: readonly (boolean | string)[];
	readonly defaultValue: boolean | string;
	readonly path: readonly string[];
	readonly legacyPaths: readonly (readonly string[])[];
	readonly inputKeys: readonly string[];
	readonly restartRequired: boolean;
}

export const DEFAULT_SHELL_SETTINGS: ShellSettings = Object.freeze({
	statusbar_mode: "full",
	view_mode: "default",
	theme: "dark",
	hide_thinking: true,
	tool_details_default: "collapsed",
	hardware_cursor: false,
	clear_on_shrink: true,
	terminal_progress: true,
	subagent_density: "normal",
	color_mode: "auto",
	reduced_motion: false,
	glyph_mode: "auto",
	high_contrast: false,
});

export const SHELL_SETTING_DESCRIPTORS: readonly ShellSettingDescriptor[] = Object.freeze([
	descriptor({
		key: "tui.statusbar_mode",
		settingKey: "statusbar_mode",
		clientKey: "statusbarMode",
		label: "Statusbar",
		description: "Controls how much session and model status is shown in the footer",
		allowedValues: ["off", "compact", "full"],
		path: ["tui_statusbar_mode"],
		legacyPaths: [["statusbarMode"], ["statusbar_mode"], ["statusline_enabled"]],
		inputKeys: ["statusbarMode", "statusbar_mode", "tui_statusbar_mode"],
	}),
	descriptor({
		key: "tui.view_mode",
		settingKey: "view_mode",
		clientKey: "viewMode",
		label: "View mode",
		description: "Controls transcript detail density while keeping tool activity visible",
		allowedValues: ["default", "verbose", "focus"],
		path: ["view_mode"],
		legacyPaths: [["viewMode"]],
		inputKeys: ["viewMode", "view_mode"],
	}),
	descriptor({
		key: "tui.theme",
		settingKey: "theme",
		clientKey: "theme",
		label: "Theme",
		description: "Selects the terminal color theme",
		allowedValues: ["dark", "light"],
		path: ["tui_theme"],
		legacyPaths: [["theme"]],
		inputKeys: ["theme", "tui_theme"],
	}),
	descriptor({
		key: "tui.hide_thinking",
		settingKey: "hide_thinking",
		clientKey: "hideThinking",
		label: "Hide thinking",
		description: "Hides reasoning blocks in assistant responses",
		allowedValues: [true, false],
		path: ["tui_hide_thinking"],
		legacyPaths: [["hideThinking"], ["hide_thinking"]],
		inputKeys: ["hideThinking", "hide_thinking", "tui_hide_thinking"],
	}),
	descriptor({
		key: "tui.tool_details_default",
		settingKey: "tool_details_default",
		clientKey: "toolDetailsDefault",
		label: "Tool details",
		description: "Controls whether completed tool details start collapsed or expanded",
		allowedValues: ["collapsed", "expanded"],
		path: ["tui_tool_details_default"],
		legacyPaths: [["toolDetailsDefault"], ["tool_details_default"]],
		inputKeys: ["toolDetailsDefault", "tool_details_default", "tui_tool_details_default"],
	}),
	descriptor({
		key: "tui.hardware_cursor",
		settingKey: "hardware_cursor",
		clientKey: "hardwareCursor",
		label: "Hardware cursor",
		description: "Uses the terminal cursor for IME placement when supported",
		allowedValues: [true, false],
		path: ["tui_hardware_cursor"],
		legacyPaths: [["hardwareCursor"], ["hardware_cursor"]],
		inputKeys: ["hardwareCursor", "hardware_cursor", "tui_hardware_cursor"],
	}),
	descriptor({
		key: "tui.clear_on_shrink",
		settingKey: "clear_on_shrink",
		clientKey: "clearOnShrink",
		label: "Clear on shrink",
		description: "Clears stale terminal cells after the viewport becomes smaller",
		allowedValues: [true, false],
		path: ["tui_clear_on_shrink"],
		legacyPaths: [["clearOnShrink"], ["clear_on_shrink"]],
		inputKeys: ["clearOnShrink", "clear_on_shrink", "tui_clear_on_shrink"],
	}),
	descriptor({
		key: "tui.terminal_progress",
		settingKey: "terminal_progress",
		clientKey: "terminalProgress",
		label: "Terminal progress",
		description: "Shows compact progress while an agent turn is running",
		allowedValues: [true, false],
		path: ["tui_terminal_progress"],
		legacyPaths: [["terminalProgress"], ["terminal_progress"]],
		inputKeys: ["terminalProgress", "terminal_progress", "tui_terminal_progress"],
	}),
	descriptor({
		key: "tui.subagent_density",
		settingKey: "subagent_density",
		clientKey: "subagentDensity",
		label: "Subagent detail",
		description: "Controls the density of subagent task summaries",
		allowedValues: ["compact", "normal", "detailed"],
		path: ["tui_subagent_density"],
		legacyPaths: [["subagentDensity"], ["subagent_density"]],
		inputKeys: ["subagentDensity", "subagent_density", "tui_subagent_density"],
	}),
	descriptor({
		key: "tui.color_mode",
		settingKey: "color_mode",
		clientKey: "colorMode",
		label: "Color mode",
		description: "Selects automatic, truecolor, 256-color, 16-color, or no-color output",
		allowedValues: ["auto", "truecolor", "256", "16", "none"],
		path: ["tui_color_mode"],
		legacyPaths: [["colorMode"], ["color_mode"]],
		inputKeys: ["colorMode", "color_mode", "tui_color_mode"],
	}),
	descriptor({
		key: "tui.reduced_motion",
		settingKey: "reduced_motion",
		clientKey: "reducedMotion",
		label: "Reduced motion",
		description: "Uses static progress indicators instead of animated terminal frames",
		allowedValues: [true, false],
		path: ["tui_reduced_motion"],
		legacyPaths: [["reducedMotion"], ["reduced_motion"]],
		inputKeys: ["reducedMotion", "reduced_motion", "tui_reduced_motion"],
	}),
	descriptor({
		key: "tui.glyph_mode",
		settingKey: "glyph_mode",
		clientKey: "glyphMode",
		label: "Glyph mode",
		description: "Selects automatic, Unicode, or ASCII-only interface glyphs",
		allowedValues: ["auto", "unicode", "ascii"],
		path: ["tui_glyph_mode"],
		legacyPaths: [["glyphMode"], ["glyph_mode"]],
		inputKeys: ["glyphMode", "glyph_mode", "tui_glyph_mode"],
	}),
	descriptor({
		key: "tui.high_contrast",
		settingKey: "high_contrast",
		clientKey: "highContrast",
		label: "High contrast",
		description: "Uses stronger semantic contrast for status and selection tokens",
		allowedValues: [true, false],
		path: ["tui_high_contrast"],
		legacyPaths: [["highContrast"], ["high_contrast"]],
		inputKeys: ["highContrast", "high_contrast", "tui_high_contrast"],
	}),
]);

const DESCRIPTOR_BY_KEY: ReadonlyMap<string, ShellSettingDescriptor> = new Map(
	SHELL_SETTING_DESCRIPTORS.map((item) => [item.key, item]),
);

export function shellSettingDescriptor(key: string): ShellSettingDescriptor | undefined {
	return DESCRIPTOR_BY_KEY.get(key);
}

export function resolveShellSettingsFromLayers(
	layers: readonly ConfigLayerInput[],
): LoadedShellSettings {
	const settings = {} as Record<ShellSettingName, ShellSettings[ShellSettingName]>;
	const sources = {} as Record<ShellSettingName, ShellSettingSource>;
	const overridden = {} as Record<ShellSettingName, readonly ConfigLayerId[]>;
	for (const item of SHELL_SETTING_DESCRIPTORS) {
		const candidates = layers.flatMap((layer) => {
			if (!layer.metadata.enabled) return [];
			const value = shellSettingLayerValue(layer.values, item);
			return value === undefined ? [] : [{ layer: layer.metadata.id, value }];
		});
		const winner = candidates[0];
		settings[item.settingKey] = winner
			? parseShellSettingValue(item, winner.value, winner.layer)
			: DEFAULT_SHELL_SETTINGS[item.settingKey];
		sources[item.settingKey] = winner?.layer ?? "default";
		overridden[item.settingKey] = Object.freeze(candidates.slice(1).map((entry) => entry.layer));
	}
	return Object.freeze({
		settings: Object.freeze(settings) as ShellSettings,
		sources: Object.freeze(sources),
		overridden: Object.freeze(overridden),
		keymap: resolveTuiKeymapFromLayers(layers),
	});
}

function shellSettingLayerValue(
	values: Readonly<Record<string, unknown>>,
	item: ShellSettingDescriptor,
): unknown {
	for (const key of item.inputKeys) {
		if (values[key] !== undefined) return values[key];
	}
	if (item.settingKey === "statusbar_mode" && values.statusline_enabled !== undefined) {
		if (values.statusline_enabled === true) return "full";
		if (values.statusline_enabled === false) return "off";
		return values.statusline_enabled;
	}
	return undefined;
}

function parseShellSettingValue(
	item: ShellSettingDescriptor,
	value: unknown,
	layer: ConfigLayerId,
): ShellSettings[ShellSettingName] {
	if (item.valueKind === "boolean" && typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.toLowerCase();
		if (item.allowedValues.includes(normalized)) {
			return normalized as ShellSettings[ShellSettingName];
		}
	}
	throw configError({
		code: "invalid_value",
		severity: "error",
		layer,
		keyPath: item.key,
		message: "configuration setting has an invalid value",
		remediation: `Use a supported value for '${item.key}' or remove the setting.`,
	});
}

function descriptor(input: Omit<ShellSettingDescriptor, "defaultValue" | "restartRequired" | "valueKind">): ShellSettingDescriptor {
	const defaultValue = DEFAULT_SHELL_SETTINGS[input.settingKey];
	return Object.freeze({
		...input,
		allowedValues: Object.freeze([...input.allowedValues]),
		path: Object.freeze([...input.path]),
		legacyPaths: Object.freeze(input.legacyPaths.map((path) => Object.freeze([...path]))),
		inputKeys: Object.freeze([...input.inputKeys]),
		defaultValue,
		valueKind: typeof defaultValue === "boolean" ? "boolean" : "string",
		restartRequired: false,
	});
}
