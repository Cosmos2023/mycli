from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import LLMSummarization, _collect_recent_files


def _make_tool_msg(tool_name: str, path: str, tool_call_id: str = "c1") -> Message:
    return Message(
        role="tool",
        content="ok",
        tool_call_id=tool_call_id,
        metadata={"tool_name": tool_name, "path": path},
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text="ok",
                call_id=tool_call_id,
                metadata={"tool_name": tool_name, "path": path},
            ),
        ),
    )


class TestRehydration:
    def test_collects_edited_first(self) -> None:
        msgs = [
            _make_tool_msg("Read", "a.py", "c1"),
            _make_tool_msg("Read", "b.py", "c2"),
            _make_tool_msg("Edit", "c.py", "c3"),
        ]

        result = _collect_recent_files(msgs, n=3)

        assert result[0] == "c.py"

    def test_no_files_returns_empty(self) -> None:
        msgs = [Message(role="user", content="hello")]

        assert _collect_recent_files(msgs) == []

    def test_deduplicates_paths(self) -> None:
        msgs = [
            _make_tool_msg("Read", "auth.py", "c1"),
            _make_tool_msg("Read", "auth.py", "c2"),
        ]

        result = _collect_recent_files(msgs, n=3)

        assert len(result) == 1

    def test_frozen_zone_unchanged_after_l4_apply(self) -> None:
        summarizer = LLMSummarization(trigger_ratio=0.1, summarizer_client=None)
        budget = ContextBudget(max_tokens=200_000)
        budget.record({"total_tokens": 190_000})

        conv = Conversation(session_id="test")
        conv.messages = [
            Message(role="system", content="FROZEN_sys", metadata={"cache_policy": "STATIC"}),
            Message(role="system", content="FROZEN_tool", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="test", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="resp", metadata={"cache_policy": "DYNAMIC"}),
            _make_tool_msg("Read", "a.py", "c1"),
            Message(role="user", content="continue", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="more", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
        ]

        zones = CacheZones.from_conversation(conv)
        frozen_before = [
            (message.content, dict(message.metadata))
            for message in conv.messages[: zones.fresh_start]
        ]

        result = summarizer.apply(conv, zones, budget)
        frozen_after = [
            (message.content, dict(message.metadata))
            for message in result.messages[: zones.fresh_start]
        ]

        assert frozen_before == frozen_after
        assert summarizer.last_cost_metrics is not None
        assert summarizer.last_cost_metrics["recent_files"] == ["a.py"]
