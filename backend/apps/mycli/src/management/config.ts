import {
	applyConfigMigration,
	configDiagnostic,
	isConfigError,
	mutateUserConfigSetting,
	parseConfigProfileName,
	previewConfigMigration,
	resolveConfigPath,
	resolveConfigWithMetadata,
	rollbackConfigMigration,
	runtimeSettingSnapshots,
	SHELL_SETTING_DESCRIPTORS,
	type ConfigDiagnostic,
	type ConfigLayerDisabledReason,
	type ConfigLayerId,
	type ConfigLayerScope,
	type ConfigLayerStack,
	type ConfigMigrationChange,
	type ConfigPathScope,
	type ConfigProfileName,
	type LoadedShellSettings,
	type WorkspaceTrustState,
} from "@mycli/config";
import { redactDoctorText } from "./doctor/redaction.ts";
import type { ManagementResponse } from "./types.ts";

const CONFIG_MANAGEMENT_RESPONSE_VERSION = 1 as const;

type ConfigManagementAction = "get" | "migrate" | "path" | "set" | "show" | "unset" | "validate";

type ConfigSettingSource = ConfigLayerId | "default";
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

interface ConfigCredentialState {
	readonly apiKey: "present" | "missing";
}

interface ConfigManagementResponseBase extends ManagementResponse {
	readonly version: typeof CONFIG_MANAGEMENT_RESPONSE_VERSION;
	readonly action: ConfigManagementAction;
	readonly diagnostics: readonly ConfigDiagnostic[];
}

interface ConfigValidateResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "validate";
	readonly strict: boolean;
}

export interface ConfigShowResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "show";
	readonly workspaceTrust: WorkspaceTrustState;
	readonly credentials: ConfigCredentialState;
	readonly layers: readonly ConfigLayerRow[];
	readonly settings: readonly ConfigSettingRow[];
}

interface ConfigGetResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "get";
	readonly setting: ConfigSettingRow;
}

export interface ConfigPathResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "path";
	readonly scope: ConfigPathScope;
	readonly path: string;
	readonly writable: boolean;
}

interface ConfigMutationResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "set" | "unset";
	readonly key: string;
	readonly changed: boolean;
	readonly effectiveSource: ConfigSettingSource;
	readonly overridden: readonly ConfigLayerId[];
}

export interface ConfigMigrationResponse extends ConfigManagementResponseBase {
	readonly ok: true;
	readonly action: "migrate";
	readonly operation: "apply" | "preview" | "rollback";
	readonly needed?: boolean;
	readonly applied?: boolean;
	readonly restored?: boolean;
	readonly expectedVersion?: string;
	readonly currentVersion: string;
	readonly legacyVersion?: string;
	readonly resultingVersion?: string;
	readonly backupId?: string;
	readonly changes?: readonly ConfigMigrationChange[];
	readonly truncated?: boolean;
}

interface ConfigFailureResponse extends ConfigManagementResponseBase {
	readonly ok: false;
	readonly action: ConfigManagementAction;
}

export type ConfigManagementResponse =
	| ConfigValidateResponse
	| ConfigShowResponse
	| ConfigGetResponse
	| ConfigPathResponse
	| ConfigMutationResponse
	| ConfigMigrationResponse
	| ConfigFailureResponse;

interface ConfigManagementServiceOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly workspaceTrust: WorkspaceTrustState;
	readonly configProfile?: ConfigProfileName;
	readonly systemConfigPath?: string;
}

const MAX_RATIO_ROWS = 64;

export class ConfigManagementService {
	readonly #options: ConfigManagementServiceOptions;

	constructor(options: ConfigManagementServiceOptions) {
		this.#options = options;
	}

	async validate(signal: AbortSignal): Promise<ConfigValidateResponse | ConfigFailureResponse>;
	async validate(
		strict: boolean,
		signal: AbortSignal,
	): Promise<ConfigValidateResponse | ConfigFailureResponse>;
	async validate(
		strictOrSignal: boolean | AbortSignal,
		maybeSignal?: AbortSignal,
	): Promise<ConfigValidateResponse | ConfigFailureResponse> {
		const strict = typeof strictOrSignal === "boolean" ? strictOrSignal : false;
		const signal = typeof strictOrSignal === "boolean" ? maybeSignal! : strictOrSignal;
		const resolved = await this.#resolve(signal);
		if (strict && resolved.diagnostics.length > 0) {
			return Object.freeze({
				version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
				ok: false,
				action: "validate",
				message: "configuration failed strict validation",
				issues: Object.freeze(["strict_validation_failed"]),
				exitCode: 1,
				diagnostics: Object.freeze([...resolved.diagnostics]),
			});
		}
		return Object.freeze({
			version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
			ok: true,
			action: "validate",
			strict,
			message: resolved.diagnostics.length > 0
				? "configuration valid with warnings"
				: "configuration valid",
			diagnostics: Object.freeze([...resolved.diagnostics]),
		});
	}

	async path(
		scope: ConfigPathScope,
		profile: string | undefined,
		signal: AbortSignal,
	): Promise<ConfigPathResponse> {
		signal.throwIfAborted();
		let configProfile = this.#options.configProfile;
		let resolved: ReturnType<typeof resolveConfigPath>;
		try {
			if (profile !== undefined) configProfile = parseConfigProfileName(profile);
			resolved = resolveConfigPath({
				scope,
				homeDir: this.#options.homeDir,
				workspaceRoot: this.#options.workspaceRoot,
				...(configProfile ? { configProfile } : {}),
				programDataDir: this.#options.env.ProgramData,
				...(this.#options.systemConfigPath
					? { systemConfigPath: this.#options.systemConfigPath }
					: {}),
			});
		} catch {
			throw new ConfigManagementError(configDiagnostic({
				code: "invalid_value",
				severity: "error",
				message: "configuration path selection is invalid",
				remediation: "Use a supported scope and a plain profile name.",
			}));
		}
		signal.throwIfAborted();
		return Object.freeze({
			version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
			ok: true,
			action: "path",
			message: "configuration path",
			...resolved,
			diagnostics: Object.freeze([]),
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

	async previewMigration(signal: AbortSignal): Promise<ConfigMigrationResponse> {
		return this.#runMigration("preview", undefined, signal);
	}

	async applyMigration(
		expectedVersion: string,
		signal: AbortSignal,
	): Promise<ConfigMigrationResponse> {
		return this.#runMigration("apply", expectedVersion, signal);
	}

	async rollbackMigration(
		backupId: string,
		signal: AbortSignal,
	): Promise<ConfigMigrationResponse> {
		return this.#runMigration("rollback", backupId, signal);
	}

	async #runMigration(
		operation: "apply" | "preview" | "rollback",
		argument: string | undefined,
		signal: AbortSignal,
	): Promise<ConfigMigrationResponse> {
		signal.throwIfAborted();
		try {
			const options = {
				...this.#options,
				createSessionId: () => "config-migration",
			};
			if (operation === "rollback") {
				const result = await rollbackConfigMigration({
					...options,
					backupId: argument ?? "",
				});
				signal.throwIfAborted();
				return Object.freeze({
					version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
					ok: true,
					action: "migrate",
					operation,
					message: result.restored
						? "user configuration restored"
						: "user configuration already matched the backup",
					restored: result.restored,
					backupId: result.backupId,
					currentVersion: result.currentVersion,
					diagnostics: result.diagnostics,
				});
			}
			if (operation === "apply") {
				const result = await applyConfigMigration({
					...options,
					expectedVersion: argument ?? "",
				});
				signal.throwIfAborted();
				return Object.freeze({
					version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
					ok: true,
					action: "migrate",
					operation,
					message: result.applied
						? "configuration migration applied"
						: "configuration migration not needed",
					needed: result.needed,
					applied: result.applied,
					expectedVersion: result.expectedVersion,
					currentVersion: result.currentVersion,
					legacyVersion: result.legacyVersion,
					resultingVersion: result.resultingVersion,
					...(result.backupId ? { backupId: result.backupId } : {}),
					changes: result.changes,
					truncated: result.truncated,
					diagnostics: result.diagnostics,
				});
			}
			const result = await previewConfigMigration(options);
			signal.throwIfAborted();
			return Object.freeze({
				version: CONFIG_MANAGEMENT_RESPONSE_VERSION,
				ok: true,
				action: "migrate",
				operation,
				message: result.needed
					? "configuration migration available"
					: "configuration migration not needed",
				needed: result.needed,
				expectedVersion: result.expectedVersion,
				currentVersion: result.currentVersion,
				legacyVersion: result.legacyVersion,
				resultingVersion: result.resultingVersion,
				changes: result.changes,
				truncated: result.truncated,
				diagnostics: result.diagnostics,
			});
		} catch (error) {
			if (!isConfigError(error)) throw error;
			throw new ConfigManagementError(error.diagnostic);
		}
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
		const resolved = await this.#resolve(signal);
		signal.throwIfAborted();
		return Object.freeze({ resolved, shell: resolved.shellSettings });
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
		overridden: shell.overridden[item.settingKey],
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
