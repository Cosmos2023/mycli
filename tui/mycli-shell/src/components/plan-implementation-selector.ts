import type { PlanImplementationChoice } from "../plan-implementation.ts";
import { Container, getKeybindings, Spacer, Text, truncateToWidth, visibleWidth } from "../tui-core/index.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface PlanImplementationSelectorOptions {
	onSelect: (choice: PlanImplementationChoice) => void | Promise<void>;
	onRender?: () => void;
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
	private readonly listContainer = new Container();
	private readonly statusContainer = new Container();
	private submitting = false;
	private errorMessage = "";

	constructor(private readonly options: PlanImplementationSelectorOptions) {
		super();
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Implement this plan?")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(this.statusContainer);
		this.addChild(new Text(this.footerHints(), 1, 0));
		this.updateSurface();
	}

	handleInput(keyData: string): void {
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
		this.options.onRender?.();
	}

	private activateSelected(): void {
		const selected = CHOICES[this.selectedIndex];
		if (selected) this.respond(selected.choice);
	}

	private respond(choice: PlanImplementationChoice): void {
		this.submitting = true;
		this.errorMessage = "";
		this.updateSurface();
		this.options.onRender?.();
		void Promise.resolve().then(() => this.options.onSelect(choice)).catch((error: unknown) => {
			this.submitting = false;
			this.errorMessage = error instanceof Error
				? error.message
				: "Unable to start plan implementation.";
			this.updateSurface();
			this.options.onRender?.();
		});
	}

	private updateSurface(): void {
		this.listContainer.clear();
		const contextUsageLabel = this.options.contextUsageLabel?.replace(/\s+/gu, " ").trim();
		const labels = CHOICES.map((choice, index) => `${index + 1}. ${choice.label}`);
		const labelColumnWidth = Math.max(...labels.map((label) => visibleWidth(label))) + 2;
		for (let index = 0; index < CHOICES.length; index += 1) {
			const choice = CHOICES[index]!;
			const active = index === this.selectedIndex;
			const prefix = active ? theme.fg("accent", "› ") : "  ";
			const label = labels[index]!;
			const paddedLabel = `${label}${" ".repeat(Math.max(0, labelColumnWidth - visibleWidth(label)))}`;
			const descriptionText = choice.choice === "clear_context" && contextUsageLabel
				? `Fresh thread. Context: ${contextUsageLabel}.`
				: choice.description;
			const description = truncateToWidth(descriptionText, 80, "...");
			this.listContainer.addChild(new Text(
				`${prefix}${active ? theme.fg("accent", paddedLabel) : theme.fg("text", paddedLabel)}`
				+ theme.fg("muted", description),
				1,
				0,
			));
		}

		this.statusContainer.clear();
		if (this.submitting) {
			this.statusContainer.addChild(new Text(theme.fg("muted", "Starting implementation..."), 1, 0));
		} else if (this.errorMessage) {
			this.statusContainer.addChild(new Text(theme.fg("error", this.errorMessage), 1, 0));
		}
	}

	private footerHints(): string {
		return theme.fg("dim", "Press enter to confirm or esc to go back");
	}
}
