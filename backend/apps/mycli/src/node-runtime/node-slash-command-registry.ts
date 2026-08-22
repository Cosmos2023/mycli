export type SlashCommandSurface = "cli" | "tui";
export type SlashArgumentPolicy = "none" | "optional" | "required";
export type SlashCommandOwner = "backend" | "tui";
export type SlashCommandPresentation = "none" | "overlay" | "transcript";

export interface SlashCommandManifestItem {
	readonly id: string;
	readonly name: `/${string}`;
	readonly description: string;
	readonly argument_hint?: string;
	readonly argument_policy: SlashArgumentPolicy;
	readonly available_during_turn: boolean;
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

type SlashCommandSpec = SlashCommandManifestItem & {
	readonly aliases: readonly `/${string}`[];
	readonly dispatch: Readonly<Partial<Record<SlashCommandSurface, SlashDispatchPolicy>>>;
	readonly presentation: SlashCommandPresentation;
	readonly surfaces: readonly SlashCommandSurface[];
	readonly visible: boolean;
};

type PrefixedAlias = {
	readonly prefix: `/${string}`;
	readonly commandId: string;
	readonly argsPrefix?: string;
};

type ResolutionCandidate = PrefixedAlias & { readonly canonical: boolean };

type SpecOptions = {
	readonly argumentHint?: string;
	readonly aliases?: readonly `/${string}`[];
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
		aliases: options.aliases ?? [],
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
		aliases: ["/tools permissions"],
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
		visible: false,
	}),
	spec("new", "/new", "Start a new session", {
		surfaces: TUI_SURFACE,
		presentation: "none",
		availableDuringTurn: false,
	}),
	spec("resume", "/resume", "Resume a saved session", {
		argumentHint: "[session-id]",
		aliases: ["/session", "/session list", "/sessions", "/session resume"],
		argumentPolicy: "optional",
		tuiPolicy: hybridPolicy("open_session_selector"),
		availableDuringTurn: false,
	}),
	spec("fork", "/fork", "Fork a saved session", {
		argumentHint: "[source] [new-session] [message-index]",
		aliases: ["/session fork"],
		argumentPolicy: "optional",
		availableDuringTurn: false,
	}),
	spec("status", "/status", "Show runtime status", { aliases: ["/session show"] }),
	spec("usage", "/usage", "Show token usage", { aliases: ["/status usage"] }),
	spec("context", "/context", "Show context-window diagnostics", {
		aliases: ["/status context"],
		visible: false,
	}),
	spec("compact", "/compact", "Compact the active model context", {
		availableDuringTurn: false,
	}),
	spec("stats", "/stats", "Show aggregate runtime stats", {
		aliases: ["/status stats"],
		visible: false,
	}),
	spec("skills", "/skills", "Inspect available skills", {
		aliases: ["/skill", "/tools skills"],
		presentation: "overlay",
	}),
	spec("tools", "/tools", "Inspect tools, hooks, extensions, and plugins", {
		argumentHint: "[list|sets|hooks|extensions|plugins]",
		argumentPolicy: "optional",
		presentation: "overlay",
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
		aliases: ["/tasks", "/jobs"],
		argumentPolicy: "optional",
		tuiPolicy: hybridPolicy("open_agents"),
	}),
	spec("ps", "/ps", "List background terminals", {
		argumentHint: "[stop-all]",
		aliases: ["/tasks bashes", "/bashes", "/jobs bashes"],
		argumentPolicy: "optional",
	}),
	spec("stop", "/stop", "Stop all background terminals", {
		presentation: "none",
		visible: false,
	}),
	spec("changes", "/changes", "Inspect file changes"),
	spec("undo", "/undo", "Undo the last recoverable file change", {
		aliases: ["/changes undo"],
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
		aliases: ["/search"],
		argumentPolicy: "optional",
		visible: false,
	}),
	spec("session_maintenance", "/session maintenance", "Maintain session storage", {
		argumentHint: "[--apply-empty|--apply-payloads|--apply-orphans|--apply-vacuum|--apply-transcript-normalization|--apply-content-blobs|--apply-content-blob-gc]",
		aliases: ["/session-maintenance"],
		argumentPolicy: "optional",
		availableDuringTurn: false,
		visible: false,
	}),
]);

const PREFIXED_ALIASES: readonly PrefixedAlias[] = Object.freeze([
	{ prefix: "/hooks", commandId: "tools", argsPrefix: "hooks" },
	{ prefix: "/toolsets", commandId: "tools", argsPrefix: "sets" },
	{ prefix: "/extensions", commandId: "tools", argsPrefix: "extensions" },
	{ prefix: "/plugin", commandId: "tools", argsPrefix: "plugins" },
	{ prefix: "/tasks agents", commandId: "agents", argsPrefix: "agents" },
	{ prefix: "/tasks kill-agents", commandId: "agents", argsPrefix: "kill-all" },
	{ prefix: "/jobs subagents", commandId: "agents", argsPrefix: "agents" },
	{ prefix: "/jobs kill-subagents", commandId: "agents", argsPrefix: "kill-all" },
	{ prefix: "/subagents", commandId: "agents", argsPrefix: "agents" },
	{ prefix: "/agents runs", commandId: "agents", argsPrefix: "agents" },
	{ prefix: "/agents kill", commandId: "agents", argsPrefix: "kill" },
	{ prefix: "/trace-jsonl", commandId: "trace", argsPrefix: "export" },
	{ prefix: "/logs", commandId: "trace", argsPrefix: "logs" },
]);

const SPEC_BY_ID = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.id, command]));

function matchesPrefix(text: string, prefix: string): boolean {
	return text === prefix || text.startsWith(`${prefix} `);
}

function resolutionCandidates(): ResolutionCandidate[] {
	return [
		...BUILTIN_SLASH_COMMANDS.flatMap((command) => [
			{ prefix: command.name, commandId: command.id, canonical: true },
			...command.aliases.map((prefix) => ({
				prefix,
				commandId: command.id,
				canonical: false,
			})),
		]),
		...PREFIXED_ALIASES.map((alias) => ({ ...alias, canonical: false })),
	];
}

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
		.map((command) => ({
			id: command.id,
			name: command.name,
			description: command.description,
			...(command.argument_hint ? { argument_hint: command.argument_hint } : {}),
			argument_policy: command.argument_policy,
			available_during_turn: command.available_during_turn,
		}));
}

export function builtinCommandNames(): ReadonlySet<string> {
	return new Set([
		...BUILTIN_SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]),
		...PREFIXED_ALIASES.map((alias) => alias.prefix),
	]);
}

export function slashCommandParityMatrix(): Readonly<Record<string, unknown>> {
	return Object.freeze({
		commands: BUILTIN_SLASH_COMMANDS.map((command) => Object.freeze({
			id: command.id,
			name: command.name,
			description: command.description,
			argument_hint: command.argument_hint ?? null,
			aliases: [...command.aliases],
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
			surfaces: [...command.surfaces].sort(),
			visible: command.visible,
		})),
		prefixed_aliases: PREFIXED_ALIASES.map((alias) => Object.freeze({
			prefix: alias.prefix,
			command_id: alias.commandId,
			args_prefix: alias.argsPrefix ?? "",
		})),
	});
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
	const candidate = resolutionCandidates()
		.filter((item) => matchesPrefix(normalized, item.prefix))
		.sort((left, right) =>
			right.prefix.length - left.prefix.length || Number(right.canonical) - Number(left.canonical))[0];
	if (!candidate) {
		const name = normalized.split(/\s+/, 1)[0] ?? normalized;
		throw new SlashCommandError("unknown_command", `Unknown command: ${name}`);
	}
	const command = SPEC_BY_ID.get(candidate.commandId);
	if (!command) {
		throw new Error(`Invalid slash command alias target: ${candidate.commandId}`);
	}
	let args = normalized.slice(candidate.prefix.length).trim();
	if (candidate.argsPrefix) {
		args = [candidate.argsPrefix, args].filter(Boolean).join(" ");
	}
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
	const aliases = new Set<string>();
	for (const command of BUILTIN_SLASH_COMMANDS) {
		if (ids.has(command.id)) throw new Error(`Duplicate slash command id: ${command.id}`);
		if (names.has(command.name)) throw new Error(`Duplicate slash command name: ${command.name}`);
		ids.add(command.id);
		names.add(command.name);
		for (const alias of command.aliases) {
			if (aliases.has(alias) || names.has(alias)) throw new Error(`Duplicate slash command alias: ${alias}`);
			aliases.add(alias);
		}
	}
	for (const alias of PREFIXED_ALIASES) {
		if (aliases.has(alias.prefix) || names.has(alias.prefix)) {
			throw new Error(`Duplicate slash command alias: ${alias.prefix}`);
		}
		if (!ids.has(alias.commandId)) throw new Error(`Unknown slash command alias target: ${alias.commandId}`);
		aliases.add(alias.prefix);
	}
}

validateRegistry();
