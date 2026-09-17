import type { SettingsChangeScope } from "../components/selectors/settings-selector.ts";
import type {
	MycliShellPermissionProfile,
	MycliShellPermissionState,
	MycliShellSettingsCatalog,
	MycliShellSettingsItem,
	MycliShellSettingsSnapshot,
	MycliShellVisualSettings,
} from "../model.ts";

export function settingsSnapshot(
	value: MycliShellVisualSettings | MycliShellSettingsSnapshot,
): MycliShellSettingsSnapshot {
	return "settings" in value ? value : { settings: value };
}

export function visualSettingsWithChoice(
	settings: MycliShellVisualSettings | undefined,
	item: MycliShellSettingsItem,
	value: string,
): MycliShellVisualSettings | null {
	switch (item.clientKey) {
		case "statusbarMode":
			return ["off", "compact", "full"].includes(value)
				? { ...settings, statusbarMode: value as NonNullable<MycliShellVisualSettings["statusbarMode"]> }
				: null;
		case "viewMode":
			return ["default", "verbose", "focus"].includes(value)
				? { ...settings, viewMode: value as NonNullable<MycliShellVisualSettings["viewMode"]> }
				: null;
		case "theme":
			return value ? { ...settings, theme: value } : null;
		case "hideThinking":
			return booleanSetting(settings, "hideThinking", value);
		case "toolDetailsDefault":
			return ["collapsed", "expanded"].includes(value)
				? { ...settings, toolDetailsDefault: value as NonNullable<MycliShellVisualSettings["toolDetailsDefault"]> }
				: null;
		case "hardwareCursor":
			return booleanSetting(settings, "hardwareCursor", value);
		case "clearOnShrink":
			return booleanSetting(settings, "clearOnShrink", value);
		case "terminalNotifications":
			return booleanSetting(settings, "terminalNotifications", value);
		case "terminalProgress":
			return booleanSetting(settings, "terminalProgress", value);
		case "subagentDensity":
			return ["compact", "normal", "detailed"].includes(value)
				? { ...settings, subagentDensity: value as NonNullable<MycliShellVisualSettings["subagentDensity"]> }
				: null;
		case "colorMode":
			return ["auto", "truecolor", "256", "16", "none"].includes(value)
				? { ...settings, colorMode: value as NonNullable<MycliShellVisualSettings["colorMode"]> }
				: null;
		case "reducedMotion":
			return booleanSetting(settings, "reducedMotion", value);
		case "glyphMode":
			return ["auto", "unicode", "ascii"].includes(value)
				? { ...settings, glyphMode: value as NonNullable<MycliShellVisualSettings["glyphMode"]> }
				: null;
		case "highContrast":
			return booleanSetting(settings, "highContrast", value);
		default:
			return null;
	}
}

function booleanSetting(
	settings: MycliShellVisualSettings | undefined,
	key: "hideThinking" | "hardwareCursor" | "clearOnShrink" | "terminalProgress" | "terminalNotifications"
		| "reducedMotion" | "highContrast",
	value: string,
): MycliShellVisualSettings | null {
	if (value !== "true" && value !== "false") return null;
	return { ...settings, [key]: value === "true" };
}

export function visualSettingValue(
	settings: MycliShellVisualSettings,
	item: MycliShellSettingsItem,
): string | boolean | null {
	if (!item.clientKey) return null;
	const value = settings[item.clientKey];
	return typeof value === "string" || typeof value === "boolean" ? value : null;
}

export function settingsCatalogWithChoice(
	catalog: MycliShellSettingsCatalog | undefined,
	selected: MycliShellSettingsItem,
	value: string,
	scope: SettingsChangeScope,
): MycliShellSettingsCatalog | undefined {
	if (!catalog) return undefined;
	return {
		...catalog,
		items: catalog.items.map((item) => item.id === selected.id
			? { ...item, value, source: scope === "user" ? "user" : "session", scope }
			: item),
	};
}

export function authRecoveryFromError(error: unknown): {
	readonly providerId: string;
	readonly authRef: string;
} | null {
	if (typeof error !== "object" || error === null || !("code" in error)
		|| error.code !== "auth_required" || !("data" in error)) {
		return null;
	}
	const data = error.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const providerId = "provider_id" in data && typeof data.provider_id === "string"
		? data.provider_id.trim()
		: "";
	const authRef = "auth_ref" in data && typeof data.auth_ref === "string"
		? data.auth_ref.trim()
		: "";
	return providerId && authRef ? { providerId, authRef } : null;
}

export function defaultPermissionState(): MycliShellPermissionState {
	return {
		active: "workspace",
		commandAllowanceCount: 0,
		profiles: [
			{
				id: "workspace",
				label: "Current permissions",
				description: "Permission details are unavailable until the gateway responds.",
				current: true,
			},
		],
	};
}

export function permissionStateWithActive(
	state: MycliShellPermissionState,
	active: MycliShellPermissionProfile["id"],
): MycliShellPermissionState {
	return {
		...state,
		active,
		profiles: state.profiles.map((profile) => ({
			...profile,
			current: profile.id === active,
		})),
	};
}
