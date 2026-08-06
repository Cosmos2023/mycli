import { join } from "node:path";
import type { HookRunnerContract } from "@mycli/core";
import {
	builtinSkillRoot,
	ConfiguredHookRunner,
	createSkillToolRegistration,
	defineIntegrationRegistration,
	discoverHookConfig,
	discoverMcpConfig,
	HookAllowlistStore,
	HookManager,
	IntegrationLifecycleStack,
	McpClient,
	McpManager,
	PluginRuntime,
	SEND_MESSAGE_TOOL_DEFINITION,
	SendMessageTool,
	SkillRegistry,
	SUBAGENT_OUTPUT_TOOL_DEFINITION,
	SubagentController,
	SubagentOutputTool,
	SubagentProfileRegistry,
	TASK_TOOL_DEFINITION,
	TaskTool,
} from "@mycli/integrations";
import type {
	ChildRuntimeFactory,
	HookRegistration,
	IntegrationRegistration,
	PluginCommandDescriptor,
	PluginCommandRegistry,
	SubagentControllerUpdate,
} from "@mycli/integrations";
import type { SubagentTaskStore } from "@mycli/storage";
import {
	combinedToolManifest,
	type BuiltInToolManifest,
	type CombinedToolManifest,
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
	readonly parentSessionId: string;
	readonly parentTurnId: () => string;
	readonly parentTools: () => readonly string[];
	readonly childRuntimeFactory: ChildRuntimeFactory;
	readonly taskStore: SubagentTaskStore;
	readonly closeTimeoutMs?: number;
}

export interface RuntimeIntegrationComposition extends IntegrationComposition {
	readonly hookRunner: HookRunnerContract;
	readonly subagentController?: SubagentController;
	subscribeSubagents(
		listener: (subagent: Readonly<Record<string, unknown>>) => void,
	): () => void;
}

const SOURCE_ORDER: Readonly<Record<IntegrationCompositionSourceId, number>> = Object.freeze({
	skill: 0,
	mcp: 1,
	plugin: 2,
	subagent: 3,
});

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

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
	let subagentController: SubagentController | undefined;
	const hookDiscovery = await discoverHookConfig({
		workspaceRoot: options.workspaceRoot,
		homeDir: options.homeDir,
		env: options.env,
	});
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
						sharedRepoRoot: join(options.workspaceRoot, ".agents", "skills"),
						repoRoot: join(options.workspaceRoot, ".mycli", "skills"),
					});
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
					const config = await discoverMcpConfig({
						workspaceRoot: options.workspaceRoot,
						homeDir: options.homeDir,
						env: options.env,
					});
					const manager = new McpManager({
						configs: config.servers,
						createClient: (server) => new McpClient({
							config: server,
							cwd: options.workspaceRoot,
							sandboxProfile: workspaceSandboxProfile(options.workspaceRoot),
						}),
					});
					const discovery = await manager.discover(signal);
					return {
						registrations: discovery.registrations,
						resources: mcpResources(discovery.resources),
						diagnostics: [
							...config.diagnostics.map((diagnostic) => ({ ...diagnostic })),
							...discovery.servers.flatMap((server) => server.failureCategory
								? [{ source: "mcp", label: server.serverId, errorClass: server.failureCategory }]
								: []),
						],
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
						sandboxProfile: pluginSandboxProfile,
					}, signal);
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
					const registry = await SubagentProfileRegistry.discover({
						homeDir: options.homeDir,
						workspaceRoot: options.workspaceRoot,
					});
					subagentController = new SubagentController({
						registry,
						taskStore: options.taskStore,
						factory: options.childRuntimeFactory,
						parentSessionId: options.parentSessionId,
						parentTurnId: options.parentTurnId,
						parentTools: options.parentTools,
						onUpdate: (update) => {
							const payload = subagentPayload(update);
							for (const listener of subagentListeners) {
								try {
									listener(payload);
								} catch {
									// UI projection listeners cannot affect task execution.
								}
							}
						},
					});
					subagentController.recoverAbandoned("parent runtime restarted");
					return {
						registrations: subagentRegistrations(subagentController),
						resources: subagentResources(registry),
						diagnostics: registry.diagnostics().issues.map((issue) => ({ ...issue })),
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
		const resources = Object.freeze([
			...composition.resources,
			...hookResources(hookDiscovery.hooks),
		]);
		let closePromise: Promise<void> | undefined;
		return Object.freeze({
			...composition,
			resources,
			hookRunner,
			...(subagentController ? { subagentController } : {}),
			subscribeSubagents: (
				listener: (subagent: Readonly<Record<string, unknown>>) => void,
			) => {
				subagentListeners.add(listener);
				return () => { subagentListeners.delete(listener); };
			},
			close: () => closePromise ??= composition.close().finally(() => {
				subagentListeners.clear();
			}),
		});
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
): readonly Readonly<Record<string, unknown>>[] {
	return resources.map((resource) => Object.freeze({
		id: `mcp:${resource.serverId}:${resource.uri}`.slice(0, 256),
		type: "plugin",
		name: `${resource.serverId} ${resource.name}`.slice(0, 256),
		source: "runtime",
		enabled: true,
		status: "enabled",
		detail: `MCP resource ${resource.uri}`.slice(0, 512),
		command: `/mcp inspect ${resource.serverId}`,
	}));
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

function subagentResources(
	registry: SubagentProfileRegistry,
): readonly Readonly<Record<string, unknown>>[] {
	return registry.records().map((record) => Object.freeze({
		id: `subagent:${record.id}`,
		type: "prompt",
		name: record.id,
		source: resourceSource(record.sourceKind),
		enabled: record.enabled,
		status: record.status,
		...(record.profile ? { detail: record.profile.description } : {}),
		command: "/tasks agents",
	}));
}

function subagentRegistrations(
	controller: SubagentController,
): readonly IntegrationRegistration[] {
	return Object.freeze([
		subagentRegistration(TASK_TOOL_DEFINITION, new TaskTool({ control: controller })),
		subagentRegistration(
			SUBAGENT_OUTPUT_TOOL_DEFINITION,
			new SubagentOutputTool({ control: controller }),
		),
		subagentRegistration(
			SEND_MESSAGE_TOOL_DEFINITION,
			new SendMessageTool({ control: controller }),
		),
	]);
}

function subagentRegistration(
	definition: typeof TASK_TOOL_DEFINITION,
	adapter: TaskTool | SubagentOutputTool | SendMessageTool,
): IntegrationRegistration {
	return defineIntegrationRegistration({
		id: definition.id,
		source: "subagent",
		definition,
		adapter,
		originMetadata: { controller: "local" },
	});
}

function subagentPayload(update: SubagentControllerUpdate): Readonly<Record<string, unknown>> {
	return Object.freeze({
		parent_session_id: update.parentSessionId,
		run_id: update.taskId,
		child_session_id: update.childSessionId,
		role: update.profileId,
		status: update.status,
		summary: update.summary,
		progress: update.progress.map((item) => Object.freeze({ ...item })),
	});
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
