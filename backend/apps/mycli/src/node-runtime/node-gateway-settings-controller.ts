import {
	CachedUpdateError,
	shellSettingDescriptor,
	type CachedUpdateStatus,
	type WorkspaceTrustState,
} from "@mycli/config";
import {
	isModelSelectionScope,
	type ModelSelectionScope,
} from "@mycli/contracts";
import type { ReasoningEffort } from "@mycli/core";
import type { ExecutionPolicySnapshot } from "@mycli/runtime";
import {
	sandboxNotRequired,
	type PermissionProfile,
	type SandboxReadiness,
} from "@mycli/tools";
import { buildNodeSettingsCatalog } from "./node-settings-catalog.ts";
import {
	diagnosticCommandResult,
	errorCommandResult,
	noticeCommandResult,
} from "./node-slash-command-results.ts";
import type { ResolvedSlashCommand } from "./node-slash-command-registry.ts";
import { GatewayFailure } from "./node-gateway-errors.ts";
import {
	optionalBoundedIdentity,
	requiredBoundedString as requiredString,
} from "./node-gateway-validation.ts";
import type { SessionPreferences } from "./session-preferences.ts";
import type {
	CreateNodeGatewayOptions,
	NodeGatewayControlCommands,
	NodeGatewayCredentialReadiness,
	NodeGatewayRuntime,
	NodeGatewayUpdateCommands,
} from "./node-gateway-types.ts";

type JsonObject = Record<string, unknown>;

interface SettingsSnapshot {
	readonly settings: JsonObject;
	readonly sources: JsonObject;
	readonly keymap: JsonObject;
	readonly terminalCapabilities: JsonObject;
}

interface NodeGatewaySettingsControllerOptions {
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly updateStatus?: CachedUpdateStatus;
	readonly sandboxReadiness?: SandboxReadiness;
	readonly controlCommands?: NodeGatewayControlCommands;
	readonly updateCommands?: NodeGatewayUpdateCommands;
	readonly workspaceTrust?: CreateNodeGatewayOptions["workspaceTrust"];
	readonly integrationsAvailable: boolean;
	readonly runtime: () => NodeGatewayRuntime;
	readonly workspaceRoot: () => string;
	readonly claimSessionControl: (message: string) => () => void;
	readonly status: () => JsonObject;
	readonly contextWindow: () => JsonObject;
	readonly publish: (
		method: "status.changed" | "workspace.trust.changed",
		params: JsonObject,
	) => void;
}

export class NodeGatewaySettingsController {
	readonly #options: NodeGatewaySettingsControllerOptions;
	readonly #collaborationModeByTurn = new Map<string, "default" | "plan">();
	#trustState: WorkspaceTrustState;
	#permissionProfile: PermissionProfile = "workspace";
	#provider: string;
	#model: string;
	#reasoningEffort: ReasoningEffort | undefined;
	#visibleUpdateStatus: CachedUpdateStatus | undefined;
	#collaborationMode: "default" | "plan" = "default";

	constructor(options: NodeGatewaySettingsControllerOptions) {
		this.#options = options;
		this.#trustState = options.workspaceTrust?.initialState ?? "unknown";
		this.#provider = options.provider;
		this.#model = options.model;
		this.#reasoningEffort = options.reasoningEffort;
		this.#visibleUpdateStatus = options.updateStatus;
		this.applySessionPreferences(options.runtime().sessionPreferences?.(), options.runtime());
		this.configureExecutionPolicy();
	}

	get provider(): string {
		return this.#provider;
	}

	get model(): string {
		return this.#model;
	}

	get reasoningEffort(): ReasoningEffort | undefined {
		return this.#reasoningEffort;
	}

	get collaborationMode(): "default" | "plan" {
		return this.#collaborationMode;
	}

	get permissionProfile(): PermissionProfile {
		return this.#permissionProfile;
	}

	get visibleUpdateStatus(): CachedUpdateStatus | undefined {
		return this.#visibleUpdateStatus;
	}

	modeForTurn(turnId: string): "default" | "plan" {
		return this.#collaborationModeByTurn.get(turnId) ?? this.#collaborationMode;
	}

	rememberTurnMode(turnId: string, mode: "default" | "plan"): void {
		this.#collaborationModeByTurn.set(turnId, mode);
	}

	forgetTurnMode(turnId: string): void {
		this.#collaborationModeByTurn.delete(turnId);
	}

	authProviders(): Promise<readonly JsonObject[]> {
		return this.#options.controlCommands?.authProviders() ?? Promise.resolve([]);
	}

	async credentialReadiness(): Promise<NodeGatewayCredentialReadiness | null> {
		return await this.#options.controlCommands?.credentialReadiness?.() ?? null;
	}

	models(provider: string): Promise<readonly JsonObject[]> {
		return this.#options.controlCommands?.models(provider) ?? Promise.resolve([]);
	}

	async providerList(): Promise<JsonObject> {
		return { providers: await this.#options.controlCommands?.providers() ?? [] };
	}

	async modelList(params: JsonObject): Promise<JsonObject> {
		const provider = requiredString(params.provider, "provider").trim();
		return { provider, models: await this.models(provider) };
	}

	async saveApiKey(params: JsonObject): Promise<JsonObject> {
		const release = this.#options.claimSessionControl(
			"Wait for the current session operation before saving credentials.",
		);
		try {
			const providerId = requiredString(params.provider_id, "provider_id").trim();
			const apiKey = requiredString(params.api_key, "api_key").trim();
			const authRef = optionalBoundedIdentity(params.auth_ref, "auth_ref");
			const commands = this.#options.controlCommands;
			if (!commands) {
				throw new GatewayFailure("internal_error", "Credential storage is unavailable.");
			}
			const saved = await commands.saveApiKey(providerId, apiKey, authRef);
			const readiness = await this.credentialReadiness();
			return {
				...saved,
				auth_providers: await this.authProviders(),
				...(readiness ? { auth_status: credentialReadinessPayload(readiness) } : {}),
			};
		} finally {
			release();
		}
	}

	async selectModel(params: JsonObject): Promise<JsonObject> {
		const release = this.#options.claimSessionControl(
			"Wait for the current turn to finish before changing models.",
		);
		try {
			const effort = reasoningEffort(params.reasoning_effort);
			const scope = modelSelectionScope(params.scope);
			const selection: JsonObject = {
				provider: requiredString(params.provider, "provider").trim(),
				protocol: requiredString(params.protocol, "protocol").trim(),
				model: requiredString(params.model, "model").trim(),
				base_url: requiredString(params.base_url, "base_url").trim(),
				collaboration_mode: this.#collaborationMode,
				scope,
				...(effort ? { reasoning_effort: effort } : {}),
			};
			const commands = this.#options.controlCommands;
			if (!commands) throw new GatewayFailure("internal_error", "Model selection is unavailable.");
			const selected = await commands.selectModel(selection);
			const persisted = this.#options.runtime().sessionPreferences?.();
			if (persisted) {
				this.applySessionPreferences(persisted);
			} else {
				this.#provider = String(selected.provider ?? selection.provider);
				this.#model = String(selected.model ?? selection.model);
				this.#reasoningEffort = reasoningEffort(selected.reasoning_effort ?? effort);
			}
			const status = this.#options.status();
			this.#options.publish("status.changed", status);
			const selectedProvider = String(selected.provider ?? selection.provider);
			const models = await this.models(selectedProvider);
			const authStatus = await this.credentialReadiness();
			return {
				selected,
				auth_providers: await this.authProviders(),
				provider: selectedProvider,
				scope,
				status,
				models: models.map((entry) => ({
					...entry,
					current: sameModelCatalogIdentity(entry, selected),
				})),
				...(authStatus ? { auth_status: credentialReadinessPayload(authStatus) } : {}),
			};
		} finally {
			release();
		}
	}

	async validateConnectivity(): Promise<JsonObject> {
		const release = this.#options.claimSessionControl(
			"Wait for the current turn to finish before testing provider connectivity.",
		);
		try {
			const validate = this.#options.controlCommands?.validateConnectivity;
			return validate
				? await validate()
				: { ok: false, message: "Connection testing is unavailable." };
		} finally {
			release();
		}
	}

	async loadSettings(): Promise<JsonObject> {
		return this.#settingsPayload(settingsSnapshot(
			await this.#options.controlCommands?.loadSettings(),
		));
	}

	async resetKeymap(): Promise<JsonObject> {
		const release = this.#options.claimSessionControl(
			"Wait for the current session operation before resetting the keymap.",
		);
		try {
			const resetKeymap = this.#options.controlCommands?.resetKeymap;
			if (!resetKeymap) {
				throw new GatewayFailure("internal_error", "Keymap storage is unavailable.");
			}
			return {
				ok: true,
				message: "Reset TUI keymap.",
				...await this.#settingsPayload(settingsSnapshot(await resetKeymap())),
			};
		} finally {
			release();
		}
	}

	async saveSettings(params: JsonObject): Promise<JsonObject> {
		const release = this.#options.claimSessionControl(
			"Wait for the current session operation before saving settings.",
		);
		try {
			const commands = this.#options.controlCommands;
			if (!commands) throw new GatewayFailure("internal_error", "Settings storage is unavailable.");
			if ("setting_id" in params || "value" in params) {
				const mutation = shellSettingMutation(params);
				if (!commands.saveSetting) {
					throw new GatewayFailure("internal_error", "Settings storage is unavailable.");
				}
				const saved = settingsSnapshot(
					await commands.saveSetting(mutation.settingId, mutation.value),
				);
				return {
					ok: true,
					message: "Saved TUI setting.",
					...await this.#settingsPayload({
						...saved,
						sources: authoritativeSettingsSources(saved),
					}),
				};
			}
			if (!isObject(params.settings)) {
				throw new GatewayFailure("invalid_params", "settings is required.");
			}
			const saved = settingsSnapshot(await commands.saveSettings(params.settings));
			return {
				ok: true,
				message: "Saved TUI settings.",
				...await this.#settingsPayload({
					...saved,
					sources: authoritativeSettingsSources(saved),
				}),
			};
		} finally {
			release();
		}
	}

	async updateStatus(): Promise<JsonObject> {
		this.#visibleUpdateStatus = await this.#requiredUpdateCommands().status();
		return { update: cachedUpdateStatusPayload(this.#visibleUpdateStatus) };
	}

	async updateDismiss(params: JsonObject): Promise<JsonObject> {
		const version = requiredString(params.version, "version").trim();
		try {
			this.#visibleUpdateStatus = await this.#requiredUpdateCommands().dismiss(version);
		} catch (error) {
			throw updateGatewayFailure(error);
		}
		return {
			ok: true,
			dismissed_version: version,
			update: cachedUpdateStatusPayload(this.#visibleUpdateStatus),
		};
	}

	async updateCommand(invocation: ResolvedSlashCommand): Promise<JsonObject> {
		const commands = this.#requiredUpdateCommands();
		const args = invocation.args.trim();
		if (!args || args === "status") {
			this.#visibleUpdateStatus = await commands.status();
			return diagnosticCommandResult(
				invocation,
				"Updates",
				updateCommandFields(this.#visibleUpdateStatus),
			);
		}
		if (args === "check") {
			const checked = await commands.check();
			this.#visibleUpdateStatus = checked.status;
			return diagnosticCommandResult(invocation, "Updates", [
				{ label: "Check", value: checked.outcome },
				...updateCommandFields(checked.status),
			]);
		}
		const dismissMatch = /^dismiss\s+(\S+)$/u.exec(args);
		if (dismissMatch) {
			const version = dismissMatch[1]!;
			try {
				this.#visibleUpdateStatus = await commands.dismiss(version);
			} catch (error) {
				if (error instanceof CachedUpdateError) {
					return errorCommandResult(
						invocation,
						updateErrorMessage(error.code),
						"/update dismiss <version>",
					);
				}
				throw error;
			}
			return noticeCommandResult(invocation, "Updates", `Dismissed update ${version}.`, {
				extra: {
					dismissed_update_version: version,
					update_status: cachedUpdateStatusPayload(this.#visibleUpdateStatus),
				},
			});
		}
		return errorCommandResult(
			invocation,
			"Unsupported update action",
			"/update [check|dismiss <version>]",
		);
	}

	trustStatus(): JsonObject {
		return {
			state: this.#trustState,
			workspace: this.#options.workspaceRoot(),
			source: this.#options.workspaceTrust ? "user_store" : "runtime",
			enforced: this.#options.runtime().configureExecutionPolicy !== undefined,
		};
	}

	async setWorkspaceTrust(params: JsonObject): Promise<JsonObject> {
		const release = this.#options.claimSessionControl(
			"Wait for the current turn to finish before changing workspace trust.",
		);
		try {
			const state = workspaceTrustState(params.state);
			const workspaceRoot = this.#options.workspaceRoot();
			const trust = this.#options.workspaceTrust;
			const previousState = this.#trustState;
			let nextPreferences: SessionPreferences | void = undefined;
			if (trust && state === "trusted") {
				await trust.save(workspaceRoot, state);
				try {
					nextPreferences = await trust.reload?.(workspaceRoot, state);
				} catch {
					try {
						await trust.save(workspaceRoot, previousState);
						const restored = await trust.reload?.(workspaceRoot, previousState);
						if (restored) this.applySessionPreferences(restored);
					} catch {
						this.#trustState = "unknown";
						this.configureExecutionPolicy();
						await trust.reload?.(workspaceRoot, "unknown").catch(() => undefined);
					}
					throw new GatewayFailure(
						"internal_error",
						"Workspace trust could not be applied.",
					);
				}
			} else if (trust) {
				try {
					nextPreferences = await trust.reload?.(workspaceRoot, state);
				} catch {
					throw new GatewayFailure(
						"internal_error",
						"Workspace trust could not be applied.",
					);
				}
				try {
					await trust.save(workspaceRoot, state);
				} catch {
					this.#trustState = "unknown";
					this.configureExecutionPolicy();
					if (nextPreferences) this.applySessionPreferences(nextPreferences);
					throw new GatewayFailure(
						"internal_error",
						"Workspace trust could not be saved.",
					);
				}
			}
			if (nextPreferences) this.applySessionPreferences(nextPreferences);
			this.#trustState = state;
			this.configureExecutionPolicy();
			const payload = this.trustStatus();
			this.#options.publish("workspace.trust.changed", payload);
			this.#options.publish("status.changed", this.#options.status());
			return payload;
		} finally {
			release();
		}
	}

	permissions(): JsonObject {
		const runtime = this.#options.runtime();
		return permissionPayload(
			this.#permissionProfile,
			runtime.listCommandAllowances?.().length ?? 0,
			runtime.executionPolicySnapshot?.(),
			this.#options.sandboxReadiness,
		);
	}

	updatePermissions(params: JsonObject): JsonObject {
		this.#permissionProfile = permissionProfile(params.profile);
		this.ensureSessionPreferences(this.#collaborationMode);
		this.configureExecutionPolicy();
		const permissions = this.permissions();
		const status = this.#options.status();
		this.#options.publish("status.changed", status);
		return { permissions, status };
	}

	setCollaborationMode(mode: "default" | "plan", publish = true): void {
		this.ensureSessionPreferences(mode);
		this.#collaborationMode = mode;
		this.#options.runtime().configureRuntimeContext?.({ collaborationMode: mode });
		if (publish) this.#options.publish("status.changed", this.#options.status());
	}

	updateSandbox(value: string): "read-only" | "workspace-write" | "danger-full-access" {
		const sandbox = requestedSandboxMode(value, this.#permissionProfile);
		this.#permissionProfile = permissionForSandbox(sandbox);
		this.ensureSessionPreferences(this.#collaborationMode);
		this.configureExecutionPolicy();
		this.#options.publish("status.changed", this.#options.status());
		return sandbox;
	}

	ensureSessionPreferences(collaborationMode: "default" | "plan"): void {
		const preferences = this.#options.runtime().ensureSessionPreferences?.({
			provider: this.#provider,
			model: this.#model,
			...(this.#reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
			collaborationMode,
			permissionProfile: this.#permissionProfile,
		});
		if (preferences) this.applySessionPreferences(preferences);
	}

	applySessionPreferences(
		preferences: SessionPreferences | undefined,
		runtime: NodeGatewayRuntime = this.#options.runtime(),
	): void {
		if (!preferences) return;
		this.#provider = preferences.provider;
		this.#model = preferences.model;
		this.#reasoningEffort = preferences.reasoningEffort;
		this.#collaborationMode = preferences.collaborationMode;
		if (preferences.permissionProfile) this.#permissionProfile = preferences.permissionProfile;
		runtime.configureRuntimeContext?.({ collaborationMode: preferences.collaborationMode });
	}

	configureExecutionPolicy(runtime: NodeGatewayRuntime = this.#options.runtime()): void {
		runtime.configureExecutionPolicy?.({
			trust: this.#trustState,
			permission: this.#permissionProfile,
		});
		runtime.configureRuntimeContext?.({ collaborationMode: this.#collaborationMode });
	}

	async activateSession(workspaceRoot: string, runtime: NodeGatewayRuntime): Promise<void> {
		const trustState = await this.loadWorkspaceTrust(workspaceRoot);
		await this.#options.workspaceTrust?.reload?.(workspaceRoot, trustState);
		this.#trustState = trustState;
		const storedPreferences = runtime.sessionPreferences?.();
		const preferences = await this.#options.controlCommands?.activateSessionPreferences?.(
			storedPreferences,
		) ?? storedPreferences;
		this.applySessionPreferences(preferences, runtime);
		this.configureExecutionPolicy(runtime);
	}

	async loadWorkspaceTrust(workspaceRoot: string): Promise<WorkspaceTrustState> {
		try {
			return await this.#options.workspaceTrust?.load(workspaceRoot) ?? "unknown";
		} catch {
			return "unknown";
		}
	}

	async #settingsPayload(snapshot: SettingsSnapshot): Promise<JsonObject> {
		const credential = await this.credentialReadiness();
		return {
			settings: snapshot.settings,
			sources: snapshot.sources,
			keymap: snapshot.keymap,
			terminal_capabilities: snapshot.terminalCapabilities,
			source: Object.values(snapshot.sources).some((value) => value === "user")
				? "user_config"
				: "defaults",
			catalog: buildNodeSettingsCatalog({
				settings: snapshot.settings,
				sources: settingsSources(snapshot.sources),
				keymap: snapshot.keymap,
				terminalCapabilities: snapshot.terminalCapabilities,
				provider: this.#provider,
				model: this.#model,
				...(this.#reasoningEffort ? { reasoningEffort: this.#reasoningEffort } : {}),
				...(credential ? {
					credential: { ready: credential.ready, source: credential.source },
				} : {}),
				permissions: this.permissions(),
				trust: this.trustStatus(),
				context: this.#options.contextWindow(),
				integrationsAvailable: this.#options.integrationsAvailable,
				...(this.#visibleUpdateStatus ? { update: this.#visibleUpdateStatus } : {}),
			}),
		};
	}

	#requiredUpdateCommands(): NodeGatewayUpdateCommands {
		const commands = this.#options.updateCommands;
		if (!commands) throw new GatewayFailure("unavailable_feature", "Update status is unavailable.");
		return commands;
	}
}

export function credentialReadinessPayload(
	readiness: NodeGatewayCredentialReadiness,
): JsonObject {
	return {
		ready: readiness.ready,
		provider_id: boundedString(readiness.providerId.replace(/[\r\n\0]/gu, ""), 256),
		auth_ref: boundedString(readiness.authRef.replace(/[\r\n\0]/gu, ""), 512),
		source: readiness.source,
	};
}

export function sandboxForPermission(
	value: PermissionProfile,
): "read-only" | "workspace-write" | "danger-full-access" {
	return value === "read-only"
		? "read-only"
		: value === "workspace"
			? "workspace-write"
			: "danger-full-access";
}

export function cachedUpdateStatusPayload(status: CachedUpdateStatus): JsonObject {
	return {
		schema_version: status.schemaVersion,
		package_name: status.packageName,
		current_version: status.currentVersion,
		check_on_startup: status.checkOnStartup,
		availability: status.availability,
		cache_state: status.cacheState,
		install: {
			method: status.install.method,
			command: status.install.command,
			fallback: status.install.fallback,
		},
		...(status.latestVersion ? { latest_version: status.latestVersion } : {}),
		...(status.lastCheckedAt ? { last_checked_at: status.lastCheckedAt } : {}),
		...(status.dismissedVersion ? { dismissed_version: status.dismissedVersion } : {}),
	};
}

function updateCommandFields(status: CachedUpdateStatus): readonly {
	readonly label: string;
	readonly value: string;
}[] {
	return [
		{ label: "Current", value: status.currentVersion },
		{ label: "Latest", value: status.latestVersion ?? "unknown" },
		{ label: "Status", value: status.availability },
		{ label: "Cache", value: status.cacheState },
		{ label: "Install", value: status.install.command },
	];
}

function updateGatewayFailure(error: unknown): GatewayFailure {
	if (!(error instanceof CachedUpdateError)) {
		return new GatewayFailure("internal_error", "Update operation failed.");
	}
	const code = error.code === "update_cache_write_failed" ? "internal_error" : "invalid_params";
	return new GatewayFailure(code, updateErrorMessage(error.code));
}

function updateErrorMessage(code: CachedUpdateError["code"]): string {
	if (code === "invalid_update_version") return "Update version must be a stable semantic version.";
	if (code === "update_version_unavailable") return "That update version is not currently advertised.";
	return "Update dismissal could not be saved.";
}

function permissionProfile(value: unknown): PermissionProfile {
	if (value === "read-only" || value === "workspace" || value === "full-access") return value;
	throw new GatewayFailure("invalid_params", "Unsupported permission profile.");
}

function permissionPayload(
	active: PermissionProfile,
	commandAllowanceCount = 0,
	snapshot?: ExecutionPolicySnapshot,
	readiness?: SandboxReadiness,
): JsonObject {
	const profile = snapshot?.profile ?? nominalExecutionPolicy(active);
	const resolution = snapshot?.resolution;
	const sandboxReadiness = processSandboxRequired(profile)
		? readiness
		: sandboxNotRequired(readiness?.platform);
	return {
		active,
		command_allowance_count: commandAllowanceCount,
		effective: {
			trusted: snapshot?.trusted ?? false,
			valid: snapshot?.valid ?? false,
			sandbox_mode: profile.mode,
			filesystem: profile.filesystem,
			network: profile.network,
			approval_behavior: profile.filesystem === "unrestricted" ? "never" : "on-request",
			source: resolution?.configurationSource ?? "session",
			constrained: resolution?.constraintsSource !== undefined,
			...(resolution?.constraintsSource ? { constraints_source: resolution.constraintsSource } : {}),
			readable_roots: profile.readableRoots?.length ?? 0,
			writable_roots: profile.writableRoots.length,
			network_domains: profile.networkDomains?.length ?? 0,
			session_grant: resolution?.sessionGrant !== undefined,
			turn_grant: resolution?.turnGrant !== undefined,
		},
		...(sandboxReadiness ? {
			sandbox_readiness: {
				state: sandboxReadiness.state,
				code: sandboxReadiness.code,
				platform: sandboxReadiness.platform,
				isolation: sandboxReadiness.isolation,
			},
		} : {}),
		profiles: [
			permissionProfileRow(
				"workspace",
				"Ask for approval",
				"Read and edit the current workspace with network access; ask before outside access or risky commands.",
				active,
			),
			permissionProfileRow(
				"full-access",
				"Full Access",
				"Access files and network without approval.",
				active,
			),
			permissionProfileRow(
				"read-only",
				"Read Only",
				"Read workspace files; ask before edits or network.",
				active,
			),
		],
	};
}

function permissionProfileRow(
	id: PermissionProfile,
	label: string,
	description: string,
	active: PermissionProfile,
): JsonObject {
	const policy = nominalExecutionPolicy(id);
	return {
		id,
		label,
		description,
		current: active === id,
		sandbox_mode: policy.mode,
		filesystem: policy.filesystem,
		network: policy.network,
		approval_behavior: policy.filesystem === "unrestricted" ? "never" : "on-request",
	};
}

function nominalExecutionPolicy(active: PermissionProfile): ExecutionPolicySnapshot["profile"] {
	if (active === "read-only") {
		return { mode: "read-only", filesystem: "read_only", network: "disabled", writableRoots: [] };
	}
	if (active === "workspace") {
		return {
			mode: "workspace-write",
			filesystem: "workspace_write",
			network: "enabled",
			writableRoots: [],
		};
	}
	return {
		mode: "danger-full-access",
		filesystem: "unrestricted",
		network: "enabled",
		writableRoots: [],
	};
}

function processSandboxRequired(profile: ExecutionPolicySnapshot["profile"]): boolean {
	return profile.mode !== "danger-full-access"
		|| profile.network !== "enabled"
		|| profile.networkDomains !== undefined;
}

function settingsSnapshot(value: JsonObject | undefined): SettingsSnapshot {
	if (!value) return { settings: {}, sources: {}, keymap: {}, terminalCapabilities: {} };
	if (isObject(value.settings)) {
		return {
			settings: { ...value.settings },
			sources: isObject(value.sources) ? { ...value.sources } : {},
			keymap: isObject(value.keymap) ? { ...value.keymap } : {},
			terminalCapabilities: isObject(value.terminal_capabilities)
				? { ...value.terminal_capabilities }
				: {},
		};
	}
	return {
		settings: { ...value },
		sources: {},
		keymap: {},
		terminalCapabilities: {},
	};
}

function userSettingsSources(settings: JsonObject): JsonObject {
	return Object.freeze(Object.fromEntries(Object.keys(settings).map((key) => [key, "user"])));
}

function authoritativeSettingsSources(snapshot: {
	readonly settings: JsonObject;
	readonly sources: JsonObject;
}): JsonObject {
	return Object.keys(snapshot.sources).length > 0
		? snapshot.sources
		: userSettingsSources(snapshot.settings);
}

function shellSettingMutation(params: JsonObject): {
	readonly settingId: string;
	readonly value: string | boolean;
} {
	const settingId = typeof params.setting_id === "string" ? params.setting_id.trim() : "";
	const item = shellSettingDescriptor(settingId);
	if (!item) throw new GatewayFailure("invalid_params", "A supported TUI setting is required.");
	let value = params.value;
	if (item.valueKind === "boolean" && typeof value === "string") {
		value = value === "true" ? true : value === "false" ? false : value;
	}
	if ((typeof value !== "string" && typeof value !== "boolean")
		|| !item.allowedValues.includes(value)) {
		throw new GatewayFailure("invalid_params", "A supported TUI setting value is required.");
	}
	return { settingId: item.key, value };
}

function settingsSources(value: JsonObject): Record<string, "default" | "user"> {
	return Object.fromEntries(Object.entries(value).flatMap(([key, source]) =>
		source === "user" || source === "default" ? [[key, source]] : []));
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (
		value === "none"
		|| value === "minimal"
		|| value === "low"
		|| value === "medium"
		|| value === "high"
		|| value === "xhigh"
		|| value === "max"
		|| value === "ultra"
	) return value;
	throw new GatewayFailure("invalid_params", "Unsupported reasoning_effort.");
}

function workspaceTrustState(value: unknown): WorkspaceTrustState {
	if (value === "trusted" || value === "untrusted" || value === "unknown") return value;
	throw new GatewayFailure("invalid_params", "state must be trusted, untrusted, or unknown.");
}

function modelSelectionScope(value: unknown): ModelSelectionScope {
	if (value === undefined) return "session";
	if (isModelSelectionScope(value)) return value;
	throw new GatewayFailure("invalid_params", "Model selection scope is not supported.");
}

function sameModelCatalogIdentity(left: JsonObject, right: JsonObject): boolean {
	return left.provider === right.provider
		&& left.protocol === right.protocol
		&& left.model === right.model
		&& left.base_url === right.base_url;
}

function requestedSandboxMode(
	value: string,
	currentPermission: PermissionProfile,
): "read-only" | "workspace-write" | "danger-full-access" {
	const current = sandboxForPermission(currentPermission);
	if (!value) return current;
	if (value === "next") {
		return current === "read-only"
			? "workspace-write"
			: current === "workspace-write"
				? "danger-full-access"
				: "read-only";
	}
	if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
		return value;
	}
	throw new GatewayFailure("invalid_arguments", "Unsupported sandbox mode.");
}

function permissionForSandbox(
	value: "read-only" | "workspace-write" | "danger-full-access",
): PermissionProfile {
	return value === "read-only"
		? "read-only"
		: value === "workspace-write"
			? "workspace"
			: "full-access";
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: string, limit: number): string {
	return value.slice(0, limit);
}
