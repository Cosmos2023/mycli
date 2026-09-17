import type { ReviewSelection } from "@mycli/contracts";
import { Input, getKeybindings, type Component, type Focusable } from "../../tui-core/index.ts";
import { safeErrorMessage } from "../../safe-ui-text.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints } from "./decision-list.ts";

const choices = [
	{ label: "Review uncommitted changes", description: "Staged, unstaged and untracked files" },
	{ label: "Review against a base branch", description: "Changes since the common ancestor" },
	{ label: "Review a commit", description: "Changes introduced by one commit" },
	{ label: "Custom review", description: "Choose what the review should focus on" },
];

export class ReviewSelectorComponent implements Component, Focusable {
	private readonly panel: DecisionPanel;
	private readonly input = new Input();
	private readonly controller = new AbortController();
	private index = 0;
	private kind?: "base" | "commit" | "custom";
	private busy = false;
	private status = "";
	constructor(private readonly options: DecisionPanelOptions & {
		readonly onSelect: (selection: ReviewSelection, signal: AbortSignal) => Promise<void>;
		readonly onCancel: () => void;
	}) { this.panel = new DecisionPanel(options); this.update(); }
	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }
	invalidate(): void { this.panel.invalidate(); }
	render(width: number): string[] { return this.panel.render(width); }
	dispose(): void { this.controller.abort(); }
	handleInput(data: string): void {
		if (this.controller.signal.aborted || this.panel.handleInput(data)) return;
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.kind && !this.busy) { this.kind = undefined; this.status = ""; this.input.setValue(""); this.update(); }
			else { this.dispose(); this.options.onCancel(); }
			return;
		}
		if (this.busy) return;
		if (keys.matches(data, "tui.select.confirm")) {
			if (!this.kind) {
				if (this.index === 0) { void this.submit({ kind: "uncommitted" }); return; }
				this.kind = this.index === 1 ? "base" : this.index === 2 ? "commit" : "custom";
			} else {
				const value = this.input.getValue().trim();
				if (!value || value.length > (this.kind === "custom" ? 4000 : 256)) this.status = "Enter a valid review target.";
				else { void this.submit(this.kind === "custom" ? { kind: "custom", instructions: value } : { kind: this.kind, ref: value }); return; }
			}
		} else if (this.kind) this.input.handleInput(data);
		else if (keys.matches(data, "tui.select.up")) this.index = (this.index + 3) % 4;
		else if (keys.matches(data, "tui.select.down")) this.index = (this.index + 1) % 4;
		this.update();
	}
	private async submit(selection: ReviewSelection): Promise<void> {
		this.busy = true; this.status = "Preparing review…"; this.update();
		try { await this.options.onSelect(selection, this.controller.signal); }
		catch (error) { if (!this.controller.signal.aborted) this.status = safeErrorMessage(error, "Unable to start review."); }
		finally { if (!this.controller.signal.aborted) { this.busy = false; this.update(); } }
	}
	private update(): void {
		this.panel.setContent({ title: this.kind === "base" ? "Base branch" : this.kind === "commit" ? "Commit SHA or ref" : this.kind === "custom" ? "Review instructions" : "Code review",
			details: ["Reviews can read files. They cannot modify files or run shell commands."],
			preview: this.kind ? this.input : undefined, items: this.kind ? [] : choices, selectedIndex: this.index,
			busy: this.busy, status: this.status, hints: decisionNavigationHints(),
		});
	}
}
