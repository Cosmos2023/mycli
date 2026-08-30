import { join } from "node:path";
import type { HookRunnerContract } from "@mycli/core";
import {
	builtinSkillRoot,
	ConfiguredHookRunner,
	createSkillToolRegistration,
	defineIntegrationRegistration,
	discoverHookConfig,
	discoverMcpConfig,
	FOLLOWUP_TASK_TOOL_DEFINITION,
	HookAllowlistStore,
	HookManager,
	INTERRUPT_AGENT_TOOL_DEFINITION,
	InterruptAgentTool,
	IntegrationLifecycleStack,
	LIST_AGENTS_TOOL_DEFINITION,
	ListAgentsTool,
	McpClient,
	McpCatalogCache,
	McpManager,
	type McpManagerDiscovery,
	PluginRuntime,
	renderSkillCatalog,
	SEND_AGENT_MESSAGE_TOOL_DEFINITION,
	SendAgentMessageTool,
	SkillRegistry,
	SubagentController,
	SPAWN_AGENT_TOOL_DEFINITION,
	SpawnAgentTool,
	WAIT_AGENT_TOOL_DEFINITION,
	WaitAgentTool,
} from "@mycli/integrations";
import type {
	CreateSubagentSupervisorOptions,
	AgentCoordinationMailboxContract,
	AgentCoordinationRouteContext,
	HookRegistration,
	IntegrationRegistration,
	PluginCommandDescriptor,
	PluginCommandRegistry,
	ResolvedSubagentSpawnContext,
	ResolveSubagentSpawnContextInput,
	SubagentSupervisorContract,
	WaitAgentActivityContract,
} from "@mycli/integrations";
import {
	combinedToolManifest,
	type BuiltInToolManifest,
	type CombinedToolManifest,
	type ToolAdapter,
} from "@mycli/tools";
import {
	pluginSandboxProfile,
	workspaceSandboxProfile,
} from "./integration-sandbox.ts";

export type IntegrationCompositionSourceId = "skill" | "mcp" | "plugin" | "subagent";

export interface IntegrationCompositionContribution {
	readonly registrations?: readonly IntegrationRegistration[];
	readonly hooks?: readonly HookRegistration[];
	readonly resources?: readonly Readonly<Record<string, unknown>>[];
	readonly diagnostics?: readonly Readonly<Record<string, unknown>>[];
	readonly commands?: IntegrationCommandService;
	readonly subagents?: unknown;
	close?(signal?: AbortSignal): Promise<void>;
}

export interface IntegrationCommandService {
	list(): readonly Readonly<Record<string, unknown>>[];
	run(
		command: string,
		signal: AbortSignal,
	): Promise<Readonly<Record<string, unknown>> | undefined>;
}

export interface IntegrationCompositionSource {
	readonly id: IntegrationCompositionSourceId;
	start(signal: AbortSignal): Promise<IntegrationCompositionContribution>;
}

export interface CreateIntegrationCompositionOptions {
	readonly builtinManifest: BuiltInToolManifest;
	readonly sources: readonly IntegrationCompositionSource[];
	readonly closeTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface IntegrationComposition {
	readonly registrations: readonly IntegrationRegistration[];
	readonly hooks: readonly HookRegistration[];
	readonly resources: readonly Readonly<Record<string, unknown>>[];
	readonly diagnostics: readonly Readonly<Record<string, unknown>>[];
	readonly commands: readonly IntegrationCommandService[];
	readonly subagents: readonly unknown[];
	readonly manifest: CombinedToolManifest;
	close(): Promise<void>;
}

export interface CreateRuntimeIntegrationCompositionOptions {
	readonly builtinManifest: BuiltInToolManifest;
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly projectConfigurationEnabled?: boolean;
	readonly parentSessionId: string;
	readonly parentTurnId: () => string;
	readonly parentTools: () => readonly string[];
	readonly createSubagentSupervisor: (
		options: CreateSubagentSupervisorOptions,
	) => SubagentSupervisorContract;
	readonly resolveSubagentSpawnContext: (
		input: ResolveSubagentSpawnContextInput,
	) => ResolvedSubagentSpawnContext | Promise<ResolvedSubagentSpawnContext>;
	readonly agentActivity?: WaitAgentActivityContract;
	readonly agentMailbox?: AgentCoordinationMailboxContract;
	readonly resolveAgentRouteContext?: (
		sessionId: string,
	) => AgentCoordinationRouteContext | undefined;
	readonly maxAgentDepth?: number;
	readonly closeTimeoutMs?: number;
	readonly onStartupStage?: (stage: IntegrationStartupStage) => void;
}

export type IntegrationStartupStage =
	| "integration_discovery_started"
	| "hooks_ready"
	| "skills_ready"
	| "mcp_cache_ready"
	| "plugins_ready"
	| "subagents_ready";

export interface RuntimeIntegrationComposition extends IntegrationComposition {
	readonly version: number;
	readonly hookRunner: HookRunnerContract;
	readonly skillCatalog: string;
	readonly subagentController?: SubagentController;
	subscribeSubagents(
		listener: (subagent: Readonly<Record<string, unknown>>) => void,
	): () => void;
	publishSubagent(subagent: Readonly<Record<string, unknown>>): void;
	subscribeExtensions(listener: (version: number) => void): () => void;
}

export interface RuntimeToolRegistrationPartition {
	readonly direct: readonly IntegrationRegistration[];
	readonly deferred: readonly (IntegrationRegistration & { readonly source: "mcp" | "plugin" })[];
}

const SOURCE_ORDER: Readonly<Record<IntegrationCompositionSourceId, number>> = Object.freeze({
	skill: 0,
	mcp: 1,
	plugin: 2,
	subagent: 3,
});

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export function partitionRuntimeToolRegistrations(
	registrations: readonly IntegrationRegistration[],
): RuntimeToolRegistrationPartition {
	const visible = registrations.filter((registration) => registration.modelVisible !== false);
	return Object.freeze({
		direct: Object.freeze(visible.filter((registration) => !isDeferredRegistration(registration))),
		deferred: Object.freeze(visible.filter(isDeferredRegistration)),
	});
}

function isDeferredRegistration(
	registration: IntegrationRegistration,
): registration is IntegrationRegistration & { readonly source: "mcp" | "plugin" } {
	return registration.source === "mcp" || registration.source === "plugin";
}

export async function createIntegrationComposition(
	options: CreateIntegrationCompositionOptions,
): Promise<IntegrationComposition> {
	const lifecycles = new IntegrationLifecycleStack({
		closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
	});
	const controller = new AbortController();
	const onAbort = (): void => { controller.abort(); };
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) controller.abort();
	const contributions: IntegrationCompositionContribution[] = [];
	const sources = orderedSources(options.sources);
	try {
		for (const source of sources) {
			let contribution: IntegrationCompositionContribution;
			try {
				contribution = await source.start(controller.signal);
			} catch {
				await lifecycles.close().catch(() => undefined);
				throw new Error("integration_start_failed");
			}
			contributions.push(contribution);
			if (contribution.close) {
				lifecycles.add({ close: (signal) => contribution.close!(signal) });
			}
		}

		const registrations = Object.freeze(contributions.flatMap(
			(contribution) => [...(contribution.registrations ?? [])],
		));
		let manifest: CombinedToolManifest;
		try {
			manifest = combinedToolManifest(options.builtinManifest, registrations);
		} catch (error) {
			await lifecycles.close().catch(() => undefined);
			throw error;
		}
		const hooks = Object.freeze(contributions.flatMap(
			(contribution) => [...(contribution.hooks ?? [])],
		));
		const resources = Object.freeze(contributions.flatMap(
			(contribution) => [...(contribution.resources ?? [])],
		));
		const diagnostics = Object.freeze(contributions.flatMap(
			(contribution) => [...(contribution.diagnostics ?? [])],
		));
		const commands = Object.freeze(contributions.flatMap(
			(contribution) => contribution.commands ? [contribution.commands] : [],
		));
		const subagents = Object.freeze(contributions.flatMap(
			(contribution) => contribution.subagents === undefined ? [] : [contribution.subagents],
		));
		return Object.freeze({
			registrations,
			hooks,
			resources,
			diagnostics,
			commands,
			subagents,
			manifest,
			close: () => lifecycles.close(),
		});
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export async function createRuntimeIntegrationComposition(
	options: CreateRuntimeIntegrationCompositionOptions,
): Promise<RuntimeIntegrationComposition> {
	const subagentListeners = new Set<(
		subagent: Readonly<Record<string, unknown>>,
	) => void>();
	const extensionListeners = new Set<(version: number) => void>();
	const mcpRefreshController = new AbortController();
	let startMcpRefresh: ((publish: (contribution: IntegrationCompositionContribution) => void) => void)
		| undefined;
	let subagentController: SubagentController | undefined;
	options.onStartupStage?.("integration_discovery_started");
	const hookDiscovery = await discoverHookConfig({
		workspaceRoot: options.workspaceRoot,
		homeDir: options.homeDir,
		env: options.env,
		includeRepository: options.projectConfigurationEnabled !== false,
	});
	options.onStartupStage?.("hooks_ready");
	let skillRegistry: SkillRegistry | undefined;
	const composition = await createIntegrationComposition({
		builtinManifest: options.builtinManifest,
		...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
		sources: [
			{
				id: "skill",
				start: async () => {
					skillRegistry = await SkillRegistry.discover({
						builtinRoot: builtinSkillRoot(),
						userRoot: join(options.homeDir, ".mycli", "skills"),
						...(options.projectConfigurationEnabled === false ? {} : {
							sharedRepoRoot: join(options.workspaceRoot, ".agents", "skills"),
							repoRoot: join(options.workspaceRoot, ".mycli", "skills"),
						}),
					});
					options.onStartupStage?.("skills_ready");
					return {
						registrations: [createSkillToolRegistration(skillRegistry)],
						resources: skillResources(skillRegistry),
						diagnostics: skillDiagnostics(skillRegistry),
					};
				},
			},
				{
					id: "mcp",
					start: async (signal) => {
						const discoverySignal = AbortSignal.any([signal, mcpRefreshController.signal]);
					const config = await discoverMcpConfig({
						workspaceRoot: options.workspaceRoot,
						homeDir: options.homeDir,
						env: options.env,
						includeRepository: options.projectConfigurationEnabled !== false,
					});
					const manager = new McpManager({
						configs: config.servers,
						catalogCache: new McpCatalogCache({
							directory: join(options.homeDir, ".mycli", "cache"),
						}),
						createClient: (server) => new McpClient({
							config: server,
							cwd: options.workspaceRoot,
							sandboxProfile: workspaceSandboxProfile(options.workspaceRoot),
						}),
					});
						const cached = await manager.loadCached(discoverySignal);
						options.onStartupStage?.("mcp_cache_ready");
						startMcpRefresh = (publish) => {
							void manager.refresh(discoverySignal).then(
								(discovery) => {
									if (!discoverySignal.aborted) {
										publish(mcpContribution(
											config.diagnostics,
											mergeMcpRefresh(cached, discovery),
										));
									}
								},
								() => {
									if (!discoverySignal.aborted) {
										publish(mcpRefreshFailure(config.diagnostics, cached));
									}
								},
							);
						};
						return {
							...mcpContribution(config.diagnostics, cached),
							close: () => manager.close(),
						};
				},
			},
			{
				id: "plugin",
				start: async (signal) => {
					const runtime = await PluginRuntime.load({
						workspaceRoot: options.workspaceRoot,
						homeDir: options.homeDir,
						env: options.env,
						includeRepository: options.projectConfigurationEnabled !== false,
						sandboxProfile: pluginSandboxProfile,
					}, signal);
					options.onStartupStage?.("plugins_ready");
					return {
						registrations: runtime.tools,
						hooks: runtime.hooks,
						resources: pluginResources(runtime.records),
						diagnostics: runtime.issues.map((issue) => ({
							source: "plugin",
							label: "runtime",
							errorClass: issue,
						})),
						commands: pluginCommandService(runtime.commands),
						close: () => runtime.close(),
					};
				},
			},
			{
				id: "subagent",
				start: async () => {
					subagentController = new SubagentController({
						createSupervisor: options.createSubagentSupervisor,
						parentSessionId: options.parentSessionId,
						parentTurnId: options.parentTurnId,
						parentTools: options.parentTools,
						resolveSpawnContext: options.resolveSubagentSpawnContext,
						...(options.agentMailbox ? { mailbox: options.agentMailbox } : {}),
						...(options.resolveAgentRouteContext
							? { resolveAgentRouteContext: options.resolveAgentRouteContext }
							: {}),
						...(options.maxAgentDepth === undefined
							? {}
							: { maxAgentDepth: options.maxAgentDepth }),
						});
					subagentController.recoverAbandoned("parent runtime restarted");
					options.onStartupStage?.("subagents_ready");
					return {
						registrations: subagentRegistrations(
							subagentController,
							options.agentActivity ?? UNAVAILABLE_AGENT_ACTIVITY,
						),
						subagents: subagentController,
						close: () => subagentController?.close() ?? Promise.resolve(),
					};
				},
			},
		],
	});

	try {
		const allowlistStore = new HookAllowlistStore({ homeDir: options.homeDir });
		const configuredExecutor = new ConfiguredHookRunner({
			workspaceRoot: options.workspaceRoot,
			allowlistStore,
			env: options.env,
			sandboxProfile: (cwd) => workspaceSandboxProfile(options.workspaceRoot, cwd),
		});
		const hookRunner = new HookManager({
			configuredHooks: hookDiscovery.hooks,
			configuredExecutor,
			pluginHooks: composition.hooks,
		});
			const initialResources = Object.freeze([
				...composition.resources,
				...hookResources(hookDiscovery.hooks),
			]);
			let snapshot = runtimeIntegrationSnapshot({
				version: 1,
				builtinManifest: options.builtinManifest,
				registrations: composition.registrations,
				resources: initialResources,
				diagnostics: composition.diagnostics,
			});
			const staticRegistrations = composition.registrations.filter(
				(registration) => registration.source !== "mcp",
			);
			const staticResources = initialResources.filter((resource) => !isMcpResource(resource));
			const staticDiagnostics = composition.diagnostics.filter((diagnostic) => !isMcpDiagnostic(diagnostic));
			const publishMcp = (contribution: IntegrationCompositionContribution): void => {
				try {
					snapshot = runtimeIntegrationSnapshot({
						version: snapshot.version + 1,
						builtinManifest: options.builtinManifest,
						registrations: orderedRegistrations([
							...staticRegistrations,
							...(contribution.registrations ?? []),
						]),
						resources: [...staticResources, ...(contribution.resources ?? [])],
						diagnostics: [...staticDiagnostics, ...(contribution.diagnostics ?? [])],
					});
				} catch {
					snapshot = runtimeIntegrationSnapshot({
						version: snapshot.version + 1,
						builtinManifest: options.builtinManifest,
						registrations: snapshot.registrations,
						resources: snapshot.resources,
						diagnostics: [
							...staticDiagnostics,
							{ source: "mcp", label: "runtime", errorClass: "refresh_failed" },
						],
					});
				}
				for (const listener of extensionListeners) {
					try { listener(snapshot.version); } catch { /* Observers cannot affect discovery. */ }
				}
			};
			let closePromise: Promise<void> | undefined;
			const runtimeComposition: RuntimeIntegrationComposition = Object.freeze({
				get version() { return snapshot.version; },
				get registrations() { return snapshot.registrations; },
				get hooks() { return composition.hooks; },
				get resources() { return snapshot.resources; },
				get diagnostics() { return snapshot.diagnostics; },
				get commands() { return composition.commands; },
				get subagents() { return composition.subagents; },
				get manifest() { return snapshot.manifest; },
				hookRunner,
			skillCatalog: skillRegistry ? renderSkillCatalog(skillRegistry) : "",
			...(subagentController ? { subagentController } : {}),
			subscribeSubagents: (
				listener: (subagent: Readonly<Record<string, unknown>>) => void,
				) => {
					subagentListeners.add(listener);
					return () => { subagentListeners.delete(listener); };
				},
				publishSubagent: (subagent: Readonly<Record<string, unknown>>) => {
					for (const listener of subagentListeners) {
						try {
							listener(subagent);
						} catch {
							// UI projection listeners cannot affect agent execution.
						}
					}
				},
				subscribeExtensions: (listener: (version: number) => void) => {
					extensionListeners.add(listener);
					return () => { extensionListeners.delete(listener); };
				},
				close: () => closePromise ??= (() => {
					mcpRefreshController.abort();
					return composition.close();
				})().finally(() => {
					subagentListeners.clear();
					extensionListeners.clear();
				}),
			});
			queueMicrotask(() => { startMcpRefresh?.(publishMcp); });
			return runtimeComposition;
	} catch {
		await composition.close().catch(() => undefined);
		throw new Error("integration_start_failed");
	}
}

function orderedSources(
	sources: readonly IntegrationCompositionSource[],
): readonly IntegrationCompositionSource[] {
	const ids = sources.map((source) => source.id);
	if (new Set(ids).size !== ids.length) throw new Error("duplicate_integration_source");
	return Object.freeze([...sources].sort((left, right) => (
		SOURCE_ORDER[left.id] - SOURCE_ORDER[right.id]
	)));
}

interface RuntimeIntegrationSnapshot {
	readonly version: number;
	readonly registrations: readonly IntegrationRegistration[];
	readonly resources: readonly Readonly<Record<string, unknown>>[];
	readonly diagnostics: readonly Readonly<Record<string, unknown>>[];
	readonly manifest: CombinedToolManifest;
}

function runtimeIntegrationSnapshot(input: {
	readonly version: number;
	readonly builtinManifest: BuiltInToolManifest;
	readonly registrations: readonly IntegrationRegistration[];
	readonly resources: readonly Readonly<Record<string, unknown>>[];
	readonly diagnostics: readonly Readonly<Record<string, unknown>>[];
}): RuntimeIntegrationSnapshot {
	const registrations = Object.freeze([...input.registrations]);
	return Object.freeze({
		version: input.version,
		registrations,
		resources: Object.freeze([...input.resources]),
		diagnostics: Object.freeze([...input.diagnostics]),
		manifest: combinedToolManifest(input.builtinManifest, registrations),
	});
}

function mcpContribution(
	configDiagnostics: readonly object[],
	discovery: McpManagerDiscovery | undefined,
): IntegrationCompositionContribution {
	return Object.freeze({
		registrations: discovery?.registrations ?? Object.freeze([]),
		resources: discovery ? mcpResources(discovery.resources, discovery.servers) : Object.freeze([]),
		diagnostics: Object.freeze([
			...configDiagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
			...(discovery?.servers.flatMap((server) => server.failureCategory
				? [Object.freeze({ source: "mcp", label: server.serverId, errorClass: server.failureCategory })]
				: []) ?? []),
		]),
	});
}

function mcpRefreshFailure(
	configDiagnostics: readonly object[],
	cached: McpManagerDiscovery | undefined,
): IntegrationCompositionContribution {
	return Object.freeze({
		registrations: cached?.registrations ?? Object.freeze([]),
		resources: cached ? mcpResources(cached.resources, cached.servers) : Object.freeze([]),
		diagnostics: Object.freeze([
			...configDiagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
			Object.freeze({ source: "mcp", label: "runtime", errorClass: "refresh_failed" }),
		]),
	});
}

function mergeMcpRefresh(
	cached: McpManagerDiscovery | undefined,
	live: McpManagerDiscovery,
): McpManagerDiscovery {
	if (!cached) return live;
	const failedServers = new Map(live.servers.flatMap((server) => (
		server.status === "failed" ? [[server.serverId, server] as const] : []
	)));
	if (failedServers.size === 0) return live;
	const cachedServers = new Map(cached.servers.map((server) => [server.serverId, server]));
	const retainedServerIds = new Set([...failedServers.keys()].filter((serverId) => (
		cachedServers.get(serverId)?.status === "ok"
	)));
	if (retainedServerIds.size === 0) return live;
	return Object.freeze({
		registrations: Object.freeze([
			...live.registrations,
			...cached.registrations.filter((registration) => (
				retainedServerIds.has(registration.originMetadata.server ?? "")
			)),
		]),
		resources: Object.freeze([
			...live.resources,
			...cached.resources.filter((resource) => retainedServerIds.has(resource.serverId)),
		]),
		servers: Object.freeze(live.servers.map((server) => {
			if (!retainedServerIds.has(server.serverId)) return server;
			const retained = cachedServers.get(server.serverId)!;
			return Object.freeze({
				...retained,
				...(server.failureCategory ? { failureCategory: server.failureCategory } : {}),
			});
		})),
	});
}

function orderedRegistrations(
	registrations: readonly IntegrationRegistration[],
): readonly IntegrationRegistration[] {
	return Object.freeze([...registrations].sort((left, right) => {
		const sourceOrder = SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source];
		return sourceOrder || left.id.localeCompare(right.id, "en");
	}));
}

function isMcpResource(resource: Readonly<Record<string, unknown>>): boolean {
	return typeof resource.id === "string" && resource.id.startsWith("mcp:");
}

function isMcpDiagnostic(diagnostic: Readonly<Record<string, unknown>>): boolean {
	return diagnostic.source === "mcp";
}

function skillResources(registry: SkillRegistry): readonly Readonly<Record<string, unknown>>[] {
	return registry.list().map((skill) => Object.freeze({
		id: `skill:${skill.name}`,
		type: "skill",
		name: skill.name,
		source: resourceSource(skill.sourceKind),
		enabled: true,
		status: "enabled",
		detail: skill.description,
		command: "/tools skills",
	}));
}

function skillDiagnostics(registry: SkillRegistry): readonly Readonly<Record<string, unknown>>[] {
	return registry.diagnostics().issues.map((issue) => Object.freeze({ ...issue }));
}

function mcpResources(
	resources: readonly {
		readonly serverId: string;
		readonly uri: string;
		readonly name: string;
		readonly description: string;
	}[],
	servers: readonly {
		readonly serverId: string;
		readonly status: string;
		readonly resourceCount: number;
	}[],
): readonly Readonly<Record<string, unknown>>[] {
	const projected = resources.map((resource) => Object.freeze({
		id: `mcp:${resource.serverId}:${resource.uri}`.slice(0, 256),
		type: "plugin",
		name: `${resource.serverId} ${resource.name}`.slice(0, 256),
		source: "runtime",
		enabled: true,
		status: "enabled",
		detail: `MCP resource ${resource.uri}`.slice(0, 512),
		command: `/mcp inspect ${resource.serverId}`,
	}));
	const projectedServers = new Set(resources.map((resource) => resource.serverId));
	for (const server of servers) {
		if (server.status !== "ok" || server.resourceCount === 0
			|| projectedServers.has(server.serverId)) continue;
		projected.push(Object.freeze({
			id: `mcp:${server.serverId}:resources`.slice(0, 256),
			type: "plugin",
			name: `${server.serverId} resources`.slice(0, 256),
			source: "runtime",
			enabled: true,
			status: "enabled",
			detail: `${server.resourceCount} cached MCP resources`.slice(0, 512),
			command: `/mcp inspect ${server.serverId}`,
		}));
	}
	return Object.freeze(projected);
}

function pluginResources(
	records: readonly {
		readonly pluginId: string;
		readonly source: string;
		readonly enabled: boolean;
		readonly status: string;
		readonly issues: readonly string[];
	}[],
): readonly Readonly<Record<string, unknown>>[] {
	return records.map((record) => Object.freeze({
		id: `plugin:${record.pluginId}`,
		type: "plugin",
		name: record.pluginId,
		source: resourceSource(record.source),
		enabled: record.enabled,
		status: record.status === "loaded" ? "enabled" : record.status,
		...(record.issues[0] ? { detail: record.issues[0].slice(0, 512) } : {}),
		command: "/tools plugins",
	}));
}

function hookResources(
	hooks: readonly {
		readonly hookId: string;
		readonly name: string;
		readonly scope: string;
		readonly enabled: boolean;
		readonly hookPoint: string;
	}[],
): readonly Readonly<Record<string, unknown>>[] {
	return hooks.map((hook) => Object.freeze({
		id: `hook:${hook.hookId}`,
		type: "hook",
		name: hook.name,
		source: resourceSource(hook.scope),
		enabled: hook.enabled,
		status: hook.enabled ? "enabled" : "disabled",
		detail: hook.hookPoint,
		command: "/tools hooks",
	}));
}

function subagentRegistrations(
	controller: SubagentController,
	agentActivity: WaitAgentActivityContract,
): readonly IntegrationRegistration[] {
	return Object.freeze([
		subagentRegistration(
			SPAWN_AGENT_TOOL_DEFINITION,
			new SpawnAgentTool({ control: controller }),
		),
		subagentRegistration(
			SEND_AGENT_MESSAGE_TOOL_DEFINITION,
			new SendAgentMessageTool({
				control: controller,
				definition: SEND_AGENT_MESSAGE_TOOL_DEFINITION,
				triggerMode: "queue_only",
			}),
		),
		subagentRegistration(
			FOLLOWUP_TASK_TOOL_DEFINITION,
			new SendAgentMessageTool({
				control: controller,
				definition: FOLLOWUP_TASK_TOOL_DEFINITION,
				triggerMode: "follow_up",
			}),
		),
		subagentRegistration(
			INTERRUPT_AGENT_TOOL_DEFINITION,
			new InterruptAgentTool({ control: controller }),
		),
		subagentRegistration(
			LIST_AGENTS_TOOL_DEFINITION,
			new ListAgentsTool({ control: controller }),
		),
		subagentRegistration(
			WAIT_AGENT_TOOL_DEFINITION,
			new WaitAgentTool({ activity: agentActivity }),
		),
	]);
}

function subagentRegistration(
	definition: IntegrationRegistration["definition"],
	adapter: ToolAdapter,
	modelVisible = true,
): IntegrationRegistration {
	return defineIntegrationRegistration({
		id: definition.id,
		source: "subagent",
		definition,
		adapter,
		originMetadata: { controller: "local" },
		modelVisible,
	});
}

const UNAVAILABLE_AGENT_ACTIVITY: WaitAgentActivityContract = Object.freeze({
	wait: async () => Object.freeze({ kind: "unavailable" as const }),
});

function pluginCommandService(registry: PluginCommandRegistry): IntegrationCommandService {
	const service: IntegrationCommandService = {
		list: () => registry.list().map(pluginCommandRow),
		run: async (command: string, signal: AbortSignal) => {
			const [route = "", ...argumentParts] = command.trim().split(/\s+/u);
			const descriptor = registry.list().find((item) => pluginCommandRoute(item) === route);
			if (!descriptor) return undefined;
			const rawArguments = argumentParts.join(" ");
			const argumentsValue = rawArguments ? parseCommandArguments(rawArguments) : {};
			const result = await registry.execute(
				descriptor.pluginId,
				descriptor.name,
				argumentsValue,
				signal,
			);
			return Object.freeze({
				result_id: `command:${descriptor.id}`,
				presentation: "transcript",
				command_kind: "plugin",
				lines: Object.freeze([result.summary]),
				ok: result.ok,
				...(result.error ? { error: result.error } : {}),
			});
		},
	};
	return Object.freeze(service);
}

function pluginCommandRow(descriptor: PluginCommandDescriptor): Readonly<Record<string, unknown>> {
	return Object.freeze({
		id: descriptor.id,
		name: pluginCommandRoute(descriptor),
		description: descriptor.description,
		argument_policy: "optional",
		argument_hint: "{json}",
		available_during_turn: true,
	});
}

function pluginCommandRoute(descriptor: PluginCommandDescriptor): string {
	return `/plugin:${descriptor.pluginId}:${descriptor.name}`;
}

function parseCommandArguments(value: string): Readonly<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("invalid_plugin_command_arguments");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("invalid_plugin_command_arguments");
	}
	return parsed as Readonly<Record<string, unknown>>;
}

function resourceSource(value: string): "user" | "repo" | "builtin" | "runtime" | "unknown" {
	if (value === "user" || value === "repo" || value === "builtin") return value;
	if (value === "repository" || value === "shared_repo") return "repo";
	if (value === "mcp" || value === "runtime") return "runtime";
	return "unknown";
}
