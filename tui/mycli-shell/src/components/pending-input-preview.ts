import type { MycliShellPendingInput } from "../model.ts";
import { Text } from "../tui-core/components/text.ts";
import type { Component } from "../tui-core/tui.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

const PREVIEW_LINE_LIMIT = 3;

export class PendingInputPreviewComponent implements Component {
	constructor(private readonly pendingInput: MycliShellPendingInput) {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.pendingInput.steering.length > 0) {
			lines.push(...new Text(theme.bold("• Messages to be submitted after next tool call"), 1, 0).render(width));
			lines.push(...new Text(theme.fg("muted", "(press esc to interrupt and send immediately)"), 2, 0).render(width));
			for (const item of this.pendingInput.steering) {
				lines.push(...this.messageLines(item.text, width));
			}
		}

		if (this.pendingInput.steering.length > 0 && this.pendingInput.followUps.length > 0) {
			lines.push("");
		}

		if (this.pendingInput.followUps.length > 0) {
			lines.push(...new Text(theme.bold("• Queued follow-up inputs"), 1, 0).render(width));
			for (const item of this.pendingInput.followUps) {
				lines.push(...this.messageLines(item.text, width));
			}
			lines.push(...new Text(keyHint("app.message.dequeue", "edit last queued message"), 4, 0).render(width));
		}

		return lines;
	}

	private messageLines(text: string, width: number): string[] {
		const sanitized = text
			.replace(/\r\n?/g, "\n")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, " ")
			.replace(/\t/g, "   ")
			.trim();
		const wrapped = new Text(sanitized, 4, 0).render(width);
		const visible =
			wrapped.length > PREVIEW_LINE_LIMIT
				? [...wrapped.slice(0, PREVIEW_LINE_LIMIT - 1), theme.fg("dim", "    …")]
				: wrapped.slice(0, PREVIEW_LINE_LIMIT);
		if (visible.length > 0) {
			visible[0] = visible[0]!.replace(/^ {4}/, "  ↳ ");
		}
		return visible;
	}
}
