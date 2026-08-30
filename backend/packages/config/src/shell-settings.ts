import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { WorkspaceTrustState } from "./workspace-trust-store.ts";
import {
	applyUserConfigEdits,
	type UserConfigEdit,
} from "./user-config-editor.ts";

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
	readonly workspaceRoot?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly workspaceTrust?: WorkspaceTrustState;
	readonly failpoint?: (name: string) => void;
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
		await applyUserConfigEdits({
			homeDir: options.homeDir,
			workspaceRoot: options.workspaceRoot ?? options.homeDir,
			env: options.env ?? {},
			workspaceTrust: options.workspaceTrust ?? "untrusted",
			edits: shellSettingEdits(settings),
			validateCurrent: true,
			...(options.failpoint ? { failpoint: options.failpoint } : {}),
		});
	} catch {
		throw new Error("shell_settings_write_failed: unable to update user config");
	}
	return settings;
}

function shellSettingEdits(settings: ShellSettings): readonly UserConfigEdit[] {
	const edits: UserConfigEdit[] = [];
	for (const key of [
		"statusbarMode",
		"statusbar_mode",
		"viewMode",
		"theme",
		"hideThinking",
		"hide_thinking",
		"toolDetailsDefault",
		"tool_details_default",
		"hardwareCursor",
		"hardware_cursor",
		"clearOnShrink",
		"clear_on_shrink",
		"terminalProgress",
		"terminal_progress",
		"subagentDensity",
		"subagent_density",
	] as const) {
		edits.push({ action: "clear", path: [key] });
	}
	edits.push(
		set("view_mode", settings.view_mode),
		set("statusline_enabled", settings.statusbar_mode !== "off"),
		set("tui_statusbar_mode", settings.statusbar_mode),
		set("tui_theme", settings.theme),
		set("tui_hide_thinking", settings.hide_thinking),
		set("tui_tool_details_default", settings.tool_details_default),
		set("tui_hardware_cursor", settings.hardware_cursor),
		set("tui_clear_on_shrink", settings.clear_on_shrink),
		set("tui_terminal_progress", settings.terminal_progress),
		set("tui_subagent_density", settings.subagent_density),
	);
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
