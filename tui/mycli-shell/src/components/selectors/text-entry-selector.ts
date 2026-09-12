import { Input, getKeybindings, type Component, type Focusable } from "../../tui-core/index.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints } from "./decision-list.ts";

export class TextEntrySelectorComponent implements Component, Focusable {
	private readonly panel: DecisionPanel;
	private readonly input = new Input();
	private readonly controller = new AbortController();
	private busy = false;
	private status = "";
	constructor(private readonly options: DecisionPanelOptions & {
		readonly title: string; readonly description: string; readonly initialValue?: string;
		readonly maxLength?: number;
		readonly onSubmit: (value: string, signal: AbortSignal) => Promise<void>;
		readonly onCancel: () => void;
	}) {
		this.panel = new DecisionPanel(options); this.input.setValue(options.initialValue ?? ""); this.update();
	}
	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }
	invalidate(): void { this.panel.invalidate(); }
	render(width: number): string[] { return this.panel.render(width); }
	dispose(): void { this.controller.abort(); }
	handleInput(data: string): void {
		if (this.controller.signal.aborted || this.panel.handleInput(data)) return;
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) { this.dispose(); this.options.onCancel(); return; }
		if (this.busy) return;
		if (keys.matches(data, "tui.select.confirm")) { void this.submit(); return; }
		this.input.handleInput(data); this.status = ""; this.update();
	}
	private async submit(): Promise<void> {
		const value = this.input.getValue().trim();
		if (!value || value.length > (this.options.maxLength ?? 4000)) { this.status = "Enter a value within the allowed length."; this.update(); return; }
		this.busy = true; this.status = "Saving…"; this.update();
		try { await this.options.onSubmit(value, this.controller.signal); }
		catch { if (!this.controller.signal.aborted) this.status = "Request failed. Check the value and retry."; }
		finally { if (!this.controller.signal.aborted) { this.busy = false; this.update(); } }
	}
	private update(): void {
		this.panel.setContent({ title: this.options.title, details: [this.options.description], preview: this.input,
			items: [], selectedIndex: 0, busy: this.busy, status: this.status, hints: decisionNavigationHints() });
	}
}
