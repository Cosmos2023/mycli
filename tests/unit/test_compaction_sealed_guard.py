from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import SlidingWindowEviction, ToolResultDedup


def _make_tool_msg(
    content: str,
    tool_call_id: str,
    *,
    cache_frozen: bool,
    tool_name: str = "read_file",
) -> Message:
    return Message(
        role="tool",
        content=content,
        tool_call_id=tool_call_id,
        metadata={"tool_name": tool_name, "cache_frozen": cache_frozen},
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=content,
                call_id=tool_call_id,
                metadata={"tool_name": tool_name},
            ),
        ),
    )


def _budget_above_threshold() -> ContextBudget:
    budget = ContextBudget(max_tokens=200_000)
    budget.record({"total_tokens": 100_000})
    return budget


class TestSealedGuard:
    def test_l2_byte_level_unchanged_for_cache_frozen(self) -> None:
        dedup = ToolResultDedup(trigger_ratio=0.1)
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                _make_tool_msg("sealed result v1", "old1", cache_frozen=True),
                _make_tool_msg("sealed result v1", "old2", cache_frozen=True),
            ],
        )

        result = dedup.apply(conv, CacheZones.from_conversation(conv), _budget_above_threshold())

        assert result.messages[1].content == "sealed result v1"
        assert result.messages[2].content == "sealed result v1"
        assert result.messages[1].metadata["cache_frozen"] is True

    def test_l2_still_dedups_non_sealed(self) -> None:
        dedup = ToolResultDedup(trigger_ratio=0.1)
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                _make_tool_msg("same result", "c1", cache_frozen=False),
                _make_tool_msg("same result", "c2", cache_frozen=False),
            ],
        )

        result = dedup.apply(conv, CacheZones.from_conversation(conv), _budget_above_threshold())

        assert "cleared" in result.messages[2].content

    def test_l3_skips_sealed_when_archiving(self) -> None:
        eviction = SlidingWindowEviction(trigger_ratio=0.1, keep_recent=1)
        budget = ContextBudget(max_tokens=200_000)
        budget.record({"total_tokens": 150_000})
        conv = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                _make_tool_msg("sealed old 1", "s1", cache_frozen=True),
                _make_tool_msg("sealed old 2", "s2", cache_frozen=True),
                _make_tool_msg("fresh new 1", "n1", cache_frozen=False),
                _make_tool_msg("fresh new 2", "n2", cache_frozen=False),
            ],
        )

        result = eviction.apply(conv, CacheZones.from_conversation(conv), budget)

        assert result.messages[1].content == "sealed old 1"
        assert result.messages[2].content == "sealed old 2"
        assert "archived" not in result.messages[1].content
        assert "archived" not in result.messages[2].content
