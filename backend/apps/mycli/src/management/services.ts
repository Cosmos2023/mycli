import {
	HookManagementService,
	McpClient,
	McpManagementService,
	PluginManagementService,
} from "@mycli/integrations";
import {
	loadManagedExecutionPolicy,
	loadModelCatalog,
	readApiKey,
	resolveConfig,
	WorkspaceTrustStore,
} from "@mycli/config";
import type { McpServerConfig } from "@mycli/integrations";
import { openRuntimeSessionStore } from "@mycli/storage";
import {
	pluginSandboxProfile,
	workspaceSandboxProfile,
} from "../node-runtime/integration-sandbox.ts";
import type {
	ManagementCommand,
	ManagementExecutor,
	ManagementResponse,
} from "./types.ts";
import {
	ConfigManagementError,
	ConfigManagementService,
	configFailureResponse,
} from "./config.ts";
import {
	doctorResponseFromReport,
	runDoctor,
} from "./doctor/runner.ts";
import { inspectSandboxStatus } from "./sandbox.ts";
import { SessionManagementService } from "./session.ts";
import { SessionService } from "../node-runtime/session-service.ts";
import type { SessionManagementCommand } from "./types.ts";

type MaybePromise<T> = T | Promise<T>;

export interface HookManagementContract {
	list(): MaybePromise<ManagementResponse>;
	inspect(identity: string): MaybePromise<ManagementResponse>;
	approve(identity: string): MaybePromise<ManagementResponse>;
	revoke(identity: string): MaybePromise<ManagementResponse>;
}

export interface PluginManagementContract {
	list(signal: AbortSignal): MaybePromise<ManagementResponse>;
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
}

export interface ConfigManagementContract {
	validate(signal: AbortSignal): MaybePromise<ManagementResponse>;
	show(signal: AbortSignal): MaybePromise<ManagementResponse>;
	get(key: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	set(key: string, value: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
	unset(key: string, signal: AbortSignal): MaybePromise<ManagementResponse>;
}

export interface SessionManagementContract {
	execute(command: SessionManagementCommand): MaybePromise<ManagementResponse>;
}

export interface ManagementServicesOptions {
	readonly config: ConfigManagementContract;
	readonly hooks: HookManagementContract;
	readonly plugins: PluginManagementContract;
	readonly mcp: McpManagementContract;
	readonly doctor: (signal: AbortSignal) => MaybePromise<ManagementResponse>;
	readonly sandbox: (signal: AbortSignal) => MaybePromise<ManagementResponse>;
	readonly setup: (signal: AbortSignal) => MaybePromise<ManagementResponse>;
	readonly session?: SessionManagementContract;
}

export interface DefaultManagementServicesOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly setup?: (signal: AbortSignal) => MaybePromise<ManagementResponse>;
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
		if (command.kind === "doctor") return this.#services.doctor(signal);
		if (command.kind === "sandbox") return this.#services.sandbox(signal);
		if (command.kind === "setup") return this.#services.setup(signal);
		if (command.kind === "config") {
			if (command.action === "validate") return this.#services.config.validate(signal);
			if (command.action === "show") return this.#services.config.show(signal);
			if (command.action === "get") return this.#services.config.get(command.key, signal);
			if (command.action === "set") {
				return this.#services.config.set(command.key, command.value, signal);
			}
			if (command.action === "unset") return this.#services.config.unset(command.key, signal);
		}
		if (command.kind === "hooks") {
			if (command.action === "list") return this.#services.hooks.list();
			if (command.action === "inspect") return this.#services.hooks.inspect(command.identity);
			if (command.action === "approve") return this.#services.hooks.approve(command.identity);
			return this.#services.hooks.revoke(command.identity);
		}
		if (command.kind === "plugins") {
			if (command.action === "list") return this.#services.plugins.list(signal);
			if (command.action === "inspect") {
				return this.#services.plugins.inspect(command.pluginId, signal);
			}
			return this.#services.plugins.run(
				command.pluginId,
				command.commandName,
				command.arguments,
				signal,
			);
		}
		if (command.kind === "mcp") {
			return command.action === "list"
				? this.#services.mcp.list(signal)
				: this.#services.mcp.inspect(command.serverId, signal);
		}
		if (command.kind === "session") {
			return this.#services.session?.execute(command)
				?? failure(command.action, "session management is unavailable", "session_unavailable");
		}
		return this.#services.setup(signal);
	}
}

export async function createDefaultManagementServices(
	options: DefaultManagementServicesOptions,
): Promise<ManagementServices> {
	const workspaceTrust = await new WorkspaceTrustStore({
		homeDir: options.homeDir,
	}).load(options.workspaceRoot);
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
	const mcp = new McpManagementService({
		workspaceRoot: options.workspaceRoot,
		homeDir: options.homeDir,
		env: options.env,
		includeRepository,
		createClient: (config: McpServerConfig) => new McpClient({
			config,
			cwd: options.workspaceRoot,
			sandboxProfile: workspaceSandboxProfile(options.workspaceRoot),
		}),
	});
	return new ManagementServices({
		config,
		hooks,
		plugins,
		mcp,
		doctor: async (signal) => doctorResponseFromReport(await runDoctor({
			...options,
			workspaceTrust,
			includeRepository,
		}, signal)),
		sandbox: (signal) => inspectSandboxStatus({}, signal),
		setup: options.setup ?? (async () => failure(
			"setup",
			"setup is not available in this M7 batch",
			"setup_not_implemented",
		)),
		session: {
			execute: async (command) => {
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
						loadModelCatalog: () => loadModelCatalog({
							homeDir: options.homeDir,
							currentConfig,
						}),
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
					return new SessionManagementService(sessions).execute(command);
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
