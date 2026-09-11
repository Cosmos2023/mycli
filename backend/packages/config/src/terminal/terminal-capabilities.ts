import type { ShellSettings } from "./shell-setting-catalog.ts";

export type TerminalColorMode = "truecolor" | "256" | "16" | "none";
export type TerminalGlyphMode = "unicode" | "ascii";

export interface DetectedTerminalCapabilities {
	readonly colorMode: TerminalColorMode;
	readonly colorForcedOff: boolean;
	readonly glyphMode: TerminalGlyphMode;
	readonly terminalKind: "dumb" | "standard" | "windows_terminal";
}

export interface ResolvedTerminalCapabilities extends DetectedTerminalCapabilities {
	readonly version: 1;
	readonly progressVisible: boolean;
	readonly progressAnimated: boolean;
	readonly reducedMotion: boolean;
	readonly highContrast: boolean;
	readonly guidance: readonly string[];
}

export function detectTerminalCapabilities(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): DetectedTerminalCapabilities {
	const term = env.TERM?.trim().toLowerCase() ?? "";
	const colorTerm = env.COLORTERM?.trim().toLowerCase() ?? "";
	const dumb = term === "dumb";
	const windowsTerminal = Boolean(env.WT_SESSION) && !dumb;
	const colorForcedOff = env.NO_COLOR !== undefined || env.MYCLI_TUI_COLOR === "never" || dumb;
	const colorMode: TerminalColorMode = colorForcedOff
		? "none"
		: colorTerm === "truecolor" || colorTerm === "24bit" || windowsTerminal
			? "truecolor"
			: term.includes("256color")
				? "256"
				: "16";
	const locale = `${env.LC_ALL ?? ""} ${env.LC_CTYPE ?? ""} ${env.LANG ?? ""}`.toLowerCase();
	const glyphMode: TerminalGlyphMode = dumb || env.MYCLI_TUI_ASCII === "1"
		? "ascii"
		: platform === "win32" || !locale || /utf-?8/u.test(locale)
			? "unicode"
			: "ascii";
	return Object.freeze({
		colorMode,
		colorForcedOff,
		glyphMode,
		terminalKind: dumb ? "dumb" : windowsTerminal ? "windows_terminal" : "standard",
	});
}

export function resolveTerminalCapabilities(
	settings: ShellSettings,
	detected: DetectedTerminalCapabilities,
): ResolvedTerminalCapabilities {
	const colorMode: TerminalColorMode = detected.colorForcedOff
		? "none"
		: settings.color_mode === "auto"
			? detected.colorMode
			: settings.color_mode;
	const glyphMode: TerminalGlyphMode = settings.glyph_mode === "auto"
		? detected.glyphMode
		: settings.glyph_mode;
	const guidance: string[] = [];
	if (settings.color_mode === "auto" && detected.colorMode === "none") {
		guidance.push("Terminal color is unavailable; using no-color output.");
	}
	if (settings.glyph_mode === "auto" && detected.glyphMode === "ascii") {
		guidance.push("Unicode glyph support is unavailable; using ASCII indicators.");
	}
	return Object.freeze({
		version: 1,
		colorMode,
		colorForcedOff: detected.colorForcedOff,
		glyphMode,
		terminalKind: detected.terminalKind,
		progressVisible: settings.terminal_progress,
		progressAnimated: settings.terminal_progress && !settings.reduced_motion,
		reducedMotion: settings.reduced_motion,
		highContrast: settings.high_contrast,
		guidance: Object.freeze(guidance.slice(0, 2)),
	});
}
