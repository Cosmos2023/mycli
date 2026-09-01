export type UiGlyphMode = "unicode" | "ascii";

export interface UiGlyphs {
	readonly bullet: string;
	readonly branch: string;
	readonly vertical: string;
	readonly output: string;
	readonly continuation: string;
	readonly error: string;
	readonly warning: string;
	readonly success: string;
	readonly completed: string;
	readonly pending: string;
	readonly selector: string;
	readonly arrow: string;
	readonly left: string;
	readonly up: string;
	readonly down: string;
	readonly collapsed: string;
	readonly expanded: string;
	readonly active: string;
	readonly diamond: string;
	readonly prompt: string;
	readonly completion: string;
	readonly mask: string;
	readonly cursor: string;
	readonly ellipsis: string;
	readonly separator: string;
	readonly descriptionSeparator: string;
	readonly horizontal: string;
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly teeLeft: string;
	readonly teeRight: string;
	readonly teeTop: string;
	readonly teeBottom: string;
	readonly cross: string;
	readonly tableTopLeft: string;
	readonly tableTopRight: string;
	readonly tableBottomLeft: string;
	readonly tableBottomRight: string;
	readonly spinnerFrames: readonly string[];
	readonly staticProgress: string;
}

const UNICODE_GLYPHS: UiGlyphs = Object.freeze({
	bullet: "•",
	branch: "└",
	vertical: "│",
	output: "⎿",
	continuation: "↳",
	error: "×",
	warning: "⚠",
	success: "✓",
	completed: "✔",
	pending: "□",
	selector: "›",
	arrow: "→",
	left: "←",
	up: "↑",
	down: "↓",
	collapsed: "▶",
	expanded: "▼",
	active: "●",
	diamond: "◇",
	prompt: "▸",
	completion: "✻",
	mask: "•",
	cursor: "▌",
	ellipsis: "…",
	separator: "·",
	descriptionSeparator: "—",
	horizontal: "─",
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	teeLeft: "├",
	teeRight: "┤",
	teeTop: "┬",
	teeBottom: "┴",
	cross: "┼",
	tableTopLeft: "┌",
	tableTopRight: "┐",
	tableBottomLeft: "└",
	tableBottomRight: "┘",
	spinnerFrames: Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]),
	staticProgress: "•",
});

const ASCII_GLYPHS: UiGlyphs = Object.freeze({
	bullet: "*",
	branch: "\\",
	vertical: "|",
	output: "\\",
	continuation: ">",
	error: "x",
	warning: "!",
	success: "+",
	completed: "x",
	pending: "o",
	selector: ">",
	arrow: ">",
	left: "<",
	up: "^",
	down: "v",
	collapsed: ">",
	expanded: "v",
	active: "*",
	diamond: "*",
	prompt: ">",
	completion: "*",
	mask: "*",
	cursor: "|",
	ellipsis: "...",
	separator: "|",
	descriptionSeparator: "-",
	horizontal: "-",
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	teeLeft: "+",
	teeRight: "+",
	teeTop: "+",
	teeBottom: "+",
	cross: "+",
	tableTopLeft: "+",
	tableTopRight: "+",
	tableBottomLeft: "+",
	tableBottomRight: "+",
	spinnerFrames: Object.freeze(["-", "\\", "|", "/"]),
	staticProgress: "*",
});

let activeGlyphMode: UiGlyphMode = process.env.TERM?.toLowerCase() === "dumb"
	|| process.env.MYCLI_TUI_ASCII === "1"
	? "ascii"
	: "unicode";

export function setUiGlyphMode(mode: UiGlyphMode): void {
	activeGlyphMode = mode;
}

export function uiGlyphMode(): UiGlyphMode {
	return activeGlyphMode;
}

export function uiGlyphs(): UiGlyphs {
	return activeGlyphMode === "ascii" ? ASCII_GLYPHS : UNICODE_GLYPHS;
}
