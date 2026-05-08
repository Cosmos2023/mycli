from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import (
    CompactionCostProfile,
    CompactionPipeline,
    LLMSummarization,
    SlidingWindowEviction,
    ToolResultBudget,
    ToolResultDedup,
)
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.services.hooks import HookAction, HookContext, HookManager, HookPoint, HookResult


def _tool_msg(
    call_id: str,
    tool_name: str = "read_file",
    path: str = "/a.py",
    content: str = "result",
    summary: str = "Read file",
    *,
    cache_policy: str = "EPHEMERAL",
) -> Message:
    return Message(
        role="tool",
        content=content,
        tool_call_id=call_id,
        metadata={"cache_policy": cache_policy},
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=content,
                call_id=call_id,
                metadata={
                    "path": path,
                    "success": True,
                    "summary": summary,
                    "tool_name": tool_name,
                },
            ),
        ),
    )


def _zones(conversation: Conversation) -> CacheZones:
    return CacheZones.from_conversation(conversation)


class TestToolResultDedup:
    def test_dedup_triggers_at_threshold(self) -> None:
        dedup = ToolResultDedup(trigger_ratio=0.35)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 400})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", path="/a.py"),
                _tool_msg("c2", path="/a.py"),
                _tool_msg("c3", path="/b.py"),
            ],
        )
        result = dedup.apply(conversation, _zones(conversation), budget)
        assert "[cleared" in result.messages[2].content
        assert "result" in conversation.messages[2].content

    def test_dedup_does_not_trigger_below_threshold(self) -> None:
        dedup = ToolResultDedup(trigger_ratio=0.4)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 300})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", path="/a.py"),
                _tool_msg("c2", path="/a.py"),
            ],
        )
        result = dedup.apply(conversation, _zones(conversation), budget)
        assert "[cleared" not in result.messages[2].content

    def test_dedup_does_not_modify_messages_before_fresh_start(self) -> None:
        dedup = ToolResultDedup(trigger_ratio=0.3)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 400})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                Message(role="assistant", content="tool defs", metadata={"cache_policy": "STATIC"}),
                Message(role="user", content="turn1", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c0", path="/old.py"),
                Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="user", content="turn2", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", path="/old.py"),
                _tool_msg("c2", path="/old.py"),
            ],
        )
        result = dedup.apply(conversation, _zones(conversation), budget)
        assert "[cleared" not in result.messages[1].content
        assert "[cleared" not in result.messages[5].content
        assert "[cleared" in result.messages[6].content


class TestSlidingWindowEviction:
    def test_evicts_old_tool_results_when_over_threshold(self) -> None:
        eviction = SlidingWindowEviction(trigger_ratio=0.6, keep_recent=2)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 700})
        messages = [Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"})]
        for index in range(5):
            messages.append(_tool_msg(f"c{index}"))
        conversation = Conversation(session_id="test", messages=messages)

        result = eviction.apply(conversation, _zones(conversation), budget)

        assert "[archived:" in result.messages[1].content
        assert "[archived:" in result.messages[2].content
        assert "[archived:" in result.messages[3].content
        assert "result" in result.messages[4].content
        assert "result" in result.messages[5].content
        assert "result" in conversation.messages[1].content

    def test_does_not_evict_when_below_threshold(self) -> None:
        eviction = SlidingWindowEviction(trigger_ratio=0.7, keep_recent=2)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 500})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1"),
                _tool_msg("c2"),
                _tool_msg("c3"),
            ],
        )
        result = eviction.apply(conversation, _zones(conversation), budget)
        assert "result" in result.messages[1].content

    def test_no_eviction_when_fewer_than_keep_recent(self) -> None:
        eviction = SlidingWindowEviction(trigger_ratio=0.6, keep_recent=8)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 700})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1"),
                _tool_msg("c2"),
            ],
        )
        result = eviction.apply(conversation, _zones(conversation), budget)
        assert "result" in result.messages[1].content
        assert "result" in result.messages[2].content


class TestToolResultBudget:
    def test_formats_fresh_tool_results_and_marks_them_compacted(self) -> None:
        strategy = ToolResultBudget(ToolResultFormatter(read_file_max_chars=120))
        budget = ContextBudget(max_tokens=1000)
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                Message(role="user", content="inspect", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg(
                    "c1",
                    tool_name="read_file",
                    path="/big.py",
                    content="x = 1\n" * 400,
                    summary="Read big.py",
                ),
            ],
        )

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result.messages[2].content != conversation.messages[2].content
        assert result.messages[2].metadata["l1_truncated"] is True
        assert result.messages[2].metadata["cache_frozen"] is True
        assert len(result.messages[2].content) <= 120
        assert "tool_result" == result.messages[2].blocks[0].type
        assert result.messages[2].blocks[0].metadata["compacted"] is True

    def test_skips_frozen_tool_results(self) -> None:
        strategy = ToolResultBudget(ToolResultFormatter(read_file_max_chars=120))
        budget = ContextBudget(max_tokens=1000)
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="inspect", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", content="x = 1\n" * 400),
            ],
        )
        conversation.messages[1].metadata["cache_frozen"] = True

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result.messages[1].content == conversation.messages[1].content


class StubSummarization(LLMSummarization):
    def __init__(
        self,
        *,
        trigger_ratio: float = 0.9,
        fail: bool = False,
        model_name: str | None = None,
        trigger_ratios_by_model: dict[str, float] | None = None,
        cost_profile: CompactionCostProfile | None = None,
    ) -> None:
        super().__init__(
            trigger_ratio=trigger_ratio,
            model_name=model_name,
            trigger_ratios_by_model=trigger_ratios_by_model,
            cost_profile=cost_profile,
        )
        self.fail = fail

    def _call_summarizer(self, messages: list[Message]) -> str:
        if self.fail:
            raise RuntimeError("boom")
        return f"summary for {len(messages)} messages"


class TestLLMSummarization:
    def test_skips_summary_when_carrying_tokens_is_cheaper(self) -> None:
        strategy = StubSummarization(
            trigger_ratio=0.5,
            cost_profile=CompactionCostProfile(
                input_cost_per_1k=0.001,
                output_cost_per_1k=1.0,
                carry_cost_per_1k=0.001,
                carry_turns=1,
                expected_summary_tokens=500,
                min_savings_ratio=0.0,
            ),
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 600})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="turn1 " * 40, metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="resp1 " * 40, metadata={"cache_policy": "DYNAMIC"}),
                Message(role="user", content="turn2 " * 40, metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="resp2 " * 40, metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result is conversation
        assert strategy.last_cost_metrics is not None
        assert strategy.last_cost_metrics["decision"] == "skip_cost"
        assert strategy.last_cost_metrics["summary_cost"] > strategy.last_cost_metrics["carry_cost"]

    def test_summarizes_first_half_of_fresh_messages_when_over_threshold(self) -> None:
        strategy = StubSummarization(
            trigger_ratio=0.5,
            cost_profile=CompactionCostProfile(
                input_cost_per_1k=0.001,
                output_cost_per_1k=0.001,
                carry_cost_per_1k=0.01,
                carry_turns=10,
                expected_summary_tokens=20,
                min_savings_ratio=0.0,
            ),
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 600})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                Message(role="user", content="turn1", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="resp1", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1"),
                Message(role="user", content="turn2", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="resp2", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result.messages[0].content == "sys"
        assert result.messages[1].metadata["compaction"] is True
        assert result.messages[1].metadata["compressed_turns"] == 2
        assert result.messages[1].metadata["compaction_cost"]["decision"] == "summarize"
        assert strategy.last_cost_metrics is not None
        assert strategy.last_cost_metrics["decision"] == "summarize"
        assert result.messages[2].metadata["compaction_continuation"] is True
        assert result.messages[3].content == conversation.messages[3].content
        assert result.messages[4].content == conversation.messages[4].content
        assert result.messages[5].content == conversation.messages[5].content

    def test_uses_model_specific_trigger_ratio_when_configured(self) -> None:
        strategy = StubSummarization(
            trigger_ratio=0.9,
            model_name="cheap-model",
            trigger_ratios_by_model={"cheap-model": 0.5},
            cost_profile=CompactionCostProfile(
                input_cost_per_1k=0.001,
                output_cost_per_1k=0.001,
                carry_cost_per_1k=0.01,
                carry_turns=10,
                expected_summary_tokens=20,
                min_savings_ratio=0.0,
            ),
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 600})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="turn1", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="resp1", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="user", content="turn2", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="resp2", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result is not conversation
        assert strategy.last_cost_metrics is not None
        assert strategy.last_cost_metrics["trigger_ratio"] == 0.5

    def test_returns_original_conversation_on_failure(self) -> None:
        strategy = StubSummarization(trigger_ratio=0.5, fail=True)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 600})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="turn1", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="resp1", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result is conversation


class TestCompactionPipeline:
    def test_pipeline_applies_strategies_in_order(self) -> None:
        pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(ToolResultFormatter()),
            tool_result_dedup=ToolResultDedup(trigger_ratio=0.1),
            sliding_window_eviction=SlidingWindowEviction(
                trigger_ratio=0.1,
                keep_recent=2,
            ),
            llm_summarization=LLMSummarization(trigger_ratio=0.99),
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 500})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", path="/a.py"),
                _tool_msg("c2", path="/a.py"),
                _tool_msg("c3", path="/b.py"),
            ],
        )
        result = pipeline.apply(conversation, budget)
        assert "[cleared" in result.messages[2].content
        assert "[archived:" in result.messages[1].content
        assert "result" in conversation.messages[1].content

    def test_pipeline_emits_pre_compact_hook(self) -> None:
        seen: list[HookContext] = []
        hook_manager = HookManager()

        def capture(ctx: HookContext) -> HookResult:
            seen.append(ctx)
            return HookResult(action=HookAction.ALLOW)

        hook_manager.register(HookPoint.PRE_COMPACT, capture)
        pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(ToolResultFormatter()),
            tool_result_dedup=ToolResultDedup(trigger_ratio=0.1),
            sliding_window_eviction=SlidingWindowEviction(trigger_ratio=0.1, keep_recent=2),
            llm_summarization=LLMSummarization(trigger_ratio=0.99),
            hook_manager=hook_manager,
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 500})
        conversation = Conversation(
            session_id="test",
            messages=[Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"})],
        )

        pipeline.apply(conversation, budget)

        assert len(seen) == 1
        assert seen[0].hook_point is HookPoint.PRE_COMPACT
        assert seen[0].metadata["usage_ratio"] == budget.usage_ratio
