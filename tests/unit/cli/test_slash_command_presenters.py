from __future__ import annotations

from mycli.cli.slash_command_presenters import (
    present_diagnostic,
    present_error,
    present_list,
    present_notice,
    present_preformatted,
    present_status,
)


def test_status_presenter_builds_named_fields() -> None:
    display = present_status(
        command="/status",
        values=(
            "session=demo model=gpt-5.4 provider=openai/responses",
            "context=32.8% pending=no suspended=no",
        ),
        directory="/repo/mycli",
    )

    assert display.kind.value == "status"
    assert [(field.label, field.value) for field in display.fields] == [
        ("Session", "demo"),
        ("Model", "gpt-5.4"),
        ("Provider", "openai/responses"),
        ("Directory", "/repo/mycli"),
        ("Context", "32.8%"),
    ]


def test_list_presenter_keeps_unknown_tokens_as_detail() -> None:
    display = present_list(
        command="/tools",
        title="Tools",
        values=("Read source=builtin toolset=file extra-token",),
        row_prefix="tool",
    )

    assert display.rows[0].label == "Read"
    assert display.rows[0].values == ("builtin", "file")
    assert display.rows[0].detail == "extra-token"
    assert display.summary == "1 item"


def test_list_presenter_keeps_multiword_final_value() -> None:
    display = present_list(
        command="/permissions",
        title="Permissions",
        values=("allow_session pattern=git push --force",),
        row_prefix="permission",
    )

    assert display.rows[0].values == ("git push --force",)


def test_notice_names_the_affected_object() -> None:
    display = present_notice(
        command="/undo",
        title="Undo complete",
        summary="Restored src/mycli/app.py",
    )

    assert display.severity.value == "success"
    assert display.summary == "Restored src/mycli/app.py"


def test_error_includes_usage_and_registry_suggestions() -> None:
    display = present_error(
        command="/memroy",
        reason="Unknown command /memroy",
        usage=None,
        suggestions=("/memory",),
    )

    assert display.kind.value == "error"
    assert display.suggestions == ("/memory",)


def test_usage_diagnostic_builds_metrics_and_sections() -> None:
    display = present_diagnostic(
        command="/usage",
        title="Usage",
        values=(
            "session=demo",
            "turns=3",
            "current_context_window input_tokens=42000 max_tokens=128000 usage_ratio=32.8% source=provider",
            "cumulative_usage input_tokens=100000 output_tokens=8000 cache_read_tokens=90000",
            "estimated_cost=0.123",
        ),
    )

    assert [(field.label, field.value) for field in display.fields] == [
        ("Session", "demo"),
        ("Turns", "3"),
        ("Estimated cost", "0.123"),
    ]
    assert [section.title for section in display.sections] == [
        "Current context window",
        "Cumulative usage",
    ]
    assert display.sections[0].fields[2].value == "32.8%"


def test_context_diagnostic_groups_budget_and_compaction() -> None:
    display = present_diagnostic(
        command="/context",
        title="Context",
        values=(
            "budget input_tokens=91000 max_tokens=128000 usage_ratio=71.1% source=estimate",
            "context_window fresh_tokens=12000 tool_result_tokens=30000",
            "compaction before_tokens=90000 after_tokens=45000 ratio=50.0% last_decision=compact",
        ),
    )

    assert display.fields[0].label == "Input tokens"
    assert display.fields[2].tone == "warning"
    assert [section.title for section in display.sections] == [
        "Context composition",
        "Compaction",
    ]


def test_preformatted_presenter_preserves_line_breaks() -> None:
    display = present_preformatted(
        command="/trace logs",
        title="Trace logs",
        values=("first", "second"),
    )

    assert display.kind.value == "preformatted"
    assert display.preformatted == "first\nsecond"
