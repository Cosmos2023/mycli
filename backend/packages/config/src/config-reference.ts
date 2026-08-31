import {
	configSettingDescriptors,
	runtimeSettingSnapshots,
	type ConfigSettingValueKind,
	type RuntimeSettingValue,
} from "./runtime-setting-catalog.ts";
import type { NodeRuntimeConfig } from "./settings.ts";
import {
	SHELL_SETTING_DESCRIPTORS,
} from "./shell-setting-catalog.ts";

export const CONFIG_REFERENCE_VERSION = 1 as const;

export interface ConfigReferenceSetting {
	readonly key: string;
	readonly description: string;
	readonly valueKind: ConfigSettingValueKind;
	readonly writable: boolean;
	readonly canonicalPath: string;
	readonly legacyPaths: readonly string[];
	readonly defaultValue: RuntimeSettingValue;
	readonly allowedValues?: readonly (boolean | string)[];
	readonly restartRequired: boolean;
}

export interface ConfigReferenceDocument {
	readonly version: typeof CONFIG_REFERENCE_VERSION;
	readonly settings: readonly ConfigReferenceSetting[];
}

export function buildConfigReference(config: NodeRuntimeConfig): ConfigReferenceDocument {
	const runtimeDefaults = new Map<string, RuntimeSettingValue>(
		runtimeSettingSnapshots(config).map((item) => [item.key, item.value]),
	);
	const shellDefaults = new Map<string, RuntimeSettingValue>(
		SHELL_SETTING_DESCRIPTORS.map((item) => [item.key, item.defaultValue]),
	);
	return Object.freeze({
		version: CONFIG_REFERENCE_VERSION,
		settings: Object.freeze(configSettingDescriptors().map((descriptor) => Object.freeze({
			key: descriptor.key,
			description: descriptor.description,
			valueKind: descriptor.valueKind,
			writable: descriptor.writable,
			canonicalPath: descriptor.path.join("."),
			legacyPaths: Object.freeze(descriptor.legacyPaths.map((path) => path.join("."))),
			defaultValue: runtimeDefaults.get(descriptor.key) ?? shellDefaults.get(descriptor.key) ?? null,
			...(descriptor.allowedValues ? { allowedValues: descriptor.allowedValues } : {}),
			restartRequired: descriptor.restartRequired,
		}))),
	});
}

export function renderConfigReferenceJson(config: NodeRuntimeConfig): string {
	return `${JSON.stringify(buildConfigReference(config), null, 2)}\n`;
}

export function renderConfigReferenceMarkdown(config: NodeRuntimeConfig): string {
	const reference = buildConfigReference(config);
	const lines = [
		"# Configuration Reference",
		"",
		"> Generated from the canonical mycli setting descriptors. Do not edit by hand.",
		"",
		`Reference version: ${reference.version}`,
		"",
		"Configuration precedence, highest first: session, environment, trusted project, selected",
		"profile, user, system, legacy user, then built-in defaults. Credentials belong in",
		"`~/.mycli/auth.json` or the process environment and are never valid reference settings.",
		"",
		"| Key | Type | Default | Writable | Canonical TOML path | Description |",
		"| --- | --- | --- | :---: | --- | --- |",
	];
	for (const setting of reference.settings) {
		lines.push([
			`| \`${setting.key}\``,
			`\`${setting.valueKind}\``,
			`\`${markdownCell(referenceValue(setting.defaultValue))}\``,
			setting.writable ? "yes" : "no",
			`\`${setting.canonicalPath}\``,
			markdownCell(setting.description),
		].join(" | ") + " |");
	}
	lines.push("", "## Compatibility Aliases", "");
	lines.push("Aliases remain readable for compatibility, emit deprecation diagnostics, and are normalized by");
	lines.push("`mycli config migrate`. The migration preview and output never include configured values.", "");
	for (const setting of reference.settings.filter((item) => item.legacyPaths.length > 0)) {
		lines.push(`- \`${setting.key}\`: ${setting.legacyPaths.map((path) => `\`${path}\``).join(", ")}`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderConfigExampleToml(config: NodeRuntimeConfig): string {
	const settings = buildConfigReference(config).settings.filter((item) => item.writable);
	const root = settings.filter((item) => !item.canonicalPath.includes("."));
	const sections = new Map<string, ConfigReferenceSetting[]>();
	for (const setting of settings) {
		const [section] = setting.canonicalPath.split(".");
		if (!setting.canonicalPath.includes(".")) continue;
		const values = sections.get(section!) ?? [];
		values.push(setting);
		sections.set(section!, values);
	}
	const lines = [
		`# mycli configuration example (reference version ${CONFIG_REFERENCE_VERSION})`,
		"# All settings are commented out so built-in/provider defaults remain authoritative.",
		"# Credentials must be stored in ~/.mycli/auth.json or supplied through the environment.",
		"",
	];
	for (const setting of root) appendExampleSetting(lines, setting, setting.canonicalPath);
	for (const [section, values] of [...sections].sort(([left], [right]) => compareText(left, right))) {
		if (lines.at(-1) !== "") lines.push("");
		lines.push(`[${section}]`);
		for (const setting of values) {
			appendExampleSetting(lines, setting, setting.canonicalPath.slice(section.length + 1));
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function appendExampleSetting(
	lines: string[],
	setting: ConfigReferenceSetting,
	key: string,
): void {
	lines.push(`# ${setting.description}`);
	if (setting.allowedValues) {
		lines.push(`# Allowed: ${setting.allowedValues.map(referenceValue).join(", ")}`);
	}
	lines.push(`# ${key} = ${tomlExampleValue(setting)}`, "");
}

function tomlExampleValue(setting: ConfigReferenceSetting): string {
	if (setting.defaultValue !== null && typeof setting.defaultValue !== "object") {
		return referenceValue(setting.defaultValue);
	}
	if (setting.valueKind === "string") return '"replace-me"';
	if (setting.valueKind === "boolean") return "false";
	return "0";
}

function referenceValue(value: RuntimeSettingValue | boolean): string {
	if (value === null) return "unset";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function markdownCell(value: string): string {
	return value.replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
