import { theme } from "../theme/theme.ts";

export function formatKeyText(key: string): string {
	return key
		.split("/")
		.map((part) =>
			part
				.split("+")
				.map((segment) => (process.platform === "darwin" && segment.toLowerCase() === "alt" ? "option" : segment))
				.join("+"),
		)
		.join("/");
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

export function keyHint(action: string, description: string): string {
	return rawKeyHint(defaultKeyForAction(action), description);
}

function defaultKeyForAction(action: string): string {
	switch (action) {
		case "app.interrupt":
			return "esc";
		case "app.exit":
			return "ctrl+d";
		case "app.tools.expand":
			return "ctrl+o";
		case "app.model.select":
			return "ctrl+l";
		case "app.message.followUp":
			return "alt+enter";
		case "tui.select.confirm":
			return "enter";
		case "tui.select.cancel":
			return "esc";
		case "tui.input.tab":
			return "tab";
		default:
			return action;
	}
}
