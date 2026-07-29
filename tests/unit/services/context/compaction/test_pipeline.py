from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolCall
from mycli.services.context.compaction.pipeline import (
    CompactService,
    LocalCompactProvider,
    effective_l4_trigger_ratio,
)
from mycli.llms.adapters.base import ModelToolDefinition
from mycli.services.context.compaction.replacement import CompactionReplacementBuilder
from mycli.services.context.compaction.trigger import (
    CompactPhase,
    CompactReason,
    CompactTriggerPolicy,
)


def _tool_message(call_id: str, *, content: str) -> Message:
    return Message(
        role="tool",
        content=content,
        tool_call_id=call_id,
        blocks=(RuntimeBlock(type="tool_result", text=content, call_id=call_id),),
    )


def _assistant_tool_call(call_id: str) -> Message:
    return Message(
        role="assistant",
        content="",
        tool_calls=(
            ToolCall(
                name="Read",
                arguments={"file_path": "README.md"},
                reason="inspect file",
                call_id=call_id,
            ),
        ),
        blocks=(
            RuntimeBlock(
                type="tool_call",
                tool_name="Read",
                tool_arguments={"file_path": "README.md"},
                call_id=call_id,
            ),
        ),
    )


class CapturingCompactProvider:
    path = "capturing"

    def __init__(self, output: tuple[Message, ...]) -> None:
        self.output = output
        self.messages: tuple[Message, ...] = ()

    def compact(
        self,
        messages: tuple[Message, ...],
        *,
        tools: tuple[ModelToolDefinition, ...] = (),
    ) -> tuple[Message, ...]:
        self.messages = messages
        return self.output


class CapturingStructuredSummarizer:
    def __init__(self, response: str = "Structured summary.") -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def complete_compaction(
        self,
        *,
        messages: tuple[Message, ...],
        instruction: str,
        tools: tuple[ModelToolDefinition, ...],
        model: str,
        max_tokens: int,
    ) -> str:
        self.calls.append(
            {
                "messages": messages,
                "instruction": instruction,
                "tools": tools,
                "model": model,
                "max_tokens": max_tokens,
            }
        )
        return self.response


def _compact_decision():
    return CompactTriggerPolicy(limit_tokens=100).forced(
        reason=CompactReason.CONTEXT_LIMIT,
        phase=CompactPhase.PRE_TURN,
        trigger_tokens=120,
    )


def _three_completed_turns() -> Conversation:
    return Conversation(
        session_id="compact-service",
        messages=[
            Message(role="user", content="old request"),
            _assistant_tool_call("call_old"),
            _tool_message("call_old", content="large old tool output"),
            Message(role="assistant", content="old final answer"),
            Message(role="user", content="recent request"),
            Message(role="assistant", content="recent answer"),
            Message(role="user", content="latest request"),
            Message(role="assistant", content="latest answer"),
        ],
    )


def test_compact_service_summarizes_full_structured_history() -> None:
    provider = CapturingCompactProvider(
        (Message(role="assistant", content="Earlier work summary."),)
    )
    service = CompactService(
        provider=provider,
        replacement_builder=CompactionReplacementBuilder(
            tail_turns=2,
            tail_max_tokens=2_000,
        ),
    )

    result = service.compact(_three_completed_turns(), _compact_decision())

    assert [message.content for message in provider.messages] == [
        "old request",
        "",
        "large old tool output",
        "old final answer",
        "recent request",
        "recent answer",
        "latest request",
        "latest answer",
    ]
    assert [(message.role, message.content) for message in result.messages] == [
        ("user", "[compact-summary]\nEarlier work summary."),
        ("user", "recent request"),
        ("assistant", "recent answer"),
        ("user", "latest request"),
        ("assistant", "latest answer"),
    ]
    assert result.messages[0].metadata["compaction_reason"] == "context_limit"
    assert result.messages[0].metadata["compaction_phase"] == "pre_turn"


def test_native_and_local_provider_outputs_normalize_to_same_history() -> None:
    builder = CompactionReplacementBuilder(tail_turns=2, tail_max_tokens=2_000)
    conversation = _three_completed_turns()
    local = CompactService(
        provider=CapturingCompactProvider(
            (Message(role="assistant", content="Shared summary."),)
        ),
        replacement_builder=builder,
    )
    native = CompactService(
        provider=CapturingCompactProvider(
            (
                Message(role="developer", content="stale instructions"),
                _assistant_tool_call("native_call"),
                _tool_message("native_call", content="native tool output"),
                Message(role="assistant", content="Shared summary."),
            )
        ),
        replacement_builder=builder,
    )

    local_result = local.compact(conversation, _compact_decision())
    native_result = native.compact(conversation, _compact_decision())

    assert native_result.messages == local_result.messages


def test_compact_service_keeps_history_when_provider_output_is_invalid() -> None:
    service = CompactService(
        provider=CapturingCompactProvider(
            (
                Message(role="developer", content="instructions only"),
                _tool_message("call_invalid", content="tool output only"),
            )
        ),
        replacement_builder=CompactionReplacementBuilder(
            tail_turns=2,
            tail_max_tokens=2_000,
        ),
    )
    conversation = _three_completed_turns()

    result = service.compact(conversation, _compact_decision())

    assert result is conversation
    assert service.last_status == "failed"


def test_local_compact_provider_excludes_private_reasoning() -> None:
    provider = LocalCompactProvider(
        summarizer_client=None,
        model_name="summary-model",
    )

    output = provider.compact(
        (
            Message(role="user", content="old request"),
            Message(
                role="assistant",
                content="private reasoning",
                blocks=(RuntimeBlock(type="reasoning", text="private reasoning"),),
            ),
            Message(role="assistant", content="old final answer"),
        )
    )

    assert "old request" in output[0].content
    assert "old final answer" in output[0].content
    assert "private reasoning" not in output[0].content


def test_local_compact_provider_sends_structured_tool_history_and_tool_specs() -> None:
    client = CapturingStructuredSummarizer()
    provider = LocalCompactProvider(
        summarizer_client=client,
        model_name="summary-model",
    )
    tool = ModelToolDefinition(
        name="Read",
        description="Read a file",
        parameters=(),
    )

    output = provider.compact(
        (
            Message(role="user", content="inspect the project"),
            _assistant_tool_call("call_structured"),
            _tool_message("call_structured", content="README contents"),
            Message(role="assistant", content="inspection complete"),
        ),
        tools=(tool,),
    )

    sent = client.calls[0]
    messages = sent["messages"]
    assert isinstance(messages, tuple)
    assert messages[1].tool_calls[0].name == "Read"
    assert messages[1].tool_calls[0].arguments == {"file_path": "README.md"}
    assert messages[1].tool_calls[0].call_id == "call_structured"
    assert messages[2].role == "tool"
    assert messages[2].tool_call_id == "call_structured"
    assert messages[2].content == "README contents"
    assert sent["tools"] == (tool,)
    assert "Conversation:" not in str(sent["instruction"])
    assert output == (Message(role="assistant", content="Structured summary."),)


def test_local_compact_provider_repairs_pairs_and_bounds_tool_output() -> None:
    client = CapturingStructuredSummarizer()
    provider = LocalCompactProvider(
        summarizer_client=client,
        model_name="summary-model",
        tool_output_max_chars=80,
    )

    provider.compact(
        (
            _tool_message("orphan", content="must be removed"),
            _assistant_tool_call("call_long"),
            _tool_message("call_long", content="A" * 200),
            _assistant_tool_call("call_missing"),
            Message(role="assistant", content="done"),
        )
    )

    messages = client.calls[0]["messages"]
    assert isinstance(messages, tuple)
    tool_messages = [message for message in messages if message.role == "tool"]
    assert [message.tool_call_id for message in tool_messages] == [
        "call_long",
        "call_missing",
    ]
    assert len(tool_messages[0].content) <= 80
    assert "chars omitted" in tool_messages[0].content
    assert tool_messages[0].blocks[0].call_id == "call_long"
    assert tool_messages[0].blocks[0].text == tool_messages[0].content
    assert "unavailable during compaction" in tool_messages[1].content


def test_legacy_ratio_migration_reserves_the_configured_buffer() -> None:
    assert effective_l4_trigger_ratio(
        configured_ratio=0.95,
        max_tokens=100_000,
        buffer_tokens=20_000,
    ) == 0.8
    assert effective_l4_trigger_ratio(
        configured_ratio=0.7,
        max_tokens=100_000,
        buffer_tokens=20_000,
    ) == 0.7
