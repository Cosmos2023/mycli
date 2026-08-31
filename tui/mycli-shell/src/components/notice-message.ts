import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellMessage } from "../model.ts";
import { theme } from "../theme/theme.ts";

type NoticeMessage = Extract<
	MycliShellMessage,
	{ role: "system" | "error" | "warning" }
>;

export class NoticeMessageComponent extends Container {
	constructor(message: NoticeMessage) {
		super();
		const error = message.role === "error";
		const glyph = process.env.TERM?.toLowerCase() === "dumb"
			? error ? "x" : "!"
			: error ? "■" : "⚠";
		const color = error ? "error" : "warning";
		this.addChild(new Text(theme.fg(color, `${glyph} ${message.text}`), 1, 0));
		const diagnostic = diagnosticText(message);
		if (diagnostic) {
			this.addChild(new Text(theme.fg("dim", `  └ ${diagnostic}`), 1, 0));
		}
	}
}

function diagnosticText(message: NoticeMessage): string | undefined {
	const diagnostic = message.diagnostic;
	const recovery = diagnostic?.recoveryActions?.[0];
	const recoveryText = recovery
		? `${recovery.label}${recovery.command ? ` (${recovery.command})` : ""}`
		: undefined;
	const values = diagnostic?.hint
		? [diagnostic.hint, diagnostic.details]
		: [
			diagnostic?.details,
			recoveryText,
			diagnostic?.code,
			diagnostic?.method,
			diagnostic?.source,
		];
	const visibleValues = values.filter((value): value is string => Boolean(value));
	return visibleValues.length > 0 ? visibleValues.join(" · ") : undefined;
}
