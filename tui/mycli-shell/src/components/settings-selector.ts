import type { Component } from "../tui-core/index.ts";
import { Container, type SelectItem, SelectList, type SettingItem, SettingsList, Spacer, Text } from "../tui-core/index.ts";
import type { MycliShellVisualSettings } from "../model.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

type SettingsSelectorCallbacks = {
	onChange: (settings: MycliShellVisualSettings) => void;
	onCancel: () => void;
};

class SelectSubmenu extends Container {
	private readonly selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme(), {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
		});
		const currentIndex = options.findIndex((option) => option.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

export class SettingsSelectorComponent extends Container {
	private readonly settingsList: SettingsList;
	private settings: MycliShellVisualSettings;
	private readonly callbacks: SettingsSelectorCallbacks;

	constructor(settings: MycliShellVisualSettings | undefined, callbacks: SettingsSelectorCallbacks) {
		super();
		this.settings = {
			statusbarMode: "full",
			viewMode: "default",
			theme: "dark",
			hideThinking: true,
			toolDetailsDefault: "collapsed",
			hardwareCursor: false,
			clearOnShrink: true,
			terminalProgress: true,
			subagentDensity: "normal",
			...settings,
		};
		this.callbacks = callbacks;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Settings")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Runtime-backed TUI settings. Changes are saved by mycli."), 0, 0));
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "statusbar-mode",
				label: "Statusbar",
				description: "Controls how much footer status is shown",
				currentValue: this.settings.statusbarMode ?? "full",
				submenu: (currentValue, done) =>
					this.submenu(
						"Statusbar",
						"Controls footer status density",
						["off", "compact", "full"],
						currentValue,
						done,
					),
			},
			{
				id: "view-mode",
				label: "View mode",
				description: "Controls transcript detail density",
				currentValue: this.settings.viewMode ?? "default",
				submenu: (currentValue, done) =>
					this.submenu("View mode", "Controls transcript detail density", ["default", "verbose", "focus"], currentValue, done),
			},
			{
				id: "theme",
				label: "Theme",
				description: "Theme selection for the mycli shell",
				currentValue: this.settings.theme ?? "dark",
				submenu: (currentValue, done) => this.submenu("Theme", "Theme selection for this shell", ["dark", "light"], currentValue, done),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide reasoning blocks in assistant responses",
				currentValue: this.settings.hideThinking ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "tool-details-default",
				label: "Tool details",
				description: "Default expansion state for completed tool and bash details",
				currentValue: this.settings.toolDetailsDefault ?? "collapsed",
				submenu: (currentValue, done) =>
					this.submenu("Tool details", "Default expansion state for completed tool and bash details", ["collapsed", "expanded"], currentValue, done),
			},
			{
				id: "hardware-cursor",
				label: "Hardware cursor",
				description: "Prefer terminal cursor behavior when supported by the frontend",
				currentValue: this.settings.hardwareCursor ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "clear-on-shrink",
				label: "Clear on shrink",
				description: "Clear stale cells when the terminal shrinks",
				currentValue: this.settings.clearOnShrink ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "terminal-progress",
				label: "Progress",
				description: "Show compact terminal progress while a turn is running",
				currentValue: this.settings.terminalProgress ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "subagent-density",
				label: "Subagents",
				description: "Controls density for sub-agent task summaries",
				currentValue: this.settings.subagentDensity ?? "normal",
				submenu: (currentValue, done) =>
					this.submenu("Subagents", "Controls density for sub-agent task summaries", ["compact", "normal", "detailed"], currentValue, done),
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => this.handleChange(id, newValue),
			callbacks.onCancel,
			{ enableSearch: true },
		);
		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}

	private submenu(title: string, description: string, values: string[], currentValue: string, done: (selectedValue?: string) => void): Component {
		return new SelectSubmenu(
			title,
			description,
			values.map((value) => ({ value, label: value })),
			currentValue,
			(value) => done(value),
			() => done(),
		);
	}

	private handleChange(id: string, newValue: string): void {
		switch (id) {
			case "statusbar-mode":
				this.settings = { ...this.settings, statusbarMode: newValue as MycliShellVisualSettings["statusbarMode"] };
				break;
			case "view-mode":
				this.settings = { ...this.settings, viewMode: newValue as MycliShellVisualSettings["viewMode"] };
				break;
			case "theme":
				this.settings = { ...this.settings, theme: newValue };
				break;
			case "hide-thinking":
				this.settings = { ...this.settings, hideThinking: newValue === "true" };
				break;
			case "tool-details-default":
				this.settings = { ...this.settings, toolDetailsDefault: newValue as MycliShellVisualSettings["toolDetailsDefault"] };
				break;
			case "hardware-cursor":
				this.settings = { ...this.settings, hardwareCursor: newValue === "true" };
				break;
			case "clear-on-shrink":
				this.settings = { ...this.settings, clearOnShrink: newValue === "true" };
				break;
			case "terminal-progress":
				this.settings = { ...this.settings, terminalProgress: newValue === "true" };
				break;
			case "subagent-density":
				this.settings = { ...this.settings, subagentDensity: newValue as MycliShellVisualSettings["subagentDensity"] };
				break;
		}
		this.callbacks.onChange({ ...this.settings });
	}
}
