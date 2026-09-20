import { Container, getKeybindings } from "../../tui-core/index.ts";
import type { MycliShellPermissionProfile, MycliShellPermissionState } from "../../model.ts";
import { safeErrorMessage } from "../../safe-ui-text.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints, nextDecisionIndex, type DecisionItem } from "./decision-list.ts";

type PermissionStage = "profiles" | "confirm-full-access" | "allowances";

export interface PermissionSelectorOptions extends DecisionPanelOptions {
	permissions: MycliShellPermissionState;
	showAllowances?: boolean;
	title?: string;
	onSelect: (profile: MycliShellPermissionProfile) => void | Promise<void>;
	onClearAllowances: () => void | Promise<void>;
	onCancel: () => void;
}

export class PermissionSelectorComponent extends Container {
	private stage: PermissionStage = "profiles";
	private selectedIndex = 0;
	private error: string | null = null;
	private submitting = false;
	private readonly panel: DecisionPanel;
	private readonly permissions: MycliShellPermissionState;
	private readonly showAllowances: boolean;
	private readonly title: string;
	private readonly onSelectCallback: PermissionSelectorOptions["onSelect"];
	private readonly onClearAllowancesCallback: PermissionSelectorOptions["onClearAllowances"];
	private readonly onCancelCallback: () => void;

	constructor(options: PermissionSelectorOptions) {
		super();
		this.permissions = options.permissions;
		this.showAllowances = options.showAllowances !== false;
		this.title = options.title ?? "Update Model Permissions";
		this.onSelectCallback = options.onSelect;
		this.onClearAllowancesCallback = options.onClearAllowances;
		this.onCancelCallback = options.onCancel;
		const currentIndex = this.permissions.profiles.findIndex((profile) => profile.current);
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.panel = new DecisionPanel(options);
		this.addChild(this.panel);
		this.rebuild();
	}

	setError(message: string): void {
		this.submitting = false;
		this.error = message.trim() || "Permission update failed.";
		this.rebuild();
	}

	handleInput(keyData: string): void {
		if (this.panel.handleInput(keyData)) return;
		if (this.submitting) return;
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.stage === "profiles") {
				this.onCancelCallback();
			} else {
				this.stage = "profiles";
				this.selectedIndex = Math.max(0, this.permissions.profiles.findIndex((profile) => profile.current));
				this.error = null;
				this.rebuild();
			}
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
		if (/^[1-9]$/u.test(keyData) && Number(keyData) <= this.items().length) {
			const item = this.items()[Number(keyData) - 1];
			if (item?.disabled || item?.disabledReason) return;
			this.selectedIndex = Number(keyData) - 1;
			this.confirm();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.confirm();
		}
	}

	private move(delta: number): void {
		this.selectedIndex = nextDecisionIndex(this.items(), this.selectedIndex, delta);
		this.error = null;
		this.rebuild();
	}

	private confirm(): void {
		const item = this.items()[this.selectedIndex];
		if (!item || item.disabled || item.disabledReason) return;
		this.error = null;
		if (this.stage === "confirm-full-access") {
			if (this.selectedIndex === 0) {
				const profile = this.permissions.profiles.find((candidate) => candidate.id === "full-access");
				if (profile) this.submit(() => this.onSelectCallback(profile));
				return;
			}
			this.stage = "profiles";
			this.selectedIndex = Math.max(0, this.permissions.profiles.findIndex((profile) => profile.current));
			this.rebuild();
			return;
		}
		if (this.stage === "allowances") {
			if (this.selectedIndex === 0 && this.permissions.commandAllowanceCount > 0) {
				this.submit(() => this.onClearAllowancesCallback());
				return;
			}
			this.stage = "profiles";
			this.selectedIndex = Math.max(0, this.permissions.profiles.findIndex((profile) => profile.current));
			this.rebuild();
			return;
		}

		if (this.showAllowances && this.selectedIndex === this.permissions.profiles.length) {
			this.stage = "allowances";
			this.selectedIndex = this.permissions.commandAllowanceCount > 0 ? 0 : 1;
			this.rebuild();
			return;
		}
		const profile = this.permissions.profiles[this.selectedIndex];
		if (!profile || profile.disabledReason) return;
		if (profile.id === "full-access") {
			this.stage = "confirm-full-access";
			this.selectedIndex = 0;
			this.rebuild();
			return;
		}
		this.submit(() => this.onSelectCallback(profile));
	}

	private submit(action: () => void | Promise<void>): void {
		this.submitting = true;
		this.rebuild();
		try {
			void Promise.resolve(action()).then(() => {
				this.submitting = false;
				this.rebuild();
			}, (error: unknown) => this.setError(safeErrorMessage(error, "Permission update failed.")));
		} catch (error) {
			this.setError(safeErrorMessage(error, "Permission update failed."));
		}
	}

	private rebuild(): void {
		this.panel.setContent({
			title: theme.bold(this.stage === "profiles" ? this.title
				: this.stage === "allowances" ? "Session command allowances" : "Confirm Full Access"),
			tone: this.stage === "confirm-full-access" ? "warning" : "accent",
			details: this.detailLines(),
			items: this.items(),
			selectedIndex: this.selectedIndex,
			busy: this.submitting,
			status: this.submitting ? theme.fg("muted", "Saving permissions...")
				: this.error ? theme.fg("error", this.error) : "",
			hints: decisionNavigationHints(),
		});
	}

	private items(): DecisionItem[] {
		if (this.stage === "confirm-full-access") return [
			{ label: "Enable Full Access", shortcut: "1" },
			{ label: "Go back", shortcut: "2" },
		];
		if (this.stage === "allowances") return [
			{ label: "Clear session allowances", shortcut: "1", disabled: this.permissions.commandAllowanceCount === 0 },
			{ label: "Go back", shortcut: "2" },
		];
		return [
			...this.permissions.profiles.map((profile, index) => ({
				label: profile.label,
				description: profile.description,
				current: profile.current,
				shortcut: String(index + 1),
				...(profile.disabledReason ? { disabledReason: profile.disabledReason } : {}),
			})),
			...(this.showAllowances ? [{
				label: "Command allowances...",
				description: `${this.permissions.commandAllowanceCount} active for this session`,
				shortcut: String(this.permissions.profiles.length + 1),
			}] : []),
		];
	}

	private detailLines(): string[] {
		if (this.stage === "confirm-full-access") return [theme.fg("warning",
			"mycli will be able to edit files outside this workspace and access the internet without asking.",
		)];
		if (this.stage === "allowances") return [theme.fg("muted", `${this.permissions.commandAllowanceCount} active`)];
		const lines: string[] = [];
		const effective = this.permissions.effective;
		const readiness = this.permissions.sandboxReadiness;
		if (effective) {
			lines.push(theme.fg(
				effective.constrained ? "warning" : "muted",
				`Effective: ${filesystemLabel(effective.filesystem)} ${uiGlyphs().separator} network ${effective.network} ${uiGlyphs().separator} ${approvalLabel(effective.approvalBehavior)}`,
			));
			const constraint = effective.constrained
				? ` ${uiGlyphs().separator} constrained by ${effective.constraintsSource ?? "runtime"}`
				: "";
			lines.push(theme.fg("muted", `Policy: ${effective.source}${constraint}`));
		}
		if (readiness) {
			const color = readiness.state === "ready" || readiness.state === "not_required"
				? "muted"
				: "warning";
			lines.push(theme.fg(
				color,
				`Sandbox: ${readinessLabel(readiness.state)} ${uiGlyphs().separator} ${isolationLabel(readiness.isolation)}`,
			));
		}
		const selected = this.permissions.profiles[this.selectedIndex];
		const effects = selected && !selected.current ? permissionEffects(selected) : null;
		if (effects) lines.push(theme.fg("muted", `Selected: ${effects}`));
		return lines;
	}
}

function permissionEffects(profile: MycliShellPermissionProfile): string | null {
	if (!profile.filesystem || !profile.network || !profile.approvalBehavior) return null;
	return `${filesystemLabel(profile.filesystem)} ${uiGlyphs().separator} network ${profile.network} ${uiGlyphs().separator} ${approvalLabel(profile.approvalBehavior)}`;
}

function filesystemLabel(value: NonNullable<MycliShellPermissionProfile["filesystem"]>): string {
	if (value === "read_only") return "read only";
	if (value === "workspace_write") return "workspace write";
	return "unrestricted files";
}

function approvalLabel(value: NonNullable<MycliShellPermissionProfile["approvalBehavior"]>): string {
	return value === "never" ? "no routine prompts" : "asks when needed";
}

function readinessLabel(value: NonNullable<MycliShellPermissionState["sandboxReadiness"]>["state"]): string {
	if (value === "setup_required") return "setup required";
	if (value === "not_required") return "not required";
	return value;
}

function isolationLabel(value: NonNullable<MycliShellPermissionState["sandboxReadiness"]>["isolation"]): string {
	if (value === "macos_seatbelt") return "macOS Seatbelt";
	if (value === "linux_bubblewrap") return "Linux bubblewrap";
	if (value === "windows_restricted_token") return "Windows restricted token";
	if (value === "windows_psec") return "Windows PSEC";
	return "no process isolation";
}
