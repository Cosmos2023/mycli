import type { MycliShellPendingClarification } from "../model.ts";
import { decodePrintableKey } from "../tui-core/keys.ts";
import { Container, getKeybindings, matchesKey, Spacer, Text } from "../tui-core/index.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { ResponsiveDescriptionRow, SegmentedHintLine } from "./responsive-row.ts";

export interface ClarificationSelectorOptions {
	clarification: MycliShellPendingClarification;
	onRespond: (response: string) => void | Promise<void>;
	onCancel: () => void;
}

export class ClarificationSelectorComponent extends Container {
	private selectedIndex = 0;
	private readonly selectedLabels = new Set<string>();
	private readonly listContainer = new Container();
	private readonly responseContainer = new Container();
	private readonly clarification: MycliShellPendingClarification;
	private readonly onRespondCallback: (response: string) => void | Promise<void>;
	private readonly onCancelCallback: () => void;
	private customMode = false;
	private customText = "";
	private responded = false;
	private submitting = false;
	private submittedResponse = "";

	constructor(options: ClarificationSelectorOptions) {
		super();
		this.clarification = options.clarification;
		this.onRespondCallback = options.onRespond;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.titleText(), 1, 0));
		this.addChild(new Text(theme.fg("text", this.clarification.question), 3, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(this.responseContainer);
		this.updateSurface();
	}

	handleInput(keyData: string): void {
		if (this.responded || this.submitting) return;
		if (this.customMode) {
			this.handleCustomInput(keyData);
			return;
		}

		const shortcutIndex = this.shortcutIndex(keyData);
		if (shortcutIndex !== null) {
			this.selectedIndex = shortcutIndex;
			this.activateSelected();
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
			return;
		}
		if (this.clarification.multiSelect && matchesKey(keyData, "space")) {
			this.toggleSelected();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			if (this.clarification.multiSelect) {
				this.submitMultiSelection();
			} else {
				this.activateSelected();
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	private handleCustomInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			this.customMode = false;
			this.customText = "";
			this.updateSurface();
			return;
		}
		if (matchesKey(keyData, "enter")) {
			const custom = this.customText.trim();
			if (!custom) return;
			const selected = [...this.selectedLabels].filter((label) => !this.isOtherLabel(label));
			this.respond([...selected, custom].join(", "));
			return;
		}
		if (matchesKey(keyData, "backspace")) {
			this.customText = this.customText.slice(0, -1);
			this.updateSurface();
			return;
		}
		const printable = decodePrintableKey(keyData) ?? this.rawPrintable(keyData);
		if (printable) {
			this.customText += printable;
			this.updateSurface();
		}
	}

	private rawPrintable(keyData: string): string | undefined {
		if (!keyData || keyData.includes("\x1b") || keyData.charCodeAt(0) < 32) return undefined;
		return keyData;
	}

	private shortcutIndex(keyData: string): number | null {
		if (!/^[1-9]$/.test(keyData)) return null;
		const index = Number(keyData) - 1;
		return index < this.clarification.options.length ? index : null;
	}

	private moveSelection(delta: number): void {
		const count = this.clarification.options.length;
		if (count === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.updateSurface();
	}

	private activateSelected(): void {
		const option = this.clarification.options[this.selectedIndex];
		if (!option) return;
		if (this.isOtherLabel(option.label)) {
			this.customMode = true;
			this.updateSurface();
			return;
		}
		if (this.clarification.multiSelect) {
			this.toggleSelected();
			return;
		}
		this.respond(option.label);
	}

	private toggleSelected(): void {
		const option = this.clarification.options[this.selectedIndex];
		if (!option) return;
		if (this.isOtherLabel(option.label)) {
			this.customMode = true;
			this.updateSurface();
			return;
		}
		if (this.selectedLabels.has(option.label)) {
			this.selectedLabels.delete(option.label);
		} else {
			this.selectedLabels.add(option.label);
		}
		this.updateSurface();
	}

	private submitMultiSelection(): void {
		if (this.selectedLabels.size === 0) return;
		this.respond([...this.selectedLabels].join(", "));
	}

	private respond(response: string): void {
		this.submitting = true;
		this.submittedResponse = response;
		this.updateSurface();
		this.updateResponse();
		void Promise.resolve().then(() => this.onRespondCallback(response)).then(
			() => {
				this.submitting = false;
				this.responded = true;
				this.updateResponse();
			},
			() => {
				this.submitting = false;
				this.responded = false;
				this.submittedResponse = "";
				this.updateSurface();
				this.updateResponse();
			},
		);
	}

	private updateSurface(): void {
		this.listContainer.clear();
		if (this.responded || this.submitting) return;
		if (this.customMode) {
			this.listContainer.addChild(new Text(theme.fg("muted", "Other answer"), 1, 0));
			this.listContainer.addChild(new Text(`${theme.fg("accent", "> ")}${this.customText || theme.fg("muted", "Type a response")}`, 1, 0));
			this.listContainer.addChild(new Text(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "back")}`, 1, 0));
			return;
		}

		for (let index = 0; index < this.clarification.options.length; index += 1) {
			const option = this.clarification.options[index];
			if (!option) continue;
			const active = index === this.selectedIndex;
			const checked = this.selectedLabels.has(option.label);
			const marker = this.clarification.multiSelect ? (checked ? "[x] " : "[ ] ") : "";
			const prefix = active ? theme.fg("accent", "→ ") : "  ";
			const label = `${index + 1}. ${marker}${option.label}`;
			this.listContainer.addChild(new ResponsiveDescriptionRow(
				prefix,
				active ? theme.fg("accent", label) : theme.fg("text", label),
				option.description ? theme.fg("muted", option.description) : "",
			));
		}
		const hints = [
			rawKeyHint("↑↓", "navigate"),
			...(this.clarification.multiSelect ? [rawKeyHint("space", "toggle")] : []),
			keyHint("tui.select.confirm", this.clarification.multiSelect ? "submit" : "select"),
			keyHint("tui.select.cancel", "interrupt"),
		];
		this.listContainer.addChild(new SegmentedHintLine(hints, 1));
	}

	private updateResponse(): void {
		this.responseContainer.clear();
		if (this.submitting) {
			this.responseContainer.addChild(new Text(theme.fg("muted", "Submitting..."), 1, 0));
			return;
		}
		if (this.responded) {
			this.responseContainer.addChild(
				new Text(theme.fg("success", `Answered: ${this.submittedResponse}`), 1, 0),
			);
		}
	}

	private titleText(): string {
		const title = this.clarification.header?.trim() || "Question";
		return theme.fg("accent", theme.bold(title));
	}

	private isOtherLabel(label: string): boolean {
		return label.trim().toLowerCase() === "other";
	}
}
