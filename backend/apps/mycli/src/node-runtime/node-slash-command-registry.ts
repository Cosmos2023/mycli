import { slashCommandArguments } from "@mycli/contracts";

export type SlashCommandSurface = "cli" | "tui";
type SlashArgumentPolicy = "none" | "optional" | "required";
type SlashCommandOwner = "backend" | "tui";
export type SlashCommandPresentation = "none" | "overlay" | "transcript";
type SlashCommandCategory =
	| "diagnostics"
	| "interface"
	| "integrations"
	| "model"
	| "safety"
	| "session"
	| "tools";

interface SlashCommandManifestItem {
	readonly id: string;
	readonly name: `/${string}`;
	readonly description: string;
	readonly argument_hint?: string;
	readonly argument_policy: SlashArgumentPolicy;
	readonly available_during_turn: boolean;
	readonly aliases: readonly `/${string}`[];
	readonly category: SlashCommandCategory;
	readonly search_only: boolean;
}

export interface ResolvedSlashCommand {
	readonly commandId: string;
	readonly canonicalName: `/${string}`;
	readonly args: string;
	readonly owner: SlashCommandOwner;
	readonly clientAction?: string;
	readonly presentation: SlashCommandPresentation;
}

type SlashDispatchPolicy = {
	readonly bareOwner: SlashCommandOwner;
	readonly inlineOwner?: SlashCommandOwner;
	readonly bareClientAction?: string;
	readonly inlineClientAction?: string;
};

type SlashCommandSpec = Omit<SlashCommandManifestItem, "aliases" | "category" | "search_only"> & {
	readonly dispatch: Readonly<Partial<Record<SlashCommandSurface, SlashDispatchPolicy>>>;
	readonly presentation: SlashCommandPresentation;
	readonly surfaces: readonly SlashCommandSurface[];
	readonly visible: boolean;
};

interface RetiredSlashCommand {
	readonly name: `/${string}`;
	readonly replacement: `/${string}`;
}

type ResolutionCandidate =
	| { readonly name: `/${string}`; readonly command: SlashCommandSpec }
	| RetiredSlashCommand;

type SpecOptions = {
	readonly argumentHint?: string;
	readonly argumentPolicy?: SlashArgumentPolicy;
	readonly tuiPolicy?: SlashDispatchPolicy;
	readonly cliPolicy?: SlashDispatchPolicy;
	readonly presentation?: SlashCommandPresentation;
	readonly availableDuringTurn?: boolean;
	readonly surfaces?: readonly SlashCommandSurface[];
	readonly visible?: boolean;
};

export class SlashCommandError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly replacement?: `/${string}`,
	) {
		super(message);
		this.name = "SlashCommandError";
	}
}

const ALL_SURFACES = ["cli", "tui"] as const;
const TUI_SURFACE = ["tui"] as const;

function backendPolicy(inline: boolean): SlashDispatchPolicy {
	return {
		bareOwner: "backend",
		...(inline ? { inlineOwner: "backend" as const } : {}),
	};
}

function tuiPolicy(action: string, inlineAction?: string): SlashDispatchPolicy {
	return {
		bareOwner: "tui",
		bareClientAction: action,
		...(inlineAction
			? { inlineOwner: "tui" as const, inlineClientAction: inlineAction }
			: {}),
	};
}

function hybridPolicy(action: string): SlashDispatchPolicy {
	return { bareOwner: "tui", bareClientAction: action, inlineOwner: "backend" };
}

function spec(
	id: string,
	name: `/${string}`,
	description: string,
	options: SpecOptions = {},
): SlashCommandSpec {
	const argumentPolicy = options.argumentPolicy ?? "none";
	const surfaces = options.surfaces ?? ALL_SURFACES;
	const inline = argumentPolicy !== "none";
	return {
		id,
		name,
		description,
		...(options.argumentHint ? { argument_hint: options.argumentHint } : {}),
		argument_policy: argumentPolicy,
		available_during_turn: options.availableDuringTurn ?? true,
		dispatch: {
			...(surfaces.includes("cli")
				? { cli: options.cliPolicy ?? backendPolicy(inline) }
				: {}),
			...(surfaces.includes("tui")
				? { tui: options.tuiPolicy ?? backendPolicy(inline) }
				: {}),
		},
		presentation: options.presentation ?? "transcript",
		surfaces,
		visible: options.visible ?? true,
	};
}

const BUILTIN_SLASH_COMMANDS: readonly SlashCommandSpec[] = Object.freeze([
	spec("model", "/model", "Choose the model and thinking effort", {
		argumentHint: "[model] [--thinking-effort level]",
		argumentPolicy: "optional",
		tuiPolicy: hybridPolicy("open_model_selector"),
	}),
	spec("plan", "/plan", "Switch to Plan mode", {
		presentation: "none",
		availableDuringTurn: false,
	}),
	spec("mode", "/mode", "Inspect or switch collaboration mode", {
		argumentHint: "[default|plan]",
		argumentPolicy: "optional",
		presentation: "none",
		availableDuringTurn: false,
		visible: false,
	}),
	spec("permissions", "/permissions", "Inspect or update command permissions", {
		argumentHint: "[allow|revoke|clear]",
		argumentPolicy: "optional",
		tuiPolicy: hybridPolicy("open_permissions"),
		presentation: "overlay",
	}),
	spec("sandbox", "/sandbox", "Inspect or switch sandbox mode", {
		argumentHint: "[read-only|workspace-write|danger-full-access|next]",
		argumentPolicy: "optional",
		presentation: "none",
		availableDuringTurn: false,
		visible: false,
	}),
	spec("settings", "/settings", "Open visual settings", {
		tuiPolicy: tuiPolicy("open_settings"),
		surfaces: TUI_SURFACE,
		presentation: "none",
	}),
	spec("new", "/new", "Start a new session", {
		surfaces: TUI_SURFACE,
		presentation: "none",
		availableDuringTurn: false,
	}),
	spec("resume", "/resume", "Resume a saved session", {
		argumentHint: "[session-id]",
		argumentPolicy: "optional",
		tuiPolicy: hybridPolicy("open_session_selector"),
		availableDuringTurn: false,
	}),
	spec("fork", "/fork", "Fork a saved session", {
		argumentHint: "[source] [new-session] [message-index]",
		argumentPolicy: "optional",
		availableDuringTurn: false,
	}),
	spec("status", "/status", "Show runtime status"),
	spec("update", "/update", "Inspect cached updates or dismiss a version", {
		argumentHint: "[check|dismiss <version>]",
		argumentPolicy: "optional",
	}),
	spec("usage", "/usage", "Show token usage"),
	spec("context", "/context", "Show context-window diagnostics", {
		visible: false,
	}),
	spec("compact", "/compact", "Compact the active model context", {
		availableDuringTurn: false,
	}),
	spec("stats", "/stats", "Show aggregate runtime stats", {
		visible: false,
	}),
	spec("skills", "/skills", "Inspect available skills", {
		presentation: "overlay",
	}),
	spec("mcp", "/mcp", "Inspect MCP servers and their tools", {
		argumentHint: "[verbose]",
		argumentPolicy: "optional",
		presentation: "overlay",
	}),
	spec("plugins", "/plugins", "Browse installed plugins and their capabilities", {
		presentation: "overlay",
	}),
	spec("hooks", "/hooks", "Inspect configured hooks", {
		presentation: "overlay",
	}),
	spec("tools", "/tools", "Inspect the runtime tool inventory", {
		argumentHint: "[list|sets]",
		argumentPolicy: "optional",
		presentation: "overlay",
		visible: false,
	}),
	spec("resources", "/resources", "Browse runtime resources", {
		tuiPolicy: tuiPolicy("open_resources"),
		surfaces: TUI_SURFACE,
		presentation: "none",
		visible: false,
	}),
	spec("memory", "/memory", "Inspect or update session memory", {
		argumentHint: "[list|path|search|add|forget]",
		argumentPolicy: "optional",
		presentation: "overlay",
		visible: false,
	}),
	spec("agents", "/agents", "Inspect or stop background agents", {
		argumentHint: "[child-session-id|kill <child-session-id>|kill-all]",
		argumentPolicy: "optional",
		tuiPolicy: hybridPolicy("open_agents"),
	}),
	spec("ps", "/ps", "List background terminals", {
		argumentHint: "[stop-all]",
		argumentPolicy: "optional",
	}),
	spec("changes", "/changes", "Inspect file changes"),
	spec("undo", "/undo", "Undo the last recoverable file change", {
		visible: false,
	}),
	spec("trace", "/trace", "Inspect runtime trace or logs", {
		argumentHint: "[export|logs]",
		argumentPolicy: "optional",
		presentation: "overlay",
		visible: false,
	}),
	spec("details", "/details", "Toggle compact tool details", {
		tuiPolicy: tuiPolicy("toggle_details"),
		surfaces: TUI_SURFACE,
		presentation: "none",
		visible: false,
	}),
	spec("view", "/view", "Switch tool visibility", {
		argumentHint: "[default|verbose|focus]",
		argumentPolicy: "optional",
		tuiPolicy: tuiPolicy("set_view_mode", "set_view_mode"),
		presentation: "none",
		visible: false,
	}),
	spec("hotkeys", "/hotkeys", "Show keyboard shortcuts", {
		tuiPolicy: tuiPolicy("open_hotkeys"),
		surfaces: TUI_SURFACE,
		presentation: "none",
		visible: false,
	}),
	spec("copy", "/copy", "Copy the last assistant response", {
		tuiPolicy: tuiPolicy("copy_last_response"),
		surfaces: TUI_SURFACE,
		presentation: "none",
		visible: false,
	}),
	spec("clear", "/clear", "Clear the local transcript view", {
		tuiPolicy: tuiPolicy("clear_transcript"),
		surfaces: TUI_SURFACE,
		presentation: "none",
		availableDuringTurn: false,
		visible: false,
	}),
	spec("login", "/login", "Configure provider credentials", {
		tuiPolicy: tuiPolicy("open_login"),
		surfaces: TUI_SURFACE,
		presentation: "none",
		visible: false,
	}),
	spec("trust", "/trust", "Review workspace trust", {
		tuiPolicy: tuiPolicy("open_trust"),
		surfaces: TUI_SURFACE,
		presentation: "none",
		visible: false,
	}),
	spec("help", "/help", "Open command help", {
		tuiPolicy: tuiPolicy("open_help"),
		presentation: "none",
	}),
	spec("quit", "/quit", "Exit mycli", {
		tuiPolicy: tuiPolicy("quit"),
		presentation: "none",
	}),
	spec("session_search", "/session search", "Search saved sessions", {
		argumentHint: "[query]",
		argumentPolicy: "optional",
		visible: false,
	}),
	spec("session_maintenance", "/session maintenance", "Maintain session storage", {
		argumentHint: "[--apply-empty|--apply-payloads|--apply-orphans|--apply-vacuum|--apply-transcript-normalization|--apply-content-blobs|--apply-content-blob-gc]",
		argumentPolicy: "optional",
		availableDuringTurn: false,
		visible: false,
	}),
]);

const RETIRED_SLASH_COMMANDS: readonly RetiredSlashCommand[] = Object.freeze([
	{ name: "/tools permissions", replacement: "/permissions" },
	{ name: "/session", replacement: "/resume" },
	{ name: "/session list", replacement: "/resume" },
	{ name: "/sessions", replacement: "/resume" },
	{ name: "/session resume", replacement: "/resume" },
	{ name: "/session fork", replacement: "/fork" },
	{ name: "/session show", replacement: "/status" },
	{ name: "/status usage", replacement: "/usage" },
	{ name: "/status context", replacement: "/context" },
	{ name: "/status stats", replacement: "/stats" },
	{ name: "/skill", replacement: "/skills" },
	{ name: "/tools skills", replacement: "/skills" },
	{ name: "/tools hooks", replacement: "/hooks" },
	{ name: "/tools plugins", replacement: "/plugins" },
	{ name: "/tools extensions", replacement: "/tools" },
	{ name: "/toolsets", replacement: "/tools sets" },
	{ name: "/extensions", replacement: "/tools" },
	{ name: "/plugin", replacement: "/plugins" },
	{ name: "/tasks", replacement: "/agents" },
	{ name: "/jobs", replacement: "/agents" },
	{ name: "/tasks agents kill", replacement: "/agents kill" },
	{ name: "/tasks agents", replacement: "/agents" },
	{ name: "/tasks kill-agents", replacement: "/agents kill-all" },
	{ name: "/jobs subagents kill", replacement: "/agents kill" },
	{ name: "/jobs subagents", replacement: "/agents" },
	{ name: "/jobs kill-subagents", replacement: "/agents kill-all" },
	{ name: "/subagents", replacement: "/agents" },
	{ name: "/agents runs", replacement: "/agents" },
	{ name: "/agents agents", replacement: "/agents" },
	{ name: "/agents kill-agents", replacement: "/agents kill-all" },
	{ name: "/tasks bashes", replacement: "/ps" },
	{ name: "/bashes", replacement: "/ps" },
	{ name: "/jobs bashes", replacement: "/ps" },
	{ name: "/stop", replacement: "/ps stop-all" },
	{ name: "/changes undo", replacement: "/undo" },
	{ name: "/trace-jsonl", replacement: "/trace export" },
	{ name: "/logs", replacement: "/trace logs" },
	{ name: "/search", replacement: "/session search" },
	{ name: "/session-maintenance", replacement: "/session maintenance" },
]);

const RESOLUTION_CANDIDATES: readonly ResolutionCandidate[] = [
	...BUILTIN_SLASH_COMMANDS.map((command) => ({ name: command.name, command })),
	...RETIRED_SLASH_COMMANDS,
].sort((left, right) => right.name.length - left.name.length);

function usage(command: SlashCommandSpec): string {
	return `Usage: ${command.name}${command.argument_hint ? ` ${command.argument_hint}` : ""}`;
}

function checkSurface(command: SlashCommandSpec, surface: SlashCommandSurface): void {
	if (!command.surfaces.includes(surface)) {
		throw new SlashCommandError(
			"unavailable_surface",
			`${command.name} is unavailable on this interface.`,
		);
	}
}

export function commandManifest(surface: SlashCommandSurface): SlashCommandManifestItem[] {
	return BUILTIN_SLASH_COMMANDS
		.filter((command) => command.visible && command.surfaces.includes(surface))
		.map((command) => commandManifestItem(command));
}

export function commandDiscoveryManifest(surface: SlashCommandSurface): SlashCommandManifestItem[] {
	return BUILTIN_SLASH_COMMANDS
		.filter((command) => command.surfaces.includes(surface))
		.map((command) => commandManifestItem(command));
}

// Retired names remain reserved so input is rejected locally, never sent as a model turn.
export function builtinCommandRoutingNames(): ReadonlySet<string> {
	return new Set(RESOLUTION_CANDIDATES.map((candidate) => candidate.name));
}

export function slashCommandParityMatrix(): Readonly<Record<string, unknown>> {
	return Object.freeze({
		commands: BUILTIN_SLASH_COMMANDS.map((command) => Object.freeze({
			id: command.id,
			name: command.name,
			description: command.description,
			argument_hint: command.argument_hint ?? null,
			aliases: [],
			argument_policy: command.argument_policy,
			dispatch: Object.fromEntries([...command.surfaces].sort().map((surface) => {
				const policy = command.dispatch[surface]!;
				return [surface, {
					bare_owner: policy.bareOwner,
					inline_owner: policy.inlineOwner ?? null,
					bare_client_action: policy.bareClientAction ?? null,
					inline_client_action: policy.inlineClientAction ?? null,
				}];
			})),
			presentation: command.presentation,
			available_during_turn: command.available_during_turn,
			category: commandCategory(command.id),
			search_only: !command.visible,
			surfaces: [...command.surfaces].sort(),
			visible: command.visible,
		})),
		retired_commands: RETIRED_SLASH_COMMANDS.map((command) => Object.freeze({ ...command })),
	});
}

function commandManifestItem(command: SlashCommandSpec): SlashCommandManifestItem {
	return Object.freeze({
		id: command.id,
		name: command.name,
		description: command.description,
		...(command.argument_hint ? { argument_hint: command.argument_hint } : {}),
		argument_policy: command.argument_policy,
		available_during_turn: command.available_during_turn,
		aliases: Object.freeze([]),
		category: commandCategory(command.id),
		search_only: !command.visible,
	});
}

function commandCategory(id: string): SlashCommandCategory {
	if (["model", "mode", "plan"].includes(id)) return "model";
	if (["permissions", "sandbox", "trust"].includes(id)) return "safety";
	if (["new", "resume", "fork", "session_search", "session_maintenance", "compact", "clear"].includes(id)) {
		return "session";
	}
	if (["skills", "mcp", "plugins", "hooks", "resources"].includes(id)) return "integrations";
	if (["tools", "memory", "agents", "ps", "changes", "undo"].includes(id)) {
		return "tools";
	}
	if (["status", "usage", "context", "stats", "trace"].includes(id)) return "diagnostics";
	return "interface";
}

export function resolveSlashCommand(input: {
	readonly text: string;
	readonly surface: SlashCommandSurface;
	readonly turnRunning: boolean;
}): ResolvedSlashCommand {
	const normalized = input.text.trim();
	if (!normalized.startsWith("/")) {
		throw new SlashCommandError("not_slash_command", "command must start with '/'.");
	}
	const candidate = RESOLUTION_CANDIDATES.find((item) => slashCommandArguments(normalized, item.name) !== null);
	if (!candidate) {
		const name = normalized.split(/\s+/, 1)[0] ?? normalized;
		throw new SlashCommandError("unknown_command", `Unknown command: ${name}`);
	}
	if ("replacement" in candidate) {
		throw new SlashCommandError(
			"invalid_arguments",
			`${candidate.name} has been removed. Use ${candidate.replacement} instead.`,
			candidate.replacement,
		);
	}
	const command = candidate.command;
	const args = slashCommandArguments(normalized, candidate.name) ?? "";
	checkSurface(command, input.surface);
	if (args && command.argument_policy === "none") {
		throw new SlashCommandError("invalid_arguments", usage(command));
	}
	if (!args && command.argument_policy === "required") {
		throw new SlashCommandError("invalid_arguments", usage(command));
	}
	const policy = command.dispatch[input.surface];
	if (!policy) {
		throw new SlashCommandError(
			"unavailable_surface",
			`${command.name} is unavailable on this interface.`,
		);
	}
	const owner = args ? policy.inlineOwner : policy.bareOwner;
	const clientAction = args ? policy.inlineClientAction : policy.bareClientAction;
	if (!owner) {
		throw new SlashCommandError("invalid_arguments", usage(command));
	}
	if (input.turnRunning && !command.available_during_turn) {
		throw new SlashCommandError(
			"unavailable_during_turn",
			`${command.name} is disabled while a task is in progress.`,
		);
	}
	return {
		commandId: command.id,
		canonicalName: command.name,
		args,
		owner,
		...(clientAction ? { clientAction } : {}),
		presentation: command.presentation,
	};
}

function validateRegistry(): void {
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const command of BUILTIN_SLASH_COMMANDS) {
		if (ids.has(command.id)) throw new Error(`Duplicate slash command id: ${command.id}`);
		if (names.has(command.name)) throw new Error(`Duplicate slash command name: ${command.name}`);
		ids.add(command.id);
		names.add(command.name);
	}
	for (const retired of RETIRED_SLASH_COMMANDS) {
		if (names.has(retired.name)) {
			throw new Error(`Duplicate retired slash command: ${retired.name}`);
		}
		names.add(retired.name);
		const replacement = RESOLUTION_CANDIDATES.find((item) =>
			slashCommandArguments(retired.replacement, item.name) !== null);
		if (!replacement || !("command" in replacement)) {
			throw new Error(`Invalid replacement for retired slash command: ${retired.name}`);
		}
	}
}

validateRegistry();
