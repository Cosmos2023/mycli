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
		"app.transcript.open": true;
		"app.model.select": true;
		"app.commandPalette": true;
		"app.help": true;
		"app.permissions.open": true;
		"app.message.followUp": true;
		"app.message.dequeue": true;
	}
}

export type AppKeybinding = Extract<Keybinding, `app.${string}`>;

const APP_KEYBINDINGS = {
	"app.interrupt": { defaultKeys: "escape", description: "Interrupt / cancel", context: "app" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit", context: "app" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output", context: "app" },
	"app.transcript.open": { defaultKeys: "ctrl+t", description: "Open transcript", context: "app" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "Select model", context: "app" },
	"app.commandPalette": { defaultKeys: "ctrl+p", description: "Open commands", context: "app" },
	"app.help": { defaultKeys: "?", description: "Open help", context: "app" },
	"app.permissions.open": { defaultKeys: "ctrl+x", description: "Open permissions", context: "app" },
	"app.message.followUp": { defaultKeys: "tab", description: "Queue follow-up", context: "app" },
	"app.message.dequeue": {
		defaultKeys: ["alt+up", "shift+left"],
		description: "Edit last queued follow-up",
		context: "app",
	},
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
