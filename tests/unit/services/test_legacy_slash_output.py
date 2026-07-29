from mycli.services.legacy_slash_output import is_legacy_slash_output


def test_legacy_slash_output_accepts_one_known_tag_family() -> None:
    assert is_legacy_slash_output(
        (
            "[status] session=demo model=gpt-5.4 provider=openai/responses",
            "[status] mode=default sandbox=workspace-write",
        )
    )


def test_legacy_slash_output_accepts_each_supported_family() -> None:
    for tag in (
        "usage",
        "context",
        "stats",
        "tool",
        "skill",
        "agent",
        "permission",
        "change",
        "memory",
        "mode",
        "sandbox",
        "undo",
        "bash",
    ):
        assert is_legacy_slash_output((f"[{tag}] value=1",))


def test_legacy_slash_output_rejects_empty_malformed_unknown_and_mixed_text() -> None:
    assert not is_legacy_slash_output(())
    assert not is_legacy_slash_output((' [tool] Read description="unterminated',))
    assert not is_legacy_slash_output(("[unknown] value=1",))
    assert not is_legacy_slash_output(
        ("[usage] turns=3", "[tool] Read available=true")
    )
