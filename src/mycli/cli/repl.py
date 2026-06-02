from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from mycli.application.turn_service import TurnService


def handle_slash_command(command: str) -> str:
    if command == "/help":
        return "\n".join(
            [
                "/help",
                "/skill",
                "/skills",
                "/memory",
                "/plan",
                "/subagents",
                "/trace",
                "/trace-jsonl",
                "/logs",
                "/tools",
                "/hooks",
                "/plugin",
                "/toolsets",
                "/bashes",
                "/changes",
                "/undo",
                "/extensions",
                "/resume <session>",
                "/fork [source] <new-session> [message-index]",
                "/status",
                "/view [default|verbose|focus]",
                "/stats",
                "/context",
                "/usage",
                "/session",
                "/sessions",
                "/session-maintenance",
                "/session-maintenance --apply-empty",
                "/session-maintenance --apply-orphans",
                "/session-maintenance --apply-vacuum",
                "/search <query>",
                "/quit",
            ]
        )
    if command == "/quit":
        return "quit"
    return f"Unknown command: {command}"


def build_command_handler(
    service: TurnService,
) -> Callable[[str], Iterable[str]]:
    def handle(command: str) -> Iterable[str]:
        if command in {"/skill", "/skills"}:
            return [f"[skill] {line}" for line in service.inspect_skills()]
        if command == "/tools":
            return [f"[tool] {line}" for line in service.inspect_tools()]
        if command == "/hooks":
            return [f"[hook] {line}" for line in service.inspect_hooks()]
        if command == "/toolsets":
            return [f"[toolset] {line}" for line in service.inspect_toolsets()]
        if command == "/bashes":
            return [f"[bash] {line}" for line in service.inspect_bashes()]
        if command == "/changes":
            return [f"[change] {line}" for line in service.inspect_file_changes()]
        if command == "/memory":
            return [f"[memory] {line}" for line in service.inspect_memory()]
        if command == "/extensions":
            return [f"[extension] {line}" for line in service.inspect_extensions()]
        if command == "/plugin":
            return [f"[plugin] {line}" for line in service.inspect_plugin_commands()]
        if command.startswith("/plugin "):
            parts = command.split(maxsplit=3)
            if len(parts) < 3:
                return ["[plugin] usage: /plugin <plugin_id> <command_name> [json-args]"]
            raw_args = parts[3] if len(parts) > 3 else ""
            return [
                f"[plugin] {line}"
                for line in service.run_plugin_command(parts[1], parts[2], raw_args)
            ]
        if command == "/plan":
            return [f"[plan] {line}" for line in service.inspect_plan()]
        if command.startswith("/subagents"):
            parts = command.split(maxsplit=1)
            child_session_id = parts[1] if len(parts) > 1 else None
            return [f"[subagent] {line}" for line in service.inspect_subagents(child_session_id)]
        if command == "/session":
            return [f"[session] {line}" for line in service.inspect_session()]
        if command == "/sessions":
            return [f"[session] {line}" for line in service.inspect_sessions()]
        if command == "/session-maintenance":
            return [f"[session] {line}" for line in service.inspect_session_maintenance()]
        if command == "/session-maintenance --apply-empty":
            return [
                f"[session] {line}"
                for line in service.apply_session_maintenance_empty_cleanup()
            ]
        if command == "/session-maintenance --apply-orphans":
            return [
                f"[session] {line}"
                for line in service.apply_session_maintenance_orphan_cleanup()
            ]
        if command == "/session-maintenance --apply-vacuum":
            return [
                f"[session] {line}"
                for line in service.apply_session_maintenance_vacuum()
            ]
        if command.startswith("/search"):
            parts = command.split(maxsplit=1)
            query = parts[1] if len(parts) > 1 else ""
            return [f"[search] {line}" for line in service.search_sessions(query)]
        if command == "/status":
            return [f"[status] {line}" for line in service.inspect_status()]
        if command.startswith("/view"):
            parts = command.split(maxsplit=1)
            if len(parts) == 1:
                return [f"[view] {line}" for line in service.inspect_view()]
            return [f"[view] {line}" for line in service.set_view_mode(parts[1])]
        if command == "/stats":
            return [f"[stats] {line}" for line in service.inspect_stats()]
        if command == "/context":
            return [f"[context] {line}" for line in service.inspect_context()]
        if command == "/usage":
            return [f"[usage] {line}" for line in service.inspect_usage()]
        if command.startswith("/resume"):
            parts = command.split()
            session_id = parts[1] if len(parts) > 1 else None
            return [f"[session] {line}" for line in service.resume_session(session_id)]
        if command.startswith("/fork"):
            parts = command.split()
            source_session_id: str | None = None
            new_session_id: str | None = None
            fork_point: int | None = None
            if len(parts) == 2:
                new_session_id = parts[1]
            elif len(parts) >= 3:
                source_session_id = parts[1]
                new_session_id = parts[2]
                if len(parts) >= 4:
                    try:
                        fork_point = int(parts[3])
                    except ValueError:
                        return [f"[session] invalid fork point: {parts[3]}"]
            return [
                f"[session] {line}"
                for line in service.fork_session(source_session_id, new_session_id, fork_point)
            ]
        if command == "/trace":
            return [f"[trace] {line}" for line in service.inspect_trace()]
        if command == "/trace-jsonl":
            return [f"[trace-jsonl] {line}" for line in service.export_trace_jsonl() if line]
        if command == "/logs":
            return [f"[log] {line}" for line in service.inspect_logs()]
        if command == "/undo":
            return [f"[undo] {service.undo_last_file_change()}"]
        return [f"Unknown command: {command}"]

    return handle


def run_repl(
    turn_handler: Callable[[str], str | Iterable[str]],
    input_func: Callable[[str], str] = input,
    output_func: Callable[[str], Any] = print,
    session_id: str = "default",
    decision_handler: Callable[[str], Iterable[str]] | None = None,
    pending_decision_provider: Callable[[], bool] | None = None,
    command_handler: Callable[[str], Iterable[str]] | None = None,
    statusline_provider: Callable[[], Iterable[str]] | None = None,
) -> None:
    while True:
        try:
            if statusline_provider is not None:
                for line in statusline_provider():
                    output_func(f"[status] {line}")
            raw = input_func("> ").strip()
        except (EOFError, KeyboardInterrupt):
            output_func("Bye.")
            return
        if not raw:
            continue
        if raw.startswith("/"):
            handled = handle_slash_command(raw)
            if handled == "quit":
                output_func("Bye.")
                return
            if handled.startswith("Unknown command:") and command_handler is not None:
                for line in command_handler(raw):
                    output_func(line)
            else:
                output_func(handled)
            continue
        if pending_decision_provider is not None and pending_decision_provider():
            if raw in {"1", "2", "3"} and decision_handler is not None:
                for line in decision_handler(raw):
                    output_func(line)
            else:
                output_func("There is a pending risky action. Choose one of the available options.")
            continue
        rendered = turn_handler(raw)
        if isinstance(rendered, str):
            output_func(rendered)
            continue
        for line in rendered:
            output_func(line)
