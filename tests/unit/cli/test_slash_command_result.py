from __future__ import annotations

import pytest

from mycli.cli.slash_command_result import (
    MAX_ROWS,
    SlashCommandDisplay,
    SlashCommandDisplayKind,
    SlashCommandField,
    SlashCommandRow,
    SlashCommandSection,
    SlashCommandSeverity,
    render_slash_command_text,
)


def test_status_display_serializes_as_versioned_bounded_payload() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.STATUS,
        command="/status",
        title="mycli",
        fields=(
            SlashCommandField(label="Model", value="gpt-5.4"),
            SlashCommandField(label="Directory", value="/repo/mycli"),
        ),
    )

    assert display.to_payload() == {
        "version": 1,
        "kind": "status",
        "command": "/status",
        "title": "mycli",
        "severity": "info",
        "fields": [
            {"label": "Model", "value": "gpt-5.4"},
            {"label": "Directory", "value": "/repo/mycli"},
        ],
    }


def test_list_text_projection_is_deterministic_and_ansi_free() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.LIST,
        command="/tools",
        title="Tools",
        summary="2 available",
        rows=(
            SlashCommandRow(
                key="Read",
                label="Read",
                values=("file", "auto allow"),
                status="available",
            ),
            SlashCommandRow(
                key="Shell",
                label="Shell",
                values=("shell", "asks approval"),
                status="warning",
            ),
        ),
    )

    assert render_slash_command_text(display) == (
        "Tools - 2 available",
        "Read  file  auto allow",
        "Shell  shell  asks approval",
    )
    assert "\x1b" not in "\n".join(render_slash_command_text(display))


def test_diagnostic_text_projection_includes_sections() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.DIAGNOSTIC,
        command="/usage",
        title="Usage",
        fields=(SlashCommandField(label="Turns", value="3"),),
        sections=(
            SlashCommandSection(
                title="Cumulative tokens",
                fields=(SlashCommandField(label="Input", value="100000"),),
            ),
        ),
    )

    assert render_slash_command_text(display) == (
        "Usage",
        "Turns: 3",
        "Cumulative tokens",
        "Input: 100000",
    )


def test_notice_text_projection_uses_summary() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.NOTICE,
        command="/undo",
        title="Undo complete",
        severity=SlashCommandSeverity.SUCCESS,
        summary="Restored app.py",
    )

    assert render_slash_command_text(display) == ("Restored app.py",)


def test_error_display_rejects_success_severity() -> None:
    with pytest.raises(ValueError, match="error displays cannot use success severity"):
        SlashCommandDisplay(
            kind=SlashCommandDisplayKind.ERROR,
            command="/memory add",
            title="Invalid command",
            severity=SlashCommandSeverity.SUCCESS,
        )


def test_error_text_projection_includes_usage_and_suggestions() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.ERROR,
        command="/memroy",
        title="Unknown command",
        severity=SlashCommandSeverity.ERROR,
        summary="Unknown command: /memroy",
        usage="/memory [list|path|search|add|forget]",
        suggestions=("/memory",),
    )

    assert render_slash_command_text(display) == (
        "Error: Unknown command: /memroy",
        "Usage: /memory [list|path|search|add|forget]",
        "Did you mean: /memory",
    )


def test_preformatted_display_bounds_text_and_reports_omission() -> None:
    display = SlashCommandDisplay.preformatted_result(
        command="/trace logs",
        title="Trace logs",
        text="x" * 20_000,
    )

    payload = display.to_payload()
    assert len(str(payload["preformatted"])) <= 8_000
    assert int(payload["omitted_chars"]) > 0


def test_display_payload_round_trips_through_validation() -> None:
    original = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.NOTICE,
        command="/undo",
        title="Undo complete",
        severity=SlashCommandSeverity.SUCCESS,
        summary="Restored app.py",
    )

    assert SlashCommandDisplay.from_payload(original.to_payload()) == original


def test_display_caps_rows_and_reports_omission() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.LIST,
        command="/tools",
        title="Tools",
        rows=tuple(
            SlashCommandRow(key=str(index), label=f"Tool {index}")
            for index in range(MAX_ROWS + 3)
        ),
    )

    payload = display.to_payload()
    assert len(payload["rows"]) == MAX_ROWS
    assert payload["total_rows"] == MAX_ROWS + 3
    assert payload["omitted_rows"] == 3


def test_empty_optional_fields_are_omitted() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.NOTICE,
        command="/stop",
        title="Nothing to stop",
    )

    assert display.to_payload() == {
        "version": 1,
        "kind": "notice",
        "command": "/stop",
        "title": "Nothing to stop",
        "severity": "info",
    }
