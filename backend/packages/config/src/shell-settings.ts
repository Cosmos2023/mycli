import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { ConfigLayerInput } from "./config-layers.ts";
import type { ConfigProfileName } from "./config-profile.ts";
import type { WorkspaceTrustState } from "./workspace-trust-store.ts";
import {
	DEFAULT_SHELL_SETTINGS,
	SHELL_SETTING_DESCRIPTORS,
	shellSettingDescriptor,
	type LoadedShellSettings,
	type ShellSettingDescriptor,
	type ShellSettingName,
	type ShellSettingSource,
	type ShellSettings,
} from "./shell-setting-catalog.ts";
import { resolveTuiKeymapFromLayers } from "./tui-keymap.ts";
import {
	applyUserConfigEdits,
	type UserConfigEdit,
} from "./user-config-editor.ts";

export type { ShellSettings } from "./shell-setting-catalog.ts";
export type { LoadedShellSettings, ShellSettingSource } from "./shell-setting-catalog.ts";

export interface LoadShellSettingsOptions {
	readonly homeDir: string;
}

export interface SaveShellSettingsOptions extends LoadShellSettingsOptions {
	readonly settings: Readonly<Record<string, unknown>>;
	readonly workspaceRoot?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly workspaceTrust?: WorkspaceTrustState;
	readonly configProfile?: ConfigProfileName;
	readonly systemConfigPath?: string;
	readonly failpoint?: (name: string) => void;
}

export interface SaveShellSettingOptions extends LoadShellSettingsOptions {
	readonly key: string;
	readonly value: string | boolean;
	readonly workspaceRoot?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly workspaceTrust?: WorkspaceTrustState;
	readonly configProfile?: ConfigProfileName;
	readonly systemConfigPath?: string;
	readonly failpoint?: (name: string) => void;
}

export async function loadShellSettings(options: LoadShellSettingsOptions): Promise<ShellSettings> {
	return (await loadShellSettingsState(options)).settings;
}

export async function loadShellSettingsState(options: LoadShellSettingsOptions): Promise<LoadedShellSettings> {
	let raw: string;
	try {
		raw = await readFile(configPath(options.homeDir), "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return loadedShellSettings({}, DEFAULT_SHELL_SETTINGS);
		throw new Error("shell_settings_invalid: unable to read user config");
	}
	try {
		const payload = parsePayload(raw);
		return loadedShellSettings(payload, settingsFromPayload(payload, DEFAULT_SHELL_SETTINGS));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("shell_settings_invalid:")) throw error;
		throw new Error("shell_settings_invalid: unable to parse user config");
	}
}

export async function saveShellSettings(options: SaveShellSettingsOptions): Promise<ShellSettings> {
	const current = await loadShellSettings(options);
	const settings = settingsFromPayload(options.settings, current);
	await persistShellSettings(options, settings, SHELL_SETTING_DESCRIPTORS);
	return settings;
}

export async function saveShellSetting(options: SaveShellSettingOptions): Promise<LoadedShellSettings> {
	const item = shellSettingDescriptor(options.key);
	if (!item) throw new Error("shell_settings_invalid: unsupported setting");
	const current = await loadShellSettings(options);
	const settings = settingsFromPayload({ [item.settingKey]: options.value }, current);
	await persistShellSettings(options, settings, [item]);
	return loadShellSettingsState(options);
}

async function persistShellSettings(
	options: SaveShellSettingsOptions | SaveShellSettingOptions,
	settings: ShellSettings,
	items: readonly ShellSettingDescriptor[],
): Promise<void> {
	try {
		await applyUserConfigEdits({
			homeDir: options.homeDir,
			workspaceRoot: options.workspaceRoot ?? options.homeDir,
			env: options.env ?? {},
			workspaceTrust: options.workspaceTrust ?? "untrusted",
			...(options.configProfile ? { configProfile: options.configProfile } : {}),
			...(options.systemConfigPath ? { systemConfigPath: options.systemConfigPath } : {}),
			edits: shellSettingEdits(settings, items),
			validateCurrent: true,
			...(options.failpoint ? { failpoint: options.failpoint } : {}),
		});
	} catch {
		throw new Error("shell_settings_write_failed: unable to update user config");
	}
}

function shellSettingEdits(
	settings: ShellSettings,
	items: readonly ShellSettingDescriptor[],
): readonly UserConfigEdit[] {
	const edits: UserConfigEdit[] = [];
	for (const item of items) {
		edits.push({ action: "clear", path: item.path });
		for (const legacyPath of item.legacyPaths) {
			edits.push({ action: "clear", path: legacyPath });
		}
	}
	for (const item of items) {
		edits.push(set(item.path[0]!, settings[item.settingKey]));
	}
	if (items.some((item) => item.settingKey === "statusbar_mode")) {
		edits.push(set("statusline_enabled", settings.statusbar_mode !== "off"));
	}
	return edits;
}

function set(key: string, value: string | boolean): UserConfigEdit {
	return { action: "set", path: [key], value };
}

function settingsFromPayload(
	payload: Readonly<Record<string, unknown>>,
	fallback: ShellSettings,
): ShellSettings {
	return {
		statusbar_mode: enumValue(
			"statusbar_mode",
			settingValue(payload, "statusbar_mode")
				?? (payload.statusline_enabled === false ? "off" : fallback.statusbar_mode),
			stringValues("statusbar_mode"),
		),
		view_mode: enumValue(
			"view_mode",
			settingValue(payload, "view_mode") ?? fallback.view_mode,
			stringValues("view_mode"),
		),
		theme: enumValue(
			"theme",
			settingValue(payload, "theme") ?? fallback.theme,
			stringValues("theme"),
		),
		hide_thinking: booleanValue(
			"hide_thinking",
			settingValue(payload, "hide_thinking") ?? fallback.hide_thinking,
		),
		tool_details_default: enumValue(
			"tool_details_default",
			settingValue(payload, "tool_details_default") ?? fallback.tool_details_default,
			stringValues("tool_details_default"),
		),
		hardware_cursor: booleanValue(
			"hardware_cursor",
			settingValue(payload, "hardware_cursor") ?? fallback.hardware_cursor,
		),
		clear_on_shrink: booleanValue(
			"clear_on_shrink",
			settingValue(payload, "clear_on_shrink") ?? fallback.clear_on_shrink,
		),
		terminal_progress: booleanValue(
			"terminal_progress",
			settingValue(payload, "terminal_progress") ?? fallback.terminal_progress,
		),
		subagent_density: enumValue(
			"subagent_density",
			settingValue(payload, "subagent_density") ?? fallback.subagent_density,
			stringValues("subagent_density"),
		),
		color_mode: enumValue(
			"color_mode",
			settingValue(payload, "color_mode") ?? fallback.color_mode,
			stringValues("color_mode"),
		),
		reduced_motion: booleanValue(
			"reduced_motion",
			settingValue(payload, "reduced_motion") ?? fallback.reduced_motion,
		),
		glyph_mode: enumValue(
			"glyph_mode",
			settingValue(payload, "glyph_mode") ?? fallback.glyph_mode,
			stringValues("glyph_mode"),
		),
		high_contrast: booleanValue(
			"high_contrast",
			settingValue(payload, "high_contrast") ?? fallback.high_contrast,
		),
	};
}

function enumValue<const Value extends string>(
	name: string,
	value: unknown,
	allowed: readonly Value[],
): Value {
	if (typeof value === "string" && allowed.includes(value.toLowerCase() as Value)) {
		return value.toLowerCase() as Value;
	}
	throw new Error(`shell_settings_invalid: unsupported ${name}`);
}

function booleanValue(name: string, value: unknown): boolean {
	if (typeof value === "boolean") return value;
	throw new Error(`shell_settings_invalid: ${name} must be a boolean`);
}

function settingValue(payload: Readonly<Record<string, unknown>>, name: ShellSettingName): unknown {
	const item = descriptorForName(name);
	for (const key of item.inputKeys) {
		if (payload[key] !== undefined) return payload[key];
	}
	return undefined;
}

function stringValues<Name extends ShellSettingName>(
	name: Name,
): readonly Extract<ShellSettings[Name], string>[] {
	return descriptorForName(name).allowedValues.filter(
		(value): value is string => typeof value === "string",
	) as unknown as readonly Extract<ShellSettings[Name], string>[];
}

function descriptorForName(name: ShellSettingName): ShellSettingDescriptor {
	return SHELL_SETTING_DESCRIPTORS.find((item) => item.settingKey === name)!;
}

function loadedShellSettings(
	payload: Readonly<Record<string, unknown>>,
	settings: ShellSettings,
): LoadedShellSettings {
	const sources = Object.fromEntries(SHELL_SETTING_DESCRIPTORS.map((item) => [
		item.settingKey,
		item.inputKeys.some((key) => payload[key] !== undefined)
			|| item.legacyPaths.some((path) => path.length === 1 && payload[path[0]!] !== undefined)
			? "user"
			: "default",
	])) as Record<ShellSettingName, ShellSettingSource>;
	const overridden = Object.fromEntries(SHELL_SETTING_DESCRIPTORS.map((item) => [
		item.settingKey,
		Object.freeze([]),
	])) as Record<ShellSettingName, readonly []>;
	return Object.freeze({
		settings: Object.freeze({ ...settings }),
		sources: Object.freeze(sources),
		overridden: Object.freeze(overridden),
		keymap: resolveTuiKeymapFromLayers(payloadLayer(payload)),
	});
}

function payloadLayer(payload: Readonly<Record<string, unknown>>): readonly ConfigLayerInput[] {
	return [{
		metadata: {
			id: "user",
			scope: "user",
			source: "~/.mycli/config.toml",
			version: 1,
			enabled: true,
		},
		values: payload,
	}];
}

function parsePayload(raw: string): Record<string, unknown> {
	const payload: unknown = parse(raw);
	if (!isRecord(payload)) throw new Error("shell_settings_invalid: user config must be an object");
	return { ...payload };
}

function configPath(homeDir: string): string {
	return join(homeDir, ".mycli", "config.toml");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
