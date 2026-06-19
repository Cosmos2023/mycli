from __future__ import annotations

from collections.abc import Callable, Iterable
import shlex
from typing import Any

from mycli.application.turn_service import TurnService


def handle_slash_command(command: str) -> str:
    if command == "/help":
        return "\n".join(
            [
                "/help",
                "/skills",
                "/memory [list|path|search|add|forget]",
                "/plan",
                "/mode [default|plan]",
                "/status [usage|context|stats]",
                "/session [show|list|resume|fork|search|maintenance]",
                "/tools [list|sets|permissions|hooks|extensions|plugins|skills]",
                "/agents [list|inspect <profile_id>|runs [child_session_id]|kill]",
                "/tasks [agents [child_session_id]|agents kill <child_session_id>|bashes|kill-agents]",
                "/changes [undo]",
                "/trace [export|logs]",
                "/extensions",
                "/model <model> [--thinking-effort low|medium|high|xhigh]",
                "/view [default|verbose|focus]",
                "/quit",
                "Aliases: /skill, /usage, /context, /stats, /sessions, /resume, /fork, /search, /session-maintenance, /permissions, /hooks, /toolsets, /jobs, /bashes, /subagents, /trace-jsonl, /logs, /undo",
            ]
        )
    if command == "/quit":
        return "quit"
    return f"Unknown command: {command}"


def build_command_handler(
    service: TurnService,
) -> Callable[[str], Iterable[str]]:
    def handle(command: str) -> Iterable[str]:
        command = canonical_slash_command(command)
        if command == "/skills":
            return [f"[skill] {line}" for line in service.inspect_skills()]
        if command in {"/tools", "/tools list"}:
            return [f"[tool] {line}" for line in service.inspect_tools()]
        if command == "/tools permissions":
            return [f"[permission] {line}" for line in service.inspect_permissions()]
        if command == "/tools hooks":
            return [f"[hook] {line}" for line in service.inspect_hooks()]
        if command == "/tools sets":
            return [f"[toolset] {line}" for line in service.inspect_toolsets()]
        if command in {"/tasks", "/tasks bashes"}:
            return [f"[bash] {line}" for line in service.inspect_bashes()]
        if command in {"/tasks agents", "/agents runs"}:
            return [f"[subagent] {line}" for line in service.inspect_subagents()]
        if command == "/changes":
            return [f"[change] {line}" for line in service.inspect_file_changes()]
        if command == "/memory" or command == "/memory list":
            return [f"[memory] {line}" for line in service.inspect_memory()]
        if command == "/memory path":
            return [f"[memory] {line}" for line in service.inspect_memory_path()]
        if command.startswith("/memory search "):
            query = command.split(maxsplit=2)[2]
            return [f"[memory] {line}" for line in service.search_memory(query)]
        if command.startswith("/memory forget "):
            query = command.split(maxsplit=2)[2]
            return [f"[memory] {line}" for line in service.forget_memory(query)]
        if command.startswith("/memory add "):
            return [f"[memory] {line}" for line in _handle_memory_add(service, command)]
        if command == "/tools extensions":
            return [f"[extension] {line}" for line in service.inspect_extensions()]
        if command == "/tools skills":
            return [f"[skill] {line}" for line in service.inspect_skills()]
        if command == "/tools plugins":
            return [f"[plugin] {line}" for line in service.inspect_plugin_commands()]
        if command.startswith("/tools plugins "):
            payload = command.removeprefix("/tools plugins ").strip()
            plugin_parts = payload.split(maxsplit=2)
            if len(plugin_parts) < 2:
                return ["[plugin] usage: /tools plugins <plugin_id> <command_name> [json-args]"]
            json_args = plugin_parts[2] if len(plugin_parts) > 2 else ""
            return [
                f"[plugin] {line}"
                for line in service.run_plugin_command(plugin_parts[0], plugin_parts[1], json_args)
            ]
        if command == "/plan":
            mode_lines = service.set_collaboration_mode("plan")
            plan_lines = service.inspect_plan()
            return [
                *(f"[mode] {line}" for line in mode_lines),
                *(f"[plan] {line}" for line in plan_lines),
            ]
        if command == "/mode" or command.startswith("/mode "):
            parts = command.split(maxsplit=1)
            if len(parts) == 1:
                return [f"[mode] {line}" for line in service.inspect_mode()]
            return [f"[mode] {line}" for line in service.set_collaboration_mode(parts[1])]
        if command in {"/tasks kill-agents", "/agents kill"}:
            return [f"[subagent] {line}" for line in service.cancel_background_subagents()]
        if command.startswith("/tasks agents kill "):
            child_session_id = command.removeprefix("/tasks agents kill ").strip()
            return [f"[subagent] {line}" for line in service.cancel_background_subagent(child_session_id)]
        if command.startswith("/tasks agents"):
            child_session_id = command.removeprefix("/tasks agents").strip() or None
            return [f"[subagent] {line}" for line in service.inspect_subagents(child_session_id)]
        if command.startswith("/agents runs"):
            child_session_id = command.removeprefix("/agents runs").strip() or None
            return [f"[subagent] {line}" for line in service.inspect_subagents(child_session_id)]
        if command in {"/agents", "/agents list"}:
            return [f"[agent] {line}" for line in service.inspect_subagent_profiles()]
        if command.startswith("/agents inspect "):
            profile_id = command.removeprefix("/agents inspect ").strip()
            return [f"[agent] {line}" for line in service.inspect_subagent_profile(profile_id)]
        if command in {"/session", "/session show"}:
            return [f"[session] {line}" for line in service.inspect_session()]
        if command == "/session list":
            return [f"[session] {line}" for line in service.inspect_sessions()]
        if command == "/session maintenance":
            return [f"[session] {line}" for line in service.inspect_session_maintenance()]
        if command == "/session maintenance --apply-empty":
            return [
                f"[session] {line}"
                for line in service.apply_session_maintenance_empty_cleanup()
            ]
        if command == "/session maintenance --apply-orphans":
            return [
                f"[session] {line}"
                for line in service.apply_session_maintenance_orphan_cleanup()
            ]
        if command == "/session maintenance --apply-vacuum":
            return [
                f"[session] {line}"
                for line in service.apply_session_maintenance_vacuum()
            ]
        if command.startswith("/session search"):
            query = command.removeprefix("/session search").strip()
            return [f"[search] {line}" for line in service.search_sessions(query)]
        if command == "/status":
            return [f"[status] {line}" for line in service.inspect_status()]
        if command == "/status stats":
            return [f"[stats] {line}" for line in service.inspect_stats()]
        if command == "/status context":
            return [f"[context] {line}" for line in service.inspect_context()]
        if command == "/status usage":
            return [f"[usage] {line}" for line in service.inspect_usage()]
        if command == "/model" or command.startswith("/model "):
            try:
                model, thinking_effort = _parse_model_command(command)
            except ValueError as exc:
                return [f"[model] {exc}"]
            setter = getattr(service, "set_model_settings", None)
            if not callable(setter):
                return ["[model] runtime model switching is not available"]
            return [
                f"[model] {line}"
                for line in setter(model=model, thinking_effort=thinking_effort)
            ]
        if command.startswith("/view"):
            parts = command.split(maxsplit=1)
            if len(parts) == 1:
                return [f"[view] {line}" for line in service.inspect_view()]
            return [f"[view] {line}" for line in service.set_view_mode(parts[1])]
        if command.startswith("/session resume"):
            session_id = command.removeprefix("/session resume").strip() or None
            return [f"[session] {line}" for line in service.resume_session(session_id)]
        if command.startswith("/session fork"):
            parts = command.split()
            source_session_id: str | None = None
            new_session_id: str | None = None
            fork_point: int | None = None
            fork_args = parts[2:]
            if len(fork_args) == 1:
                new_session_id = fork_args[0]
            elif len(fork_args) >= 2:
                source_session_id = fork_args[0]
                new_session_id = fork_args[1]
                if len(fork_args) >= 3:
                    try:
                        fork_point = int(fork_args[2])
                    except ValueError:
                        return [f"[session] invalid fork point: {fork_args[2]}"]
            return [
                f"[session] {line}"
                for line in service.fork_session(source_session_id, new_session_id, fork_point)
            ]
        if command == "/trace":
            return [f"[trace] {line}" for line in service.inspect_trace()]
        if command == "/trace export":
            return [f"[trace-jsonl] {line}" for line in service.export_trace_jsonl() if line]
        if command == "/trace logs":
            return [f"[log] {line}" for line in service.inspect_logs()]
        if command == "/changes undo":
            return [f"[undo] {service.undo_last_file_change()}"]
        return [f"Unknown command: {command}"]

    return handle


def canonical_slash_command(command: str) -> str:
    normalized = command.strip()
    exact_aliases = {
        "/skill": "/skills",
        "/usage": "/status usage",
        "/context": "/status context",
        "/stats": "/status stats",
        "/sessions": "/session list",
        "/session-maintenance": "/session maintenance",
        "/session-maintenance --apply-empty": "/session maintenance --apply-empty",
        "/session-maintenance --apply-orphans": "/session maintenance --apply-orphans",
        "/session-maintenance --apply-vacuum": "/session maintenance --apply-vacuum",
        "/permissions": "/tools permissions",
        "/hooks": "/tools hooks",
        "/toolsets": "/tools sets",
        "/extensions": "/tools extensions",
        "/plugin": "/tools plugins",
        "/jobs": "/tasks",
        "/jobs bashes": "/tasks bashes",
        "/jobs subagents": "/tasks agents",
        "/jobs kill-subagents": "/tasks kill-agents",
        "/bashes": "/tasks bashes",
        "/subagents": "/tasks agents",
        "/trace-jsonl": "/trace export",
        "/logs": "/trace logs",
        "/undo": "/changes undo",
    }
    if normalized in exact_aliases:
        return exact_aliases[normalized]
    prefix_aliases = (
        ("/resume ", "/session resume "),
        ("/fork ", "/session fork "),
        ("/search ", "/session search "),
        ("/session-maintenance ", "/session maintenance "),
        ("/plugin ", "/tools plugins "),
        ("/jobs subagents ", "/tasks agents "),
        ("/subagents ", "/tasks agents "),
    )
    for old_prefix, new_prefix in prefix_aliases:
        if normalized.startswith(old_prefix):
            return new_prefix + normalized.removeprefix(old_prefix)
    return normalized


def _handle_memory_add(service: TurnService, command: str) -> Iterable[str]:
    payload = command.removeprefix("/memory add ").strip()
    if "::" not in payload:
        return ("usage: /memory add <type> <name> :: <content>",)
    header, content = payload.split("::", 1)
    parts = header.strip().split(maxsplit=1)
    if len(parts) != 2:
        return ("usage: /memory add <type> <name> :: <content>",)
    return service.add_memory(
        kind=parts[0],
        name=parts[1],
        content=content.strip(),
    )


def _parse_model_command(command: str) -> tuple[str | None, str | None]:
    parts = shlex.split(command)
    if len(parts) == 1:
        return None, None
    if parts[0] != "/model":
        raise ValueError("usage: /model <model> [--thinking-effort low|medium|high|xhigh]")
    model: str | None = None
    thinking_effort: str | None = None
    index = 1
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
            raise ValueError("usage: /model <model> [--thinking-effort low|medium|high|xhigh]")
        model = part
        index += 1
    return model, thinking_effort


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
    del session_id  # Kept for the existing CLI embedding contract.
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
