import { getKeybindings, Container } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints, nextDecisionIndex } from "./decision-list.ts";

export type ProjectTrustDecision = boolean | null;

interface TrustOption {
	label: string;
	trusted: boolean;
}

export interface TrustSelectorOptions extends DecisionPanelOptions {
	cwd: string;
	savedDecision: ProjectTrustDecision;
	projectTrusted: boolean;
	onSelect: (trusted: boolean) => void | Promise<void>;
	onCancel: () => void;
}

const TRUST_OPTIONS: TrustOption[] = [
	{ label: "Trust", trusted: true },
	{ label: "Do not trust", trusted: false },
];

function formatDecision(decision: ProjectTrustDecision): string {
	if (decision === true) {
		return "trusted";
	}
	if (decision === false) {
		return "untrusted";
	}
	return "none";
}

export class TrustSelectorComponent extends Container {
	private selectedIndex: number;
	private readonly panel: DecisionPanel;
	private submitting = false;
	private error = "";
	private readonly savedDecision: ProjectTrustDecision;
	private readonly onSelectCallback: TrustSelectorOptions["onSelect"];
	private readonly onCancelCallback: () => void;

	constructor(private readonly options: TrustSelectorOptions) {
		super();

		this.savedDecision = options.savedDecision;
		this.selectedIndex = Math.max(
			0,
			TRUST_OPTIONS.findIndex((option) => option.trusted === options.savedDecision),
		);
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.panel = new DecisionPanel(options);
		this.addChild(this.panel);
		this.updateList();
	}

	setError(message?: string): void {
		this.submitting = false;
		this.error = message ?? "";
		this.updateList();
	}

	handleInput(keyData: string): void {
		if (this.panel.handleInput(keyData)) return;
		if (this.submitting) return;
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = nextDecisionIndex(TRUST_OPTIONS, this.selectedIndex, -1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = nextDecisionIndex(TRUST_OPTIONS, this.selectedIndex, 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || /^[12]$/u.test(keyData)) {
			if (/^[12]$/u.test(keyData)) this.selectedIndex = Number(keyData) - 1;
			const selected = TRUST_OPTIONS[this.selectedIndex];
			if (selected) {
				this.submit(selected.trusted);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	private submit(trusted: boolean): void {
		this.submitting = true;
		this.error = "";
		this.updateList();
		try {
			const result = this.onSelectCallback(trusted);
			if (!result) {
				this.submitting = false;
				this.updateList();
				return;
			}
			void result.then(() => {
				this.submitting = false;
				this.updateList();
			}, () => this.setError("Unable to save workspace trust."));
		} catch {
			this.setError("Unable to save workspace trust.");
		}
	}

	private updateList(): void {
		this.panel.setContent({
			title: theme.bold("Project trust"),
			details: [
				theme.fg("text", this.options.cwd),
				theme.fg("muted", `Saved decision: ${formatDecision(this.savedDecision)}`),
				theme.fg("muted", `Current session: ${this.options.projectTrusted ? "trusted" : "untrusted"}`),
			],
			items: TRUST_OPTIONS.map((option, index) => ({
				label: option.label,
				shortcut: String(index + 1),
				current: option.trusted === this.savedDecision,
			})),
			selectedIndex: this.selectedIndex,
			busy: this.submitting,
			status: this.submitting ? theme.fg("muted", "Saving workspace trust...")
				: this.error ? theme.fg("error", this.error) : "",
			hints: decisionNavigationHints("save", "cancel"),
		});
	}
}
