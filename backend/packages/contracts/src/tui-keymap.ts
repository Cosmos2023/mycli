export const TUI_KEYMAP_CONTEXTS = ["app", "editor", "selector"] as const;

export type TuiKeymapContext = typeof TUI_KEYMAP_CONTEXTS[number];

export interface TuiKeymapActionDescriptor {
	readonly id: string;
	readonly context: TuiKeymapContext;
	readonly configKey: string;
	readonly description: string;
	readonly defaultKeys: readonly string[];
	readonly required: boolean;
	readonly cancelable: boolean;
}

export const TUI_KEYMAP_ACTIONS = [
	action("app.interrupt", "app", "interrupt", "Interrupt or cancel the active operation", ["escape"], true, true),
	action("app.exit", "app", "exit", "Exit when the input editor is empty", ["ctrl+d"], true),
	action("app.tools.expand", "app", "tools_expand", "Expand or collapse tool details", ["ctrl+o"]),
	action("app.transcript.open", "app", "transcript_open", "Open the complete transcript", ["ctrl+t"]),
	action("app.model.select", "app", "model_select", "Open model selection", ["ctrl+l"]),
	action("app.commandPalette", "app", "command_palette", "Open the command palette", ["ctrl+p"]),
	action("app.help", "app", "help", "Open keyboard and command help", ["?"]),
	action("app.permissions.open", "app", "permissions_open", "Open permission settings", ["ctrl+x"]),
	action("app.message.followUp", "app", "message_follow_up", "Queue a follow-up while a turn runs", ["tab"]),
	action("app.message.dequeue", "app", "message_dequeue", "Restore the latest queued follow-up", ["alt+up", "shift+left"]),
	action("tui.editor.cursorUp", "editor", "cursor_up", "Move the cursor up", ["up"]),
	action("tui.editor.cursorDown", "editor", "cursor_down", "Move the cursor down", ["down"]),
	action("tui.editor.cursorLeft", "editor", "cursor_left", "Move the cursor left", ["left", "ctrl+b"]),
	action("tui.editor.cursorRight", "editor", "cursor_right", "Move the cursor right", ["right", "ctrl+f"]),
	action("tui.editor.cursorWordLeft", "editor", "cursor_word_left", "Move one word left", ["alt+left", "ctrl+left", "alt+b"]),
	action("tui.editor.cursorWordRight", "editor", "cursor_word_right", "Move one word right", ["alt+right", "ctrl+right", "alt+f"]),
	action("tui.editor.cursorLineStart", "editor", "cursor_line_start", "Move to the start of the line", ["home", "ctrl+a"]),
	action("tui.editor.cursorLineEnd", "editor", "cursor_line_end", "Move to the end of the line", ["end", "ctrl+e"]),
	action("tui.editor.jumpForward", "editor", "jump_forward", "Jump forward to a character", ["ctrl+]"]),
	action("tui.editor.jumpBackward", "editor", "jump_backward", "Jump backward to a character", ["ctrl+alt+]"]),
	action("tui.editor.pageUp", "editor", "page_up", "Move one editor page up", ["pageUp"]),
	action("tui.editor.pageDown", "editor", "page_down", "Move one editor page down", ["pageDown"]),
	action("tui.editor.deleteCharBackward", "editor", "delete_char_backward", "Delete the previous character", ["backspace"]),
	action("tui.editor.deleteCharForward", "editor", "delete_char_forward", "Delete the next character", ["delete", "ctrl+d"]),
	action("tui.editor.deleteWordBackward", "editor", "delete_word_backward", "Delete the previous word", ["ctrl+w", "alt+backspace"]),
	action("tui.editor.deleteWordForward", "editor", "delete_word_forward", "Delete the next word", ["alt+d", "alt+delete"]),
	action("tui.editor.deleteToLineStart", "editor", "delete_to_line_start", "Delete to the start of the line", ["ctrl+u"]),
	action("tui.editor.deleteToLineEnd", "editor", "delete_to_line_end", "Delete to the end of the line", ["ctrl+k"]),
	action("tui.editor.yank", "editor", "yank", "Paste the latest killed text", ["ctrl+y"]),
	action("tui.editor.yankPop", "editor", "yank_pop", "Cycle the kill ring after paste", ["alt+y"]),
	action("tui.editor.undo", "editor", "undo", "Undo the latest edit", ["ctrl+-"]),
	action("tui.input.newLine", "editor", "new_line", "Insert a newline", ["shift+enter"]),
	action("tui.input.submit", "editor", "submit", "Submit the current input", ["enter"], true),
	action("tui.input.tab", "editor", "tab", "Complete or change the active input scope", ["tab"]),
	action("tui.input.copy", "editor", "copy", "Copy the active selection", ["ctrl+c"]),
	action("tui.select.up", "selector", "up", "Move selection up", ["up"]),
	action("tui.select.down", "selector", "down", "Move selection down", ["down"]),
	action("tui.select.pageUp", "selector", "page_up", "Move one selection page up", ["pageUp"]),
	action("tui.select.pageDown", "selector", "page_down", "Move one selection page down", ["pageDown"]),
	action("tui.select.previousGroup", "selector", "previous_group", "Move to the previous selection group", ["["]),
	action("tui.select.nextGroup", "selector", "next_group", "Move to the next selection group", ["]"]),
	action("tui.select.confirm", "selector", "confirm", "Confirm the selected item", ["enter"], true),
	action("tui.select.options", "selector", "options", "Open options for the selected item", ["tab"]),
	action("tui.select.cancel", "selector", "cancel", "Cancel or leave the selector", ["escape", "ctrl+c"], true, true),
] as const satisfies readonly TuiKeymapActionDescriptor[];

export type TuiKeymapActionId = typeof TUI_KEYMAP_ACTIONS[number]["id"];

const ACTION_BY_ID: ReadonlyMap<string, TuiKeymapActionDescriptor> = new Map(
	TUI_KEYMAP_ACTIONS.map((item) => [item.id, item]),
);

const ACTION_BY_CONFIG_PATH: ReadonlyMap<string, TuiKeymapActionDescriptor> = new Map(
	TUI_KEYMAP_ACTIONS.map((item) => [configPath(item.context, item.configKey), item]),
);

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const NAMED_KEYS = new Map<string, string>([
	["escape", "escape"],
	["esc", "escape"],
	["enter", "enter"],
	["return", "enter"],
	["tab", "tab"],
	["space", "space"],
	["backspace", "backspace"],
	["delete", "delete"],
	["insert", "insert"],
	["clear", "clear"],
	["home", "home"],
	["end", "end"],
	["pageup", "pageUp"],
	["pagedown", "pageDown"],
	["up", "up"],
	["down", "down"],
	["left", "left"],
	["right", "right"],
	...Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `f${index + 1}`] as const),
]);
const SYMBOL_KEYS = new Set("`-=[]\\;',./!?@#$%^&*()_|~{}:<>");

export function tuiKeymapAction(id: string): TuiKeymapActionDescriptor | undefined {
	return ACTION_BY_ID.get(id);
}

export function tuiKeymapActionForConfig(
	context: string,
	configKey: string,
): TuiKeymapActionDescriptor | undefined {
	return ACTION_BY_CONFIG_PATH.get(configPath(context, configKey));
}

export function tuiKeymapConfigPath(action: TuiKeymapActionDescriptor): string {
	return `tui.keymap.${action.context}.${action.configKey}`;
}

export function normalizeTuiKeySpec(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 64) return undefined;
	const parts = trimmed.split("+");
	if (parts.some((part) => !part.trim())) return undefined;
	const rawBase = parts.at(-1)!.trim().toLowerCase();
	const modifiers = new Set<string>();
	for (const rawModifier of parts.slice(0, -1)) {
		const modifier = rawModifier.trim().toLowerCase();
		if (!MODIFIERS.has(modifier) || modifiers.has(modifier)) return undefined;
		modifiers.add(modifier);
	}
	const base = normalizeBaseKey(rawBase);
	if (!base || (base === "escape" && modifiers.size > 0)) return undefined;
	const prefix = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
	return prefix.length > 0 ? `${prefix.join("+")}+${base}` : base;
}

function action<const Id extends string>(
	id: Id,
	context: TuiKeymapContext,
	configKey: string,
	description: string,
	defaultKeys: readonly string[],
	required = false,
	cancelable = false,
): Readonly<{
	id: Id;
	context: TuiKeymapContext;
	configKey: string;
	description: string;
	defaultKeys: readonly string[];
	required: boolean;
	cancelable: boolean;
}> {
	return Object.freeze({
		id,
		context,
		configKey,
		description,
		defaultKeys: Object.freeze([...defaultKeys]),
		required,
		cancelable,
	});
}

function normalizeBaseKey(value: string): string | undefined {
	const named = NAMED_KEYS.get(value);
	if (named) return named;
	if (/^[a-z0-9]$/u.test(value) || SYMBOL_KEYS.has(value)) return value;
	return undefined;
}

function configPath(context: string, key: string): string {
	return `${context}\0${key}`;
}
