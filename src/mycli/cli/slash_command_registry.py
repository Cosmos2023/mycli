from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from difflib import get_close_matches
from enum import StrEnum
import sys


class SlashCommandId(StrEnum):
    HELP = "help"
    MODEL = "model"
    PLAN = "plan"
    MODE = "mode"
    PERMISSIONS = "permissions"
    SANDBOX = "sandbox"
    SETTINGS = "settings"
    RESUME = "resume"
    FORK = "fork"
    NEW = "new"
    STATUS = "status"
    USAGE = "usage"
    COMPACT = "compact"
    CONTEXT = "context"
    STATS = "stats"
    SKILLS = "skills"
    TOOLS = "tools"
    RESOURCES = "resources"
    MEMORY = "memory"
    AGENTS = "agents"
    TASKS = "tasks"
    PS = "ps"
    STOP = "stop"
    CHANGES = "changes"
    UNDO = "undo"
    TRACE = "trace"
    DETAILS = "details"
    VIEW = "view"
    HOTKEYS = "hotkeys"
    COPY = "copy"
    CLEAR = "clear"
    LOGIN = "login"
    TRUST = "trust"
    QUIT = "quit"
    SESSION_SEARCH = "session_search"
    SESSION_MAINTENANCE = "session_maintenance"


class SlashCommandOwner(StrEnum):
    BACKEND = "backend"
    TUI = "tui"


class SlashCommandSurface(StrEnum):
    CLI = "cli"
    TUI = "tui"


class SlashArgumentPolicy(StrEnum):
    NONE = "none"
    OPTIONAL = "optional"
    REQUIRED = "required"


class SlashCommandPresentation(StrEnum):
    NONE = "none"
    OVERLAY = "overlay"
    TRANSCRIPT = "transcript"


@dataclass(frozen=True)
class SlashDispatchPolicy:
    bare_owner: SlashCommandOwner
    inline_owner: SlashCommandOwner | None = None
    bare_client_action: str | None = None
    inline_client_action: str | None = None


@dataclass(frozen=True)
class SlashCommandContext:
    surface: SlashCommandSurface
    turn_running: bool = False
    platform: str = sys.platform
    enabled_features: frozenset[str] = frozenset()


@dataclass(frozen=True)
class SlashCommandSpec:
    id: SlashCommandId
    name: str
    description: str
    argument_hint: str | None
    aliases: tuple[str, ...]
    argument_policy: SlashArgumentPolicy
    dispatch_by_surface: Mapping[SlashCommandSurface, SlashDispatchPolicy]
    presentation: SlashCommandPresentation
    available_during_turn: bool
    surfaces: frozenset[SlashCommandSurface]
    platforms: frozenset[str] | None = None
    feature: str | None = None
    visible: bool = True


@dataclass(frozen=True)
class SlashCommandManifestItem:
    id: str
    name: str
    description: str
    argument_hint: str | None
    argument_policy: str
    available_during_turn: bool


@dataclass(frozen=True)
class ResolvedSlashCommand:
    command_id: SlashCommandId
    canonical_name: str
    args: str
    owner: SlashCommandOwner
    client_action: str | None
    presentation: SlashCommandPresentation


@dataclass(frozen=True)
class _SlashAlias:
    prefix: str
    command_id: SlashCommandId
    args_prefix: str = ""


@dataclass(frozen=True)
class _ResolutionCandidate:
    prefix: str
    command_id: SlashCommandId
    args_prefix: str
    canonical: bool


class SlashCommandError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


_ALL_SURFACES = frozenset(SlashCommandSurface)
_TUI_SURFACE = frozenset({SlashCommandSurface.TUI})


def _backend_policy(*, inline: bool) -> SlashDispatchPolicy:
    return SlashDispatchPolicy(
        bare_owner=SlashCommandOwner.BACKEND,
        inline_owner=SlashCommandOwner.BACKEND if inline else None,
    )


def _tui_policy(action: str, *, inline_action: str | None = None) -> SlashDispatchPolicy:
    return SlashDispatchPolicy(
        bare_owner=SlashCommandOwner.TUI,
        inline_owner=SlashCommandOwner.TUI if inline_action is not None else None,
        bare_client_action=action,
        inline_client_action=inline_action,
    )


def _hybrid_policy(action: str) -> SlashDispatchPolicy:
    return SlashDispatchPolicy(
        bare_owner=SlashCommandOwner.TUI,
        inline_owner=SlashCommandOwner.BACKEND,
        bare_client_action=action,
    )


def _spec(
    command_id: SlashCommandId,
    name: str,
    description: str,
    *,
    argument_hint: str | None = None,
    aliases: tuple[str, ...] = (),
    argument_policy: SlashArgumentPolicy = SlashArgumentPolicy.NONE,
    tui_policy: SlashDispatchPolicy | None = None,
    cli_policy: SlashDispatchPolicy | None = None,
    presentation: SlashCommandPresentation = SlashCommandPresentation.TRANSCRIPT,
    available_during_turn: bool = True,
    surfaces: frozenset[SlashCommandSurface] = _ALL_SURFACES,
    visible: bool = True,
) -> SlashCommandSpec:
    inline = argument_policy is not SlashArgumentPolicy.NONE
    policies: dict[SlashCommandSurface, SlashDispatchPolicy] = {}
    if SlashCommandSurface.CLI in surfaces:
        policies[SlashCommandSurface.CLI] = cli_policy or _backend_policy(inline=inline)
    if SlashCommandSurface.TUI in surfaces:
        policies[SlashCommandSurface.TUI] = tui_policy or _backend_policy(inline=inline)
    return SlashCommandSpec(
        id=command_id,
        name=name,
        description=description,
        argument_hint=argument_hint,
        aliases=aliases,
        argument_policy=argument_policy,
        dispatch_by_surface=policies,
        presentation=presentation,
        available_during_turn=available_during_turn,
        surfaces=surfaces,
        visible=visible,
    )


_SPECS: tuple[SlashCommandSpec, ...] = (
    _spec(
        SlashCommandId.MODEL,
        "/model",
        "Choose the model and thinking effort",
        argument_hint="[model] [--thinking-effort level]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        tui_policy=_hybrid_policy("open_model_selector"),
    ),
    _spec(
        SlashCommandId.PLAN,
        "/plan",
        "Switch to Plan mode",
        presentation=SlashCommandPresentation.NONE,
        available_during_turn=False,
    ),
    _spec(
        SlashCommandId.MODE,
        "/mode",
        "Inspect or switch collaboration mode",
        argument_hint="[default|plan]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        presentation=SlashCommandPresentation.NONE,
        available_during_turn=False,
        visible=False,
    ),
    _spec(
        SlashCommandId.PERMISSIONS,
        "/permissions",
        "Inspect or update command permissions",
        argument_hint="[allow|revoke|clear]",
        aliases=("/tools permissions",),
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        tui_policy=_hybrid_policy("open_permissions"),
        presentation=SlashCommandPresentation.OVERLAY,
    ),
    _spec(
        SlashCommandId.SANDBOX,
        "/sandbox",
        "Inspect or switch sandbox mode",
        argument_hint="[read-only|workspace-write|danger-full-access|next]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        presentation=SlashCommandPresentation.NONE,
        available_during_turn=False,
        visible=False,
    ),
    _spec(
        SlashCommandId.SETTINGS,
        "/settings",
        "Open visual settings",
        tui_policy=_tui_policy("open_settings"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.NEW,
        "/new",
        "Start a fresh local transcript",
        tui_policy=_tui_policy("start_new_session"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        available_during_turn=False,
    ),
    _spec(
        SlashCommandId.RESUME,
        "/resume",
        "Resume a saved session",
        argument_hint="[session-id]",
        aliases=("/session", "/session list", "/sessions", "/session resume"),
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        tui_policy=_hybrid_policy("open_session_selector"),
        available_during_turn=False,
    ),
    _spec(
        SlashCommandId.FORK,
        "/fork",
        "Fork a saved session",
        argument_hint="[source] [new-session] [message-index]",
        aliases=("/session fork",),
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        available_during_turn=False,
    ),
    _spec(
        SlashCommandId.STATUS,
        "/status",
        "Show runtime status",
        aliases=("/session show",),
    ),
    _spec(
        SlashCommandId.USAGE,
        "/usage",
        "Show token usage",
        aliases=("/status usage",),
    ),
    _spec(
        SlashCommandId.CONTEXT,
        "/context",
        "Show context-window diagnostics",
        aliases=("/status context",),
        visible=False,
    ),
    _spec(
        SlashCommandId.COMPACT,
        "/compact",
        "Compact the active model context",
        presentation=SlashCommandPresentation.TRANSCRIPT,
        available_during_turn=False,
    ),
    _spec(
        SlashCommandId.STATS,
        "/stats",
        "Show aggregate runtime stats",
        aliases=("/status stats",),
        visible=False,
    ),
    _spec(
        SlashCommandId.SKILLS,
        "/skills",
        "Inspect available skills",
        aliases=("/skill", "/tools skills"),
        presentation=SlashCommandPresentation.OVERLAY,
    ),
    _spec(
        SlashCommandId.TOOLS,
        "/tools",
        "Inspect tools, hooks, extensions, and plugins",
        argument_hint="[list|sets|hooks|extensions|plugins]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        presentation=SlashCommandPresentation.OVERLAY,
    ),
    _spec(
        SlashCommandId.RESOURCES,
        "/resources",
        "Browse runtime resources",
        tui_policy=_tui_policy("open_resources"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.MEMORY,
        "/memory",
        "Inspect or update session memory",
        argument_hint="[list|path|search|add|forget]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        presentation=SlashCommandPresentation.OVERLAY,
        visible=False,
    ),
    _spec(
        SlashCommandId.AGENTS,
        "/agents",
        "Inspect agent profiles",
        argument_hint="[list|inspect profile-id]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        presentation=SlashCommandPresentation.OVERLAY,
        visible=False,
    ),
    _spec(
        SlashCommandId.TASKS,
        "/tasks",
        "Inspect or stop background agent tasks",
        argument_hint="[agents|kill-agents]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        tui_policy=_hybrid_policy("open_tasks"),
    ),
    _spec(
        SlashCommandId.PS,
        "/ps",
        "List background terminals",
        aliases=("/tasks bashes", "/bashes", "/jobs bashes"),
    ),
    _spec(
        SlashCommandId.STOP,
        "/stop",
        "Stop all background terminals",
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.CHANGES,
        "/changes",
        "Inspect file changes",
    ),
    _spec(
        SlashCommandId.UNDO,
        "/undo",
        "Undo the last recoverable file change",
        aliases=("/changes undo",),
        visible=False,
    ),
    _spec(
        SlashCommandId.TRACE,
        "/trace",
        "Inspect runtime trace or logs",
        argument_hint="[export|logs]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        presentation=SlashCommandPresentation.OVERLAY,
        visible=False,
    ),
    _spec(
        SlashCommandId.DETAILS,
        "/details",
        "Toggle compact tool details",
        tui_policy=_tui_policy("toggle_details"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.VIEW,
        "/view",
        "Switch tool visibility",
        argument_hint="[default|verbose|focus]",
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        tui_policy=_tui_policy("set_view_mode", inline_action="set_view_mode"),
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.HOTKEYS,
        "/hotkeys",
        "Show keyboard shortcuts",
        tui_policy=_tui_policy("open_hotkeys"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.COPY,
        "/copy",
        "Copy the last assistant response",
        tui_policy=_tui_policy("copy_last_response"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.CLEAR,
        "/clear",
        "Clear the local transcript view",
        tui_policy=_tui_policy("clear_transcript"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        available_during_turn=False,
        visible=False,
    ),
    _spec(
        SlashCommandId.LOGIN,
        "/login",
        "Configure provider credentials",
        tui_policy=_tui_policy("open_login"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.TRUST,
        "/trust",
        "Review workspace trust",
        tui_policy=_tui_policy("open_trust"),
        surfaces=_TUI_SURFACE,
        presentation=SlashCommandPresentation.NONE,
        visible=False,
    ),
    _spec(
        SlashCommandId.HELP,
        "/help",
        "Open command help",
        tui_policy=_tui_policy("open_command_palette"),
        presentation=SlashCommandPresentation.NONE,
    ),
    _spec(
        SlashCommandId.QUIT,
        "/quit",
        "Exit mycli",
        tui_policy=_tui_policy("quit"),
        presentation=SlashCommandPresentation.NONE,
    ),
    _spec(
        SlashCommandId.SESSION_SEARCH,
        "/session search",
        "Search saved sessions",
        argument_hint="[query]",
        aliases=("/search",),
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        visible=False,
    ),
    _spec(
        SlashCommandId.SESSION_MAINTENANCE,
        "/session maintenance",
        "Maintain session storage",
        argument_hint="[--apply-empty|--apply-orphans|--apply-vacuum]",
        aliases=("/session-maintenance",),
        argument_policy=SlashArgumentPolicy.OPTIONAL,
        visible=False,
    ),
)


_ALIASES_WITH_ARGUMENT_PREFIX: tuple[_SlashAlias, ...] = (
    _SlashAlias("/hooks", SlashCommandId.TOOLS, "hooks"),
    _SlashAlias("/toolsets", SlashCommandId.TOOLS, "sets"),
    _SlashAlias("/extensions", SlashCommandId.TOOLS, "extensions"),
    _SlashAlias("/plugin", SlashCommandId.TOOLS, "plugins"),
    _SlashAlias("/jobs", SlashCommandId.TASKS),
    _SlashAlias("/jobs subagents", SlashCommandId.TASKS, "agents"),
    _SlashAlias("/jobs kill-subagents", SlashCommandId.TASKS, "kill-agents"),
    _SlashAlias("/subagents", SlashCommandId.TASKS, "agents"),
    _SlashAlias("/agents runs", SlashCommandId.TASKS, "agents"),
    _SlashAlias("/agents kill", SlashCommandId.TASKS, "kill-agents"),
    _SlashAlias("/trace-jsonl", SlashCommandId.TRACE, "export"),
    _SlashAlias("/logs", SlashCommandId.TRACE, "logs"),
)


_SPEC_BY_ID = {spec.id: spec for spec in _SPECS}


def _matches_prefix(text: str, prefix: str) -> bool:
    return text == prefix or text.startswith(f"{prefix} ")


def _resolution_candidates() -> tuple[_ResolutionCandidate, ...]:
    candidates: list[_ResolutionCandidate] = []
    for spec in _SPECS:
        candidates.append(_ResolutionCandidate(spec.name, spec.id, "", True))
        candidates.extend(
            _ResolutionCandidate(alias, spec.id, "", False) for alias in spec.aliases
        )
    candidates.extend(
        _ResolutionCandidate(alias.prefix, alias.command_id, alias.args_prefix, False)
        for alias in _ALIASES_WITH_ARGUMENT_PREFIX
    )
    return tuple(candidates)


def _usage(spec: SlashCommandSpec) -> str:
    suffix = f" {spec.argument_hint}" if spec.argument_hint else ""
    return f"Usage: {spec.name}{suffix}"


def _check_availability(spec: SlashCommandSpec, context: SlashCommandContext) -> None:
    if context.surface not in spec.surfaces:
        raise SlashCommandError(
            "unavailable_surface",
            f"{spec.name} is unavailable on this interface.",
        )
    if spec.platforms is not None and context.platform not in spec.platforms:
        raise SlashCommandError(
            "unavailable_platform",
            f"{spec.name} is unavailable on this platform.",
        )
    if spec.feature is not None and spec.feature not in context.enabled_features:
        raise SlashCommandError(
            "unavailable_feature",
            f"{spec.name} is unavailable because {spec.feature} is disabled.",
        )


def resolve_slash_command(
    text: str,
    context: SlashCommandContext,
) -> ResolvedSlashCommand:
    normalized = text.strip()
    if not normalized.startswith("/"):
        raise SlashCommandError("not_slash_command", "command must start with '/'.")
    candidates = tuple(
        candidate
        for candidate in _resolution_candidates()
        if _matches_prefix(normalized, candidate.prefix)
    )
    if not candidates:
        name = normalized.split(maxsplit=1)[0]
        raise SlashCommandError("unknown_command", f"Unknown command: {name}")
    candidate = max(candidates, key=lambda item: (len(item.prefix), item.canonical))
    spec = _SPEC_BY_ID[candidate.command_id]
    args = normalized[len(candidate.prefix) :].strip()
    if candidate.args_prefix:
        args = " ".join(part for part in (candidate.args_prefix, args) if part)
    _check_availability(spec, context)
    if args and spec.argument_policy is SlashArgumentPolicy.NONE:
        raise SlashCommandError("invalid_arguments", _usage(spec))
    if not args and spec.argument_policy is SlashArgumentPolicy.REQUIRED:
        raise SlashCommandError("invalid_arguments", _usage(spec))
    policy = spec.dispatch_by_surface[context.surface]
    owner = policy.inline_owner if args else policy.bare_owner
    action = policy.inline_client_action if args else policy.bare_client_action
    if owner is None:
        raise SlashCommandError("invalid_arguments", _usage(spec))
    if context.turn_running and not spec.available_during_turn:
        raise SlashCommandError(
            "unavailable_during_turn",
            f"{spec.name} is disabled while a task is in progress.",
        )
    return ResolvedSlashCommand(
        command_id=spec.id,
        canonical_name=spec.name,
        args=args,
        owner=owner,
        client_action=action,
        presentation=spec.presentation,
    )


def command_manifest(context: SlashCommandContext) -> tuple[SlashCommandManifestItem, ...]:
    items: list[SlashCommandManifestItem] = []
    for spec in _SPECS:
        if not spec.visible:
            continue
        try:
            _check_availability(spec, context)
        except SlashCommandError:
            continue
        items.append(
            SlashCommandManifestItem(
                id=spec.id.value,
                name=spec.name,
                description=spec.description,
                argument_hint=spec.argument_hint,
                argument_policy=spec.argument_policy.value,
                available_during_turn=spec.available_during_turn,
            )
        )
    return tuple(items)


def slash_command_help(context: SlashCommandContext) -> str:
    return "\n".join(
        f"{item.name}{f' {item.argument_hint}' if item.argument_hint else ''}  {item.description}"
        for item in command_manifest(context)
    )


def slash_command_suggestions(
    text: str,
    context: SlashCommandContext,
) -> tuple[str, ...]:
    command = text.strip().split(maxsplit=1)[0]
    names = tuple(item.name for item in command_manifest(context))
    return tuple(get_close_matches(command, names, n=3, cutoff=0.6))


def validate_slash_command_registry() -> None:
    ids: set[SlashCommandId] = set()
    names: set[str] = set()
    aliases: set[str] = set()
    for spec in _SPECS:
        if spec.id in ids:
            raise ValueError(f"duplicate slash command id: {spec.id.value}")
        if spec.name in names:
            raise ValueError(f"duplicate slash command name: {spec.name}")
        if not spec.name.startswith("/") or not spec.description:
            raise ValueError(f"invalid slash command spec: {spec.id.value}")
        if set(spec.dispatch_by_surface) != set(spec.surfaces):
            raise ValueError(f"missing dispatch policy: {spec.name}")
        ids.add(spec.id)
        names.add(spec.name)
        for spec_alias in spec.aliases:
            if spec_alias in aliases or spec_alias in names:
                raise ValueError(f"duplicate slash command alias: {spec_alias}")
            aliases.add(spec_alias)
        for policy in spec.dispatch_by_surface.values():
            _validate_dispatch_policy(spec, policy)
    for prefixed_alias in _ALIASES_WITH_ARGUMENT_PREFIX:
        if prefixed_alias.prefix in aliases or prefixed_alias.prefix in names:
            raise ValueError(f"duplicate slash command alias: {prefixed_alias.prefix}")
        if prefixed_alias.command_id not in ids:
            raise ValueError(
                f"unknown slash command alias target: {prefixed_alias.command_id.value}"
            )
        aliases.add(prefixed_alias.prefix)


def _validate_dispatch_policy(
    spec: SlashCommandSpec,
    policy: SlashDispatchPolicy,
) -> None:
    pairs = (
        (policy.bare_owner, policy.bare_client_action),
        (policy.inline_owner, policy.inline_client_action),
    )
    for owner, action in pairs:
        if owner is SlashCommandOwner.TUI and not action:
            raise ValueError(f"missing TUI action: {spec.name}")
        if owner is SlashCommandOwner.BACKEND and action is not None:
            raise ValueError(f"backend command has TUI action: {spec.name}")
    if spec.argument_policy is SlashArgumentPolicy.NONE and policy.inline_owner is not None:
        raise ValueError(f"non-argument command has inline owner: {spec.name}")


validate_slash_command_registry()
