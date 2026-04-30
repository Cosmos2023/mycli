from __future__ import annotations

from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.runtime import AgentConfig, InstructionContract, InstructionFragment, RuntimeBlock
from mycli.domain.runtime.request_shape import (
    FragmentStability,
    RequestFragmentKind,
)
from mycli.infrastructure.models.base import (
    ModelToolDefinition,
    ModelToolParameter,
)
from mycli.services.request_shape_builder import RequestShapeBuilder


def _tool(
    name: str,
    *,
    parameters: tuple[ModelToolParameter, ...] = (),
) -> ModelToolDefinition:
    return ModelToolDefinition(
        name=name,
        description=f"Tool {name}",
        parameters=parameters,
    )


def _contract(
    *,
    current_user_request: str,
    contextual_content: str,
) -> InstructionContract:
    return InstructionContract(
        base_instructions="Stable system rules.",
        developer_sections=(
            InstructionFragment(
                kind="tool_exposure",
                title="Tool exposure",
                content="Available tools: read_file",
            ),
        ),
        contextual_user_sections=(
            InstructionFragment(
                kind="runtime_policy",
                title="Runtime policy",
                content=contextual_content,
            ),
        ),
        conversation_messages=(
            Message(role="user", content="Earlier request"),
            Message(role="assistant", content="Earlier answer"),
        ),
        current_user_request=current_user_request,
    )


def test_request_shape_builder_keeps_stable_hashes_when_volatile_context_changes(
    tmp_path: Path,
) -> None:
    builder = RequestShapeBuilder()
    config = AgentConfig(
        workspace_root=tmp_path,
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
    )
    first = builder.build(
        config=config,
        contract=_contract(
            current_user_request="fix cache",
            contextual_content="Runtime policy: step 1",
        ),
        tools=(
            _tool("read_file"),
            _tool("search_text"),
        ),
    )
    second = builder.build(
        config=config,
        contract=_contract(
            current_user_request="fix cache again",
            contextual_content="Runtime policy: step 2",
        ),
        tools=(
            _tool("search_text"),
            _tool("read_file"),
        ),
    )

    assert first.system_hash == second.system_hash
    assert first.tool_schema_hash == second.tool_schema_hash
    assert first.tool_order_hash == second.tool_order_hash
    assert first.volatile_hash != second.volatile_hash


def test_request_shape_builder_changes_tool_schema_hash_for_parameter_changes(
    tmp_path: Path,
) -> None:
    builder = RequestShapeBuilder()
    config = AgentConfig(workspace_root=tmp_path)
    base_contract = _contract(
        current_user_request="inspect",
        contextual_content="Runtime policy: same",
    )

    first = builder.build(
        config=config,
        contract=base_contract,
        tools=(
            _tool(
                "read_file",
                parameters=(ModelToolParameter(name="path", type="string"),),
            ),
        ),
    )
    second = builder.build(
        config=config,
        contract=base_contract,
        tools=(
            _tool(
                "read_file",
                parameters=(
                    ModelToolParameter(name="path", type="string"),
                    ModelToolParameter(name="offset", type="integer", required=False),
                ),
            ),
        ),
    )

    assert first.tool_order_hash == second.tool_order_hash
    assert first.tool_schema_hash != second.tool_schema_hash


def test_request_shape_builder_orders_intent_before_volatile_context(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=_contract(
            current_user_request="current task",
            contextual_content="volatile runtime context",
        ),
        tools=(_tool("read_file"),),
    )

    fragment_ids = [fragment.id for fragment in shape.fragments]
    provider_roles = [message.role for message in shape.provider_messages]
    provider_contents = [message.content for message in shape.provider_messages]

    assert fragment_ids == [
        "stable:system",
        "stable:tool_schema",
        "replay:conversation",
        "intent:current",
        "volatile:runtime_policy",
    ]
    assert shape.fragments[2].kind is RequestFragmentKind.REPLAY
    assert shape.fragments[2].stability is FragmentStability.REPLAY
    assert provider_roles == ["system", "developer", "user", "assistant", "user", "user"]
    assert provider_contents[-2] == "Current user request: current task"
    assert provider_contents[-1] == "volatile runtime context"


def test_request_shape_builder_splits_contextual_sections_for_diagnostics(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="environment_context",
                    title="Environment",
                    content="Workspace root: /tmp/demo",
                ),
                InstructionFragment(
                    kind="memory",
                    title="Memory",
                    content="Memory: prefers concise replies",
                ),
                InstructionFragment(
                    kind="plan",
                    title="Plan",
                    content="Current plan: inspect",
                ),
                InstructionFragment(
                    kind="runtime_policy",
                    title="Runtime policy",
                    content="Runtime policy: source_first",
                ),
            ),
            current_user_request="inspect",
        ),
        tools=(_tool("read_file"),),
    )

    fragments = {fragment.id: fragment for fragment in shape.fragments}

    assert "volatile:context" not in fragments
    assert fragments["volatile:environment_context"].kind is RequestFragmentKind.VOLATILE
    assert fragments["retrieved_memory"].kind is RequestFragmentKind.RETRIEVED_MEMORY
    assert fragments["volatile:plan"].kind is RequestFragmentKind.VOLATILE
    assert fragments["volatile:runtime_policy"].kind is RequestFragmentKind.VOLATILE
    assert shape.provider_messages[-1].content == "\n".join(
        [
            "Workspace root: /tmp/demo",
            "Memory: prefers concise replies",
            "Current plan: inspect",
            "Runtime policy: source_first",
        ]
    )


def test_request_shape_builder_does_not_duplicate_current_user_request_in_replay(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=(
                Message(role="user", content="current task"),
                Message(role="assistant", content="I will inspect it."),
            ),
            current_user_request="current task",
        ),
        tools=(_tool("read_file"),),
    )

    user_messages = [
        message.content for message in shape.provider_messages if message.role == "user"
    ]

    assert user_messages == ["Current user request: current task"]
    assert "user: current task" not in shape.fragments[2].content
    assert "assistant: I will inspect it." in shape.fragments[2].content


def test_request_shape_builder_preserves_structured_runtime_replay_blocks(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=(
                Message(
                    role="assistant",
                    content="",
                    blocks=(
                        RuntimeBlock(type="text", text="I will inspect."),
                        RuntimeBlock(
                            type="tool_call",
                            tool_name="read_file",
                            tool_arguments={"path": "README.md"},
                            call_id="call_read_1",
                        ),
                    ),
                ),
                Message(
                    role="tool",
                    content="Tool read_file: README",
                    tool_call_id="call_read_1",
                    blocks=(
                        RuntimeBlock(
                            type="tool_result",
                            text="Tool read_file: README",
                            call_id="call_read_1",
                        ),
                    ),
                ),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("read_file"),),
    )

    assistant_item = next(item for item in shape.provider_runtime_items if item.role == "assistant")
    tool_item = next(item for item in shape.provider_runtime_items if item.role == "tool")

    assert [block.type for block in assistant_item.blocks] == ["text", "tool_call"]
    assert assistant_item.blocks[1].call_id == "call_read_1"
    assert tool_item.blocks[0].type == "tool_result"
    assert tool_item.blocks[0].call_id == "call_read_1"


def test_request_shape_builder_removes_replayed_lines_from_volatile_conversation_context(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="conversation_context",
                    title="Conversation context",
                    content=(
                        "这是本轮相关的近期对话上下文。\n"
                        "Conversation summary: User asked for a repo inspection.\n"
                        "Recent conversation:\n"
                        "user: inspect repo\n"
                        "assistant: I will inspect README.\n"
                        "tool: Tool read_file: README content"
                    ),
                ),
            ),
            conversation_messages=(
                Message(role="user", content="inspect repo"),
                Message(role="assistant", content="I will inspect README."),
                Message(role="tool", content="Tool read_file: README content"),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("read_file"),),
    )

    volatile_fragment = next(
        fragment for fragment in shape.fragments if fragment.id == "volatile:conversation_context"
    )
    volatile_payload = shape.provider_messages[-1].content

    assert "Conversation summary: User asked for a repo inspection." in volatile_fragment.content
    assert "user: inspect repo" not in volatile_fragment.content
    assert "assistant: I will inspect README." not in volatile_fragment.content
    assert "tool: Tool read_file: README content" not in volatile_fragment.content
    assert "user: inspect repo" not in volatile_payload
    assert "assistant: I will inspect README." not in volatile_payload
    assert "tool: Tool read_file: README content" not in volatile_payload
