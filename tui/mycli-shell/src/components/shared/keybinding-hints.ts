import { tuiKeymapAction } from "@mycli/contracts";
import {
	getKeybindings,
	type Keybinding,
} from "../../tui-core/keybindings.ts";
import { theme } from "../../theme/theme.ts";

export function formatKeyText(key: string, platform: NodeJS.Platform = process.platform): string {
	return key
		.split("/")
		.map((part) =>
			part
				.split("+")
				.map((segment) => (platform === "darwin" && segment.toLowerCase() === "alt" ? "option" : segment))
				.join("+"),
		)
		.join("/");
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

export function keyHint(action: string, description: string): string {
	return rawKeyHint(keyForAction(action), description);
}

export function keyForAction(action: string): string {
	const descriptor = tuiKeymapAction(action);
	if (!descriptor) return action;
	const key = getKeybindings().getKeys(descriptor.id as Keybinding)[0]
		?? descriptor.defaultKeys[0]
		?? action;
	return key === "escape" ? "esc" : key;
}
