from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from mycli.cli.slash_command_dispatch import dispatch_backend_slash_command
from mycli.cli.slash_command_registry import (
    SlashCommandContext,
    SlashCommandPresentation,
    SlashCommandSurface,
    resolve_slash_command,
)


def resolve_cli(text: str):
    return resolve_slash_command(
        text,
        SlashCommandContext(surface=SlashCommandSurface.CLI),
    )


def fake_service() -> Any:
    return SimpleNamespace(
        inspect_usage=lambda: ("session=demo",),
        inspect_bashes=lambda: ("shell-1 running",),
        active_background_shells=lambda: (
            {"shell_id": "shell-1", "status": "running", "background": True},
        ),
        stop_background_shells=lambda: ("Stopping all background terminals.",),
        undo_last_file_change=lambda: "restored",
    )


def test_short_canonical_commands_and_hidden_aliases_share_handlers() -> None:
    service = fake_service()

    usage = dispatch_backend_slash_command(service, resolve_cli("/usage"))
    legacy_usage = dispatch_backend_slash_command(service, resolve_cli("/status usage"))

    assert usage.lines == legacy_usage.lines == ("[usage] session=demo",)
    assert usage.presentation is SlashCommandPresentation.OVERLAY


def test_ps_returns_structured_background_shells() -> None:
    result = dispatch_backend_slash_command(fake_service(), resolve_cli("/ps"))

    assert result.lines == ("[bash] shell-1 running",)
    assert result.command_kind == "background_shells"
    assert result.processes == (
        {"shell_id": "shell-1", "status": "running", "background": True},
    )


def test_stop_and_undo_are_canonical_backend_commands() -> None:
    service = fake_service()

    stopped = dispatch_backend_slash_command(service, resolve_cli("/stop"))
    undone = dispatch_backend_slash_command(service, resolve_cli("/changes undo"))

    assert stopped.lines == ("[bash] Stopping all background terminals.",)
    assert stopped.command_kind == "shell_stop"
    assert undone.lines == ("[undo] restored",)


def test_result_payload_omits_unused_optional_fields() -> None:
    payload = dispatch_backend_slash_command(fake_service(), resolve_cli("/usage")).to_payload()

    assert payload == {
        "execution": "backend",
        "lines": ["[usage] session=demo"],
        "presentation": "overlay",
        "mutated_session": False,
        "mutated_model": False,
        "mutated_mode": False,
        "exit_requested": False,
    }
