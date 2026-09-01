import {
	TUI_KEYMAP_ACTIONS,
	type TuiKeymapActionId,
} from "@mycli/contracts";
import {
	type Keybinding,
	type KeybindingDefinitions,
	KeybindingsManager,
	setKeybindings,
} from "./tui-core/index.ts";
import type { KeybindingsConfig } from "./tui-core/keybindings.ts";
import type { KeyId } from "./tui-core/keys.ts";

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

const MYCLI_KEYBINDINGS: KeybindingDefinitions = Object.freeze(Object.fromEntries(
	TUI_KEYMAP_ACTIONS.map((action) => [action.id, Object.freeze({
		defaultKeys: [...action.defaultKeys] as KeyId[],
		description: action.description,
		context: action.context,
	})]),
));

export function createMycliKeybindings(
	bindings?: Readonly<Partial<Record<TuiKeymapActionId, readonly string[]>>>,
): KeybindingsManager {
	return new KeybindingsManager(MYCLI_KEYBINDINGS, keybindingsConfig(bindings));
}

export function installMycliKeybindings(
	bindings?: Readonly<Partial<Record<TuiKeymapActionId, readonly string[]>>>,
): KeybindingsManager {
	const keybindings = createMycliKeybindings(bindings);
	setKeybindings(keybindings);
	return keybindings;
}

export function applyMycliKeymap(
	keybindings: KeybindingsManager,
	bindings?: Readonly<Partial<Record<TuiKeymapActionId, readonly string[]>>>,
): void {
	keybindings.setUserBindings(keybindingsConfig(bindings));
}

function keybindingsConfig(
	bindings?: Readonly<Partial<Record<TuiKeymapActionId, readonly string[]>>>,
): KeybindingsConfig {
	if (!bindings) return {};
	return Object.fromEntries(TUI_KEYMAP_ACTIONS.flatMap((action) => {
		const keys = bindings[action.id];
		return keys === undefined ? [] : [[action.id, [...keys] as KeyId[]]];
	}));
}
