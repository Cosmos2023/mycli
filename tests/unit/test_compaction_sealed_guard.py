from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import ContextWindowAnalyzer


def _make_tool_msg(
    content: str,
    tool_call_id: str,
    *,
    append_only: bool,
    tool_name: str = "read_file",
) -> Message:
    return Message(
        role="tool",
        content=content,
        tool_call_id=tool_call_id,
        metadata={"tool_name": tool_name, "append_only": append_only},
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=content,
                call_id=tool_call_id,
                metadata={
                    "path": "/tmp/a.py",
                    "summary": "Read file",
                    "tool_name": tool_name,
                },
            ),
        ),
    )


def _budget_above_threshold() -> ContextBudget:
    budget = ContextBudget(max_tokens=200_000)
    budget.record({"total_tokens": 100_000})
    return budget


class TestAppendOnlyWindowMetrics:
    def test_analyzer_leaves_append_only_duplicates_byte_level_unchanged(self) -> None:
        analyzer = ContextWindowAnalyzer(dedup_trigger_ratio=0.1, eviction_trigger_ratio=0.9)
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                _make_tool_msg("sealed result v1", "old1", append_only=True),
                _make_tool_msg("sealed result v1", "old2", append_only=True),
            ],
        )

        result = analyzer.apply(conv, CacheZones.from_conversation(conv), _budget_above_threshold())

        assert result is conv
        assert result.messages[1].content == "sealed result v1"
        assert result.messages[2].content == "sealed result v1"
        assert analyzer.last_metrics is not None
        assert analyzer.last_metrics.duplicate_tool_result_count == 1

    def test_analyzer_reports_evictable_pressure_without_archiving(self) -> None:
        analyzer = ContextWindowAnalyzer(
            dedup_trigger_ratio=0.9,
            eviction_trigger_ratio=0.1,
            keep_recent_tool_results=1,
        )
        budget = ContextBudget(max_tokens=200_000)
        budget.record({"total_tokens": 150_000})
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                _make_tool_msg("old 1", "s1", append_only=True),
                _make_tool_msg("old 2", "s2", append_only=True),
                _make_tool_msg("recent", "s3", append_only=True),
            ],
        )

        result = analyzer.apply(conv, CacheZones.from_conversation(conv), budget)

        assert result is conv
        assert [message.content for message in result.messages[1:]] == [
            "old 1",
            "old 2",
            "recent",
        ]
        assert analyzer.last_metrics is not None
        assert analyzer.last_metrics.evictable_tool_result_count == 2
