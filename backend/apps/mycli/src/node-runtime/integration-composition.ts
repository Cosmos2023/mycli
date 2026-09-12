import { HookBrowserService, configuredHookEnablement, pluginHookIdentity, integrationEnabled } from "@mycli/integrations";
import { join } from "node:path";
import type { ExecutionPolicyConstraints } from "@mycli/runtime";
import type { HookRunnerContract } from "@mycli/core";
import {
	ConfiguredHookRunner,
	createSkillToolRegistration,
	discoverHookConfig,
	pluginBundleContributions,
	HookManager,
	IntegrationLifecycleStack,
	McpClient,
	McpCatalogCache,
	McpManager,
	McpRequiredServerError,
	normalizeIntegrationToolNames,
	type McpManagerDiscovery,
	type McpResourceService,
	type McpServerConfig,
	type McpElicitationHandler,
	PluginRuntime,
	renderSkillCatalog,
	type SkillRegistry,
	type ConfiguredHookSpec,
	SkillManagementService,
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
} from "@mycli/tools";
import {
	pluginSandboxProfile,
	mcpSandboxProfile,
	workspaceSandboxProfile,
} from "./integration-sandbox.ts";
import { mcpCatalogResources, pluginCatalogResources, type McpCatalogPhase } from "./integration-resource-catalog.ts";
import { loadRuntimeIntegrationConfiguration, type RuntimeIntegrationConfiguration } from "./integration-configuration.ts";

import { createRuntimeSubagentServices, type RuntimeSubagentServices } from "./runtime-subagent-services.ts";
import type { SubagentController } from "@mycli/integrations";

type IntegrationCompositionSourceId = "skill" | "mcp" | "plugin" | "subagent";

interface IntegrationCompositionContribution {
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

interface CreateIntegrationCompositionOptions {
	readonly builtinManifest: BuiltInToolManifest;
	readonly sources: readonly IntegrationCompositionSource[];
	readonly closeTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

interface IntegrationComposition {
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
	readonly subagentServices?: RuntimeSubagentServices;
	readonly signal?: AbortSignal;
	readonly configuration?: RuntimeIntegrationConfiguration;
	readonly pinConfiguration?: boolean;
	readonly onMcpElicitation?: McpElicitationHandler;
	readonly managedExecutionPolicy?: ExecutionPolicyConstraints;
	readonly disabled?: boolean;
	readonly builtinManifest: BuiltInToolManifest;
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly projectConfigurationEnabled?: boolean;
	readonly parentSessionId: string;
	readonly parentTurnId: () => string;
	readonly parentTools: (input: {
		readonly parentSessionId: string;
		readonly parentTurnId: string;
	}) => readonly string[];
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

type IntegrationStartupStage =
	| "integration_discovery_started"
	| "hooks_ready"
	| "skills_ready"
	| "mcp_cache_ready"
	| "plugins_ready"
	| "subagents_ready";

export interface RuntimeIntegrationComposition extends IntegrationComposition {
	readonly skills?: SkillManagementService;
	readonly hookManagement?: HookBrowserService;
	readonly configuration?: RuntimeIntegrationConfiguration;
	readonly mcpResourceService: McpResourceService;
	readonly version: number;
	readonly hookRunner: HookRunnerContract;
	readonly skillCatalog: string;
	readonly subagentController?: SubagentController;
	subscribeSubagents(
		listener: (subagent: Readonly<Record<string, unknown>>) => void,
	): () => void;
	publishSubagent(subagent: Readonly<Record<string, unknown>>): void;
	subscribeExtensions(listener: (version: number) => void): () => void;
	prepareRun(turnId: string, signal: AbortSignal): Promise<void>;
	finishRun(turnId: string): void;
	refreshConfiguration(): Promise<void>;
	reloadProjectConfiguration(input: {
		readonly workspaceRoot: string;
		readonly enabled: boolean;
	}): Promise<void>;
}

interface RuntimeToolRegistrationPartition {
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
			controller.signal.throwIfAborted();
			let contribution: IntegrationCompositionContribution;
			try {
				contribution = await source.start(controller.signal);
			} catch (error) {
				await lifecycles.close().catch(() => undefined);
				if (error instanceof McpRequiredServerError) throw error;
				throw new Error("integration_start_failed");
			}
			contributions.push(contribution);
			if (contribution.close) {
				lifecycles.add({ close: (signal) => contribution.close!(signal) });
			}
			if (controller.signal.aborted) {
				await lifecycles.close().catch(() => undefined);
				controller.signal.throwIfAborted();
			}
		}

		let registrations: readonly IntegrationRegistration[];
		let manifest: CombinedToolManifest;
		try {
			registrations = normalizeIntegrationToolNames(contributions.flatMap(
				(contribution) => [...(contribution.registrations ?? [])],
			), options.builtinManifest.tools.map((tool) => tool.name));
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
	if (options.disabled) {
		const composition = await createIntegrationComposition({ builtinManifest: options.builtinManifest,
			signal: options.signal,
			sources: options.subagentServices ? [{ id: "subagent", start: async () => ({
				registrations: options.subagentServices!.registrations,
			}) }] : [],
		});
		return Object.freeze({
			...composition, version: 1, skillCatalog: "",
			mcpResourceService: {
				listResources: async (signal: AbortSignal) => { signal.throwIfAborted(); return { resources: [], failures: [] }; },
				listResourcesPage: async () => { throw new Error("unknown_mcp_server"); },
				listResourceTemplates: async (signal: AbortSignal, serverId?: string) => {
					signal.throwIfAborted();
					if (serverId !== undefined) throw new Error("unknown_mcp_server");
					return { resourceTemplates: [], failures: [] };
				},
				readResource: async () => { throw new Error("unknown_mcp_server"); },
			},
			hookRunner: { run: async () => Object.freeze([]) },
			subscribeSubagents: () => () => undefined,
			publishSubagent: () => undefined,
			subscribeExtensions: () => () => undefined,
			reloadProjectConfiguration: async () => undefined,
			prepareRun: async (_turnId: string, signal: AbortSignal) => { signal.throwIfAborted(); },
			finishRun: () => undefined,
			refreshConfiguration: async () => undefined,
		});
	}
	const extensionListeners = new Set<(version: number) => void>();
	options.onStartupStage?.("integration_discovery_started");
	let content = await createRuntimeIntegrationContent({
		options,
		workspaceRoot: options.workspaceRoot,
		projectConfigurationEnabled: options.projectConfigurationEnabled !== false,
		reportStartup: true,
		configuration: options.configuration,
		signal: options.signal,
	});
	let subagents: RuntimeSubagentServices;
	try {
		subagents = options.subagentServices ?? createRuntimeSubagentServices({
			createSupervisor: options.createSubagentSupervisor,
			parentSessionId: options.parentSessionId,
			parentTurnId: options.parentTurnId,
			parentTools: options.parentTools,
			resolveSpawnContext: options.resolveSubagentSpawnContext,
			...(options.agentMailbox ? { mailbox: options.agentMailbox } : {}),
			...(options.resolveAgentRouteContext ? { resolveAgentRouteContext: options.resolveAgentRouteContext } : {}),
			...(options.maxAgentDepth === undefined ? {} : { maxAgentDepth: options.maxAgentDepth }),
			agentActivity: options.agentActivity,
		});
		options.onStartupStage?.("subagents_ready");
	} catch {
		await content.close().catch(() => undefined);
		throw new Error("integration_start_failed");
	}

	let activeSkillRegistry = content.skillRegistry;
	const skillRegistration = createSkillToolRegistration({
		get: (name) => activeSkillRegistry.get(name),
	});
	let activeHookRunner = createRuntimeHookRunner(options, content);
	const hookRunner: HookRunnerContract = Object.freeze({
		run: (
			input: Parameters<HookRunnerContract["run"]>[0],
			signal: Parameters<HookRunnerContract["run"]>[1],
		) => activeHookRunner.run(input, signal),
	});
	let workspaceRoot = options.workspaceRoot;
	let projectConfigurationEnabled = options.projectConfigurationEnabled !== false;
	const retiredContents: RuntimeIntegrationContent[] = [];
	let snapshot = runtimeContentSnapshot(
		options.builtinManifest,
		1,
		content,
		skillRegistration,
		subagents.registrations,
	);
	let closed = false;
	const activeRuns = new Set<string>();
	const configurationController = new AbortController();
	const abortConfiguration = (): void => { configurationController.abort(); };
	options.signal?.addEventListener("abort", abortConfiguration, { once: true });
	if (options.signal?.aborted) configurationController.abort();
	let reloadQueue = Promise.resolve();
	let closePromise: Promise<void> | undefined;

	const notifyExtensions = (): void => {
		for (const listener of extensionListeners) {
			try { listener(snapshot.version); } catch { /* Observers cannot affect discovery. */ }
		}
	};
	const publishMcp = (
		owner: RuntimeIntegrationContent,
		contribution: IntegrationCompositionContribution,
	): void => {
		if (closed || owner !== content) return;
		try {
			snapshot = runtimeContentSnapshot(
				options.builtinManifest,
				snapshot.version + 1,
				owner,
				skillRegistration,
				subagents.registrations,
				contribution,
			);
		} catch {
			snapshot = runtimeIntegrationSnapshot({
				version: snapshot.version + 1,
				builtinManifest: options.builtinManifest,
				registrations: snapshot.registrations,
				resources: snapshot.resources,
				diagnostics: [
					...snapshot.diagnostics.filter((diagnostic) => !isMcpDiagnostic(diagnostic)),
					{ source: "mcp", label: "runtime", errorClass: "refresh_failed" },
				],
			});
		}
		notifyExtensions();
	};
	const startRefresh = (owner: RuntimeIntegrationContent): void => {
		owner.startPluginUpdates(() => {
			if (closed || owner !== content) return;
			const plugin = owner.pluginContribution();
			snapshot = runtimeIntegrationSnapshot({ version: snapshot.version + 1, builtinManifest: options.builtinManifest,
				registrations: snapshot.registrations,
				resources: [...snapshot.resources.filter((resource) => !isPluginResource(resource)), ...(plugin.resources ?? [])],
				diagnostics: [...snapshot.diagnostics.filter((diagnostic) => diagnostic.source !== "plugin"), ...(plugin.diagnostics ?? [])],
			});
			notifyExtensions();
		});
		queueMicrotask(() => owner.startMcpRefresh(
			(contribution) => publishMcp(owner, contribution),
		));
	};
	const replaceConfiguration = async (input: {
		readonly workspaceRoot: string;
		readonly enabled: boolean;
	}, configuration?: RuntimeIntegrationConfiguration): Promise<void> => {
		if (closed) throw new Error("integration_composition_closed");
		const next = await createRuntimeIntegrationContent({
			options,
			workspaceRoot: input.workspaceRoot,
			projectConfigurationEnabled: input.enabled,
			reportStartup: false,
			configuration,
			waitForMcpDiscovery: configuration !== undefined,
			signal: configurationController.signal,
		});
		let nextSnapshot: RuntimeIntegrationSnapshot;
		try {
			configurationController.signal.throwIfAborted();
			nextSnapshot = runtimeContentSnapshot(
				options.builtinManifest,
				snapshot.version + 1,
				next,
				skillRegistration,
				subagents.registrations,
			);
		} catch (error) {
			await next.close().catch(() => undefined);
			throw error;
		}
		const previous = content;
		previous.retire();
		content = next;
		activeSkillRegistry = next.skillRegistry;
		activeHookRunner = createRuntimeHookRunner(options, next);
		workspaceRoot = input.workspaceRoot;
		projectConfigurationEnabled = input.enabled;
		snapshot = nextSnapshot;
		notifyExtensions();
		startRefresh(next);
		try {
			await previous.close();
		} catch {
			retiredContents.push(previous);
		}
	};
	const enqueue = (operation: () => Promise<void>): Promise<void> => {
		const task = reloadQueue.then(operation);
		reloadQueue = task.catch(() => undefined);
		return task;
	};
	const refreshConfiguration = async (): Promise<void> => {
		if (closed) throw new Error("integration_composition_closed");
		if (activeRuns.size || options.pinConfiguration) return;
		const configuration = await loadRuntimeIntegrationConfiguration({ workspaceRoot, homeDir: options.homeDir,
			env: options.env, includeRepository: projectConfigurationEnabled });
		configurationController.signal.throwIfAborted();
		if (configuration.fingerprint === content.configurationFingerprint) return;
		await replaceConfiguration({ workspaceRoot, enabled: projectConfigurationEnabled }, configuration);
	};
	const reloadProjectConfiguration = (input: { readonly workspaceRoot: string; readonly enabled: boolean }): Promise<void> => {
		return enqueue(async () => {
			if (closed) throw new Error("integration_composition_closed");
			if (input.workspaceRoot === workspaceRoot && input.enabled === projectConfigurationEnabled) return;
			await replaceConfiguration(input);
		});
	};

	const runtimeComposition: RuntimeIntegrationComposition = Object.freeze({
		hookManagement: new HookBrowserService({ homeDir: options.homeDir,
			configured: async () => (await discoverHookConfig({ workspaceRoot: content.workspaceRoot, homeDir: options.homeDir, env: options.env, includeRepository: content.projectConfigurationEnabled })).hooks,
			plugins: () => content.composition.hooks,
		}),
		skills: new SkillManagementService({ registry: () => activeSkillRegistry, homeDir: options.homeDir,
			catalog: async () => (await loadRuntimeIntegrationConfiguration({ workspaceRoot: content.workspaceRoot, homeDir: options.homeDir, env: options.env, includeRepository: content.projectConfigurationEnabled })).skills,
		}),
		mcpResourceService: {
			listResources: (signal: AbortSignal, serverId?: string) => content.mcpResourceService.listResources(signal, serverId),
			listResourcesPage: async (serverId: string, signal: AbortSignal, cursor?: string) => {
				if (content.mcpResourceService.listResourcesPage) return content.mcpResourceService.listResourcesPage(serverId, signal, cursor);
				if (cursor !== undefined) throw new Error("invalid_mcp_resource_pagination");
				const listing = await content.mcpResourceService.listResources(signal, serverId);
				if (listing.failures.length) throw new Error("mcp_resource_error");
				return { resources: listing.resources };
			},
			listResourceTemplates: async (signal: AbortSignal, serverId?: string, cursor?: string) =>
				content.mcpResourceService.listResourceTemplates?.(signal, serverId, cursor) ?? { resourceTemplates: [], failures: [] },
			readResource: (serverId: string, uri: string, signal: AbortSignal) => content.mcpResourceService.readResource(serverId, uri, signal),
		},
		get configuration() { return content.configuration; },
		get version() { return snapshot.version; },
		get registrations() { return snapshot.registrations; },
		get hooks() { return content.composition.hooks; },
		get resources() { return snapshot.resources; },
		get diagnostics() { return snapshot.diagnostics; },
		get commands() { return content.composition.commands; },
		get subagents() { return [subagents.controller]; },
		get manifest() { return snapshot.manifest; },
		hookRunner,
		get skillCatalog() { return renderSkillCatalog(activeSkillRegistry); },
		subagentController: subagents.controller,
		subscribeSubagents: subagents.subscribe,
		publishSubagent: subagents.publish,
		subscribeExtensions: (listener: (version: number) => void) => {
			extensionListeners.add(listener);
			return () => { extensionListeners.delete(listener); };
		},
		reloadProjectConfiguration,
		refreshConfiguration: () => enqueue(refreshConfiguration),
		prepareRun: (turnId: string, signal: AbortSignal) => enqueue(async () => {
			if (closed) throw new Error("integration_composition_closed");
			signal.throwIfAborted();
			if (activeRuns.has(turnId)) return;
			await refreshConfiguration();
			signal.throwIfAborted();
			activeRuns.add(turnId);
		}),
		finishRun: (turnId: string) => { activeRuns.delete(turnId); },
		close: () => closePromise ??= (async () => {
			closed = true;
			configurationController.abort();
			await reloadQueue;
			content.retire();
			let failed = false;
			try {
				if (!options.subagentServices) await subagents.close();
			} catch {
				failed = true;
			}
			for (const owned of [content, ...retiredContents].reverse()) {
				try {
					await owned.close();
				} catch {
					failed = true;
				}
			}
			options.signal?.removeEventListener("abort", abortConfiguration);
			extensionListeners.clear();
			if (failed) throw new Error("integration_close_failed");
		})(),
	});
	startRefresh(content);
	return runtimeComposition;
}

interface RuntimeIntegrationContent {
	readonly projectConfigurationEnabled: boolean;
	readonly configuration: RuntimeIntegrationConfiguration;
	readonly configurationFingerprint: string;
	readonly mcpResourceService: McpResourceService;
	readonly workspaceRoot: string;
	readonly composition: IntegrationComposition;
	readonly hookDiscovery: Awaited<ReturnType<typeof discoverHookConfig>>;
	readonly skillRegistry: SkillRegistry;
	pluginContribution(): IntegrationCompositionContribution;
	startPluginUpdates(publish: () => void): void;
	startMcpRefresh(
		publish: (contribution: IntegrationCompositionContribution) => void,
	): void;
	retire(): void;
	close(): Promise<void>;
}

async function createRuntimeIntegrationContent(input: {
	readonly options: CreateRuntimeIntegrationCompositionOptions;
	readonly workspaceRoot: string;
	readonly projectConfigurationEnabled: boolean;
	readonly reportStartup: boolean;
	readonly configuration?: RuntimeIntegrationConfiguration;
	readonly waitForMcpDiscovery?: boolean;
	readonly signal?: AbortSignal;
}): Promise<RuntimeIntegrationContent> {
	const { options } = input;
	const mcpRefreshController = new AbortController();
	let skillRegistry: SkillRegistry | undefined;
	let mcpManager: McpManager | undefined;
	let pluginRuntime: PluginRuntime | undefined;
	let unsubscribePlugins: (() => void) | undefined;
	let startMcpRefresh: ((
		publish: (contribution: IntegrationCompositionContribution) => void,
	) => void) | undefined;
	const configuration = input.configuration ?? await loadRuntimeIntegrationConfiguration({ workspaceRoot: input.workspaceRoot,
		homeDir: options.homeDir, env: options.env, includeRepository: input.projectConfigurationEnabled });
	const pluginDiscovery = configuration.plugins;
	const bundles = pluginBundleContributions(pluginDiscovery, { workspaceRoot: input.workspaceRoot, env: options.env,
		sandboxProfile: (cwd) => workspaceSandboxProfile(input.workspaceRoot, cwd),
		hookEnabled: (hook) => integrationEnabled(configuration.enablement, "hook", pluginHookIdentity(hook), hook.origin?.enabled ?? true),
	});
	const hookDiscovery = configuration.hooks;
	if (input.reportStartup) options.onStartupStage?.("hooks_ready");
	let composition: IntegrationComposition;
	try {
		composition = await createIntegrationComposition({
			signal: input.signal,
			builtinManifest: options.builtinManifest,
			...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
			sources: [
				{
					id: "skill",
					start: async () => {
						skillRegistry = configuration.skills;
						if (input.reportStartup) options.onStartupStage?.("skills_ready");
						return {
							resources: skillResources(skillRegistry),
							diagnostics: skillDiagnostics(skillRegistry),
						};
					},
				},
				{
					id: "mcp",
					start: async (signal) => {
						const discoverySignal = AbortSignal.any([signal, mcpRefreshController.signal, ...(input.signal ? [input.signal] : [])]);
						const config = configuration.mcp;
						const servers = config.servers;
						const invalidRequired = [...config.diagnostics.filter((issue) => issue.required).map((issue) => issue.serverId), ...config.requiredPluginFailures];
						if (invalidRequired.length) throw new McpRequiredServerError(invalidRequired);
						const manager = new McpManager({
							configs: servers,
							catalogCache: new McpCatalogCache({
								directory: join(options.homeDir, ".mycli", "cache"),
							}),
							createClient: (server) => new McpClient({
								homeDir: options.homeDir,
								onElicitation: options.onMcpElicitation,
								config: server,
								cwd: input.workspaceRoot,
								sandboxProfile: mcpSandboxProfile(input.workspaceRoot, server, options.managedExecutionPolicy),
							}),
						});
						mcpManager = manager;
						let cached: McpManagerDiscovery | undefined;
						try {
							cached = await manager.loadCached(discoverySignal);
							// Changed configuration must be discovered before the next run captures its catalog.
							if (input.waitForMcpDiscovery) {
								const live = await manager.refresh(discoverySignal);
								const requiredIds = new Set(servers.filter((server) => server.enabled && server.required).map((server) => server.id));
								const failed = live.servers.filter((server) => requiredIds.has(server.serverId) && (server.status === "failed"
									|| server.failures?.some((failure) => failure.capability === "tools" && !failure.tool)));
								if (failed.length) throw new McpRequiredServerError(failed.map((server) => server.serverId));
								cached = mergeMcpRefresh(cached, live);
							} else if (servers.some((server) => server.enabled && server.required)) {
								const required = await manager.discoverRequired(discoverySignal);
								const ids = new Set(required.servers.map((server) => server.serverId));
								cached = {
									registrations: [...(cached?.registrations.filter((tool) => !ids.has(tool.originMetadata.server ?? "")) ?? []), ...required.registrations],
									resources: [...(cached?.resources.filter((resource) => !ids.has(resource.serverId)) ?? []), ...required.resources],
									servers: [...(cached?.servers.filter((server) => !ids.has(server.serverId)) ?? []), ...required.servers],
								};
							}
						} catch (error) { await manager.close().catch(() => undefined); throw error; }
						if (input.reportStartup) options.onStartupStage?.("mcp_cache_ready");
						startMcpRefresh = (publish) => {
							if (input.waitForMcpDiscovery) return;
							void manager.refresh(discoverySignal).then(
								(discovery) => {
									if (!discoverySignal.aborted) {
										publish(mcpContribution(
											servers,
											config.diagnostics,
											mergeMcpRefresh(cached, discovery),
										));
									}
								},
								() => {
									if (!discoverySignal.aborted) {
										publish(mcpRefreshFailure(servers, config.diagnostics, cached));
									}
								},
							);
						};
						return {
							...mcpContribution(servers, config.diagnostics, cached, input.waitForMcpDiscovery ? "ready" : cached ? "cached" : "loading"),
							close: () => manager.close(),
						};
					},
				},
				{
					id: "plugin",
					start: async (signal) => {
						const runtime = await PluginRuntime.load({
							workspaceRoot: input.workspaceRoot,
							homeDir: options.homeDir,
							env: options.env,
							includeRepository: input.projectConfigurationEnabled,
							sandboxProfile: pluginSandboxProfile,
							discovery: pluginDiscovery,
							bundleIssues: [...bundles.issues, ...(skillRegistry?.diagnostics().issues ?? [])
								.filter((issue) => bundles.skills.some((skill) => skill.pluginId === issue.fileLabel))
								.map((issue) => ({ pluginId: issue.fileLabel, errorClass: issue.errorClass }))],
						}, input.signal ? AbortSignal.any([signal, input.signal]) : signal);
						pluginRuntime = runtime;
						if (input.reportStartup) options.onStartupStage?.("plugins_ready");
						return {
							registrations: runtime.tools,
							hooks: [...runtime.hooks, ...bundles.hooks],
							resources: pluginCatalogResources(runtime, configuration.mcp.servers),
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
			],
		});
	} catch (error) {
		mcpRefreshController.abort();
		throw error;
	}
	if (!skillRegistry || !mcpManager || !pluginRuntime) {
		mcpRefreshController.abort();
		await composition.close().catch(() => undefined);
		throw new Error("integration_start_failed");
	}
	return Object.freeze({
		workspaceRoot: input.workspaceRoot,
		configuration,
		configurationFingerprint: configuration.fingerprint,
		mcpResourceService: mcpManager,
		composition,
		projectConfigurationEnabled: input.projectConfigurationEnabled,
		hookDiscovery,
		skillRegistry,
		pluginContribution: () => pluginContribution(pluginRuntime!, configuration.mcp.servers),
		startPluginUpdates: (publish: () => void) => {
			unsubscribePlugins?.();
			unsubscribePlugins = pluginRuntime!.subscribe(publish);
		},
		startMcpRefresh: (
			publish: (contribution: IntegrationCompositionContribution) => void,
		) => { startMcpRefresh?.(publish); },
		retire: () => { mcpRefreshController.abort(); unsubscribePlugins?.(); },
		close: () => {
			mcpRefreshController.abort();
			unsubscribePlugins?.();
			return composition.close();
		},
	});
}

function createRuntimeHookRunner(
	options: CreateRuntimeIntegrationCompositionOptions,
	content: RuntimeIntegrationContent,
): HookManager {
	const allowlistStore = { statusFor: async (spec: ConfiguredHookSpec) => {
		const index = content.hookDiscovery.hooks.findIndex((hook) => hook.configPath === spec.configPath && hook.hookId === spec.hookId && hook.hookPoint === spec.hookPoint);
		return content.configuration.hookApprovals[index] ?? { allowed: false, reason: "entry_missing" as const, commandDigest: "" };
	} };
	const configuredExecutor = new ConfiguredHookRunner({
		workspaceRoot: content.workspaceRoot,
		allowlistStore,
		env: options.env,
		sandboxProfile: (cwd) => workspaceSandboxProfile(content.workspaceRoot, cwd),
	});
	return new HookManager({
		configuredHooks: content.hookDiscovery.hooks.map((hook) => configuredHookEnablement(hook, content.configuration.enablement)),
		configuredExecutor,
		pluginHooks: content.composition.hooks.filter((hook) => integrationEnabled(content.configuration.enablement, "hook", pluginHookIdentity(hook), hook.origin?.enabled ?? true)),
	});
}

function runtimeContentSnapshot(
	builtinManifest: BuiltInToolManifest,
	version: number,
	content: RuntimeIntegrationContent,
	skillRegistration: IntegrationRegistration,
	subagentRegistrations: readonly IntegrationRegistration[],
	mcpOverride?: IntegrationCompositionContribution,
): RuntimeIntegrationSnapshot {
	const resources = Object.freeze([
		...content.composition.resources.filter((resource) => !isPluginResource(resource)),
		...(content.pluginContribution().resources ?? []),
		...hookResources(content.hookDiscovery.hooks),
		...hookResources(content.composition.hooks.map((hook) => ({
			hookId: hook.id, name: hook.id, scope: "runtime", enabled: true, hookPoint: hook.hookPoint,
		}))),
	]);
	const staticRegistrations = content.composition.registrations.filter(
		(registration) => registration.source !== "mcp",
	);
	const mcpRegistrations = mcpOverride?.registrations
		?? content.composition.registrations.filter((registration) => registration.source === "mcp");
	const staticResources = resources.filter((resource) => !isMcpResource(resource));
	const mcpResources = mcpOverride?.resources ?? resources.filter(isMcpResource);
	const staticDiagnostics = content.composition.diagnostics.filter(
		(diagnostic) => !isMcpDiagnostic(diagnostic) && diagnostic.source !== "plugin",
	);
	const mcpDiagnostics = mcpOverride?.diagnostics
		?? content.composition.diagnostics.filter(isMcpDiagnostic);
	return runtimeIntegrationSnapshot({
		version,
		builtinManifest,
		registrations: orderedRegistrations([
			skillRegistration,
			...staticRegistrations,
			...mcpRegistrations,
			...subagentRegistrations,
		]),
		resources: [...staticResources, ...mcpResources],
		diagnostics: [...staticDiagnostics, ...(content.pluginContribution().diagnostics ?? []), ...mcpDiagnostics],
	});
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
	const registrations = normalizeIntegrationToolNames(input.registrations, input.builtinManifest.tools.map((tool) => tool.name));
	return Object.freeze({
		version: input.version,
		registrations,
		resources: Object.freeze([...input.resources]),
		diagnostics: Object.freeze([...input.diagnostics]),
		manifest: combinedToolManifest(input.builtinManifest, registrations),
	});
}

function mcpContribution(
	configs: readonly McpServerConfig[],
	configDiagnostics: readonly object[],
	discovery: McpManagerDiscovery | undefined,
	phase: McpCatalogPhase = "ready",
): IntegrationCompositionContribution {
	return Object.freeze({
		registrations: discovery?.registrations ?? Object.freeze([]),
		resources: mcpCatalogResources(configs, discovery, phase),
		diagnostics: Object.freeze([
			...configDiagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
			...(discovery?.servers.flatMap((server) => server.failureCategory
				? [Object.freeze({ source: "mcp", label: server.serverId, errorClass: server.failureCategory })]
				: []) ?? []),
		]),
	});
}

function mcpRefreshFailure(
	configs: readonly McpServerConfig[],
	configDiagnostics: readonly object[],
	cached: McpManagerDiscovery | undefined,
): IntegrationCompositionContribution {
	return Object.freeze({
		registrations: cached?.registrations ?? Object.freeze([]),
		resources: mcpCatalogResources(configs, cached, "failed"),
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
	return Object.freeze([...registrations].sort((left, right) => (
		SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source]
	)));
}

function isMcpResource(resource: Readonly<Record<string, unknown>>): boolean {
	return typeof resource.id === "string" && resource.id.startsWith("mcp:");
}

function isMcpDiagnostic(diagnostic: Readonly<Record<string, unknown>>): boolean {
	return diagnostic.source === "mcp";
}

function skillResources(registry: SkillRegistry): readonly Readonly<Record<string, unknown>>[] {
	return registry.listAll().map((skill) => Object.freeze({
		id: `skill:${skill.name}`,
		type: "skill",
		name: skill.name,
		source: resourceSource(skill.sourceKind),
		enabled: skill.enabled,
		status: skill.enabled ? "enabled" : "disabled",
		detail: skill.description,
		command: "/skills",
	}));
}

function skillDiagnostics(registry: SkillRegistry): readonly Readonly<Record<string, unknown>>[] {
	return registry.diagnostics().issues.map((issue) => Object.freeze({ ...issue }));
}

function isPluginResource(resource: Readonly<Record<string, unknown>>): boolean {
	return typeof resource.id === "string" && resource.id.startsWith("plugin:");
}

function pluginContribution(runtime: PluginRuntime, servers: readonly McpServerConfig[]): IntegrationCompositionContribution {
	return Object.freeze({ resources: pluginCatalogResources(runtime, servers),
		diagnostics: runtime.issues.map((errorClass) => ({ source: "plugin", label: "runtime", errorClass })) });
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
		command: "/hooks",
	}));
}

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
				...(result.errorContext ? { error_context: result.errorContext } : {}),
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
