import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { atomicPrivateFileUpdate } from "./private-file-writer.ts";

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
}

export interface LoadShellSettingsOptions {
	readonly homeDir: string;
}

export interface SaveShellSettingsOptions extends LoadShellSettingsOptions {
	readonly settings: Readonly<Record<string, unknown>>;
}

const DEFAULTS: ShellSettings = Object.freeze({
	statusbar_mode: "full",
	view_mode: "default",
	theme: "dark",
	hide_thinking: true,
	tool_details_default: "collapsed",
	hardware_cursor: false,
	clear_on_shrink: true,
	terminal_progress: true,
	subagent_density: "normal",
});

export async function loadShellSettings(options: LoadShellSettingsOptions): Promise<ShellSettings> {
	let raw: string;
	try {
		raw = await readFile(configPath(options.homeDir), "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return { ...DEFAULTS };
		throw new Error("shell_settings_invalid: unable to read user config");
	}
	try {
		return settingsFromPayload(parsePayload(raw), DEFAULTS);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("shell_settings_invalid:")) throw error;
		throw new Error("shell_settings_invalid: unable to parse user config");
	}
}

export async function saveShellSettings(options: SaveShellSettingsOptions): Promise<ShellSettings> {
	const current = await loadShellSettings(options);
	const settings = settingsFromPayload(options.settings, current);
	try {
		await atomicPrivateFileUpdate({
			directory: join(options.homeDir, ".mycli"),
			fileName: "config.toml",
			buildContent: (raw) => serializeSettings(raw, settings),
		});
	} catch {
		throw new Error("shell_settings_write_failed: unable to update user config");
	}
	return settings;
}

function serializeSettings(raw: string | undefined, settings: ShellSettings): string {
	const payload = raw ? parsePayload(raw) : {};
	for (const key of [
		"statusbar_mode",
		"theme",
		"hide_thinking",
		"tool_details_default",
		"hardware_cursor",
		"clear_on_shrink",
		"terminal_progress",
		"subagent_density",
	] as const) {
		delete payload[key];
	}
	Object.assign(payload, {
		view_mode: settings.view_mode,
		statusline_enabled: settings.statusbar_mode !== "off",
		tui_statusbar_mode: settings.statusbar_mode,
		tui_theme: settings.theme,
		tui_hide_thinking: settings.hide_thinking,
		tui_tool_details_default: settings.tool_details_default,
		tui_hardware_cursor: settings.hardware_cursor,
		tui_clear_on_shrink: settings.clear_on_shrink,
		tui_terminal_progress: settings.terminal_progress,
		tui_subagent_density: settings.subagent_density,
	});
	return `${stringify(payload).trimEnd()}\n`;
}

function settingsFromPayload(
	payload: Readonly<Record<string, unknown>>,
	fallback: ShellSettings,
): ShellSettings {
	return {
		statusbar_mode: enumValue(
			"statusbar_mode",
			first(payload, "statusbarMode", "statusbar_mode", "tui_statusbar_mode")
				?? (payload.statusline_enabled === false ? "off" : fallback.statusbar_mode),
			["off", "compact", "full"],
		),
		view_mode: enumValue(
			"view_mode",
			first(payload, "viewMode", "view_mode") ?? fallback.view_mode,
			["default", "verbose", "focus"],
		),
		theme: enumValue(
			"theme",
			first(payload, "theme", "tui_theme") ?? fallback.theme,
			["dark", "light"],
		),
		hide_thinking: booleanValue(
			"hide_thinking",
			first(payload, "hideThinking", "hide_thinking", "tui_hide_thinking") ?? fallback.hide_thinking,
		),
		tool_details_default: enumValue(
			"tool_details_default",
			first(payload, "toolDetailsDefault", "tool_details_default", "tui_tool_details_default")
				?? fallback.tool_details_default,
			["collapsed", "expanded"],
		),
		hardware_cursor: booleanValue(
			"hardware_cursor",
			first(payload, "hardwareCursor", "hardware_cursor", "tui_hardware_cursor") ?? fallback.hardware_cursor,
		),
		clear_on_shrink: booleanValue(
			"clear_on_shrink",
			first(payload, "clearOnShrink", "clear_on_shrink", "tui_clear_on_shrink") ?? fallback.clear_on_shrink,
		),
		terminal_progress: booleanValue(
			"terminal_progress",
			first(payload, "terminalProgress", "terminal_progress", "tui_terminal_progress")
				?? fallback.terminal_progress,
		),
		subagent_density: enumValue(
			"subagent_density",
			first(payload, "subagentDensity", "subagent_density", "tui_subagent_density")
				?? fallback.subagent_density,
			["compact", "normal", "detailed"],
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

function first(payload: Readonly<Record<string, unknown>>, ...keys: readonly string[]): unknown {
	for (const key of keys) {
		if (payload[key] !== undefined) return payload[key];
	}
	return undefined;
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
