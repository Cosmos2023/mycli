from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from mycli.application.turn_service import TurnService
from mycli.cli.slash_command_dispatch import dispatch_backend_slash_command
from mycli.cli.slash_command_presenters import present_error
from mycli.cli.slash_command_registry import (
    SlashCommandContext,
    SlashCommandError,
    SlashCommandId,
    SlashCommandOwner,
    SlashCommandSurface,
    resolve_slash_command,
    slash_command_help,
    slash_command_suggestions,
)
from mycli.cli.slash_command_result import render_slash_command_text


def handle_slash_command(command: str) -> str:
    context = SlashCommandContext(surface=SlashCommandSurface.CLI)
    try:
        invocation = resolve_slash_command(command, context)
    except SlashCommandError as exc:
        return str(exc)
    if invocation.command_id is SlashCommandId.HELP:
        return slash_command_help(context)
    if invocation.command_id is SlashCommandId.QUIT:
        return "quit"
    return f"Unknown command: {command}"


def build_command_handler(
    service: TurnService,
) -> Callable[[str], Iterable[str]]:
    def handle(command: str) -> Iterable[str]:
        context = SlashCommandContext(surface=SlashCommandSurface.CLI)
        try:
            invocation = resolve_slash_command(command, context)
        except SlashCommandError as exc:
            return render_slash_command_text(
                present_error(
                    command=command,
                    reason=str(exc),
                    usage=(
                        str(exc).removeprefix("Usage: ")
                        if exc.code == "invalid_arguments"
                        else None
                    ),
                    suggestions=slash_command_suggestions(command, context),
                )
            )
        if invocation.owner is not SlashCommandOwner.BACKEND:
            return (f"{invocation.canonical_name} is unavailable on this interface.",)
        return dispatch_backend_slash_command(service, invocation).lines

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
