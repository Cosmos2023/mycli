import type { MycliShellPendingApproval } from "../model.ts";
import { getKeybindings, Spacer, Text, Container, truncateToWidth } from "../tui-core/index.ts";
import { theme } from "../theme/theme.ts";
import { stripDiffHunkHeaders, styleCompactDiff } from "./diff-renderer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ApprovalSelectorOptions {
	approval: MycliShellPendingApproval;
	onSelect: (choice: string) => void;
	onCancel: () => void;
}

const approvalShortcuts: Record<string, string> = {
	approve_once: "1",
	reject: "2",
	allow_session: "3",
	always_allow: "4",
};

const approvalShortcutLabels: Record<string, string> = {
	approve_once: "allow",
	reject: "reject",
	allow_session: "session",
	always_allow: "always",
};

export class ApprovalSelectorComponent extends Container {
	private selectedIndex = 0;
	private readonly listContainer: Container;
	private readonly responseContainer: Container;
	private readonly approval: MycliShellPendingApproval;
	private readonly onSelectCallback: (choice: string) => void;
	private readonly onCancelCallback: () => void;
	private respondedChoice: string | null = null;

	constructor(options: ApprovalSelectorOptions) {
		super();
		this.approval = options.approval;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.listContainer = new Container();
		this.responseContainer = new Container();

		this.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.titleText(), 1, 0));
		this.addChild(new Text(this.commandPreview(), 3, 0));
		if (this.approval.childSessionId) {
			this.addChild(new Text(theme.fg("muted", `⎿ ${truncateToWidth(this.approval.childSessionId, 120, "...")}`), 3, 0));
		}
		if (this.approval.reason) {
			this.addChild(new Text(theme.fg("muted", this.approval.reason), 3, 0));
		}
		if (this.approval.risk || this.approval.riskReason) {
			this.addChild(new Text(theme.fg("warning", this.riskText()), 3, 0));
		}
		if (this.approval.persistentRulePreview) {
			this.addChild(
				new Text(theme.fg("muted", `Always allow: ${this.approval.persistentRulePreview}`), 3, 0),
			);
		}
		const changePreview = this.changePreviewText();
		if (changePreview) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(changePreview, 3, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(this.responseContainer);
		this.addChild(new Text(this.footerHints(), 1, 0));
		this.updateList();
	}

	handleInput(keyData: string): void {
		if (this.respondedChoice) {
			return;
		}
		const kb = getKeybindings();
		const shortcut = this.shortcutChoice(keyData);
		if (shortcut) {
			this.respond(shortcut);
			return;
		}
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex =
				this.selectedIndex === 0 ? this.approval.options.length - 1 : Math.max(0, this.selectedIndex - 1);
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex =
				this.selectedIndex === this.approval.options.length - 1 ? 0 : Math.min(this.approval.options.length - 1, this.selectedIndex + 1);
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			const selected = this.approval.options[this.selectedIndex];
			if (selected) {
				this.respond(selected.choice);
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			const reject = this.approval.options.find((option) => option.choice === "reject");
			if (reject) {
				this.respond(reject.choice);
				return;
			}
			this.onCancelCallback();
		}
	}

	private shortcutChoice(keyData: string): string | undefined {
		const normalized = keyData.toLowerCase();
		if (normalized === "a" || normalized === "y") {
			return this.choiceByName("approve_once");
		}
		if (normalized === "r" || normalized === "n") {
			return this.choiceByName("reject");
		}
		return this.approval.options.find((option) => approvalShortcuts[option.choice] === keyData)?.choice;
	}

	private choiceByName(choice: string): string | undefined {
		return this.approval.options.find((option) => option.choice === choice)?.choice;
	}

	private respond(choice: string): void {
		this.respondedChoice = choice;
		this.updateList();
		this.updateResponse();
		this.onSelectCallback(choice);
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.respondedChoice) {
			return;
		}
		for (let index = 0; index < this.approval.options.length; index += 1) {
			const option = this.approval.options[index];
			if (!option) {
				continue;
			}
			const isSelected = index === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const shortcut = approvalShortcuts[option.choice];
			const optionText = shortcut ? `${shortcut}. ${option.label}` : option.label;
			const label = isSelected ? theme.fg("accent", optionText) : theme.fg("text", optionText);
			this.listContainer.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	private footerHints(): string {
		const optionHints = this.approval.options
			.map((option) => {
				const shortcut = approvalShortcuts[option.choice];
				const label = approvalShortcutLabels[option.choice];
				return shortcut && label ? rawKeyHint(shortcut, label) : undefined;
			})
			.filter((hint): hint is string => hint !== undefined);
		return [
			...optionHints,
			rawKeyHint("↑↓", "navigate"),
			keyHint("tui.select.confirm", "confirm"),
			keyHint("tui.select.cancel", "reject"),
		].join("  ");
	}

	private updateResponse(): void {
		this.responseContainer.clear();
		if (!this.respondedChoice) {
			return;
		}
		const approved = this.respondedChoice !== "reject";
		const color = approved ? "success" : "error";
		const text = approved ? "Approved." : "Rejected.";
		this.responseContainer.addChild(new Text(theme.fg(color, text), 1, 0));
	}

	private titleText(): string {
		const parts = [
			this.approval.toolName,
			this.approval.workerName ? `@${this.approval.workerName}` : undefined,
		].filter((part): part is string => Boolean(part));
		const suffix = parts.length ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "";
		return `${theme.fg("warning", theme.bold("Permission required"))}${suffix}`;
	}

	private commandPreview(): string {
		const preview = truncateToWidth(this.approval.preview.replace(/\s+/g, " ").trim(), 140, "...");
		return theme.fg("text", `⎿ ${preview}`);
	}

	private riskText(): string {
		return [this.approval.risk ? `risk: ${this.approval.risk}` : "", this.approval.riskReason]
			.filter(Boolean)
			.join(" · ");
	}

	private changePreviewText(): string {
		if (this.approval.diffPreview) {
			return styleCompactDiff(
				this.limitPreview(stripDiffHunkHeaders(this.approval.diffPreview)),
				"muted",
			);
		}
		if (this.approval.contentPreview) {
			const suffix =
				this.approval.contentLineCount !== undefined
					? theme.fg("muted", `\n... ${this.approval.contentLineCount} total lines`)
					: "";
			return theme.fg("muted", this.limitPreview(this.approval.contentPreview)) + suffix;
		}
		return "";
	}

	private limitPreview(text: string): string {
		const lines = text.replace(/\n+$/g, "").split("\n");
		const visible = lines.slice(0, 12);
		const hidden = lines.length - visible.length;
		if (hidden <= 0) {
			return visible.join("\n");
		}
		return `${visible.join("\n")}\n... ${hidden} more lines`;
	}
}
