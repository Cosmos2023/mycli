from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.request import RequestShapeBuilder
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import AgentConfig, InstructionContract, RuntimeBlock
from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelToolDefinition
from mycli.services.context.compaction.budget import ContextBudget
from mycli.services.context.compaction.cache_zones import CacheZones
from mycli.services.context.compaction.pipeline import (
    CompactionPipeline,
    ContextWindowAnalyzer,
    LLMSummarization,
    ToolResultBudget,
)
from mycli.services.context.tool_result_formatter import ToolResultFormatter


def _tool_definition(name: str) -> ModelToolDefinition:
    return ModelToolDefinition(name=name, description=f"{name} tool", parameters=())


def _tool_call(call_id: str, name: str = "Read") -> ToolCall:
    return ToolCall(name=name, arguments={}, reason="test", call_id=call_id)


def _tool_msg(
    content: str,
    tool_call_id: str,
    *,
    append_only: bool = False,
    tool_name: str = "Read",
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
                metadata={"tool_name": tool_name},
            ),
        ),
    )


def _assert_no_orphan_provider_tool_messages(messages: object) -> None:
    pending_ids: set[str] = set()
    for message in messages:
        if message.role == "assistant":
            pending_ids = {
                call.call_id
                for call in message.metadata.get("tool_calls", ())
                if call.call_id
            }
            continue
        if message.role != "tool":
            pending_ids.clear()
            continue
        tool_call_id = message.metadata.get("tool_call_id")
        assert tool_call_id in pending_ids
        pending_ids.discard(str(tool_call_id))


def test_compacted_conversation_builds_valid_chat_completions_transcript(
    tmp_path: Path,
) -> None:
    pipeline = CompactionPipeline(
        tool_result_budget=ToolResultBudget(ToolResultFormatter()),
        context_window_analyzer=ContextWindowAnalyzer(
            dedup_trigger_ratio=0.05,
            eviction_trigger_ratio=0.05,
            keep_recent_tool_results=2,
        ),
        llm_summarization=LLMSummarization(trigger_ratio=0.95),
    )
    budget = ContextBudget(max_tokens=200_000)
    budget.record({"total_tokens": 180_000})
    conversation = Conversation(
        session_id="test",
        messages=[
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="read x"),
            Message(role="assistant", content="", tool_calls=(_tool_call("call_1"),)),
            _tool_msg("file content", "call_1", append_only=True),
            Message(role="assistant", content="done"),
            Message(role="user", content="edit x"),
            Message(role="assistant", content="", tool_calls=(_tool_call("call_2", "Edit"),)),
            _tool_msg("edit success", "call_2", append_only=True, tool_name="Edit"),
        ],
    )

    compacted = pipeline.apply(conversation, budget)
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="deepseek",
            protocol="chat_completions",
            model="deepseek-v4-flash",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=tuple(compacted.messages),
            current_user_request="finish",
        ),
        tools=(_tool_definition("Read"), _tool_definition("Edit")),
    )

    _assert_no_orphan_provider_tool_messages(shape.provider_messages)


def test_l4_summary_does_not_leave_provider_orphan_tool_results(tmp_path: Path) -> None:
    summarizer = LLMSummarization(trigger_ratio=0.1)
    budget = ContextBudget(max_tokens=200_000)
    budget.record({"total_tokens": 190_000})
    conversation = Conversation(
        session_id="test",
        messages=[
            Message(role="system", content="sys", metadata={"cache_policy": "STATIC"}),
            Message(role="user", content="read x", metadata={"cache_policy": "DYNAMIC"}),
            Message(
                role="assistant",
                content="",
                tool_calls=(_tool_call("call_1"),),
                metadata={"cache_policy": "DYNAMIC"},
            ),
            _tool_msg("file content", "call_1", append_only=True),
            Message(role="assistant", content="done", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="user", content="edit x", metadata={"cache_policy": "DYNAMIC"}),
            Message(role="assistant", content="editing", metadata={"cache_policy": "DYNAMIC"}),
        ],
    )

    compacted = summarizer.apply(conversation, CacheZones.from_conversation(conversation), budget)
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="deepseek",
            protocol="chat_completions",
            model="deepseek-v4-flash",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=tuple(compacted.messages),
            current_user_request="finish",
        ),
        tools=(_tool_definition("Read"),),
    )

    _assert_no_orphan_provider_tool_messages(shape.provider_messages)
