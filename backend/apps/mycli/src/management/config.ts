import {
	configDiagnostic,
	isConfigError,
	loadShellSettingsState,
	mutateUserConfigSetting,
	resolveConfigWithMetadata,
	runtimeSettingSnapshots,
	SHELL_SETTING_DESCRIPTORS,
	type ConfigDiagnostic,
	type ConfigLayerDisabledReason,
	type ConfigLayerId,
	type ConfigLayerScope,
	type ConfigLayerStack,
	type LoadedShellSettings,
	type WorkspaceTrustState,
} from "@mycli/config";
import { redactDoctorText } from "./doctor/redaction.ts";
import type { ManagementResponse } from "./types.ts";

export const CONFIG_MANAGEMENT_RESPONSE_VERSION = 1 as const;

export type ConfigManagementAction = "get" | "set" | "show" | "unset" | "validate";

export type ConfigSettingSource = ConfigLayerId | "default";
export type ConfigSettingValue = string | number | boolean | null | Readonly<Record<string, number>>;

export interface ConfigSettingRow {
	readonly key: string;
	readonly value: ConfigSettingValue;
	readonly source: ConfigSettingSource;
	readonly overridden: readonly ConfigLayerId[];
	readonly truncated?: boolean;
}

export interface ConfigLayerRow {
	readonly id: ConfigLayerId;
	readonly scope: ConfigLayerScope;
	readonly enabled: boolean;
	readonly disabledReason?: ConfigLayerDisabledReason;
}

export interface ConfigCredentialState {
	readonly apiKey: "present" | "missing";
}

interface ConfigManagementResponseBase extends ManagementResponse {
	readonly version: typeof CONFIG_MANAGEMENT_RESPONSE_VERSION;
	readonly action: ConfigManagementAction;
	readonly diagnostics: readonly ConfigDiagnostic[];
}

export interface ConfigValidateResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "validate";
}

export interface ConfigShowResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "show";
	readonly workspaceTrust: WorkspaceTrustState;
	readonly credentials: ConfigCredentialState;
	readonly layers: readonly ConfigLayerRow[];
	readonly settings: readonly ConfigSettingRow[];
}

export interface ConfigGetResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "get";
	readonly setting: ConfigSettingRow;
}

export interface ConfigMutationResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "set" | "unset";
	readonly key: string;
	readonly changed: boolean;
	readonly effectiveSource: ConfigSettingSource;
	readonly overridden: readonly ConfigLayerId[];
}

export interface ConfigFailureResponse extends ConfigManagementResponseBase {
	readonly ok: false;
	readonly action: ConfigManagementAction;
}

export type ConfigManagementResponse =
	| ConfigValidateResponse
	| ConfigShowResponse
	| ConfigGetResponse
	| ConfigMutationResponse
	| ConfigFailureResponse;

export interface ConfigManagementServiceOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly workspaceTrust: WorkspaceTrustState;
}

const MAX_RATIO_ROWS = 64;

export class ConfigManagementService {
	readonly #options: ConfigManagementServiceOptions;

	constructor(options: ConfigManagementServiceOptions) {
		this.#options = options;
	}

	async validate(signal: AbortSignal): Promise<ConfigValidateResponse> {
		const resolved = await this.#resolve(signal);
		return Object.freeze({
			version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
			ok: true,
			action: "validate",
			message: resolved.diagnostics.length > 0
				? "configuration valid with warnings"
				: "configuration valid",
			diagnostics: Object.freeze([...resolved.diagnostics]),
		});
	}

	async show(signal: AbortSignal): Promise<ConfigShowResponse> {
		const { resolved, shell } = await this.#snapshot(signal);
		return Object.freeze({
			version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
			ok: true,
			action: "show",
			message: "effective configuration",
			workspaceTrust: this.#options.workspaceTrust,
			credentials: Object.freeze({ apiKey: resolved.config.apiKey ? "present" : "missing" }),
			layers: projectLayers(resolved.layers),
			settings: projectSettings(resolved.config, resolved.layers, shell),
			diagnostics: Object.freeze([...resolved.diagnostics]),
		});
	}

	async get(key: string, signal: AbortSignal): Promise<ConfigGetResponse> {
		const { resolved, shell } = await this.#snapshot(signal);
		return Object.freeze({
			version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
			ok: true,
			action: "get",
			message: "effective configuration setting",
			setting: requireSettingRow(key, resolved.config, resolved.layers, shell),
			diagnostics: Object.freeze([...resolved.diagnostics]),
		});
	}

	async set(key: string, value: string, signal: AbortSignal): Promise<ConfigMutationResponse> {
		return this.#mutate("set", key, value, signal);
	}

	async unset(key: string, signal: AbortSignal): Promise<ConfigMutationResponse> {
		return this.#mutate("unset", key, undefined, signal);
	}

	async #mutate(
		action: "set" | "unset",
		key: string,
		value: string | undefined,
		signal: AbortSignal,
	): Promise<ConfigMutationResponse> {
		signal.throwIfAborted();
		let mutation: Awaited<ReturnType<typeof mutateUserConfigSetting>>;
		try {
			mutation = await mutateUserConfigSetting({
				...this.#options,
				action,
				key,
				...(value === undefined ? {} : { value }),
			});
		} catch (error) {
			if (!isConfigError(error)) throw error;
			throw new ConfigManagementError(error.diagnostic);
		}
		const { resolved, shell } = await this.#snapshot(signal);
		const setting = requireSettingRow(mutation.key, resolved.config, resolved.layers, shell);
		return Object.freeze({
			version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
			ok: true,
			action,
			message: mutation.changed ? "user configuration updated" : "user configuration unchanged",
			key: mutation.key,
			changed: mutation.changed,
			effectiveSource: setting.source,
			overridden: setting.overridden,
			diagnostics: Object.freeze([...resolved.diagnostics]),
		});
	}

	async #resolve(signal: AbortSignal): ReturnType<typeof resolveConfigWithMetadata> {
		signal.throwIfAborted();
		try {
			const resolved = await resolveConfigWithMetadata({
				...this.#options,
				createSessionId: () => "config-management",
			});
			signal.throwIfAborted();
			return resolved;
		} catch (error) {
			if (!isConfigError(error)) throw error;
			throw new ConfigManagementError(error.diagnostic);
		}
	}

	async #snapshot(signal: AbortSignal): Promise<{
		readonly resolved: Awaited<ReturnType<typeof resolveConfigWithMetadata>>;
		readonly shell: LoadedShellSettings;
	}> {
		const [resolved, shell] = await Promise.all([
			this.#resolve(signal),
			loadShellSettingsState({ homeDir: this.#options.homeDir }),
		]);
		signal.throwIfAborted();
		return Object.freeze({ resolved, shell });
	}
}

export class ConfigManagementError extends Error {
	readonly diagnostic: ConfigDiagnostic;

	constructor(diagnostic: ConfigDiagnostic) {
		super("configuration invalid");
		this.name = "ConfigManagementError";
		this.diagnostic = diagnostic;
	}
}

export function configFailureResponse(
	action: ConfigManagementAction,
	error: ConfigManagementError,
): ConfigFailureResponse {
	return Object.freeze({
		version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
		ok: false,
		action,
		message: "configuration invalid",
		issues: Object.freeze([error.diagnostic.code]),
		exitCode: 1,
		diagnostics: Object.freeze([error.diagnostic]),
	});
}

function projectLayers(layers: ConfigLayerStack): readonly ConfigLayerRow[] {
	return Object.freeze(layers.layers.map((layer) => Object.freeze({
		id: layer.metadata.id,
		scope: layer.metadata.scope,
		enabled: layer.metadata.enabled,
		...(layer.metadata.disabledReason === undefined
			? {}
			: { disabledReason: layer.metadata.disabledReason }),
	})));
}

function projectSettings(
	config: Awaited<ReturnType<typeof resolveConfigWithMetadata>>["config"],
	layers: ConfigLayerStack,
	shell: LoadedShellSettings,
): readonly ConfigSettingRow[] {
	const runtimeRows = runtimeSettingSnapshots(config).map((snapshot) => {
		const origin = snapshot.originKeys
			.map((key) => layers.origins[key])
			.find((candidate) => candidate !== undefined);
		const value = snapshot.key === "model.api_base_url"
			? safeBaseUrl(String(snapshot.value))
			: snapshot.key === "context.compaction_l4_trigger_ratios_by_model"
				? boundedRatioMap(config.compactionTriggerRatiosByModel)
				: snapshot.value;
		const truncated = snapshot.key === "context.compaction_l4_trigger_ratios_by_model"
			&& Object.keys(config.compactionTriggerRatiosByModel).length > MAX_RATIO_ROWS;
		return Object.freeze({
			key: snapshot.key,
			value: safeSettingValue(value),
			source: origin?.source.id ?? "default",
			overridden: Object.freeze(origin?.overridden.map((layer) => layer.id) ?? []),
			...(truncated ? { truncated: true } : {}),
		});
	});
	const shellRows = SHELL_SETTING_DESCRIPTORS.map((item) => Object.freeze({
		key: item.key,
		value: shell.settings[item.settingKey],
		source: shell.sources[item.settingKey],
		overridden: Object.freeze([]),
	}));
	return Object.freeze([...runtimeRows, ...shellRows].sort((left, right) => compareText(left.key, right.key)));
}

function requireSettingRow(
	key: string,
	config: Awaited<ReturnType<typeof resolveConfigWithMetadata>>["config"],
	layers: ConfigLayerStack,
	shell: LoadedShellSettings,
): ConfigSettingRow {
	const setting = projectSettings(config, layers, shell).find((candidate) => candidate.key === key);
	if (setting) return setting;
	throw new ConfigManagementError(configDiagnostic({
		code: "invalid_value",
		severity: "error",
		message: "configuration setting is not supported",
		remediation: "Use 'mycli config show' to list supported settings.",
	}));
}

function boundedRatioMap(value: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
	return Object.freeze(Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => compareText(left, right))
			.slice(0, MAX_RATIO_ROWS)
			.map(([key, ratio]) => [safeText(key, 128), ratio]),
	));
}

function safeSettingValue(value: ConfigSettingValue): ConfigSettingValue {
	if (typeof value === "string") return safeText(value, 512);
	if (value === null || typeof value !== "object") return value;
	return Object.freeze(Object.fromEntries(
		Object.entries(value).map(([key, ratio]) => [safeText(key, 128), ratio]),
	));
}

function safeBaseUrl(value: string): string {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "configured";
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString().replace(/\/$/u, "");
	} catch {
		return "configured";
	}
}

function safeText(value: string, limit: number): string {
	return redactDoctorText(value).slice(0, limit);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
