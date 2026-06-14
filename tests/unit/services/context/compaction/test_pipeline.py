from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolCall
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import (
    CheapPruning,
    CompactionCostProfile,
    CompactionPipeline,
    ContextWindowAnalyzer,
    FullContextSnapshot,
    LLMSummarization,
    ToolResultBudget,
)
from mycli.services.context.token_counter import TokenCounter
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


def _assistant_tool_call(call_id: str, *, argument_size: int = 0) -> Message:
    arguments: dict[str, object] = {"path": "/a.py"}
    if argument_size:
        arguments["content"] = "x" * argument_size
        arguments["nested"] = {"payload": "y" * argument_size}
    return Message(
        role="assistant",
        content="",
        tool_calls=(
            ToolCall(
                name="write_file",
                arguments=arguments,
                reason="test",
                call_id=call_id,
            ),
        ),
        metadata={"cache_policy": "DYNAMIC"},
        blocks=(
            RuntimeBlock(
                type="tool_call",
                tool_name="write_file",
                tool_arguments=arguments,
                call_id=call_id,
            ),
        ),
    )


def _zones(conversation: Conversation) -> CacheZones:
    return CacheZones.from_conversation(conversation)


class TestCheapPruning:
    def test_preserves_static_prefix_and_recent_tail_unchanged(self) -> None:
        strategy = CheapPruning(protected_tail_messages=2, tool_result_max_chars=80)
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
                Message(role="user", content="old", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("old1", content="x = 1\n" * 80),
                Message(role="user", content="tail user", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("tail1", content="tail result " * 80),
            ],
        )
        before_static = conversation.messages[0]
        before_tail = tuple(conversation.messages[-2:])
        before_fingerprint = _zones(conversation).frozen_fingerprint

        result = strategy.apply(
            conversation,
            _zones(conversation),
            ContextBudget(max_tokens=1000, total_tokens=900),
        )

        assert result.messages[0] == before_static
        assert tuple(result.messages[-2:]) == before_tail
        assert _zones(result).frozen_fingerprint == before_fingerprint
        assert result.messages[2].metadata["cheap_pruned"] is True

    def test_deduplicates_old_tool_results_with_back_reference(self) -> None:
        strategy = CheapPruning(protected_tail_messages=1)
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="start", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("old1", path="/a.py", content="same", summary="Read file"),
                _tool_msg("old2", path="/a.py", content="same", summary="Read file"),
                Message(role="assistant", content="tail", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(
            conversation,
            _zones(conversation),
            ContextBudget(max_tokens=1000, total_tokens=900),
        )

        assert result.messages[1].content.startswith("[duplicate tool result omitted; see ")
        assert result.messages[1].tool_call_id == "old1"
        assert result.messages[1].metadata["cheap_pruning_kind"] == "duplicate_tool_result"
        assert result.messages[2].content == "same"

    def test_expands_tail_to_keep_tool_call_group_together(self) -> None:
        strategy = CheapPruning(protected_tail_messages=1, tool_result_max_chars=40)
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="old", metadata={"cache_policy": "DYNAMIC"}),
                _assistant_tool_call("call_tail", argument_size=300),
                _tool_msg("call_tail", content="tail result " * 80),
            ],
        )
        before_tail_group = tuple(conversation.messages[-2:])

        result = strategy.apply(
            conversation,
            _zones(conversation),
            ContextBudget(max_tokens=1000, total_tokens=900),
        )

        assert tuple(result.messages[-2:]) == before_tail_group

    def test_truncates_old_tool_call_arguments_without_losing_structure(self) -> None:
        strategy = CheapPruning(
            protected_tail_messages=1,
            tool_argument_string_max_chars=16,
        )
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="old", metadata={"cache_policy": "DYNAMIC"}),
                _assistant_tool_call("call_old", argument_size=200),
                Message(role="assistant", content="tail", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(
            conversation,
            _zones(conversation),
            ContextBudget(max_tokens=1000, total_tokens=900),
        )

        pruned_call = result.messages[1].tool_calls[0]
        assert isinstance(pruned_call.arguments, dict)
        assert pruned_call.arguments["content"] == "x" * 16 + "...[truncated]"
        nested = pruned_call.arguments["nested"]
        assert isinstance(nested, dict)
        assert nested["payload"] == "y" * 16 + "...[truncated]"
        block_arguments = result.messages[1].blocks[0].tool_arguments
        assert block_arguments == pruned_call.arguments
        assert result.messages[1].metadata["cheap_pruning_kind"] == "tool_call_arguments"


class TestContextWindowAnalyzer:
    def test_records_duplicate_tool_pressure_without_modifying_messages(self) -> None:
        analyzer = ContextWindowAnalyzer(dedup_trigger_ratio=0.1, eviction_trigger_ratio=0.9)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 500})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", path="/a.py", content="same result"),
                _tool_msg("c2", path="/a.py", content="same result"),
            ],
        )

        result = analyzer.apply(conversation, _zones(conversation), budget)

        assert result is conversation
        assert analyzer.last_metrics is not None
        assert analyzer.last_metrics.duplicate_tool_result_count == 1
        assert analyzer.last_metrics.duplicate_tool_result_tokens > 0
        assert conversation.messages[2].content == "same result"

    def test_records_evictable_tool_pressure_without_archiving_messages(self) -> None:
        analyzer = ContextWindowAnalyzer(
            dedup_trigger_ratio=0.9,
            eviction_trigger_ratio=0.1,
            keep_recent_tool_results=2,
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 800})
        messages = [Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"})]
        for index in range(5):
            messages.append(_tool_msg(f"c{index}", content=f"result {index}"))
        conversation = Conversation(session_id="test", messages=messages)

        result = analyzer.apply(conversation, _zones(conversation), budget)

        assert result is conversation
        assert analyzer.last_metrics is not None
        assert analyzer.last_metrics.evictable_tool_result_count == 3
        assert analyzer.last_metrics.evictable_tool_result_tokens > 0
        assert conversation.messages[1].content == "result 0"
        assert conversation.messages[3].content == "result 2"


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
        assert result.messages[2].metadata["append_only"] is True
        assert "cache_frozen" not in result.messages[2].metadata
        assert len(result.messages[2].content) <= 120
        assert "tool_result" == result.messages[2].blocks[0].type
        assert result.messages[2].blocks[0].metadata["compacted"] is True

    def test_skips_append_only_tool_results(self) -> None:
        strategy = ToolResultBudget(ToolResultFormatter(read_file_max_chars=120))
        budget = ContextBudget(max_tokens=1000)
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="inspect", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", content="x = 1\n" * 400),
            ],
        )
        conversation.messages[1].metadata["append_only"] = True

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result.messages[1].content == conversation.messages[1].content

    def test_l1_treats_legacy_cache_frozen_as_append_only(self) -> None:
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
    def test_summary_and_continuation_include_bounded_lifecycle_metadata(self) -> None:
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
                Message(role="user", content="turn2", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="resp2", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(
            conversation,
            _zones(conversation),
            budget,
            source="pre_request",
        )

        summary = result.messages[1]
        continuation = result.messages[2]
        assert summary.metadata["compaction"] is True
        assert summary.metadata["compaction_lineage_id"]
        assert summary.metadata["compaction_source"] == "pre_request"
        assert summary.metadata["compaction_split_index"] == 2
        assert summary.metadata["compaction_summarized_count"] == 2
        assert summary.metadata["compaction_tail_count"] == 2
        assert summary.metadata["compressed_turns"] == 2
        assert continuation.metadata["compaction_continuation"] is True
        assert continuation.metadata["compaction_lineage_id"] == summary.metadata["compaction_lineage_id"]
        assert continuation.metadata["compaction_source"] == "pre_request"
        assert continuation.metadata["compaction_tail_count"] == 2

    def test_fallback_summary_omits_provider_private_reasoning_messages(self) -> None:
        strategy = LLMSummarization(trigger_ratio=0.5, summarizer_client=None)
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 600})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(
                    role="assistant",
                    content="SECRET PROVIDER REASONING",
                    blocks=(RuntimeBlock(type="reasoning", text="SECRET PROVIDER REASONING"),),
                    metadata={
                        "cache_policy": "DYNAMIC",
                        "provider_state": {
                            "codex_reasoning_items": [
                                {"type": "reasoning", "encrypted_content": "opaque"}
                            ]
                        },
                    },
                ),
                Message(role="user", content="actual user request", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="visible assistant answer", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="user", content="latest user tail", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result.messages[0].metadata["compaction"] is True
        assert "SECRET PROVIDER REASONING" not in result.messages[0].content
        assert "actual user request" in result.messages[0].content

    def test_summary_replacement_keeps_latest_user_message_in_tail(self) -> None:
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
                Message(role="user", content="old request", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="old answer", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="user", content="current request must stay raw", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="tool planning 1", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c1", content="tool result 1"),
                Message(role="assistant", content="tool planning 2", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c2", content="tool result 2"),
                Message(role="assistant", content="tool planning 3", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg("c3", content="tool result 3"),
                Message(role="assistant", content="tool planning 4", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = strategy.apply(conversation, _zones(conversation), budget)

        assert result.messages[0].metadata["compaction"] is True
        assert any(
            message.role == "user" and message.content == "current request must stay raw"
            for message in result.messages[2:]
        )
        assert "current request must stay raw" not in result.messages[0].content

    def test_summarizer_receives_full_context_snapshot_when_provided(self) -> None:
        captured: list[list[Message]] = []

        class CaptureSummarization(StubSummarization):
            def _call_summarizer(self, messages: list[Message]) -> str:
                captured.append(messages)
                return "summary"

        strategy = CaptureSummarization(
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
        budget = ContextBudget(max_tokens=1000, total_tokens=600)
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="old turn", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="old response", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="user", content="recent turn", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="assistant", content="recent response", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )
        snapshot = FullContextSnapshot(
            messages=(
                Message(role="system", content="SYSTEM PROMPT"),
                Message(role="developer", content="TOOL SCHEMA"),
                Message(role="user", content="CURRENT REQUEST"),
                *conversation.messages,
            )
        )

        result = strategy.apply(conversation, _zones(conversation), budget, snapshot=snapshot)

        assert result.messages[0].metadata["compaction"] is True
        assert captured
        summarized_text = "\n".join(message.content for message in captured[0])
        assert "SYSTEM PROMPT" in summarized_text
        assert "TOOL SCHEMA" in summarized_text
        assert "CURRENT REQUEST" in summarized_text

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
    def test_pipeline_skips_pruning_below_compression_threshold(self) -> None:
        pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(
                ToolResultFormatter(read_file_max_chars=80)
            ),
            cheap_pruning=CheapPruning(protected_tail_messages=1, tool_result_max_chars=80),
            context_window_analyzer=ContextWindowAnalyzer(
                dedup_trigger_ratio=0.01,
                eviction_trigger_ratio=0.1,
                keep_recent_tool_results=1,
            ),
            llm_summarization=LLMSummarization(trigger_ratio=0.9),
            token_counter=TokenCounter(),
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 500})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="inspect", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg(
                    "old1",
                    tool_name="read_file",
                    path="/big.py",
                    content="x = 1\n" * 400,
                    summary="Read big.py",
                ),
                Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = pipeline.apply(conversation, budget)

        assert result is conversation
        assert result.messages[1].content == "x = 1\n" * 400
        assert "append_only" not in result.messages[1].metadata
        assert "cheap_pruned" not in result.messages[1].metadata
        assert pipeline.last_context_window_metrics is None
        assert pipeline.llm_summarization.last_cost_metrics is not None
        assert pipeline.llm_summarization.last_cost_metrics["decision"] == "skip_threshold"

    def test_pipeline_applies_strategies_in_order(self) -> None:
        pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(ToolResultFormatter()),
            context_window_analyzer=ContextWindowAnalyzer(
                dedup_trigger_ratio=0.01,
                eviction_trigger_ratio=0.1,
                keep_recent_tool_results=2,
            ),
            llm_summarization=LLMSummarization(trigger_ratio=0.5),
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 900})
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
        assert result.messages[1].metadata["append_only"] is True
        assert result.messages[2].metadata["append_only"] is True
        assert "[cleared" not in result.messages[2].content
        assert "[archived:" not in result.messages[1].content
        assert pipeline.last_context_window_metrics is not None
        assert pipeline.last_context_window_metrics.duplicate_tool_result_count == 1
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
            context_window_analyzer=ContextWindowAnalyzer(
                dedup_trigger_ratio=0.1,
                eviction_trigger_ratio=0.1,
                keep_recent_tool_results=2,
            ),
            llm_summarization=LLMSummarization(trigger_ratio=0.5),
            hook_manager=hook_manager,
        )
        budget = ContextBudget(max_tokens=1000)
        budget.record({"total_tokens": 900})
        conversation = Conversation(
            session_id="test",
            messages=[Message(role="user", content="hi", metadata={"cache_policy": "DYNAMIC"})],
        )

        pipeline.apply(conversation, budget)

        assert len(seen) == 1
        assert seen[0].hook_point is HookPoint.PRE_COMPACT
        assert seen[0].metadata["usage_ratio"] == budget.usage_ratio

    def test_pipeline_recomputes_budget_after_l1_before_l4_threshold(self) -> None:
        pipeline = CompactionPipeline(
            tool_result_budget=ToolResultBudget(
                ToolResultFormatter(read_file_max_chars=80)
            ),
            context_window_analyzer=ContextWindowAnalyzer(
                dedup_trigger_ratio=0.1,
                eviction_trigger_ratio=0.1,
                keep_recent_tool_results=2,
            ),
            llm_summarization=LLMSummarization(trigger_ratio=0.6),
            token_counter=TokenCounter(),
        )
        stale_budget = ContextBudget(max_tokens=200)
        stale_budget.record({"total_tokens": 190})
        conversation = Conversation(
            session_id="test",
            messages=[
                Message(role="user", content="inspect", metadata={"cache_policy": "DYNAMIC"}),
                _tool_msg(
                    "c1",
                    tool_name="read_file",
                    path="/big.py",
                    content="x = 1\n" * 400,
                    summary="Read big.py",
                ),
                Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
                Message(role="user", content="continue", metadata={"cache_policy": "DYNAMIC"}),
            ],
        )

        result = pipeline.apply(conversation, stale_budget)

        assert all(message.metadata.get("compaction") is not True for message in result.messages)
        assert pipeline.last_context_window_metrics is not None
        assert pipeline.last_context_window_metrics.total_tokens < stale_budget.total_tokens
