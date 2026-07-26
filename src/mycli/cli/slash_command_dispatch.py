from __future__ import annotations

from dataclasses import dataclass
import shlex

from mycli.application.turn_service import TurnService
from mycli.cli.slash_command_presenters import (
    present_diagnostic,
    present_error,
    present_list,
    present_notice,
    present_preformatted,
    present_status,
)
from mycli.cli.slash_command_registry import (
    ResolvedSlashCommand,
    SlashCommandContext,
    SlashCommandId,
    SlashCommandPresentation,
    SlashCommandSurface,
    slash_command_help,
)
from mycli.cli.slash_command_result import (
    SlashCommandDisplay,
    SlashCommandSeverity,
    render_slash_command_text,
)


@dataclass(frozen=True)
class SlashCommandResult:
    display: SlashCommandDisplay
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

    @property
    def lines(self) -> tuple[str, ...]:
        return render_slash_command_text(self.display)

    def to_payload(self, *, result_id: str | None = None) -> dict[str, object]:
        payload: dict[str, object] = {
            "execution": "backend",
            "display": self.display.to_payload(),
            "lines": list(self.lines),
            "presentation": self.presentation.value,
            "mutated_session": self.mutated_session,
            "mutated_model": self.mutated_model,
            "mutated_mode": self.mutated_mode,
            "exit_requested": self.exit_requested,
        }
        optional: dict[str, object | None] = {
            "result_id": result_id,
            "command_kind": self.command_kind,
            "presentation_hint": self.presentation_hint,
            "view_mode": self.view_mode,
            "collaboration_mode": self.collaboration_mode,
        }
        payload.update({key: value for key, value in optional.items() if value is not None})
        if self.processes:
            payload["processes"] = list(self.processes)
        return payload


def _result(
    invocation: ResolvedSlashCommand,
    display: SlashCommandDisplay,
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
    presentation: SlashCommandPresentation | None = None,
) -> SlashCommandResult:
    return SlashCommandResult(
        display=display,
        presentation=presentation or invocation.presentation,
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
    command = _command_text(invocation)
    if command_id is SlashCommandId.HELP:
        context = SlashCommandContext(surface=SlashCommandSurface.CLI)
        values = tuple(slash_command_help(context).splitlines())
        return _result(
            invocation,
            present_list(
                command=command,
                title="Commands",
                values=values,
                row_prefix="command",
            ),
        )
    if command_id is SlashCommandId.QUIT:
        return _result(
            invocation,
            present_notice(command=command, title="Exit", summary="Bye."),
            exit_requested=True,
        )
    if command_id is SlashCommandId.SKILLS:
        return _result(
            invocation,
            present_list(
                command=command,
                title="Skills",
                values=service.inspect_skills(),
                row_prefix="skill",
            ),
        )
    if command_id is SlashCommandId.TOOLS:
        return _dispatch_tools(service, invocation)
    if command_id is SlashCommandId.PERMISSIONS:
        return _dispatch_permissions(service, invocation)
    if command_id is SlashCommandId.PLAN:
        values = service.set_collaboration_mode("plan")
        return _result(
            invocation,
            _notice(command, "Plan mode", values),
            mutated_mode=True,
            collaboration_mode="plan",
        )
    if command_id is SlashCommandId.MODE:
        values = service.inspect_mode() if not args else service.set_collaboration_mode(args)
        return _result(
            invocation,
            _notice(
                command,
                "Collaboration mode",
                values,
                severity=(
                    SlashCommandSeverity.SUCCESS
                    if args
                    else SlashCommandSeverity.INFO
                ),
            ),
            mutated_mode=bool(args),
            collaboration_mode=args if args in {"default", "plan"} else None,
        )
    if command_id is SlashCommandId.SANDBOX:
        values = service.inspect_sandbox() if not args else service.set_sandbox_mode(args)
        return _result(
            invocation,
            _notice(
                command,
                "Sandbox",
                values,
                severity=(
                    SlashCommandSeverity.SUCCESS
                    if args
                    else SlashCommandSeverity.INFO
                ),
            ),
            mutated_mode=bool(args),
        )
    if command_id is SlashCommandId.PS:
        active = getattr(service, "active_background_shells", None)
        processes = tuple(active()) if callable(active) else ()
        values = service.inspect_bashes()
        return _result(
            invocation,
            present_list(
                command=command,
                title="Background terminals",
                values=values,
                row_prefix="shell",
            ),
            command_kind="background_shells",
            processes=processes,
        )
    if command_id is SlashCommandId.STOP:
        return _result(
            invocation,
            _notice(command, "Background terminals", service.stop_background_shells()),
            command_kind="shell_stop",
        )
    if command_id is SlashCommandId.TASKS:
        return _dispatch_tasks(service, invocation)
    if command_id is SlashCommandId.AGENTS:
        return _dispatch_agents(service, invocation)
    if command_id is SlashCommandId.CHANGES:
        return _result(
            invocation,
            present_list(
                command=command,
                title="File changes",
                values=service.inspect_file_changes(),
                row_prefix="change",
            ),
            presentation_hint="file changes",
        )
    if command_id is SlashCommandId.UNDO:
        return _result(
            invocation,
            present_notice(
                command=command,
                title="Undo complete",
                summary=service.undo_last_file_change(),
            ),
        )
    if command_id is SlashCommandId.MEMORY:
        return _dispatch_memory(service, invocation)
    if command_id is SlashCommandId.RESUME:
        values = service.resume_session(args or None)
        return _result(
            invocation,
            _notice(command, "Session resumed", values),
            mutated_session=True,
        )
    if command_id is SlashCommandId.FORK:
        return _dispatch_fork(service, invocation)
    if command_id is SlashCommandId.SESSION_SEARCH:
        return _result(
            invocation,
            present_list(
                command=command,
                title="Session search",
                values=service.search_sessions(args),
                row_prefix="search",
            ),
        )
    if command_id is SlashCommandId.SESSION_MAINTENANCE:
        return _dispatch_session_maintenance(service, invocation)
    if command_id is SlashCommandId.STATUS:
        return _result(
            invocation,
            present_status(
                command=command,
                values=service.inspect_status(),
                directory=_workspace_directory(service),
            ),
        )
    if command_id is SlashCommandId.STATS:
        return _result(
            invocation,
            present_diagnostic(
                command=command,
                title="Stats",
                values=service.inspect_stats(),
            ),
        )
    if command_id is SlashCommandId.CONTEXT:
        return _result(
            invocation,
            present_diagnostic(
                command=command,
                title="Context",
                values=service.inspect_context(),
            ),
        )
    if command_id is SlashCommandId.COMPACT:
        return _result(
            invocation,
            _notice(command, "Context compacted", service.compact_session()),
            command_kind="compact",
        )
    if command_id is SlashCommandId.USAGE:
        return _result(
            invocation,
            present_diagnostic(
                command=command,
                title="Usage",
                values=service.inspect_usage(),
            ),
        )
    if command_id is SlashCommandId.MODEL:
        return _dispatch_model(service, invocation)
    if command_id is SlashCommandId.VIEW:
        values = service.inspect_view() if not args else service.set_view_mode(args)
        return _result(
            invocation,
            _notice(
                command,
                "Tool visibility",
                values,
                severity=(
                    SlashCommandSeverity.SUCCESS
                    if args
                    else SlashCommandSeverity.INFO
                ),
            ),
            view_mode=args if args in {"default", "verbose", "focus"} else None,
            presentation=SlashCommandPresentation.TRANSCRIPT,
        )
    if command_id is SlashCommandId.TRACE:
        if not args:
            return _result(
                invocation,
                present_list(
                    command=command,
                    title="Trace",
                    values=service.inspect_trace(),
                    row_prefix="trace",
                ),
            )
        if args == "export":
            values = tuple(line for line in service.export_trace_jsonl() if line)
            return _result(
                invocation,
                present_preformatted(
                    command=command,
                    title="Trace export",
                    values=values,
                ),
                presentation=SlashCommandPresentation.TRANSCRIPT,
            )
        if args == "logs":
            return _result(
                invocation,
                present_preformatted(
                    command=command,
                    title="Trace logs",
                    values=service.inspect_logs(),
                ),
            )
        return _result(
            invocation,
            present_error(
                command=command,
                reason="Unsupported trace action",
                usage="/trace [export|logs]",
            ),
        )
    return _result(
        invocation,
        present_error(
            command=command,
            reason=f"Unknown command: {invocation.canonical_name}",
            usage=None,
        ),
    )


def _dispatch_tools(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    command = _command_text(invocation)
    operations = {
        "": ("Tools", "tool", "inspect_tools"),
        "list": ("Tools", "tool", "inspect_tools"),
        "hooks": ("Hooks", "hook", "inspect_hooks"),
        "sets": ("Tool sets", "toolset", "inspect_toolsets"),
        "extensions": ("Extensions", "extension", "inspect_extensions"),
        "plugins": ("Plugins", "plugin", "inspect_plugin_commands"),
    }
    operation = operations.get(args)
    if operation:
        title, row_prefix, inspect_name = operation
        inspect = getattr(service, inspect_name)
        return _result(
            invocation,
            present_list(
                command=command,
                title=title,
                values=inspect(),
                row_prefix=row_prefix,
            ),
        )
    if args.startswith("plugins "):
        plugin_parts = args.removeprefix("plugins ").split(maxsplit=2)
        if len(plugin_parts) < 2:
            return _result(
                invocation,
                present_error(
                    command=command,
                    reason="Plugin ID and command name are required",
                    usage="/tools plugins <plugin-id> <command-name> [json-args]",
                ),
            )
        raw_args = plugin_parts[2] if len(plugin_parts) > 2 else ""
        values = service.run_plugin_command(plugin_parts[0], plugin_parts[1], raw_args)
        return _result(
            invocation,
            present_preformatted(command=command, title="Plugin output", values=values),
            presentation=SlashCommandPresentation.TRANSCRIPT,
        )
    return _result(
        invocation,
        present_error(
            command=command,
            reason="Unsupported tools action",
            usage="/tools [list|sets|hooks|extensions|plugins]",
        ),
    )


def _dispatch_permissions(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    command = _command_text(invocation)
    if not args:
        return _result(
            invocation,
            present_list(
                command=command,
                title="Permissions",
                values=service.inspect_permissions(),
                row_prefix="permission",
            ),
        )
    if args.startswith("allow "):
        values = service.add_permission_allowance(args.removeprefix("allow ").strip())
    elif args.startswith("revoke "):
        values = service.remove_permission_allowance(args.removeprefix("revoke ").strip())
    elif args == "clear":
        values = service.clear_permission_allowances()
    else:
        return _result(
            invocation,
            present_error(
                command=command,
                reason="Unsupported permissions action",
                usage="/permissions [allow <pattern>|revoke <pattern>|clear]",
            ),
        )
    return _result(
        invocation,
        _notice(command, "Permissions updated", values),
        presentation=SlashCommandPresentation.TRANSCRIPT,
    )


def _dispatch_tasks(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    command = _command_text(invocation)
    if not args:
        return _result(
            invocation,
            present_list(
                command=command,
                title="Background terminals",
                values=service.inspect_bashes(),
                row_prefix="shell",
            ),
        )
    if args == "kill-agents":
        return _result(
            invocation,
            _notice(command, "Background agents", service.cancel_background_subagents()),
        )
    if args.startswith("agents kill "):
        child_session_id = args.removeprefix("agents kill ").strip()
        return _result(
            invocation,
            _notice(
                command,
                "Background agent",
                service.cancel_background_subagent(child_session_id),
            ),
        )
    if args == "agents" or args.startswith("agents "):
        requested_child_session_id = args.removeprefix("agents").strip() or None
        return _result(
            invocation,
            present_list(
                command=command,
                title="Background agents",
                values=service.inspect_subagents(requested_child_session_id),
                row_prefix="subagent",
            ),
        )
    return _result(
        invocation,
        present_error(
            command=command,
            reason="Unsupported tasks action",
            usage="/tasks [agents [child-session-id]|kill-agents]",
        ),
    )


def _dispatch_agents(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    command = _command_text(invocation)
    if args in {"", "list"}:
        values = service.inspect_subagent_profiles()
        title = "Agent profiles"
    elif args.startswith("inspect "):
        values = service.inspect_subagent_profile(args.removeprefix("inspect ").strip())
        title = "Agent profile"
    else:
        return _result(
            invocation,
            present_error(
                command=command,
                reason="Unsupported agents action",
                usage="/agents [list|inspect <profile-id>]",
            ),
        )
    return _result(
        invocation,
        present_list(
            command=command,
            title=title,
            values=values,
            row_prefix="agent",
        ),
    )


def _dispatch_memory(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    args = invocation.args
    command = _command_text(invocation)
    mutating = False
    if args in {"", "list"}:
        values = service.inspect_memory()
    elif args == "path":
        values = service.inspect_memory_path()
    elif args.startswith("search "):
        values = service.search_memory(args.removeprefix("search ").strip())
    elif args.startswith("forget "):
        values = service.forget_memory(args.removeprefix("forget ").strip())
        mutating = True
    elif args.startswith("add "):
        values = _add_memory(service, args.removeprefix("add ").strip())
        mutating = True
    else:
        return _result(
            invocation,
            present_error(
                command=command,
                reason="Unsupported memory action",
                usage="/memory [list|path|search|add|forget]",
            ),
        )
    usage = _usage_line(values)
    if usage:
        return _result(
            invocation,
            present_error(
                command=command,
                reason="Invalid memory arguments",
                usage=usage,
            ),
        )
    if mutating:
        return _result(
            invocation,
            _notice(command, "Memory updated", values),
            presentation=SlashCommandPresentation.TRANSCRIPT,
        )
    return _result(
        invocation,
        present_list(
            command=command,
            title="Memory",
            values=values,
            row_prefix="memory",
        ),
    )


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
    command = _command_text(invocation)
    operation = operations.get(invocation.args)
    if operation is None:
        return _result(
            invocation,
            present_error(
                command=command,
                reason="Unsupported session maintenance action",
                usage="/session maintenance [--apply-empty|--apply-orphans|--apply-vacuum]",
            ),
        )
    values = operation()
    if invocation.args:
        return _result(invocation, _notice(command, "Session maintenance", values))
    return _result(
        invocation,
        present_list(
            command=command,
            title="Session maintenance",
            values=values,
            row_prefix="session",
        ),
    )


def _dispatch_fork(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    command = _command_text(invocation)
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
                return _result(
                    invocation,
                    present_error(
                        command=command,
                        reason=f"Invalid fork point: {parts[2]}",
                        usage="/fork [source] [new-session] [message-index]",
                    ),
                )
    values = service.fork_session(source_session_id, new_session_id, fork_point)
    return _result(
        invocation,
        _notice(command, "Session forked", values),
        mutated_session=True,
    )


def _dispatch_model(
    service: TurnService,
    invocation: ResolvedSlashCommand,
) -> SlashCommandResult:
    command = _command_text(invocation)
    try:
        model, thinking_effort = _parse_model_args(invocation.args)
    except ValueError as exc:
        return _result(
            invocation,
            present_error(
                command=command,
                reason=str(exc).removeprefix("Usage: "),
                usage="/model [model] [--thinking-effort level]",
            ),
        )
    values = service.set_model_settings(model=model, thinking_effort=thinking_effort)
    return _result(
        invocation,
        _notice(command, "Model updated", values),
        mutated_model=True,
    )


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
            raise ValueError("only one model may be selected")
        model = part
        index += 1
    return model, thinking_effort


def _notice(
    command: str,
    title: str,
    values: tuple[str, ...],
    *,
    severity: SlashCommandSeverity = SlashCommandSeverity.SUCCESS,
) -> SlashCommandDisplay:
    summary = "; ".join(value for value in values if value) or title
    return present_notice(
        command=command,
        title=title,
        summary=summary,
        severity=severity,
    )


def _usage_line(values: tuple[str, ...]) -> str | None:
    for value in values:
        if value.startswith("Usage: "):
            return value.removeprefix("Usage: ")
    return None


def _command_text(invocation: ResolvedSlashCommand) -> str:
    return " ".join(
        part for part in (invocation.canonical_name, invocation.args) if part
    )


def _workspace_directory(service: TurnService) -> str | None:
    config = getattr(service, "_config", None)
    workspace_root = getattr(config, "workspace_root", None)
    return str(workspace_root) if workspace_root is not None else None


__all__ = ["SlashCommandResult", "dispatch_backend_slash_command"]
