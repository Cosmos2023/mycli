import type { PlanImplementationChoice } from "../../interaction/plan-implementation.ts";
import { safeErrorMessage } from "../../safe-ui-text.ts";
import { Container, getKeybindings } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints } from "./decision-list.ts";

export interface PlanImplementationSelectorOptions extends DecisionPanelOptions {
	onSelect: (choice: PlanImplementationChoice) => void | Promise<void>;
	contextUsageLabel?: string;
}

const CHOICES: readonly Readonly<{
	choice: PlanImplementationChoice;
	label: string;
	description: string;
}>[] = Object.freeze([
	Object.freeze({
		choice: "implement",
		label: "Yes, implement this plan",
		description: "Switch to Default and start coding.",
	}),
	Object.freeze({
		choice: "clear_context",
		label: "Yes, clear context and implement",
		description: "Fresh thread with this plan.",
	}),
	Object.freeze({
		choice: "stay",
		label: "No, stay in Plan mode",
		description: "Continue planning with the model.",
	}),
]);

export class PlanImplementationSelectorComponent extends Container {
	private selectedIndex = 0;
	private readonly panel: DecisionPanel;
	private submitting = false;
	private errorMessage = "";

	constructor(private readonly options: PlanImplementationSelectorOptions) {
		super();
		this.panel = new DecisionPanel(options);
		this.addChild(this.panel);
		this.updateSurface();
	}

	handleInput(keyData: string): void {
		if (this.panel.handleInput(keyData)) return;
		if (this.submitting) return;
		if (/^[1-3]$/u.test(keyData)) {
			this.selectedIndex = Number(keyData) - 1;
			this.activateSelected();
			return;
		}

		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
			return;
		}
		if (keybindings.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
			return;
		}
		if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			this.activateSelected();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.respond("stay");
		}
	}

	private moveSelection(delta: number): void {
		this.selectedIndex = (this.selectedIndex + delta + CHOICES.length) % CHOICES.length;
		this.errorMessage = "";
		this.updateSurface();
	}

	private activateSelected(): void {
		const selected = CHOICES[this.selectedIndex];
		if (selected) this.respond(selected.choice);
	}

	private respond(choice: PlanImplementationChoice): void {
		this.selectedIndex = Math.max(0, CHOICES.findIndex((item) => item.choice === choice));
		this.submitting = true;
		this.errorMessage = "";
		this.updateSurface();
		void Promise.resolve().then(() => this.options.onSelect(choice)).catch((error: unknown) => {
			this.submitting = false;
			this.errorMessage = safeErrorMessage(error, "Unable to start plan implementation.");
			this.updateSurface();
		});
	}

	private updateSurface(): void {
		const contextUsageLabel = this.options.contextUsageLabel?.replace(/\s+/gu, " ").trim();
		this.panel.setContent({
			title: theme.bold("Implement this plan?"),
			items: CHOICES.map((choice, index) => ({
				label: choice.label,
				shortcut: String(index + 1),
				description: choice.choice === "clear_context" && contextUsageLabel
					? `Fresh thread. Context: ${contextUsageLabel}.` : choice.description,
			})),
			selectedIndex: this.selectedIndex,
			busy: this.submitting,
			status: this.submitting ? theme.fg("muted", "Starting implementation...")
				: this.errorMessage ? theme.fg("error", this.errorMessage) : "",
			hints: decisionNavigationHints(),
		});
	}
}
