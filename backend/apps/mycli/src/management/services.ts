import {
	HookManagementService,
	PluginManagementService,
} from "@mycli/integrations";
import { McpClient, McpManagementService, policyMcpFetch } from "@mycli/integrations/mcp";
import {
	CachedUpdateService,
	loadManagedExecutionPolicy,
	readApiKey,
	resolveConfig,
	WorkspaceTrustStore,
} from "@mycli/config";
import type { McpServerConfig, PluginPackageRequest } from "@mycli/integrations";
import { openRuntimeSessionStore } from "@mycli/storage";
import {
	pluginSandboxProfile,
	mcpSandboxProfile,
} from "../node-runtime/integration-sandbox.ts";
import { ProviderModelDirectory } from "../node-runtime/provider-model-directory.ts";
import type {
	AuthManagementCommand,
	DoctorManagementCommand,
	ManagementCommand,
	ManagementExecutor,
	ManagementResponse,
	SandboxManagementCommand,
	SetupManagementCommand,
} from "./types.ts";
import { AuthManagementService, type ApiKeyInputReader } from "./auth.ts";
import type { NativeAuthInteraction } from "@mycli/providers";
import type { ConfigPathScope } from "@mycli/config/paths";
import {
	ConfigManagementError,
	ConfigManagementService,
	configFailureResponse,
} from "./config.ts";
import { runDoctor } from "./doctor/runner.ts";
import { DoctorManagementService } from "./doctor/service.ts";
import { SandboxManagementService } from "./sandbox.ts";
import { SessionManagementService } from "./session.ts";
import { createTrainingExportHandler } from "../node-runtime/session-training-export.ts";
import { SessionService } from "../node-runtime/session-service.ts";
import type { SessionManagementCommand } from "./types.ts";
import { UpdateManagementService } from "./update.ts";
import { MYCLI_PACKAGE_NAME, MYCLI_VERSION } from "../version.ts";

type MaybePromise<T> = T | Promise<T>;

export interface HookManagementContract {
	list(): MaybePromise<ManagementResponse>;
	inspect(identity: string): MaybePromise<ManagementResponse>;
	approve(identity: string): MaybePromise<ManagementResponse>;
	revoke(identity: string): MaybePromise<ManagementResponse>;
}

export interface PluginManagementContract {
	packages?(request: PluginPackageRequest, signal: AbortSignal): MaybePromise<ManagementResponse>;
	list(signal: AbortSignal, marketplace?: string): MaybePromise<ManagementResponse>;
	inspect(pluginId: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	run(
		pluginId: string,
		commandName: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): MaybePromise<ManagementResponse>;
}

export interface McpManagementContract {
	list(signal: AbortSignal): MaybePromise<ManagementResponse>;
	inspect(serverId: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	add?(serverId: string, config: Readonly<Record<string, unknown>>, signal: AbortSignal): MaybePromise<ManagementResponse>;
	remove?(serverId: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	approvals?(): MaybePromise<ManagementResponse>;
	revoke?(serverId: string): MaybePromise<ManagementResponse>;
	login?(serverId: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	logout?(serverId: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
}

export interface ConfigManagementContract {
	validate(strict: boolean, signal: AbortSignal): MaybePromise<ManagementResponse>;
	show(signal: AbortSignal): MaybePromise<ManagementResponse>;
	path(
		scope: ConfigPathScope,
		profile: string | undefined,
		signal: AbortSignal,
	): MaybePromise<ManagementResponse>;
	get(key: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	set(key: string, value: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	unset(key: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	previewMigration(signal: AbortSignal): MaybePromise<ManagementResponse>;
	applyMigration(expectedVersion: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	rollbackMigration(backupId: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
}

export interface SessionManagementContract {
	execute(command: SessionManagementCommand, signal: AbortSignal): MaybePromise<ManagementResponse>;
}

export interface UpdateManagementContract {
	status(signal: AbortSignal): MaybePromise<ManagementResponse>;
	check(signal: AbortSignal): MaybePromise<ManagementResponse>;
	dismiss(version: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
}

export interface AuthManagementContract {
	execute(command: AuthManagementCommand, signal: AbortSignal): MaybePromise<ManagementResponse>;
}

export interface SandboxManagementContract {
	execute(command: SandboxManagementCommand, signal: AbortSignal): MaybePromise<ManagementResponse>;
}

export interface ManagementServicesOptions {
	readonly config: ConfigManagementContract;
	readonly hooks: HookManagementContract;
	readonly plugins: PluginManagementContract;
	readonly mcp: McpManagementContract;
	readonly doctor: Readonly<{
		execute(
			command: DoctorManagementCommand,
			signal: AbortSignal,
		): MaybePromise<ManagementResponse>;
	}>;
	readonly sandbox: SandboxManagementContract;
	readonly setup: (
		command: SetupManagementCommand,
		signal: AbortSignal,
	) => MaybePromise<ManagementResponse>;
	readonly auth?: AuthManagementContract;
	readonly update: UpdateManagementContract;
	readonly session?: SessionManagementContract;
}

export interface DefaultManagementServicesOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly setup?: (
		command: SetupManagementCommand,
		signal: AbortSignal,
	) => MaybePromise<ManagementResponse>;
	readonly readApiKeyInput?: ApiKeyInputReader;
	readonly createAuthInteraction?: (signal: AbortSignal) => NativeAuthInteraction;
}

export class ManagementServices implements ManagementExecutor {
	readonly #services: ManagementServicesOptions;

	constructor(options: ManagementServicesOptions) {
		this.#services = options;
	}

	async execute(
		command: ManagementCommand,
		signal = new AbortController().signal,
	): Promise<ManagementResponse> {
		try {
			return await this.#dispatch(command, signal);
		} catch (error) {
			if (command.kind === "config" && error instanceof ConfigManagementError) {
				return configFailureResponse(command.action, error);
			}
			if (signal.aborted || isAbortError(error)) {
				return failure(commandAction(command), "management command interrupted", "interrupted");
			}
			return failure(commandAction(command), "management command failed", "management_command_failed");
		}
	}

	#dispatch(command: ManagementCommand, signal: AbortSignal): MaybePromise<ManagementResponse> {
		if (command.kind === "doctor") return this.#services.doctor.execute(command, signal);
		if (command.kind === "sandbox") return this.#services.sandbox.execute(command, signal);
		if (command.kind === "setup") return this.#services.setup(command, signal);
		if (command.kind === "login" || command.kind === "logout") {
			return this.#services.auth?.execute(command, signal)
				?? failure(command.action, "authentication management is unavailable", "auth_unavailable");
		}
		if (command.kind === "update") {
			if (command.action === "status") return this.#services.update.status(signal);
			if (command.action === "check") return this.#services.update.check(signal);
			if (command.action === "dismiss") {
				return this.#services.update.dismiss(command.version, signal);
			}
		}
		if (command.kind === "config") {
			if (command.action === "validate") {
				return this.#services.config.validate(command.strict === true, signal);
			}
			if (command.action === "show") return this.#services.config.show(signal);
			if (command.action === "path") {
				return this.#services.config.path(command.scope, command.profile, signal);
			}
			if (command.action === "get") return this.#services.config.get(command.key, signal);
			if (command.action === "set") {
				return this.#services.config.set(command.key, command.value, signal);
			}
			if (command.action === "unset") return this.#services.config.unset(command.key, signal);
			if (command.action !== "migrate") {
				return failure(command.action, "configuration command is unavailable", "config_unavailable");
			}
			if (command.operation === "preview") {
				return this.#services.config.previewMigration(signal);
			}
			if (command.operation === "apply") {
				return this.#services.config.applyMigration(command.expectedVersion, signal);
			}
			return this.#services.config.rollbackMigration(command.backupId, signal);
		}
		if (command.kind === "hooks") {
			if (command.action === "list") return this.#services.hooks.list();
			if (command.action === "inspect") return this.#services.hooks.inspect(command.identity);
			if (command.action === "approve") return this.#services.hooks.approve(command.identity);
			return this.#services.hooks.revoke(command.identity);
		}
		if (command.kind === "plugins") {
			if (command.action === "list") return this.#services.plugins.list(signal, command.marketplace);
			if (command.action === "inspect") {
				return this.#services.plugins.inspect(command.pluginId, signal);
			}
			if (command.action !== "run") return this.#services.plugins.packages?.(command, signal)
				?? failure(command.action, "plugin package management is unavailable", "plugin_packages_unavailable");
			return this.#services.plugins.run(
				command.pluginId,
				command.commandName,
				command.arguments,
				signal,
			);
		}
		if (command.kind === "mcp") {
			const mcp = this.#services.mcp;
			switch (command.action) {
				case "list": return mcp.list(signal);
				case "inspect": return mcp.inspect(command.serverId, signal);
				case "add": return mcp.add?.(command.serverId, command.config, signal)
					?? failure(command.action, "MCP configuration management is unavailable", "management_unavailable");
				case "remove": return mcp.remove?.(command.serverId, signal)
					?? failure(command.action, "MCP configuration management is unavailable", "management_unavailable");
				case "approvals": return mcp.approvals?.()
					?? failure(command.action, "MCP approval management is unavailable", "management_unavailable");
				case "revoke": return mcp.revoke?.(command.serverId)
					?? failure(command.action, "MCP approval management is unavailable", "management_unavailable");
				case "login": return mcp.login?.(command.serverId, signal)
					?? failure(command.action, "MCP login is unavailable", "management_unavailable");
				case "logout": return mcp.logout?.(command.serverId, signal)
					?? failure(command.action, "MCP logout is unavailable", "management_unavailable");
			}
		}
		if (command.kind === "session") {
			return this.#services.session?.execute(command, signal)
				?? failure(command.action, "session management is unavailable", "session_unavailable");
		}
		return failure("management", "management command is unavailable", "management_unavailable");
	}
}

export async function createDefaultManagementServices(
	options: DefaultManagementServicesOptions,
): Promise<ManagementServices> {
	const workspaceTrustStore = new WorkspaceTrustStore({ homeDir: options.homeDir });
	const workspaceTrust = await workspaceTrustStore.load(options.workspaceRoot);
	const providerModelDirectory = new ProviderModelDirectory({ homeDir: options.homeDir });
	const includeRepository = workspaceTrust === "trusted";
	const config = new ConfigManagementService({
		workspaceRoot: options.workspaceRoot,
		homeDir: options.homeDir,
		env: options.env,
		workspaceTrust,
	});
	const hooks = new HookManagementService({ ...options, includeRepository });
	const plugins = new PluginManagementService({
		runtimeOptions: {
			workspaceRoot: options.workspaceRoot,
			homeDir: options.homeDir,
			env: options.env,
			includeRepository,
			sandboxProfile: pluginSandboxProfile,
		},
	});
	const mcpConstraints = await loadManagedExecutionPolicy({ homeDir: options.homeDir });
	const mcp = new McpManagementService({
		workspaceRoot: options.workspaceRoot,
		homeDir: options.homeDir,
		env: options.env,
		includeRepository,
		oauthFetch: (config) => policyMcpFetch(mcpSandboxProfile(options.workspaceRoot, config, mcpConstraints)),
		...(options.createAuthInteraction ? { onAuthorization: (url: string, signal: AbortSignal) =>
			options.createAuthInteraction!(signal).notify({ type: "auth_url", url, instructions: "Open this link to authorize the MCP server:" }) } : {}),
		createClient: (config: McpServerConfig) => new McpClient({
			config,
			homeDir: options.homeDir,
			cwd: options.workspaceRoot,
			sandboxProfile: mcpSandboxProfile(options.workspaceRoot, config, mcpConstraints),
		}),
	});
	const updateCache = new CachedUpdateService({
		homeDir: options.homeDir,
		packageName: MYCLI_PACKAGE_NAME,
		currentVersion: MYCLI_VERSION,
		env: options.env,
		executablePath: process.argv[1],
	});
	const updateCheckOnStartup = async (): Promise<boolean> => {
		try {
			return (await resolveConfig({
				homeDir: options.homeDir,
				workspaceRoot: options.workspaceRoot,
				env: options.env,
				workspaceTrust,
			})).updatesCheckOnStartup;
		} catch {
			return true;
		}
	};
	const update = new UpdateManagementService({
		cache: updateCache,
		checkOnStartup: updateCheckOnStartup,
	});
	const auth = new AuthManagementService({
		...options,
		workspaceTrust,
		...(options.readApiKeyInput ? { readApiKeyInput: options.readApiKeyInput } : {}),
	});
	const sandbox = new SandboxManagementService();
	const doctor = new DoctorManagementService({
		homeDir: options.homeDir,
		workspaceTrust,
		config,
		sandbox,
		runReport: (signal) => runDoctor({
			...options,
			workspaceTrust,
			includeRepository,
			updateStatus: () => update.readStatus(signal),
		}, signal),
	});
	return new ManagementServices({
		config,
		hooks,
		plugins,
		mcp,
		doctor,
		sandbox,
		setup: options.setup ?? (async () => failure(
			"setup",
			"setup is not available in this M7 batch",
			"setup_not_implemented",
		)),
		auth,
		update,
		session: {
			execute: async (command, signal) => {
				const currentConfig = await resolveConfig({
					homeDir: options.homeDir,
					workspaceRoot: options.workspaceRoot,
					env: options.env,
					workspaceTrust,
				});
				const store = openRuntimeSessionStore({
					dbPath: currentConfig.sessionsDbPath,
					reconcileRuntimeState: false,
				});
				try {
					const managedExecutionPolicy = await loadManagedExecutionPolicy({
						homeDir: options.homeDir,
					});
					const sessions = new SessionService({
						store,
						currentConfig: () => currentConfig,
						currentPermissionProfile: () => "workspace",
						loadModelCatalog: async (preferences, workspaceRoot, sessionId) => {
							const resolved = await resolveConfig({
								homeDir: options.homeDir,
								workspaceRoot,
								env: options.env,
								workspaceTrust: await workspaceTrustStore.load(workspaceRoot),
								overrides: {
									session: sessionId,
									provider: preferences.provider,
									protocol: preferences.protocol,
									model: preferences.model,
									apiBaseUrl: preferences.apiBaseUrl,
									authRef: preferences.authRef,
									reasoningEffort: preferences.reasoningEffort,
									thinkingEnabled: preferences.reasoningEffort !== "none",
								},
							});
							return (await providerModelDirectory.load(resolved)).models(preferences.provider);
						},
						hasCredential: async (preferences) => {
							if (preferences.authRef === currentConfig.authRef && currentConfig.apiKey) {
								return true;
							}
							return Boolean(await readApiKey({
								homeDir: options.homeDir,
								authRef: preferences.authRef,
							}));
						},
						...(managedExecutionPolicy ? { managedExecutionPolicy } : {}),
					});
					const exportTraining = createTrainingExportHandler(store, {
						workspaceRoot: options.workspaceRoot, homeDir: options.homeDir, env: options.env,
						...(currentConfig.apiKey ? { apiKey: currentConfig.apiKey } : {}),
					});
					return await new SessionManagementService(sessions, exportTraining).execute(command, signal);
				} finally {
					store.close();
				}
			},
		},
	});
}

function commandAction(command: ManagementCommand): string {
	return "action" in command ? command.action : command.kind;
}

function failure(action: string, message: string, issue: string): ManagementResponse {
	return Object.freeze({
		ok: false,
		action,
		message,
		issues: Object.freeze([issue]),
	});
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
