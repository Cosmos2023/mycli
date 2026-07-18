from __future__ import annotations

from dataclasses import dataclass
import shlex

from mycli.application.turn_service import TurnService
from mycli.cli.slash_command_registry import (
    ResolvedSlashCommand,
    SlashCommandContext,
    SlashCommandId,
    SlashCommandPresentation,
    SlashCommandSurface,
    slash_command_help,
)


@dataclass(frozen=True)
class SlashCommandResult:
    lines: tuple[str, ...] = ()
    presentation: SlashCommandPresentation = SlashCommandPresentation.TRANSCRIPT
    mutated_session: bool = False
    mutated_model: bool = False
    mutated_mode: bool = False
    exit_requested: bool = False
    command_kind: str | None = None
    presentation_hint: str | None = None
    processes: tuple[dict[str, object], ...] = ()
    view_mode: str | None = None
    collaboration_mode: str | None = None

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "execution": "backend",
            "lines": list(self.lines),
            "presentation": self.presentation.value,
            "mutated_session": self.mutated_session,
            "mutated_model": self.mutated_model,
            "mutated_mode": self.mutated_mode,
            "exit_requested": self.exit_requested,
        }
        optional = {
            "command_kind": self.command_kind,
            "presentation_hint": self.presentation_hint,
            "view_mode": self.view_mode,
            "collaboration_mode": self.collaboration_mode,
        }
        payload.update({key: value for key, value in optional.items() if value is not None})
        if self.processes:
            payload["processes"] = list(self.processes)
        return payload


def _lines(prefix: str, values: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(f"[{prefix}] {line}" for line in values)


def _result(
    invocation: ResolvedSlashCommand,
    lines: tuple[str, ...],
    *,
    mutated_session: bool = False,
    mutated_model: bool = False,
    mutated_mode: bool = False,
    exit_requested: bool = False,
    command_kind: str | None = None,
    presentation_hint: str | None = None,
    processes: tuple[dict[str, object], ...] = (),
    view_mode: str | None = None,
    collaboration_mode: str | None = None,
) -> SlashCommandResult:
    return SlashCommandResult(
        lines=lines,
        presentation=invocation.presentation,
        mutated_session=mutated_session,
        mutated_model=mutated_model,
        mutated_mode=mutated_mode,
        exit_requested=exit_requested,
        command_kind=command_kind,
        presentation_hint=presentation_hint,
        processes=processes,
        view_mode=view_mode,
        collaboration_mode=collaboration_mode,
    )


def dispatch_backend_slash_command(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    command_id = invocation.command_id
    args = invocation.args
    if command_id is SlashCommandId.HELP:
        context = SlashCommandContext(surface=SlashCommandSurface.CLI)
        return _result(invocation, tuple(slash_command_help(context).splitlines()))
    if command_id is SlashCommandId.QUIT:
        return _result(invocation, ("Bye.",), exit_requested=True)
    if command_id is SlashCommandId.SKILLS:
        return _result(invocation, _lines("skill", service.inspect_skills()))
    if command_id is SlashCommandId.TOOLS:
        return _dispatch_tools(service, invocation)
    if command_id is SlashCommandId.PERMISSIONS:
        return _dispatch_permissions(service, invocation)
    if command_id is SlashCommandId.PLAN:
        values = service.set_collaboration_mode("plan")
        return _result(
            invocation,
            _lines("mode", values),
            mutated_mode=True,
            collaboration_mode="plan",
        )
    if command_id is SlashCommandId.MODE:
        values = service.inspect_mode() if not args else service.set_collaboration_mode(args)
        return _result(
            invocation,
            _lines("mode", values),
            mutated_mode=bool(args),
            collaboration_mode=args if args in {"default", "plan"} else None,
        )
    if command_id is SlashCommandId.SANDBOX:
        values = service.inspect_sandbox() if not args else service.set_sandbox_mode(args)
        return _result(invocation, _lines("sandbox", values), mutated_mode=bool(args))
    if command_id is SlashCommandId.PS:
        active = getattr(service, "active_background_shells", None)
        processes = tuple(active()) if callable(active) else ()
        return _result(
            invocation,
            _lines("bash", service.inspect_bashes()),
            command_kind="background_shells",
            processes=processes,
        )
    if command_id is SlashCommandId.STOP:
        return _result(
            invocation,
            _lines("bash", service.stop_background_shells()),
            command_kind="shell_stop",
        )
    if command_id is SlashCommandId.TASKS:
        return _dispatch_tasks(service, invocation)
    if command_id is SlashCommandId.AGENTS:
        return _dispatch_agents(service, invocation)
    if command_id is SlashCommandId.CHANGES:
        return _result(
            invocation,
            _lines("change", service.inspect_file_changes()),
            presentation_hint="file changes",
        )
    if command_id is SlashCommandId.UNDO:
        return _result(invocation, (f"[undo] {service.undo_last_file_change()}",))
    if command_id is SlashCommandId.MEMORY:
        return _dispatch_memory(service, invocation)
    if command_id is SlashCommandId.RESUME:
        values = service.resume_session(args or None)
        return _result(invocation, _lines("session", values), mutated_session=True)
    if command_id is SlashCommandId.FORK:
        return _dispatch_fork(service, invocation)
    if command_id is SlashCommandId.SESSION_SEARCH:
        return _result(invocation, _lines("search", service.search_sessions(args)))
    if command_id is SlashCommandId.SESSION_MAINTENANCE:
        return _dispatch_session_maintenance(service, invocation)
    if command_id is SlashCommandId.STATUS:
        return _result(invocation, _lines("status", service.inspect_status()))
    if command_id is SlashCommandId.STATS:
        return _result(invocation, _lines("stats", service.inspect_stats()))
    if command_id is SlashCommandId.CONTEXT:
        return _result(invocation, _lines("context", service.inspect_context()))
    if command_id is SlashCommandId.USAGE:
        return _result(invocation, _lines("usage", service.inspect_usage()))
    if command_id is SlashCommandId.MODEL:
        return _dispatch_model(service, invocation)
    if command_id is SlashCommandId.VIEW:
        values = service.inspect_view() if not args else service.set_view_mode(args)
        return _result(
            invocation,
            _lines("view", values),
            view_mode=args if args in {"default", "verbose", "focus"} else None,
        )
    if command_id is SlashCommandId.TRACE:
        if not args:
            return _result(invocation, _lines("trace", service.inspect_trace()))
        if args == "export":
            values = tuple(line for line in service.export_trace_jsonl() if line)
            return _result(invocation, _lines("trace-jsonl", values))
        if args == "logs":
            return _result(invocation, _lines("log", service.inspect_logs()))
        return _result(invocation, ("[trace] Usage: /trace [export|logs]",))
    return _result(
        invocation,
        (f"Unknown command: {invocation.canonical_name}",),
    )


def _dispatch_tools(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    if args in {"", "list"}:
        return _result(invocation, _lines("tool", service.inspect_tools()))
    if args == "hooks":
        return _result(invocation, _lines("hook", service.inspect_hooks()))
    if args == "sets":
        return _result(invocation, _lines("toolset", service.inspect_toolsets()))
    if args == "extensions":
        return _result(invocation, _lines("extension", service.inspect_extensions()))
    if args == "plugins":
        return _result(invocation, _lines("plugin", service.inspect_plugin_commands()))
    if args.startswith("plugins "):
        plugin_parts = args.removeprefix("plugins ").split(maxsplit=2)
        if len(plugin_parts) < 2:
            return _result(
                invocation,
                ("[plugin] Usage: /tools plugins <plugin-id> <command-name> [json-args]",),
            )
        raw_args = plugin_parts[2] if len(plugin_parts) > 2 else ""
        values = service.run_plugin_command(plugin_parts[0], plugin_parts[1], raw_args)
        return _result(invocation, _lines("plugin", values))
    return _result(
        invocation,
        ("[tool] Usage: /tools [list|sets|hooks|extensions|plugins]",),
    )


def _dispatch_permissions(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    if not args:
        values = service.inspect_permissions()
    elif args.startswith("allow "):
        values = service.add_permission_allowance(args.removeprefix("allow ").strip())
    elif args.startswith("revoke "):
        values = service.remove_permission_allowance(args.removeprefix("revoke ").strip())
    elif args == "clear":
        values = service.clear_permission_allowances()
    else:
        values = ("Usage: /permissions [allow <pattern>|revoke <pattern>|clear]",)
    return _result(invocation, _lines("permission", values))


def _dispatch_tasks(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    if not args:
        return _result(invocation, _lines("bash", service.inspect_bashes()))
    if args == "kill-agents":
        return _result(invocation, _lines("subagent", service.cancel_background_subagents()))
    if args.startswith("agents kill "):
        child_session_id = args.removeprefix("agents kill ").strip()
        return _result(
            invocation,
            _lines("subagent", service.cancel_background_subagent(child_session_id)),
        )
    if args == "agents" or args.startswith("agents "):
        requested_child_session_id = args.removeprefix("agents").strip() or None
        return _result(
            invocation,
            _lines("subagent", service.inspect_subagents(requested_child_session_id)),
        )
    return _result(
        invocation,
        ("[subagent] Usage: /tasks [agents [child-session-id]|kill-agents]",),
    )


def _dispatch_agents(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    if args in {"", "list"}:
        return _result(invocation, _lines("agent", service.inspect_subagent_profiles()))
    if args.startswith("inspect "):
        profile_id = args.removeprefix("inspect ").strip()
        return _result(
            invocation,
            _lines("agent", service.inspect_subagent_profile(profile_id)),
        )
    return _result(invocation, ("[agent] Usage: /agents [list|inspect <profile-id>]",))


def _dispatch_memory(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    if args in {"", "list"}:
        values = service.inspect_memory()
    elif args == "path":
        values = service.inspect_memory_path()
    elif args.startswith("search "):
        values = service.search_memory(args.removeprefix("search ").strip())
    elif args.startswith("forget "):
        values = service.forget_memory(args.removeprefix("forget ").strip())
    elif args.startswith("add "):
        values = _add_memory(service, args.removeprefix("add ").strip())
    else:
        values = ("Usage: /memory [list|path|search|add|forget]",)
    return _result(invocation, _lines("memory", values))


def _add_memory(service: TurnService, payload: str) -> tuple[str, ...]:
    if "::" not in payload:
        return ("Usage: /memory add <type> <name> :: <content>",)
    header, content = payload.split("::", 1)
    parts = header.strip().split(maxsplit=1)
    if len(parts) != 2:
        return ("Usage: /memory add <type> <name> :: <content>",)
    return service.add_memory(kind=parts[0], name=parts[1], content=content.strip())


def _dispatch_session_maintenance(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    operations = {
        "": service.inspect_session_maintenance,
        "--apply-empty": service.apply_session_maintenance_empty_cleanup,
        "--apply-orphans": service.apply_session_maintenance_orphan_cleanup,
        "--apply-vacuum": service.apply_session_maintenance_vacuum,
    }
    operation = operations.get(invocation.args)
    values: tuple[str, ...]
    if operation is None:
        values = (
            "Usage: /session maintenance [--apply-empty|--apply-orphans|--apply-vacuum]",
        )
    else:
        values = operation()
    return _result(invocation, _lines("session", values))


def _dispatch_fork(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    parts = shlex.split(invocation.args)
    source_session_id: str | None = None
    new_session_id: str | None = None
    fork_point: int | None = None
    if len(parts) == 1:
        new_session_id = parts[0]
    elif len(parts) >= 2:
        source_session_id = parts[0]
        new_session_id = parts[1]
        if len(parts) >= 3:
            try:
                fork_point = int(parts[2])
            except ValueError:
                return _result(invocation, (f"[session] invalid fork point: {parts[2]}",))
    values = service.fork_session(source_session_id, new_session_id, fork_point)
    return _result(invocation, _lines("session", values), mutated_session=True)


def _dispatch_model(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    try:
        model, thinking_effort = _parse_model_args(invocation.args)
    except ValueError as exc:
        return _result(invocation, (f"[model] {exc}",))
    values = service.set_model_settings(model=model, thinking_effort=thinking_effort)
    return _result(invocation, _lines("model", values), mutated_model=True)


def _parse_model_args(args: str) -> tuple[str | None, str | None]:
    parts = shlex.split(args)
    model: str | None = None
    thinking_effort: str | None = None
    index = 0
    while index < len(parts):
        part = parts[index]
        if part == "--thinking-effort":
            if index + 1 >= len(parts):
                raise ValueError("--thinking-effort requires a value")
            thinking_effort = parts[index + 1]
            index += 2
            continue
        if part.startswith("--thinking-effort="):
            thinking_effort = part.split("=", 1)[1]
            index += 1
            continue
        if part.startswith("--"):
            raise ValueError(f"unsupported option: {part}")
        if model is not None:
            raise ValueError("Usage: /model [model] [--thinking-effort level]")
        model = part
        index += 1
    return model, thinking_effort
