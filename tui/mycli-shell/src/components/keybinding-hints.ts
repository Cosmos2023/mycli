import { theme } from "../theme/theme.ts";

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
		case "app.transcript.open":
			return "ctrl+t";
		case "app.model.select":
			return "ctrl+l";
		case "app.message.followUp":
			return "tab";
		case "app.message.dequeue":
			return "alt+up";
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
