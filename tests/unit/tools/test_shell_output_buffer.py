from __future__ import annotations

from mycli.tools.shell_output_buffer import ShellOutputBuffer


def test_shell_output_buffer_retains_head_and_tail_with_hard_limit() -> None:
    buffer = ShellOutputBuffer(max_chars=10)
    buffer.append("abcdefgh")
    buffer.append("ijklmnop")

    snapshot = buffer.snapshot()

    assert snapshot.retained_chars <= 10
    assert snapshot.total_chars == 16
    assert snapshot.omitted_chars == 6
    assert snapshot.text.startswith("abcde")
    assert snapshot.text.endswith("lmnop")


def test_shell_output_buffer_returns_incremental_text_from_absolute_cursor() -> None:
    buffer = ShellOutputBuffer(max_chars=20)
    buffer.append("ready\n")
    cursor = buffer.end_cursor
    buffer.append("done\n")

    chunk = buffer.read_from(cursor)

    assert chunk.text == "done\n"
    assert chunk.next_cursor == buffer.end_cursor
    assert chunk.cursor_was_evicted is False
    assert chunk.omitted_before_chunk == 0


def test_shell_output_buffer_reports_cursor_eviction() -> None:
    buffer = ShellOutputBuffer(max_chars=8)
    buffer.append("abcdefgh")
    cursor = buffer.end_cursor
    buffer.append("ijklmnop")

    chunk = buffer.read_from(cursor - 6)

    assert chunk.cursor_was_evicted is True
    assert chunk.omitted_before_chunk > 0
    assert chunk.next_cursor == buffer.end_cursor
    assert chunk.text.startswith("cd")
    assert chunk.text.endswith("mnop")


def test_shell_output_buffer_zero_capacity_tracks_omitted_text() -> None:
    buffer = ShellOutputBuffer(max_chars=0)
    buffer.append("output")

    snapshot = buffer.snapshot()
    chunk = buffer.read_from(0)

    assert snapshot.text == ""
    assert snapshot.total_chars == 6
    assert snapshot.omitted_chars == 6
    assert chunk.text == ""
    assert chunk.cursor_was_evicted is True
    assert chunk.omitted_before_chunk == 6

