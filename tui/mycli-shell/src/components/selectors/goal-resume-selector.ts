import { safeErrorMessage } from "../../safe-ui-text.ts";
import { Container, getKeybindings } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints } from "./decision-list.ts";

export type GoalResumeChoice = "resume" | "leave_paused";

export interface GoalResumeSelectorOptions extends DecisionPanelOptions {
	readonly objective: string;
	readonly onSelect: (choice: GoalResumeChoice) => void | Promise<void>;
	readonly onCancel: () => void;
}

const CHOICES: readonly Readonly<{
	choice: GoalResumeChoice;
	label: string;
	description: string;
}>[] = Object.freeze([
	Object.freeze({
		choice: "resume",
		label: "Resume goal",
		description: "Mark it active and continue when idle.",
	}),
	Object.freeze({
		choice: "leave_paused",
		label: "Leave paused",
		description: "Keep it paused; use /goal resume later.",
	}),
]);

/** Codex asks before a restored session resumes the goal it paused on cold start. */
export class GoalResumeSelectorComponent extends Container {
	private selectedIndex = 0;
	private readonly panel: DecisionPanel;
	private submitting = false;
	private errorMessage = "";

	constructor(private readonly options: GoalResumeSelectorOptions) {
		super();
		this.panel = new DecisionPanel(options);
		this.addChild(this.panel);
		this.updateSurface();
	}

	handleInput(keyData: string): void {
		if (this.panel.handleInput(keyData)) return;
		if (this.submitting) return;
		if (/^[1-2]$/u.test(keyData)) {
			this.selectedIndex = Number(keyData) - 1;
			this.activateSelected();
			return;
		}
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = (this.selectedIndex - 1 + CHOICES.length) % CHOICES.length;
			this.errorMessage = "";
			this.updateSurface();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % CHOICES.length;
			this.errorMessage = "";
			this.updateSurface();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			this.activateSelected();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}

	private activateSelected(): void {
		const selected = CHOICES[this.selectedIndex];
		if (selected) this.respond(selected.choice);
	}

	private respond(choice: GoalResumeChoice): void {
		this.submitting = true;
		this.errorMessage = "";
		this.updateSurface();
		void Promise.resolve().then(() => this.options.onSelect(choice)).catch((error: unknown) => {
			this.submitting = false;
			this.errorMessage = safeErrorMessage(error, "Unable to resume the goal.");
			this.updateSurface();
		});
	}

	private updateSurface(): void {
		this.panel.setContent({
			title: theme.bold("Resume paused goal?"),
			details: [`Goal: ${this.options.objective.replace(/\s+/gu, " ").trim()}`],
			items: CHOICES.map((choice, index) => ({
				label: choice.label,
				shortcut: String(index + 1),
				description: choice.description,
			})),
			selectedIndex: this.selectedIndex,
			busy: this.submitting,
			status: this.submitting ? theme.fg("muted", "Resuming goal...")
				: this.errorMessage ? theme.fg("error", this.errorMessage) : "",
			hints: decisionNavigationHints(),
		});
	}
}
