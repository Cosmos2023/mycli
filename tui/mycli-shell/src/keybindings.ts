import {
	type Keybinding,
	type KeybindingDefinitions,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./tui-core/index.ts";

declare module "./tui-core/keybindings.ts" {
	interface Keybindings {
		"app.interrupt": true;
		"app.exit": true;
		"app.tools.expand": true;
		"app.model.select": true;
		"app.commandPalette": true;
		"app.help": true;
		"app.mode.cycle": true;
		"app.permissions.open": true;
		"app.message.followUp": true;
		"app.message.dequeue": true;
		"app.clipboard.pasteImage": true;
	}
}

export type AppKeybinding = Extract<Keybinding, `app.${string}`>;

const APP_KEYBINDINGS = {
	"app.interrupt": { defaultKeys: "escape", description: "Interrupt / cancel" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "Select model" },
	"app.commandPalette": { defaultKeys: "ctrl+p", description: "Open commands" },
	"app.help": { defaultKeys: "?", description: "Open help" },
	"app.mode.cycle": { defaultKeys: "shift+tab", description: "Cycle mode" },
	"app.permissions.open": { defaultKeys: "ctrl+x", description: "Open permissions" },
	"app.message.followUp": { defaultKeys: "tab", description: "Queue follow-up" },
	"app.message.dequeue": { defaultKeys: ["alt+up", "shift+left"], description: "Edit last queued follow-up" },
	"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste image" },
} as const satisfies KeybindingDefinitions;

export function createMycliKeybindings(): KeybindingsManager {
	return new KeybindingsManager({
		...TUI_KEYBINDINGS,
		...APP_KEYBINDINGS,
	});
}

export function installMycliKeybindings(): KeybindingsManager {
	const keybindings = createMycliKeybindings();
	setKeybindings(keybindings);
	return keybindings;
}
