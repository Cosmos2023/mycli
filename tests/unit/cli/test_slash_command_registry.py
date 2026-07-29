from __future__ import annotations

import pytest

from mycli.cli.slash_command_registry import (
    SlashCommandContext,
    SlashCommandError,
    SlashCommandId,
    SlashCommandOwner,
    SlashCommandPresentation,
    SlashCommandSurface,
    command_manifest,
    resolve_slash_command,
    slash_command_suggestions,
    slash_command_help,
    validate_slash_command_registry,
)


VISIBLE_TUI_NAMES = (
    "/model",
    "/plan",
    "/permissions",
    "/new",
    "/resume",
    "/fork",
    "/status",
    "/usage",
    "/compact",
    "/skills",
    "/tools",
    "/tasks",
    "/ps",
    "/changes",
    "/help",
    "/quit",
)


HIDDEN_COMPATIBILITY_COMMANDS = (
    ("/mode", SlashCommandId.MODE),
    ("/sandbox", SlashCommandId.SANDBOX),
    ("/settings", SlashCommandId.SETTINGS),
    ("/context", SlashCommandId.CONTEXT),
    ("/stats", SlashCommandId.STATS),
    ("/resources", SlashCommandId.RESOURCES),
    ("/memory", SlashCommandId.MEMORY),
    ("/agents", SlashCommandId.AGENTS),
    ("/stop", SlashCommandId.STOP),
    ("/undo", SlashCommandId.UNDO),
    ("/trace", SlashCommandId.TRACE),
    ("/details", SlashCommandId.DETAILS),
    ("/view", SlashCommandId.VIEW),
    ("/hotkeys", SlashCommandId.HOTKEYS),
    ("/copy", SlashCommandId.COPY),
    ("/clear", SlashCommandId.CLEAR),
    ("/login", SlashCommandId.LOGIN),
    ("/trust", SlashCommandId.TRUST),
)


def tui_context(*, turn_running: bool = False) -> SlashCommandContext:
    return SlashCommandContext(
        surface=SlashCommandSurface.TUI,
        turn_running=turn_running,
    )


def cli_context() -> SlashCommandContext:
    return SlashCommandContext(surface=SlashCommandSurface.CLI)


def test_tui_manifest_has_one_ordered_canonical_command_surface() -> None:
    manifest = command_manifest(tui_context())

    assert tuple(item.name for item in manifest) == VISIBLE_TUI_NAMES
    assert all(item.description for item in manifest)
    assert len({item.id for item in manifest}) == len(manifest)
    assert "/status usage" not in VISIBLE_TUI_NAMES
    assert "/tasks bashes" not in VISIBLE_TUI_NAMES
    assert "/theme" not in VISIBLE_TUI_NAMES
    assert "/mark" not in VISIBLE_TUI_NAMES
    assert "/release-notes" not in VISIBLE_TUI_NAMES


@pytest.mark.parametrize(("raw", "command_id"), HIDDEN_COMPATIBILITY_COMMANDS)
def test_hidden_commands_remain_parseable_compatibility_routes(
    raw: str,
    command_id: SlashCommandId,
) -> None:
    resolved = resolve_slash_command(raw, tui_context())

    assert resolved.command_id is command_id
    assert raw not in tuple(item.name for item in command_manifest(tui_context()))


@pytest.mark.parametrize(
    ("raw", "command_id", "args"),
    (
        ("/status usage", SlashCommandId.USAGE, ""),
        ("/status context", SlashCommandId.CONTEXT, ""),
        ("/status stats", SlashCommandId.STATS, ""),
        ("/tools skills", SlashCommandId.SKILLS, ""),
        ("/tools permissions", SlashCommandId.PERMISSIONS, ""),
        ("/tasks bashes", SlashCommandId.PS, ""),
        ("/jobs bashes", SlashCommandId.PS, ""),
        ("/changes undo", SlashCommandId.UNDO, ""),
        ("/session", SlashCommandId.RESUME, ""),
        ("/session show", SlashCommandId.STATUS, ""),
        ("/session resume saved", SlashCommandId.RESUME, "saved"),
        ("/session fork old new 7", SlashCommandId.FORK, "old new 7"),
        ("/subagents child-1", SlashCommandId.TASKS, "agents child-1"),
        ("/trace-jsonl", SlashCommandId.TRACE, "export"),
    ),
)
def test_aliases_resolve_by_longest_prefix(
    raw: str,
    command_id: SlashCommandId,
    args: str,
) -> None:
    resolved = resolve_slash_command(raw, tui_context())

    assert resolved.command_id is command_id
    assert resolved.args == args


def test_hidden_legacy_routes_preserve_session_operations() -> None:
    search = resolve_slash_command("/session search cache hits", cli_context())
    maintenance = resolve_slash_command(
        "/session maintenance --apply-empty",
        cli_context(),
    )

    assert search.command_id is SlashCommandId.SESSION_SEARCH
    assert search.args == "cache hits"
    assert maintenance.command_id is SlashCommandId.SESSION_MAINTENANCE
    assert maintenance.args == "--apply-empty"
    assert all(item.id not in {"session_search", "session_maintenance"} for item in command_manifest(cli_context()))


def test_surface_policy_selects_tui_bare_and_backend_inline_owner() -> None:
    bare = resolve_slash_command("/model", tui_context())
    inline = resolve_slash_command("/model gpt-5", tui_context())
    cli_bare = resolve_slash_command("/model", cli_context())

    assert bare.owner is SlashCommandOwner.TUI
    assert bare.client_action == "open_model_selector"
    assert inline.owner is SlashCommandOwner.BACKEND
    assert inline.client_action is None
    assert inline.args == "gpt-5"
    assert cli_bare.owner is SlashCommandOwner.BACKEND


def test_permissions_use_tui_selector_but_keep_inline_backend_commands() -> None:
    bare = resolve_slash_command("/permissions", tui_context(turn_running=True))
    inline = resolve_slash_command(
        "/permissions allow git status",
        tui_context(turn_running=True),
    )

    assert bare.owner is SlashCommandOwner.TUI
    assert bare.client_action == "open_permissions"
    assert inline.owner is SlashCommandOwner.BACKEND
    assert inline.args == "allow git status"


def test_cli_manifest_hides_tui_only_commands() -> None:
    names = tuple(item.name for item in command_manifest(cli_context()))

    assert "/settings" not in names
    assert "/details" not in names
    assert "/hotkeys" not in names
    assert "/copy" not in names
    assert "/login" not in names
    assert "/trust" not in names
    assert "/usage" in names


def test_turn_policy_recognizes_but_rejects_unavailable_command() -> None:
    with pytest.raises(SlashCommandError) as caught:
        resolve_slash_command("/resume", tui_context(turn_running=True))

    assert caught.value.code == "unavailable_during_turn"
    assert "disabled while a task is in progress" in str(caught.value)


def test_compact_is_backend_owned_and_unavailable_during_turn() -> None:
    resolved = resolve_slash_command("/compact", tui_context())

    assert resolved.command_id is SlashCommandId.COMPACT
    assert resolved.owner is SlashCommandOwner.BACKEND

    with pytest.raises(SlashCommandError) as caught:
        resolve_slash_command("/compact", tui_context(turn_running=True))

    assert caught.value.code == "unavailable_during_turn"


def test_argument_policy_rejects_extra_text() -> None:
    with pytest.raises(SlashCommandError) as caught:
        resolve_slash_command("/usage now", tui_context())

    assert caught.value.code == "invalid_arguments"
    assert str(caught.value) == "Usage: /usage"


def test_unknown_command_is_a_registry_error() -> None:
    with pytest.raises(SlashCommandError) as caught:
        resolve_slash_command("/does-not-exist", tui_context())

    assert caught.value.code == "unknown_command"
    assert str(caught.value) == "Unknown command: /does-not-exist"


def test_help_uses_canonical_names_without_aliases() -> None:
    help_text = slash_command_help(cli_context())

    assert "/usage" in help_text
    assert "/status usage" not in help_text
    assert "/settings" not in help_text
    assert "Aliases:" not in help_text


def test_slash_command_suggestions_use_visible_canonical_names() -> None:
    assert slash_command_suggestions("/memroy", cli_context()) == ()
    assert "/status usage" not in slash_command_suggestions("/usag", cli_context())


def test_command_presentations_separate_reports_overlays_and_actions() -> None:
    for command in ("/status", "/usage", "/context", "/stats", "/ps", "/changes", "/undo"):
        assert (
            resolve_slash_command(command, cli_context()).presentation
            is SlashCommandPresentation.TRANSCRIPT
        )

    for command in ("/skills", "/tools", "/permissions", "/memory", "/agents", "/trace"):
        assert (
            resolve_slash_command(command, cli_context()).presentation
            is SlashCommandPresentation.OVERLAY
        )

    for command in ("/plan", "/mode plan", "/sandbox next", "/stop", "/quit"):
        assert (
            resolve_slash_command(command, cli_context()).presentation
            is SlashCommandPresentation.NONE
        )


def test_registry_integrity_passes() -> None:
    validate_slash_command_registry()
