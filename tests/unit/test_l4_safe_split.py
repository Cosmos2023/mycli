from __future__ import annotations

from mycli.domain.conversation import Message
from mycli.domain.tooling.calls import ToolCall
from mycli.services.context.compaction.pipeline import _find_safe_split


def test_no_tool_calls_returns_candidate() -> None:
    messages = [
        Message(role="user", content="q"),
        Message(role="assistant", content="a"),
    ]

    assert _find_safe_split(messages, 1) == 1


def test_tool_pair_forces_boundary_shift() -> None:
    messages = [
        Message(role="user", content="read x"),
        Message(
            role="assistant",
            content="",
            tool_calls=(
                ToolCall(
                    name="read_file",
                    arguments={"path": "x.py"},
                    reason="read",
                    call_id="c1",
                ),
            ),
        ),
        Message(role="tool", content="result", tool_call_id="c1"),
        Message(role="user", content="next question"),
    ]

    result = _find_safe_split(messages, 2)

    assert result != 2
    assert result in (1, 3)


def test_same_response_id_not_split() -> None:
    messages = [
        Message(role="user", content="q"),
        Message(role="assistant", content="thinking", response_id="r1"),
        Message(role="assistant", content="done", response_id="r1"),
    ]

    result = _find_safe_split(messages, 2)

    assert result <= 1


def test_empty_list() -> None:
    assert _find_safe_split([], 0) == 0
