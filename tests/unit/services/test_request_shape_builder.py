from __future__ import annotations

from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.runtime import AgentConfig, InstructionContract, InstructionFragment
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
        "volatile:context",
    ]
    assert shape.fragments[2].kind is RequestFragmentKind.REPLAY
    assert shape.fragments[2].stability is FragmentStability.REPLAY
    assert provider_roles == ["system", "developer", "user", "assistant", "user", "user"]
    assert provider_contents[-2] == "Current user request: current task"
    assert provider_contents[-1] == "volatile runtime context"


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
