import { Container, getKeybindings, Spacer, Text } from "../tui-core/index.ts";
import type { MycliShellPermissionProfile, MycliShellPermissionState } from "../model.ts";
import { theme } from "../theme/theme.ts";

type PermissionStage = "profiles" | "confirm-full-access" | "allowances";

export interface PermissionSelectorOptions {
	permissions: MycliShellPermissionState;
	onSelect: (profile: MycliShellPermissionProfile) => void;
	onClearAllowances: () => void;
	onCancel: () => void;
}

export class PermissionSelectorComponent extends Container {
	private stage: PermissionStage = "profiles";
	private selectedIndex = 0;
	private error: string | null = null;
	private readonly permissions: MycliShellPermissionState;
	private readonly onSelectCallback: (profile: MycliShellPermissionProfile) => void;
	private readonly onClearAllowancesCallback: () => void;
	private readonly onCancelCallback: () => void;

	constructor(options: PermissionSelectorOptions) {
		super();
		this.permissions = options.permissions;
		this.onSelectCallback = options.onSelect;
		this.onClearAllowancesCallback = options.onClearAllowances;
		this.onCancelCallback = options.onCancel;
		const currentIndex = this.permissions.profiles.findIndex((profile) => profile.current);
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.rebuild();
	}

	setError(message: string): void {
		this.error = message.trim() || "Permission update failed.";
		this.rebuild();
	}

	handleInput(keyData: string): void {
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
		if (kb.matches(keyData, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.confirm();
		}
	}

	private move(delta: number): void {
		const count = this.itemCount();
		if (count <= 0) return;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.error = null;
		this.rebuild();
	}

	private confirm(): void {
		this.error = null;
		if (this.stage === "confirm-full-access") {
			if (this.selectedIndex === 0) {
				const profile = this.permissions.profiles.find((candidate) => candidate.id === "full-access");
				if (profile) this.onSelectCallback(profile);
				return;
			}
			this.stage = "profiles";
			this.selectedIndex = Math.max(0, this.permissions.profiles.findIndex((profile) => profile.current));
			this.rebuild();
			return;
		}
		if (this.stage === "allowances") {
			if (this.selectedIndex === 0 && this.permissions.commandAllowanceCount > 0) {
				this.onClearAllowancesCallback();
				return;
			}
			this.stage = "profiles";
			this.selectedIndex = Math.max(0, this.permissions.profiles.findIndex((profile) => profile.current));
			this.rebuild();
			return;
		}

		if (this.selectedIndex === this.permissions.profiles.length) {
			this.stage = "allowances";
			this.selectedIndex = 0;
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
		this.onSelectCallback(profile);
	}

	private itemCount(): number {
		if (this.stage === "profiles") return this.permissions.profiles.length + 1;
		return 2;
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		if (this.stage === "confirm-full-access") {
			this.renderConfirmation();
		} else if (this.stage === "allowances") {
			this.renderAllowances();
		} else {
			this.renderProfiles();
		}
		if (this.error) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", this.error), 2, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "  Press enter to confirm or esc to go back"), 0, 0));
	}

	private renderProfiles(): void {
		this.addChild(new Text(theme.bold("  Update Model Permissions"), 0, 0));
		this.addChild(new Spacer(1));
		this.permissions.profiles.forEach((profile, index) => {
			const current = profile.current ? " (current)" : "";
			const prefix = index === this.selectedIndex ? theme.fg("accent", "› ") : "  ";
			const label = `${profile.label}${current}`;
			this.addChild(new Text(`${prefix}${index === this.selectedIndex ? theme.fg("accent", theme.bold(label)) : theme.bold(label)}`, 0, 0));
			this.addChild(new Text(theme.fg(profile.disabledReason ? "warning" : "muted", `    ${profile.disabledReason ?? profile.description}`), 0, 0));
		});
		this.addChild(new Spacer(1));
		const allowanceIndex = this.permissions.profiles.length;
		const prefix = allowanceIndex === this.selectedIndex ? theme.fg("accent", "› ") : "  ";
		this.addChild(new Text(`${prefix}${theme.bold("Command allowances...")}`, 0, 0));
		this.addChild(new Text(theme.fg("muted", `    ${this.permissions.commandAllowanceCount} active for this session`), 0, 0));
	}

	private renderConfirmation(): void {
		this.addChild(new Text(theme.bold("  Confirm Full Access"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("warning", "  mycli will be able to edit files outside this workspace and access the internet without asking."), 0, 0));
		this.addChild(new Spacer(1));
		this.renderSimpleOption(0, "Enable Full Access");
		this.renderSimpleOption(1, "Go back");
	}

	private renderAllowances(): void {
		this.addChild(new Text(theme.bold("  Session command allowances"), 0, 0));
		this.addChild(new Text(theme.fg("muted", `  ${this.permissions.commandAllowanceCount} active`), 0, 0));
		this.addChild(new Spacer(1));
		const clearLabel = this.permissions.commandAllowanceCount > 0
			? "Clear session allowances"
			: "Clear session allowances (none active)";
		this.renderSimpleOption(0, clearLabel, this.permissions.commandAllowanceCount === 0);
		this.renderSimpleOption(1, "Go back");
	}

	private renderSimpleOption(index: number, label: string, disabled = false): void {
		const prefix = index === this.selectedIndex ? theme.fg("accent", "› ") : "  ";
		const value = disabled ? theme.fg("muted", label) : index === this.selectedIndex ? theme.fg("accent", label) : label;
		this.addChild(new Text(`${prefix}${value}`, 0, 0));
	}
}
