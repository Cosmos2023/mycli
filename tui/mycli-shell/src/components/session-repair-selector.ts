import type {
	MycliShellResumeRepairAction,
	MycliShellResumeRepairPreview,
} from "../model.ts";
import { safeErrorMessage } from "../safe-ui-text.ts";
import { Container, getKeybindings, Spacer, Text, TruncatedText } from "../tui-core/index.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface SessionRepairSelectorOptions {
	preview: MycliShellResumeRepairPreview;
	onSelect: (action: MycliShellResumeRepairAction) => void | Promise<void>;
	onCancel: () => void;
}

export class SessionRepairSelectorComponent extends Container {
	private selectedIndex = 0;
	private submitting = false;
	private error: string | null = null;
	private readonly preview: MycliShellResumeRepairPreview;
	private readonly onSelectCallback: SessionRepairSelectorOptions["onSelect"];
	private readonly onCancelCallback: SessionRepairSelectorOptions["onCancel"];

	constructor(options: SessionRepairSelectorOptions) {
		super();
		this.preview = options.preview;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.rebuild();
	}

	setError(message: string): void {
		this.submitting = false;
		this.error = message.trim() || "Session recovery failed.";
		this.rebuild();
	}

	handleInput(keyData: string): void {
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
		void Promise.resolve(this.onSelectCallback(action)).catch((error: unknown) => {
			this.setError(safeErrorMessage(error, "Session recovery failed."));
		});
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("  Repair Session"), 0, 0));
		const title = this.preview.session.title?.trim() || this.preview.session.id;
		this.addChild(new TruncatedText(theme.fg("accent", title), 2, 0));
		if (this.preview.session.cwd) {
			this.addChild(new TruncatedText(theme.fg("muted", this.preview.session.cwd), 2, 0));
		}
		this.addChild(new Spacer(1));
		for (const issue of this.preview.issues) {
			const marker = issue.blocking ? "[!]" : "[i]";
			const color = issue.blocking ? "warning" : "muted";
			this.addChild(new Text(theme.fg(color, `  ${marker} ${issue.message}`), 0, 0));
		}
		this.addChild(new Spacer(1));
		for (let index = 0; index < this.preview.actions.length; index += 1) {
			const action = this.preview.actions[index];
			if (!action) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", `${uiGlyphs().arrow} `) : "  ";
			const label = repairActionLabel(action);
			this.addChild(new Text(
				`${prefix}${selected ? theme.fg("accent", theme.bold(label)) : theme.bold(label)}`,
				1,
				0,
			));
			this.addChild(new Text(theme.fg("muted", `    ${repairActionDescription(action)}`), 1, 0));
		}
		if (this.preview.actions.length === 0) {
			this.addChild(new Text(theme.fg("warning", "  No automatic recovery action is available."), 0, 0));
		}
		if (this.submitting) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", "  Applying recovery..."), 0, 0));
		}
		if (this.error) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", `  ${this.error}`), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `  Enter confirm ${uiGlyphs().separator} Esc cancel`), 0, 0));
		this.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
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
