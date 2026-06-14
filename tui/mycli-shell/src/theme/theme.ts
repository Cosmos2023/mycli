import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from "../tui-core/index.ts";

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

type ColorValue = string | number;
type ColorMode = "truecolor" | "256color";

const DARK_VARS: Record<string, ColorValue> = {
	cyan: "#00d7ff",
	blue: "#5f87ff",
	green: "#b5bd68",
	red: "#cc6666",
	yellow: "#ffff00",
	text: "#d4d4d4",
	gray: "#808080",
	dimGray: "#666666",
	darkGray: "#505050",
	accent: "#8abeb7",
	selectedBg: "#3a3a4a",
	userMsgBg: "#343541",
	toolPendingBg: "#282832",
	toolSuccessBg: "#283228",
	toolErrorBg: "#3c2828",
	customMsgBg: "#2d2838",
};

const DARK_COLORS: Record<ThemeColor | ThemeBg, ColorValue> = {
	accent: "accent",
	border: "blue",
	borderAccent: "cyan",
	borderMuted: "darkGray",
	success: "green",
	error: "red",
	warning: "yellow",
	muted: "gray",
	dim: "dimGray",
	text: "text",
	thinkingText: "gray",
	selectedBg: "selectedBg",
	userMessageBg: "userMsgBg",
	userMessageText: "text",
	customMessageBg: "customMsgBg",
	customMessageText: "text",
	customMessageLabel: "#9575cd",
	toolPendingBg: "toolPendingBg",
	toolSuccessBg: "toolSuccessBg",
	toolErrorBg: "toolErrorBg",
	toolTitle: "text",
	toolOutput: "gray",
	mdHeading: "#f0c674",
	mdLink: "#81a2be",
	mdLinkUrl: "dimGray",
	mdCode: "accent",
	mdCodeBlock: "green",
	mdCodeBlockBorder: "gray",
	mdQuote: "gray",
	mdQuoteBorder: "gray",
	mdHr: "gray",
	mdListBullet: "accent",
	toolDiffAdded: "green",
	toolDiffRemoved: "red",
	toolDiffContext: "gray",
	syntaxComment: "#6A9955",
	syntaxKeyword: "#569CD6",
	syntaxFunction: "#DCDCAA",
	syntaxVariable: "#9CDCFE",
	syntaxString: "#CE9178",
	syntaxNumber: "#B5CEA8",
	syntaxType: "#4EC9B0",
	syntaxOperator: "#D4D4D4",
	syntaxPunctuation: "#D4D4D4",
	thinkingOff: "darkGray",
	thinkingMinimal: "#6e6e6e",
	thinkingLow: "#5f87af",
	thinkingMedium: "#81a2be",
	thinkingHigh: "#b294bb",
	thinkingXhigh: "#d183e8",
	bashMode: "green",
};

const LIGHT_VARS: Record<string, ColorValue> = {
	teal: "#5a8080",
	blue: "#547da7",
	green: "#588458",
	red: "#aa5555",
	yellow: "#9a7326",
	text: "#1f2328",
	mediumGray: "#6c6c6c",
	dimGray: "#767676",
	lightGray: "#b0b0b0",
	selectedBg: "#d0d0e0",
	userMsgBg: "#e8e8e8",
	toolPendingBg: "#e8e8f0",
	toolSuccessBg: "#e8f0e8",
	toolErrorBg: "#f0e8e8",
	customMsgBg: "#ede7f6",
};

const LIGHT_COLORS: Record<ThemeColor | ThemeBg, ColorValue> = {
	accent: "teal",
	border: "blue",
	borderAccent: "teal",
	borderMuted: "lightGray",
	success: "green",
	error: "red",
	warning: "yellow",
	muted: "mediumGray",
	dim: "dimGray",
	text: "text",
	thinkingText: "mediumGray",
	selectedBg: "selectedBg",
	userMessageBg: "userMsgBg",
	userMessageText: "text",
	customMessageBg: "customMsgBg",
	customMessageText: "text",
	customMessageLabel: "#7e57c2",
	toolPendingBg: "toolPendingBg",
	toolSuccessBg: "toolSuccessBg",
	toolErrorBg: "toolErrorBg",
	toolTitle: "text",
	toolOutput: "mediumGray",
	mdHeading: "yellow",
	mdLink: "blue",
	mdLinkUrl: "dimGray",
	mdCode: "teal",
	mdCodeBlock: "green",
	mdCodeBlockBorder: "mediumGray",
	mdQuote: "mediumGray",
	mdQuoteBorder: "mediumGray",
	mdHr: "mediumGray",
	mdListBullet: "green",
	toolDiffAdded: "green",
	toolDiffRemoved: "red",
	toolDiffContext: "mediumGray",
	syntaxComment: "#008000",
	syntaxKeyword: "#0000FF",
	syntaxFunction: "#795E26",
	syntaxVariable: "#001080",
	syntaxString: "#A31515",
	syntaxNumber: "#098658",
	syntaxType: "#267F99",
	syntaxOperator: "#000000",
	syntaxPunctuation: "#000000",
	thinkingOff: "lightGray",
	thinkingMinimal: "#767676",
	thinkingLow: "blue",
	thinkingMedium: "teal",
	thinkingHigh: "#875f87",
	thinkingXhigh: "#8b008b",
	bashMode: "green",
};

const colorEnabled = process.env.MYCLI_TUI_COLOR === "always" ? true : process.env.MYCLI_TUI_COLOR === "never" ? false : !process.env.NO_COLOR;
const themeName = process.env.MYCLI_TUI_THEME === "light" ? "light" : "dark";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	const r = Number.parseInt(cleaned.substring(0, 2), 16);
	const g = Number.parseInt(cleaned.substring(2, 4), 16);
	const b = Number.parseInt(cleaned.substring(4, 6), 16);
	return { r, g, b };
}

function ansi(value: ColorValue, mode: ColorMode, bg = false): string {
	if (typeof value === "number") {
		return `\x1b[${bg ? 48 : 38};5;${value}m`;
	}
	if (value === "") {
		return bg ? "\x1b[49m" : "\x1b[39m";
	}
	const { r, g, b } = hexToRgb(value);
	if (mode === "truecolor") {
		return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`;
	}
	return `\x1b[${bg ? 48 : 38};5;${rgbTo256(r, g, b)}m`;
}

function rgbTo256(r: number, g: number, b: number): number {
	const cubeValues = [0, 95, 135, 175, 215, 255];
	const closest = (value: number) =>
		cubeValues.reduce((best, candidate, index) => (Math.abs(value - candidate) < Math.abs(value - cubeValues[best]!) ? index : best), 0);
	return 16 + 36 * closest(r) + 6 * closest(g) + closest(b);
}

function resolve(value: ColorValue, vars: Record<string, ColorValue>): ColorValue {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	return resolve(vars[value] ?? value, vars);
}

class Theme {
	private readonly vars = themeName === "light" ? LIGHT_VARS : DARK_VARS;
	private readonly colors = themeName === "light" ? LIGHT_COLORS : DARK_COLORS;
	private readonly mode: ColorMode = process.env.COLORTERM === "truecolor" ? "truecolor" : "256color";

	fg(color: ThemeColor, text: string): string {
		if (!colorEnabled) return text;
		return `${ansi(resolve(this.colors[color], this.vars), this.mode)}${text}\x1b[39m`;
	}

	bg(color: ThemeBg, text: string): string {
		if (!colorEnabled) return text;
		return `${ansi(resolve(this.colors[color], this.vars), this.mode, true)}${text}\x1b[49m`;
	}

	bold(text: string): string {
		return colorEnabled ? `\x1b[1m${text}\x1b[22m` : text;
	}

	italic(text: string): string {
		return colorEnabled ? `\x1b[3m${text}\x1b[23m` : text;
	}

	underline(text: string): string {
		return colorEnabled ? `\x1b[4m${text}\x1b[24m` : text;
	}

	inverse(text: string): string {
		return colorEnabled ? `\x1b[7m${text}\x1b[27m` : text;
	}

	strikethrough(text: string): string {
		return colorEnabled ? `\x1b[9m${text}\x1b[29m` : text;
	}

	getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): (str: string) => string {
		switch (level) {
			case "off":
				return (str) => this.fg("thinkingOff", str);
			case "minimal":
				return (str) => this.fg("thinkingMinimal", str);
			case "low":
				return (str) => this.fg("thinkingLow", str);
			case "medium":
				return (str) => this.fg("thinkingMedium", str);
			case "high":
				return (str) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str) => this.fg("thinkingXhigh", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str) => this.fg("bashMode", str);
	}
}

export const theme = new Theme();

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		underline: (text) => theme.underline(text),
		strikethrough: (text) => theme.strikethrough(text),
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}
