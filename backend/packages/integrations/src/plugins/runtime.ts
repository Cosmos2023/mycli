import type { SandboxProfile } from "@mycli/tools";
import type { IntegrationRegistration } from "../foundation/registration.ts";
import type { HookRegistration } from "../hooks/manager.ts";
import { createPluginHookRegistration } from "./hook-adapter.ts";
import { PluginCommandRegistry } from "./command-registry.ts";
import { discoverPlugins, type DiscoverPluginsOptions } from "./discovery.ts";
import { PluginHostError, PluginProcessHost } from "./process-host.ts";
import { RecoverablePluginHost } from "./recoverable-host.ts";
import { createPluginToolRegistration } from "./tool-adapter.ts";
import type {
	DiscoveredPlugin,
	LoadedPluginManifest,
	PluginCandidate,
	PluginDiscovery,
	PluginHostContract,
	PluginHostStatus,
	PluginProtocolRegistration,
} from "./types.ts";

type PluginCommandRegistration = Extract<PluginProtocolRegistration, { readonly kind: "command" }>;

export type PluginRuntimeRecordStatus = "loaded" | "loading" | "closed" | "disabled" | "error" | "partial" | "migration_required";

export interface PluginRuntimeRecord {
	readonly pluginId: string;
	readonly source: PluginCandidate["source"];
	readonly enabled: boolean;
	readonly status: PluginRuntimeRecordStatus;
	readonly tools: readonly string[];
	readonly hooks: readonly string[];
	readonly commands: readonly string[];
	readonly issues: readonly string[];
	readonly hostStatus?: PluginHostStatus;
	readonly format?: "codex";
	readonly skillCount?: number;
}

export interface PluginRuntimeOptions extends DiscoverPluginsOptions {
	readonly discovery?: PluginDiscovery;
	readonly bundleIssues?: readonly { readonly pluginId: string; readonly errorClass: string }[];
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly sandboxProfile: (manifest: LoadedPluginManifest) => SandboxProfile;
	readonly createHost?: (manifest: LoadedPluginManifest) => PluginHostContract;
}

export class PluginRuntime {
	readonly discovery: PluginDiscovery;
	readonly #records: readonly PluginRuntimeRecord[];
	readonly tools: readonly IntegrationRegistration[];
	readonly hooks: readonly HookRegistration[];
	readonly commands: PluginCommandRegistry;
	readonly #hosts: readonly PluginHostContract[];
	readonly #hostById: ReadonlyMap<string, PluginHostContract>;
	#closePromise?: Promise<void>;

	private constructor(input: {
		readonly discovery: PluginDiscovery;
		readonly records: readonly PluginRuntimeRecord[];
		readonly tools: readonly IntegrationRegistration[];
		readonly hooks: readonly HookRegistration[];
		readonly commands: PluginCommandRegistry;
		readonly hosts: readonly PluginHostContract[];
		readonly hostById: ReadonlyMap<string, PluginHostContract>;
	}) {
		this.discovery = input.discovery;
		this.#records = Object.freeze([...input.records]);
		this.tools = Object.freeze([...input.tools]);
		this.hooks = Object.freeze([...input.hooks]);
		this.commands = input.commands;
		this.#hosts = Object.freeze([...input.hosts]);
		this.#hostById = new Map(input.hostById);
	}

	get records(): readonly PluginRuntimeRecord[] {
		return Object.freeze(this.#records.map((record) => {
			const host = this.#hostById.get(record.pluginId);
			if (!host) return record;
			const status = host.status === "ready" ? "loaded" : host.status === "starting" ? "loading"
				: host.status === "closed" || host.status === "closing" ? "closed" : "error";
			return Object.freeze({ ...record, status, hostStatus: host.status,
				issues: Object.freeze(host.failure ? [host.failure.kind] : []) });
		}));
	}

	get issues(): readonly string[] {
		return Object.freeze([
			...this.discovery.diagnostics.map((item) => `${item.source}:${item.fileLabel}:${item.pluginId}:${item.errorClass}`),
			...this.records.flatMap((record) => record.issues.map((issue) => `${record.pluginId}:${issue}`)),
		]);
	}

	subscribe(listener: () => void): () => void {
		const unsubscribers = this.#hosts.flatMap((host) => host.subscribe ? [host.subscribe(listener)] : []);
		return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
	}

	static async load(options: PluginRuntimeOptions, signal: AbortSignal): Promise<PluginRuntime> {
		assertNotAborted(signal);
		const discovery = options.discovery ?? await discoverPlugins(options);
		const records: PluginRuntimeRecord[] = [];
		const tools: IntegrationRegistration[] = [];
		const hooks: HookRegistration[] = [];
		const commands = new PluginCommandRegistry();
		const hosts: PluginHostContract[] = [];
		const hostById = new Map<string, PluginHostContract>();
		for (const candidate of discovery.selected) {
			assertNotAborted(signal);
			if (candidate.kind === "bundle") {
				const issues = [...candidate.manifest.issues, ...(options.bundleIssues ?? [])
					.filter((issue) => issue.pluginId === candidate.pluginId).map((issue) => issue.errorClass)];
				records.push(Object.freeze({ ...runtimeRecord(candidate, candidate.enabled ? issues.length ? "partial" : "loaded" : "disabled", issues),
					format: "codex", skillCount: candidate.manifest.skillFiles.length }));
				continue;
			}
			if (candidate.kind === "migration_required") {
				records.push(runtimeRecord(candidate, "migration_required", [candidate.message]));
				continue;
			}
			if (candidate.kind === "invalid") {
				records.push(runtimeRecord(
					candidate,
					candidate.enabled ? "error" : "disabled",
					[candidate.diagnostic.errorClass],
				));
				continue;
			}
			if (!candidate.enabled) {
				records.push(runtimeRecord(candidate, "disabled"));
				continue;
			}
			let host: PluginHostContract | undefined;
			try {
				host = new RecoverablePluginHost(() => createHost(options, candidate));
				const registrations = await host.start(signal);
				const pluginTools: IntegrationRegistration[] = [];
				const pluginHooks: HookRegistration[] = [];
				const pluginToolNames: string[] = [];
				const pluginHookNames: string[] = [];
				const pluginCommands: PluginCommandRegistration[] = [];
				for (const registration of registrations) {
					if (registration.kind === "tool") {
						pluginTools.push(createPluginToolRegistration(host, candidate.pluginId, registration, candidate.manifest.description));
						pluginToolNames.push(registration.name);
					} else if (registration.kind === "hook") {
						pluginHooks.push({ ...createPluginHookRegistration(host, candidate.pluginId, registration),
							origin: { pluginId: candidate.pluginId, path: candidate.manifest.manifestPath },
						});
						pluginHookNames.push(registration.name);
					} else {
						pluginCommands.push(registration);
					}
				}
				assertUniqueRoutes([...tools, ...pluginTools]);
				commands.registerAll(host, candidate.pluginId, pluginCommands);
				tools.push(...pluginTools);
				hooks.push(...pluginHooks);
				hosts.push(host);
				hostById.set(candidate.pluginId, host);
				records.push(Object.freeze({
					pluginId: candidate.pluginId,
					source: candidate.source,
					enabled: true,
					status: "loaded",
					tools: Object.freeze(pluginToolNames.sort(compareText)),
					hooks: Object.freeze(pluginHookNames.sort(compareText)),
					commands: Object.freeze(pluginCommands.map((registration) => registration.name).sort(compareText)),
					issues: Object.freeze([]),
				}));
			} catch (error) {
				await host?.close().catch(() => undefined);
				if (signal.aborted || isAbortError(error)) {
					await closeHosts(hosts);
					throw error;
				}
				records.push(runtimeRecord(candidate, "error", [runtimeErrorKind(error)]));
			}
		}
		return new PluginRuntime({ discovery, records, tools, hooks, commands, hosts, hostById });
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#closeAll();
		return this.#closePromise;
	}

	async #closeAll(): Promise<void> {
		let failed = false;
		for (const host of [...this.#hosts].reverse()) {
			try {
				await host.close();
			} catch {
				failed = true;
			}
		}
		if (failed) throw new Error("plugin_runtime_close_failed");
	}
}

function createHost(options: PluginRuntimeOptions, candidate: DiscoveredPlugin): PluginHostContract {
	if (options.createHost) return options.createHost(candidate.manifest);
	return new PluginProcessHost({
		manifest: candidate.manifest,
		env: options.env,
		sandboxProfile: options.sandboxProfile(candidate.manifest),
	});
}

function runtimeRecord(
	candidate: PluginCandidate,
	status: PluginRuntimeRecordStatus,
	issues: readonly string[] = [],
): PluginRuntimeRecord {
	return Object.freeze({
		pluginId: candidate.pluginId,
		source: candidate.source,
		enabled: candidate.enabled,
		status,
		tools: Object.freeze([]),
		hooks: Object.freeze([]),
		commands: Object.freeze([]),
		issues: Object.freeze(issues.map((issue) => issue.slice(0, 128))),
	});
}

function assertUniqueRoutes(registrations: readonly IntegrationRegistration[]): void {
	const routes = registrations.map((registration) => registration.definition.name);
	if (new Set(routes).size !== routes.length) throw new Error("duplicate_plugin_tool_route");
}

function runtimeErrorKind(error: unknown): string {
	return error instanceof PluginHostError
		? error.kind
		: error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(error.message)
			? error.message
			: "plugin_load_failed";
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

async function closeHosts(hosts: readonly PluginHostContract[]): Promise<void> {
	await Promise.allSettled([...hosts].reverse().map((host) => host.close()));
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function assertNotAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("interrupted");
	error.name = "AbortError";
	throw error;
}
