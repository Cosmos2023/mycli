import type { MycliShellPendingClarification } from "../../model.ts";
import { decodePrintableKey } from "../../tui-core/keys.ts";
import { Container, getKeybindings, matchesKey } from "../../tui-core/index.ts";
import { safeErrorMessage } from "../../safe-ui-text.ts";
import { theme } from "../../theme/theme.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints } from "./decision-list.ts";
import { keyHint, rawKeyHint } from "../shared/keybinding-hints.ts";

export interface ClarificationSelectorOptions extends DecisionPanelOptions {
	clarification: MycliShellPendingClarification;
	onRespond: (response: string) => void | Promise<void>;
	onCancel: () => void;
}

export class ClarificationSelectorComponent extends Container {
	private selectedIndex = 0;
	private readonly selectedLabels = new Set<string>();
	private readonly panel: DecisionPanel;
	private readonly clarification: MycliShellPendingClarification;
	private readonly onRespondCallback: (response: string) => void | Promise<void>;
	private readonly onCancelCallback: () => void;
	private customMode = false;
	private customText = "";
	private responded = false;
	private submitting = false;
	private submittedResponse = "";
	private error = "";

	constructor(options: ClarificationSelectorOptions) {
		super();
		this.clarification = options.clarification;
		this.onRespondCallback = options.onRespond;
		this.onCancelCallback = options.onCancel;

		this.panel = new DecisionPanel(options);
		this.addChild(this.panel);
		this.updateSurface();
	}

	handleInput(keyData: string): void {
		if (this.panel.handleInput(keyData)) return;
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
		this.error = "";
		this.submittedResponse = response;
		this.updateSurface();
		void Promise.resolve().then(() => this.onRespondCallback(response)).then(
			() => {
				this.submitting = false;
				this.responded = true;
				this.updateSurface();
			},
			(error: unknown) => {
				this.submitting = false;
				this.responded = false;
				this.submittedResponse = "";
				this.error = safeErrorMessage(error, "Unable to submit clarification response.");
				this.updateSurface();
			},
		);
	}

	private updateSurface(): void {
		const details = [theme.fg("text", this.clarification.question)];
		if (this.customMode) details.push("", theme.fg("muted", "Other answer"),
			`${theme.fg("accent", "> ")}${this.customText || theme.fg("muted", "Type a response")}`);
		const status = this.submitting ? theme.fg("muted", "Submitting...")
			: this.responded ? theme.fg("success", `Answered: ${this.submittedResponse}`)
				: this.error ? theme.fg("error", this.error) : "";
		this.panel.setContent({
			title: this.titleText(),
			details,
			items: this.customMode ? [] : this.clarification.options.map((option, index) => ({
				label: `${this.clarification.multiSelect ? (this.selectedLabels.has(option.label) ? "[x] " : "[ ] ") : ""}${option.label}`,
				shortcut: String(index + 1),
				...(option.description ? { description: option.description } : {}),
			})),
			selectedIndex: this.selectedIndex,
			busy: this.submitting || this.responded,
			status,
			hints: this.customMode ? [keyHint("tui.select.confirm", "submit"), keyHint("tui.select.cancel", "back")]
				: [
					...decisionNavigationHints(this.clarification.multiSelect ? "submit" : "select", "interrupt"),
					...(this.clarification.multiSelect ? [rawKeyHint("space", "toggle")] : []),
				],
		});
	}

	private titleText(): string {
		const title = this.clarification.header?.trim() || "Question";
		return theme.fg("accent", theme.bold(title));
	}

	private isOtherLabel(label: string): boolean {
		return label.trim().toLowerCase() === "other";
	}
}
