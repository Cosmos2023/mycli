from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from mycli.cli.slash_command_dispatch import dispatch_backend_slash_command
from mycli.cli.slash_command_result import render_slash_command_text
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
        inspect_status=lambda: (
            "session=demo model=gpt-test provider=test context=unknown pending=no suspended=no",
        ),
        inspect_tools=lambda: ("Read source=builtin toolset=file",),
        inspect_logs=lambda: ("gateway ready",),
        inspect_bashes=lambda: ("shell-1 running",),
        active_background_shells=lambda: (
            {"shell_id": "shell-1", "status": "running", "background": True},
        ),
        stop_background_shells=lambda: ("Stopping all background terminals.",),
        undo_last_file_change=lambda: "restored",
    )


def test_short_canonical_commands_and_hidden_aliases_share_display() -> None:
    service = fake_service()

    usage = dispatch_backend_slash_command(service, resolve_cli("/usage"))
    legacy_usage = dispatch_backend_slash_command(service, resolve_cli("/status usage"))

    assert usage.display == legacy_usage.display
    assert usage.display.kind.value == "diagnostic"
    assert usage.lines == legacy_usage.lines == render_slash_command_text(usage.display)
    assert usage.presentation is SlashCommandPresentation.TRANSCRIPT


def test_ps_returns_structured_background_shells() -> None:
    result = dispatch_backend_slash_command(fake_service(), resolve_cli("/ps"))

    assert result.display.kind.value == "list"
    assert result.lines == render_slash_command_text(result.display)
    assert result.command_kind == "background_shells"
    assert result.processes == (
        {"shell_id": "shell-1", "status": "running", "background": True},
    )


def test_stop_and_undo_are_canonical_backend_commands() -> None:
    service = fake_service()

    stopped = dispatch_backend_slash_command(service, resolve_cli("/stop"))
    undone = dispatch_backend_slash_command(service, resolve_cli("/changes undo"))

    assert stopped.display.kind.value == "notice"
    assert stopped.lines == ("Stopping all background terminals.",)
    assert stopped.command_kind == "shell_stop"
    assert undone.display.kind.value == "notice"
    assert undone.lines == ("restored",)


def test_backend_commands_cover_every_result_family() -> None:
    service = fake_service()

    status = dispatch_backend_slash_command(service, resolve_cli("/status"))
    tools = dispatch_backend_slash_command(service, resolve_cli("/tools"))
    undo = dispatch_backend_slash_command(service, resolve_cli("/undo"))
    logs = dispatch_backend_slash_command(service, resolve_cli("/trace logs"))

    assert status.display.kind.value == "status"
    assert tools.display.kind.value == "list"
    assert undo.display.kind.value == "notice"
    assert logs.display.kind.value == "preformatted"


def test_result_payload_omits_unused_optional_fields() -> None:
    payload = dispatch_backend_slash_command(fake_service(), resolve_cli("/usage")).to_payload()

    assert payload["execution"] == "backend"
    assert payload["display"] == {
        "version": 1,
        "kind": "diagnostic",
        "command": "/usage",
        "title": "Usage",
        "severity": "info",
        "fields": [{"label": "Session", "value": "demo"}],
    }
    assert payload["lines"] == ["Usage", "Session: demo"]
    assert payload["presentation"] == "transcript"
    assert payload["mutated_session"] is False
    assert payload["mutated_model"] is False
    assert payload["mutated_mode"] is False
    assert payload["exit_requested"] is False
