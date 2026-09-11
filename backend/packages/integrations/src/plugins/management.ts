import type { PluginCommandResult } from "./command-registry.ts";
import { isPluginId } from "./package-files.ts";
import { PluginPackageManager, type PluginPackageRequest, type PluginPackageResponse } from "./package-management.ts";
import { discoverPlugins } from "./discovery.ts";
import { pluginBundleContributions } from "./bundle-contributions.ts";
import { PluginRuntime, type PluginRuntimeOptions, type PluginRuntimeRecord } from "./runtime.ts";

export interface PluginManagementRow {
	readonly pluginId: string;
	readonly source: PluginRuntimeRecord["source"];
	readonly enabled: boolean;
	readonly status: PluginRuntimeRecord["status"];
	readonly tools: readonly string[];
	readonly hooks: readonly string[];
	readonly commands: readonly string[];
	readonly issues: readonly string[];
	readonly hostStatus?: PluginRuntimeRecord["hostStatus"];
	readonly format?: "codex";
	readonly skillCount?: number;
}

export interface PluginManagementResponse {
	readonly ok: boolean;
	readonly action: "list" | "inspect" | "run" | "usage";
	readonly message: string;
	readonly plugins: readonly PluginManagementRow[];
	readonly issues: readonly string[];
	readonly commandResult?: PluginCommandResult;
}

export interface PluginManagementServiceOptions {
	readonly runtimeOptions: PluginRuntimeOptions;
}

export class PluginManagementService {
	readonly #options: PluginManagementServiceOptions;

	constructor(options: PluginManagementServiceOptions) {
		this.#options = options;
	}

	packages(request: PluginPackageRequest, signal: AbortSignal): Promise<PluginPackageResponse> {
		return new PluginPackageManager(this.#options.runtimeOptions).execute(request, signal);
	}

	list(signal: AbortSignal, marketplace?: string): Promise<PluginManagementResponse> {
		return this.#withRuntime("list", signal, (runtime) => {
			const records = runtime.records.filter((record) => !marketplace || record.pluginId.endsWith(`@${marketplace}`));
			return response(
			records.every((record) => record.status !== "error")
				&& runtime.discovery.diagnostics.length === 0,
			"list",
			`plugins: ${records.length} discovered`,
			records.map(managementRow),
			runtime.issues,
		); });
	}

	inspect(pluginId: string, signal: AbortSignal): Promise<PluginManagementResponse> {
		const safePluginId = isPluginId(pluginId) ? pluginId : undefined;
		if (!safePluginId) {
			return Promise.resolve(response(false, "inspect", "plugin not found: plugin", [], []));
		}
		return this.#withRuntime("inspect", signal, (runtime) => {
			const record = runtime.records.find((item) => item.pluginId === safePluginId);
			return response(
				record !== undefined && record.status !== "error",
				"inspect",
				record ? `plugin: ${record.pluginId}` : `plugin not found: ${safePluginId}`,
				record ? [managementRow(record)] : [],
				runtime.issues,
			);
		});
	}

	run(
		pluginId: string,
		command: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<PluginManagementResponse> {
		const safePluginId = isPluginId(pluginId) ? pluginId : undefined;
		const safeCommand = boundedId(command);
		if (!safePluginId || !safeCommand) {
			const commandResult: PluginCommandResult = Object.freeze({
				ok: false,
				summary: "plugin command not found",
				metadata: Object.freeze({}),
				error: "command_not_found",
			});
			return Promise.resolve(response(
				false,
				"run",
				commandResult.summary,
				[],
				[],
				commandResult,
			));
		}
		return this.#withRuntime("run", signal, async (runtime) => {
			const result = await runtime.commands.execute(safePluginId, safeCommand, argumentsValue, signal);
			const record = runtime.records.find((item) => item.pluginId === safePluginId);
			return response(
				result.ok,
				"run",
				result.summary,
				record ? [managementRow(record)] : [],
				runtime.issues,
				result,
			);
		});
	}

	usage(): PluginManagementResponse {
		return response(
			true,
			"usage",
			"usage: mycli plugins <list|inspect <plugin>|run <plugin> <command>|usage>",
			[],
			[],
		);
	}

	async #withRuntime(
		action: Exclude<PluginManagementResponse["action"], "usage">,
		signal: AbortSignal,
		operation: (runtime: PluginRuntime) => PluginManagementResponse | Promise<PluginManagementResponse>,
	): Promise<PluginManagementResponse> {
		let runtime: PluginRuntime | undefined;
		try {
			const options = this.#options.runtimeOptions;
			const discovery = options.discovery ?? await discoverPlugins(options);
			const bundles = pluginBundleContributions(discovery, { workspaceRoot: options.workspaceRoot, env: options.env,
				sandboxProfile: (cwd) => ({ mode: "workspace-write", filesystem: "workspace_write", network: "disabled",
					cwd, workspaceRoot: options.workspaceRoot, writableRoots: [options.workspaceRoot] }) });
			runtime = await PluginRuntime.load({ ...options, discovery, bundleIssues: bundles.issues }, signal);
			return await operation(runtime);
		} catch (error) {
			if (signal.aborted || isAbortError(error)) throw error;
			return response(false, action, "plugin management failed", [], ["plugin_management_failed"]);
		} finally {
			await runtime?.close().catch(() => undefined);
		}
	}
}

function managementRow(record: PluginRuntimeRecord): PluginManagementRow {
	return Object.freeze({
		pluginId: record.pluginId,
		source: record.source,
		enabled: record.enabled,
		status: record.status,
		tools: Object.freeze([...record.tools]),
		hooks: Object.freeze([...record.hooks]),
		commands: Object.freeze([...record.commands]),
		issues: Object.freeze([...record.issues]),
		...(record.hostStatus ? { hostStatus: record.hostStatus } : {}),
		...(record.format ? { format: record.format, skillCount: record.skillCount } : {}),
	});
}

function response(
	ok: boolean,
	action: PluginManagementResponse["action"],
	message: string,
	plugins: readonly PluginManagementRow[],
	issues: readonly string[],
	commandResult?: PluginCommandResult,
): PluginManagementResponse {
	return Object.freeze({
		ok,
		action,
		message: message.slice(0, 240),
		plugins: Object.freeze([...plugins]),
		issues: Object.freeze([...issues]),
		...(commandResult ? { commandResult } : {}),
	});
}

function boundedId(value: string): string | undefined {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
