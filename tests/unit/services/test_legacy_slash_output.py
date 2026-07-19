from mycli.cli.slash_command_result import SlashCommandDisplayKind
from mycli.services.legacy_slash_output import legacy_slash_display


def test_legacy_status_output_becomes_status_display() -> None:
    display = legacy_slash_display(
        command="/status",
        lines=(
            "[status] session=demo model=gpt-5.4 provider=openai/responses",
            "[status] mode=default sandbox=workspace-write",
        ),
    )

    assert display is not None
    assert display.kind is SlashCommandDisplayKind.STATUS
    assert [(field.label, field.value) for field in display.fields][:2] == [
        ("Session", "demo"),
        ("Model", "gpt-5.4"),
    ]


def test_legacy_diagnostic_list_and_notice_families_are_preserved() -> None:
    usage = legacy_slash_display(
        command="/usage",
        lines=(
            "[usage] session=demo turns=3",
            "[usage] cumulative_usage input_tokens=100 cache_read_tokens=80",
        ),
    )
    tools = legacy_slash_display(
        command="/tools",
        lines=("[tool] Read kind=builtin availability=available",),
    )
    permissions = legacy_slash_display(
        command="/permissions",
        lines=("[permission] allow_session pattern=git push",),
    )
    undo = legacy_slash_display(
        command="/undo",
        lines=("[undo] Restored src/mycli/app.py",),
    )

    assert usage is not None and usage.kind is SlashCommandDisplayKind.DIAGNOSTIC
    assert tools is not None and tools.kind is SlashCommandDisplayKind.LIST
    assert permissions is not None and permissions.kind is SlashCommandDisplayKind.LIST
    assert undo is not None and undo.kind is SlashCommandDisplayKind.NOTICE
    assert undo.summary == "Restored src/mycli/app.py"


def test_legacy_conversion_rejects_unsafe_or_mixed_tagged_text() -> None:
    malformed = legacy_slash_display(
        command="/tools",
        lines=(' [tool] Read description="unterminated',),
    )
    unknown = legacy_slash_display(
        command="/unknown",
        lines=("[unknown] value=1",),
    )
    mixed = legacy_slash_display(
        command="/usage",
        lines=("[usage] turns=3", "[tool] Read available=true"),
    )

    assert malformed is None
    assert unknown is None
    assert mixed is None
