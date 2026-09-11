import { Text } from "../../tui-core/components/text.ts";
import { Container } from "../../tui-core/tui.ts";
import type { MycliShellMessage } from "../../model.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";

type NoticeMessage = Extract<
	MycliShellMessage,
	{ role: "system" | "error" | "warning" }
>;

export class NoticeMessageComponent extends Container {
	constructor(message: NoticeMessage) {
		super();
		const error = message.role === "error";
		const glyphs = uiGlyphs();
		const glyph = error ? glyphs.error : glyphs.warning;
		const color = error ? "error" : "warning";
		this.addChild(new Text(theme.fg(color, `${glyph} ${message.text}`), 1, 0));
		for (const line of diagnosticLines(message)) {
			this.addChild(new Text(theme.fg("dim", `  ${glyphs.branch} ${line}`), 1, 0));
		}
	}
}

function diagnosticLines(message: NoticeMessage): readonly string[] {
	const diagnostic = message.diagnostic;
	const recovery = diagnostic?.recoveryActions?.[0];
	const recoveryText = recovery
		? `${recovery.label}${recovery.command ? ` (${recovery.command})` : ""}`
		: undefined;
	const values = [diagnostic?.details, diagnostic?.hint ?? recoveryText];
	const visibleValues = values.filter((value): value is string => Boolean(value));
	if (diagnostic?.expanded) {
		const context = diagnostic.errorContext;
		const technical = [context?.reason ?? diagnostic.code, context?.source ?? diagnostic.source,
			diagnostic.method, context ? `${context.scope.kind}: ${context.scope.id}` : undefined,
			context?.id ?? diagnostic.occurrenceId,
		].filter(Boolean).join(` ${uiGlyphs().separator} `);
		if (technical) visibleValues.push(technical);
	}
	return visibleValues;
}
