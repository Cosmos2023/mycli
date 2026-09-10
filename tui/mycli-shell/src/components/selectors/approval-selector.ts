import type { MycliShellPendingApproval } from "../../model.ts";
import { getKeybindings, Container, Text } from "../../tui-core/index.ts";
import { safeErrorMessage } from "../../safe-ui-text.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme, type ThemeColor } from "../../theme/theme.ts";
import { stripDiffHunkHeaders, styleCompactDiff } from "../transcript/diff-renderer.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints } from "./decision-list.ts";
import { highlightDiffCode } from "../shared/syntax-highlight.ts";

export interface ApprovalSelectorOptions extends DecisionPanelOptions {
	approval: MycliShellPendingApproval;
	onSelect: (choice: string) => void | Promise<void>;
	onCancel: () => void;
}

const approvalShortcuts: Record<string, string> = {
	approve_once: "1",
	reject: "2",
	allow_session: "3",
	always_allow: "4",
};

export class ApprovalSelectorComponent extends Container {
	private selectedIndex = 0;
	private readonly panel: DecisionPanel;
	private readonly approval: MycliShellPendingApproval;
	private readonly onSelectCallback: (choice: string) => void | Promise<void>;
	private readonly onCancelCallback: () => void;
	private respondedChoice: string | null = null;
	private submittingChoice: string | null = null;
	private error = "";

	constructor(options: ApprovalSelectorOptions) {
		super();
		this.approval = options.approval;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.panel = new DecisionPanel(options);
		this.addChild(this.panel);
		this.rebuild();
	}

	handleInput(keyData: string): void {
		if (this.panel.handleInput(keyData)) return;
		if (this.respondedChoice || this.submittingChoice) {
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
			this.rebuild();
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex =
				this.selectedIndex === this.approval.options.length - 1 ? 0 : Math.min(this.approval.options.length - 1, this.selectedIndex + 1);
			this.rebuild();
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
		this.selectedIndex = Math.max(0, this.approval.options.findIndex((option) => option.choice === choice));
		this.submittingChoice = choice;
		this.error = "";
		this.rebuild();
		void Promise.resolve().then(() => this.onSelectCallback(choice)).then(
			() => {
				this.submittingChoice = null;
				this.respondedChoice = choice;
				this.rebuild();
			},
			(error: unknown) => {
				this.submittingChoice = null;
				this.respondedChoice = null;
				this.error = safeErrorMessage(error, "Unable to submit approval response.");
				this.rebuild();
			},
		);
	}

	private rebuild(): void {
		const isCommand = this.isShellCommand();
		const command = this.commandPreview();
		const details: string[] = isCommand ? [] : [command];
		if (this.approval.commandTruncated) details.push(theme.fg("warning", "Command preview truncated."));
		// Shell reason is a policy summary; justification is the model's approval question.
		const reason = (isCommand ? this.approval.justification : undefined) ?? this.approval.reason;
		if (reason) details.push(this.detailLine("Reason", reason));
		details.push(...this.permissionRequestLines().map((line) => theme.fg("muted", line)));
		if (this.approval.risk || this.approval.riskReason) {
			details.push(this.detailLine("Risk", this.riskText(), this.approval.risk === "high" ? "error" : "warning"));
		}
		if (this.approval.persistentRulePreview) {
			details.push(this.detailLine("Always allow", this.approval.persistentRulePreview));
		}
		if (this.approval.childSessionId) details.push(this.detailLine("Session", this.approval.childSessionId, "muted"));
		const change = this.approval.childSessionId ? this.changePreviewText() : "";
		if (change) details.push("", change);
		const status = this.submittingChoice ? theme.fg("muted", "Submitting...")
			: this.respondedChoice ? theme.fg(this.respondedChoice === "reject" ? "error" : "success",
				this.respondedChoice === "reject" ? "Rejected." : "Approved.")
				: this.error ? theme.fg("error", this.error) : "";
		this.panel.setContent({
			title: this.titleText(),
			tone: isCommand ? "accent" : "warning",
			...(isCommand ? { preview: new Text(command, 0, 0, (text) => theme.bg("toolPendingBg", text)) } : {}),
			highlightSelection: isCommand,
			details,
			items: this.approval.options.map((option) => ({
				label: option.label,
				...(approvalShortcuts[option.choice] ? { shortcut: approvalShortcuts[option.choice] } : {}),
			})),
			selectedIndex: this.selectedIndex,
			busy: Boolean(this.submittingChoice || this.respondedChoice),
			status,
			hints: decisionNavigationHints("confirm", "reject"),
		});
	}

	private titleText(): string {
		const parts = [
			this.approval.toolName,
			this.approval.workerName ? `@${this.approval.workerName}` : undefined,
		].filter((part): part is string => Boolean(part));
		const suffix = parts.length ? theme.fg("muted", ` ${uiGlyphs().separator} ${parts.join(` ${uiGlyphs().separator} `)}`) : "";
		return `${theme.fg("warning", theme.bold("Permission required"))}${suffix}`;
	}

	private commandPreview(): string {
		const isCommand = this.isShellCommand();
		const preview = isCommand ? this.approval.commandPreview ?? this.approval.preview : this.approval.preview;
		if (!isCommand) return theme.fg("text", `${uiGlyphs().output} ${preview}`);
		const command = preview.replace(/\r\n?/gu, "\n");
		return `${theme.fg("accent", theme.bold("$"))} ${highlightDiffCode(command, "bash", command.split("\n").length)}`;
	}

	private isShellCommand(): boolean {
		return ["Shell", "Bash", "exec_command"].includes(this.approval.toolName ?? "");
	}

	private detailLine(label: string, value: string, tone: ThemeColor = "text"): string {
		return `${theme.fg("muted", `${label}:`)} ${theme.fg(tone, value)}`;
	}

	private riskText(): string {
		return [this.approval.risk, this.approval.riskReason]
			.filter(Boolean)
			.join(` ${uiGlyphs().separator} `);
	}

	private permissionRequestLines(): string[] {
		const request = this.approval.permissionRequest;
		if (!request) return [];
		return [
			...(request.network ? ["Network: enabled"] : []),
			...this.permissionPathLines("Read", request.readPaths),
			...this.permissionPathLines("Write", request.writePaths),
		];
	}

	private permissionPathLines(label: string, paths: string[]): string[] {
		return paths.map((path) => `${label}: ${path}`);
	}

	private changePreviewText(): string {
		if (this.approval.diffPreview) {
			return styleCompactDiff(
				stripDiffHunkHeaders(this.approval.diffPreview),
				"muted",
			);
		}
		if (this.approval.contentPreview) {
			const suffix =
				this.approval.contentLineCount !== undefined
					? theme.fg("muted", `\n... ${this.approval.contentLineCount} total lines`)
					: "";
			return theme.fg("muted", this.approval.contentPreview) + suffix;
		}
		return "";
	}

}
