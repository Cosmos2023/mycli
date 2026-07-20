import type {
	MycliShellPendingInput,
	MycliShellQueuedInputPreview,
} from "../model.ts";
import { Text } from "../tui-core/components/text.ts";
import { getKeybindings } from "../tui-core/keybindings.ts";
import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth } from "../tui-core/utils.ts";
import { theme } from "../theme/theme.ts";
import { formatKeyText, rawKeyHint } from "./keybinding-hints.ts";

const PREVIEW_LINE_LIMIT = 3;

type PendingInputPreviewOptions = {
	interruptHint?: string;
	editHint?: string;
	maxHeight?: number | (() => number);
};

type PreviewEntry = {
	lines: string[];
	itemCount: number;
};

export class PendingInputPreviewComponent implements Component {
	constructor(
		private readonly pendingInput: MycliShellPendingInput,
		private readonly options: PendingInputPreviewOptions = {},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const entries: PreviewEntry[] = [];
		this.addSection(
			entries,
			this.pendingInput.pendingSteers,
			"Messages to be submitted after next tool call",
			width,
			`(press ${this.interruptHint()} to interrupt and send immediately)`,
		);
		this.addSection(
			entries,
			this.pendingInput.rejectedSteers,
			"Messages to be submitted at end of turn",
			width,
		);
		this.addSection(
			entries,
			this.pendingInput.followUps,
			"Queued follow-up inputs",
			width,
			undefined,
			rawKeyHint(this.editHint(), "edit last queued message"),
		);

		return this.boundEntries(entries, width, this.maxHeight());
	}

	private addSection(
		entries: PreviewEntry[],
		items: MycliShellQueuedInputPreview[],
		title: string,
		width: number,
		hintBefore?: string,
		hintAfter?: string,
	): void {
		if (items.length === 0) return;
		if (entries.length > 0) {
			entries.push({ lines: [""], itemCount: 0 });
		}
		entries.push({
			lines: [truncateToWidth(theme.bold(`• ${title}`), width, theme.fg("dim", "..."))],
			itemCount: 0,
		});
		if (hintBefore) {
			entries.push({
				lines: [truncateToWidth(theme.fg("muted", `  ${hintBefore}`), width, theme.fg("dim", "..."))],
				itemCount: 0,
			});
		}
		for (const item of items) {
			entries.push({ lines: this.messageLines(item, width), itemCount: 1 });
		}
		if (hintAfter) {
			entries.push({
				lines: [truncateToWidth(`    ${hintAfter}`, width, theme.fg("dim", "..."))],
				itemCount: 0,
			});
		}
	}

	private boundEntries(entries: PreviewEntry[], width: number, maxHeight: number): string[] {
		const kept = [...entries];
		let omitted = 0;
		const lineCount = () => kept.reduce((total, entry) => total + entry.lines.length, 0);
		while (lineCount() + (omitted > 0 ? 1 : 0) > maxHeight) {
			const itemIndex = kept.findLastIndex((entry) => entry.itemCount > 0);
			if (itemIndex < 0) break;
			omitted += kept[itemIndex]!.itemCount;
			kept.splice(itemIndex, 1);
		}

		while (lineCount() + (omitted > 0 ? 1 : 0) > maxHeight && kept.length > 0) {
			kept.pop();
		}
		const lines = kept.flatMap((entry) => entry.lines);
		if (omitted > 0 && lines.length < maxHeight) {
			lines.push(truncateToWidth(theme.fg("dim", `    ... +${omitted} more`), width, ""));
		}
		return lines.slice(0, maxHeight);
	}

	private messageLines(item: MycliShellQueuedInputPreview, width: number): string[] {
		let sanitized = item.text
			.replace(/\r\n?/g, "\n")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, " ")
			.replace(/\t/g, "   ")
			.trim();
		if (item.hasImages && !/\[image #\d+\]/i.test(sanitized)) {
			sanitized = `${sanitized} [attachment]`.trim();
		}
		const wrapped = new Text(sanitized, 4, 0).render(width);
		const visible =
			wrapped.length > PREVIEW_LINE_LIMIT
				? [
					...wrapped.slice(0, PREVIEW_LINE_LIMIT - 1),
					truncateToWidth(theme.fg("dim", "    …"), width, ""),
				]
				: wrapped.slice(0, PREVIEW_LINE_LIMIT);
		if (visible.length > 0) {
			visible[0] = visible[0]!.replace(/^ {4}/, "  ↳ ");
		}
		return visible;
	}

	private interruptHint(): string {
		return this.options.interruptHint ?? activeKeyHint("app.interrupt", "esc");
	}

	private editHint(): string {
		return this.options.editHint ?? activeKeyHint("app.message.dequeue", "alt+up");
	}

	private maxHeight(): number {
		const configured = typeof this.options.maxHeight === "function"
			? this.options.maxHeight()
			: this.options.maxHeight;
		return Math.max(1, Math.floor(configured ?? Number.MAX_SAFE_INTEGER));
	}
}

function activeKeyHint(
	action: "app.interrupt" | "app.message.dequeue",
	fallback: string,
): string {
	const key = getKeybindings().getKeys(action)[0] ?? fallback;
	return formatKeyText(key === "escape" ? "esc" : key);
}
