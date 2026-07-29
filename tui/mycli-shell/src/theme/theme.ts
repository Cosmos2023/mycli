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
	| "selectorTitle"
	| "selectorMatch"
	| "selectorMeta"
	| "resourceHook"
	| "resourcePlugin"
	| "resourceSkill"
	| "resourcePrompt"
	| "resourceTheme"
	| "resourceEnabled"
	| "resourceDisabled"
	| "resourceIssue"
	| "sessionActive"
	| "sessionBranch"
	| "subagentRunning"
	| "subagentCompleted"
	| "subagentFailed"
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

type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "toolDiffAddedBg"
	| "toolDiffRemovedBg";

type ColorValue = string | number;
type ColorMode = "truecolor" | "256color" | "16color";

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
	diffAddedBg: "#193825",
	diffRemovedBg: "#452126",
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
	toolDiffAddedBg: "diffAddedBg",
	toolDiffRemovedBg: "diffRemovedBg",
	toolTitle: "text",
	toolOutput: "gray",
	selectorTitle: "accent",
	selectorMatch: "cyan",
	selectorMeta: "gray",
	resourceHook: "#f0c674",
	resourcePlugin: "#b294bb",
	resourceSkill: "#81a2be",
	resourcePrompt: "#8abeb7",
	resourceTheme: "#de935f",
	resourceEnabled: "green",
	resourceDisabled: "darkGray",
	resourceIssue: "red",
	sessionActive: "green",
	sessionBranch: "cyan",
	subagentRunning: "yellow",
	subagentCompleted: "green",
	subagentFailed: "red",
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
	diffAddedBg: "#dafbe1",
	diffRemovedBg: "#ffebe9",
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
	toolDiffAddedBg: "diffAddedBg",
	toolDiffRemovedBg: "diffRemovedBg",
	toolTitle: "text",
	toolOutput: "mediumGray",
	selectorTitle: "teal",
	selectorMatch: "blue",
	selectorMeta: "mediumGray",
	resourceHook: "yellow",
	resourcePlugin: "#7e57c2",
	resourceSkill: "blue",
	resourcePrompt: "teal",
	resourceTheme: "#a86822",
	resourceEnabled: "green",
	resourceDisabled: "lightGray",
	resourceIssue: "red",
	sessionActive: "green",
	sessionBranch: "blue",
	subagentRunning: "yellow",
	subagentCompleted: "green",
	subagentFailed: "red",
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
	if (mode === "16color") {
		return ansi16(r, g, b, bg);
	}
	return `\x1b[${bg ? 48 : 38};5;${rgbTo256(r, g, b)}m`;
}

const ANSI16_PALETTE = [
	{ r: 0, g: 0, b: 0, fg: 30, bg: 40 },
	{ r: 205, g: 49, b: 49, fg: 31, bg: 41 },
	{ r: 13, g: 188, b: 121, fg: 32, bg: 42 },
	{ r: 229, g: 229, b: 16, fg: 33, bg: 43 },
	{ r: 36, g: 114, b: 200, fg: 34, bg: 44 },
	{ r: 188, g: 63, b: 188, fg: 35, bg: 45 },
	{ r: 17, g: 168, b: 205, fg: 36, bg: 46 },
	{ r: 229, g: 229, b: 229, fg: 37, bg: 47 },
	{ r: 102, g: 102, b: 102, fg: 90, bg: 100 },
	{ r: 241, g: 76, b: 76, fg: 91, bg: 101 },
	{ r: 35, g: 209, b: 139, fg: 92, bg: 102 },
	{ r: 245, g: 245, b: 67, fg: 93, bg: 103 },
	{ r: 59, g: 142, b: 234, fg: 94, bg: 104 },
	{ r: 214, g: 112, b: 214, fg: 95, bg: 105 },
	{ r: 41, g: 184, b: 219, fg: 96, bg: 106 },
	{ r: 255, g: 255, b: 255, fg: 97, bg: 107 },
] as const;

function ansi16(r: number, g: number, b: number, background: boolean): string {
	if (background && g > r + 10 && g > b) return "\x1b[42m";
	if (background && r > g + 10 && r > b) return "\x1b[41m";
	const nearest = ANSI16_PALETTE.reduce((best, candidate) => {
		const bestDistance = (r - best.r) ** 2 + (g - best.g) ** 2 + (b - best.b) ** 2;
		const candidateDistance = (r - candidate.r) ** 2 + (g - candidate.g) ** 2 + (b - candidate.b) ** 2;
		return candidateDistance < bestDistance ? candidate : best;
	});
	return `\x1b[${background ? nearest.bg : nearest.fg}m`;
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
	private readonly mode: ColorMode = process.env.COLORTERM === "truecolor"
		? "truecolor"
		: process.env.TERM?.includes("256color")
			? "256color"
			: "16color";

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

	isColorEnabled(): boolean {
		return colorEnabled;
	}

	name(): "dark" | "light" {
		return themeName;
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
		imageMarker: (text) => theme.bold(theme.fg("accent", text)),
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
