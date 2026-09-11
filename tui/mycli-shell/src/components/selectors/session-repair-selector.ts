import type {
	MycliShellResumeRepairAction,
	MycliShellResumeRepairPreview,
} from "../../model.ts";
import { safeErrorMessage } from "../../safe-ui-text.ts";
import { Container, getKeybindings } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints } from "./decision-list.ts";

export interface SessionRepairSelectorOptions extends DecisionPanelOptions {
	preview: MycliShellResumeRepairPreview;
	onSelect: (action: MycliShellResumeRepairAction) => void | Promise<void>;
	onCancel: () => void;
}

export class SessionRepairSelectorComponent extends Container {
	private selectedIndex = 0;
	private submitting = false;
	private error: string | null = null;
	private readonly panel: DecisionPanel;
	private readonly preview: MycliShellResumeRepairPreview;
	private readonly onSelectCallback: SessionRepairSelectorOptions["onSelect"];
	private readonly onCancelCallback: SessionRepairSelectorOptions["onCancel"];

	constructor(options: SessionRepairSelectorOptions) {
		super();
		this.preview = options.preview;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.panel = new DecisionPanel(options);
		this.addChild(this.panel);
		this.rebuild();
	}

	setError(message: string): void {
		this.submitting = false;
		this.error = message.trim() || "Session recovery failed.";
		this.rebuild();
	}

	handleInput(keyData: string): void {
		if (this.panel.handleInput(keyData)) return;
		if (this.submitting) return;
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.move(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.move(1);
			return;
		}
		if (/^[1-9]$/u.test(keyData) && Number(keyData) <= this.preview.actions.length) {
			this.selectedIndex = Number(keyData) - 1;
			this.confirm();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			this.confirm();
		}
	}

	private move(delta: number): void {
		if (this.preview.actions.length === 0) return;
		this.selectedIndex = (
			this.selectedIndex + delta + this.preview.actions.length
		) % this.preview.actions.length;
		this.error = null;
		this.rebuild();
	}

	private confirm(): void {
		const action = this.preview.actions[this.selectedIndex];
		if (!action) return;
		this.submitting = true;
		this.error = null;
		this.rebuild();
		void Promise.resolve().then(() => this.onSelectCallback(action)).catch((error: unknown) => {
			this.setError(safeErrorMessage(error, "Session recovery failed."));
		});
	}

	private rebuild(): void {
		const title = this.preview.session.title?.trim() || this.preview.session.id;
		const details = [theme.fg("text", title)];
		if (this.preview.session.cwd) details.push(theme.fg("muted", this.preview.session.cwd));
		for (const issue of this.preview.issues) {
			const marker = issue.blocking ? "[!]" : "[i]";
			const color = issue.blocking ? "warning" : "muted";
			details.push(theme.fg(color, `${marker} ${issue.message}`));
		}
		const status = this.submitting ? theme.fg("muted", "Applying recovery...")
			: this.error ? theme.fg("error", this.error)
				: this.preview.actions.length === 0 ? theme.fg("warning", "No automatic recovery action is available.") : "";
		this.panel.setContent({
			title: theme.bold("Repair Session"),
			tone: "warning",
			details,
			items: this.preview.actions.map((action, index) => ({
				label: repairActionLabel(action),
				description: repairActionDescription(action),
				shortcut: String(index + 1),
			})),
			selectedIndex: this.selectedIndex,
			busy: this.submitting,
			status,
			hints: decisionNavigationHints("confirm", "cancel"),
		});
	}
}

function repairActionLabel(action: MycliShellResumeRepairAction): string {
	if (action === "takeover_stale_owner") return "Take over stale session";
	if (action === "unarchive") return "Unarchive and continue";
	return "Fork with current settings";
}

function repairActionDescription(action: MycliShellResumeRepairAction): string {
	if (action === "takeover_stale_owner") {
		return "Confirm the old owner is gone, then acquire the session atomically.";
	}
	if (action === "unarchive") return "Make the original session visible and resumable again.";
	return "Keep the original unchanged and resume a new fork in the current environment.";
}
