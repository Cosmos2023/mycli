from __future__ import annotations

from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    AgentConfig,
    InstructionContract,
    InstructionFragment,
    ProtocolId,
    RuntimeBlock,
)
from mycli.domain.runtime.request_shape import (
    FragmentStability,
    RequestFragmentKind,
)
from mycli.llms.adapters.base import (
    ModelToolDefinition,
    ModelToolParameter,
)
from mycli.application.runtime.request import RequestShapeBuilder, RequestShapePayloadFormatter
from mycli.domain.tools import ToolCall


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
                kind="runtime_reminders",
                title="Runtime reminders",
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
            contextual_content="Runtime reminders: step 1",
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
            contextual_content="Runtime reminders: step 2",
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
        contextual_content="Runtime reminders: same",
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
        config=AgentConfig(
            workspace_root=tmp_path,
            protocol=ProtocolId.ANTHROPIC_MESSAGES,
        ),
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
        "volatile:runtime_reminders",
    ]
    assert shape.fragments[2].kind is RequestFragmentKind.REPLAY
    assert shape.fragments[2].stability is FragmentStability.REPLAY
    assert provider_roles == ["system", "developer", "user", "assistant", "user", "user"]
    assert provider_contents[-2] == "Current user request: current task"
    assert provider_contents[-1] == "volatile runtime context"


def test_request_shape_builder_omits_conversation_context_but_keeps_runtime_reminders_for_responses_payload(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            protocol=ProtocolId.RESPONSES,
        ),
        contract=InstructionContract(
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
                    kind="conversation_context",
                    title="Conversation context",
                    content=(
                        "这是本轮相关的近期对话上下文。\n"
                        "Conversation summary: previous user summary\n"
                        "- [file_excerpt] src/mycli/application/runtime/agent_runtime.py:1-100"
                    ),
                ),
                InstructionFragment(
                    kind="runtime_reminders",
                    title="Runtime reminders",
                    content="Runtime reminders: use compact answers",
                ),
            ),
            conversation_messages=(
                Message(role="user", content="previous request"),
                Message(role="assistant", content="previous answer"),
            ),
            current_user_request="new query",
        ),
        tools=(_tool("read_file"),),
    )

    provider_payload = "\n".join(message.content for message in shape.provider_messages)
    runtime_payload = "\n".join(
        block.text or ""
        for item in shape.provider_runtime_items
        for block in item.blocks
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "developer",
        "user",
        "assistant",
        "user",
        "user",
    ]
    assert shape.provider_runtime_items[-2].blocks == (
        RuntimeBlock(type="text", text="new query"),
    )
    assert shape.provider_runtime_items[-1].blocks == (
        RuntimeBlock(type="text", text="Runtime reminders: use compact answers"),
    )
    assert shape.provider_messages[-2].content == "new query"
    assert shape.provider_messages[-1].content == "Runtime reminders: use compact answers"
    assert "Conversation summary:" not in provider_payload
    assert "[file_excerpt]" not in provider_payload
    assert "Current user request:" not in provider_payload
    assert "Runtime reminders: use compact answers" in provider_payload
    assert "Conversation summary:" not in runtime_payload
    assert "[file_excerpt]" not in runtime_payload
    assert "Current user request:" not in runtime_payload
    assert "Runtime reminders: use compact answers" in runtime_payload
    assert any(
        fragment.id == "volatile:conversation_context"
        and "Conversation summary:" in fragment.content
        for fragment in shape.fragments
    )


def test_request_shape_builder_uses_transcript_only_messages_for_deepseek_chat(
    tmp_path: Path,
) -> None:
    tool_call = ToolCall(
        name="read_file",
        arguments={"path": "README.md"},
        reason="inspect",
        call_id="call_read_1",
    )
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="deepseek",
            protocol="chat_completions",
            model="deepseek-v4-flash",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            developer_sections=(
                InstructionFragment(
                    kind="tool_exposure",
                    title="Tool exposure",
                    content="Available tools: read_file, search_text",
                ),
            ),
            contextual_user_sections=(
                InstructionFragment(
                    kind="runtime_reminders",
                    title="Runtime reminders",
                    content="Runtime reminders: use compact answers",
                ),
                InstructionFragment(
                    kind="environment_context",
                    title="Environment",
                    content="Workspace root: /tmp/demo",
                ),
                InstructionFragment(
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                ),
            ),
            conversation_messages=(
                Message(role="user", content="inspect README"),
                Message(
                    role="assistant",
                    content="",
                    tool_calls=(tool_call,),
                    blocks=(
                        RuntimeBlock(
                            type="reasoning",
                            text="Need the README before answering.",
                            metadata={
                                "deepseek": {
                                    "reasoning_content": "Need the README before answering."
                                }
                            },
                        ),
                        RuntimeBlock(type="text", text="I will read README."),
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
                    content="README contents",
                    tool_call_id="call_read_1",
                ),
            ),
            current_user_request="summarize the result",
        ),
        tools=(_tool("search_text"), _tool("read_file")),
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "user",
        "assistant",
        "tool",
        "user",
        "user",
    ]
    assert [message.content for message in shape.provider_messages] == [
        "Stable system rules.",
        "inspect README",
        "I will read README.",
        "README contents",
        "summarize the result",
        "Available skills:\n- code-review: Review code",
    ]
    assert [item.role for item in shape.provider_runtime_items] == [
        "system",
        "user",
        "assistant",
        "tool",
        "user",
        "user",
    ]
    assert shape.provider_runtime_items[-2].blocks == (
        RuntimeBlock(type="text", text="summarize the result"),
    )
    assert all(message.role != "developer" for message in shape.provider_messages)
    assert all(item.role != "developer" for item in shape.provider_runtime_items)
    assert all(
        "Current user request:" not in message.content
        for message in shape.provider_messages
    )
    runtime_payload = "\n".join(
        block.text or ""
        for item in shape.provider_runtime_items
        for block in item.blocks
    )
    assert "Current user request:" not in runtime_payload
    assert "Runtime reminders:" not in runtime_payload
    assert "Workspace root:" not in runtime_payload
    assert "Available skills:" in runtime_payload
    provider_payload = "\n".join(message.content for message in shape.provider_messages)
    assert "Runtime reminders:" not in provider_payload
    assert "Workspace root:" not in provider_payload
    assert "Available skills:" in provider_payload
    assistant_message = shape.provider_messages[2]
    assert assistant_message.metadata["tool_calls"] == (tool_call,)
    assert assistant_message.metadata["model_metadata"] == {
        "deepseek": {"reasoning_content": "Need the README before answering."}
    }
    legacy_messages = RequestShapePayloadFormatter().legacy_messages(shape)
    assert legacy_messages[2].content == "I will read README."
    assert legacy_messages[2].tool_calls == (tool_call,)
    assert legacy_messages[2].metadata == {
        "deepseek": {"reasoning_content": "Need the README before answering."}
    }


def test_request_shape_builder_excludes_runtime_reminders_from_chat_completions_payload(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="deepseek",
            protocol="chat_completions",
            model="deepseek-v4-flash",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="runtime_reminders",
                    title="Runtime reminders",
                    content="Runtime reminders: use compact answers",
                ),
            ),
            conversation_messages=(
                Message(role="user", content="review this"),
                Message(role="assistant", content="loading skill"),
            ),
            current_user_request="review this",
        ),
        tools=(_tool("Skill"),),
    )

    payload = "\n".join(message.content for message in shape.provider_messages)

    assert "Runtime reminders:" not in payload


def test_request_shape_builder_filters_orphan_tool_messages_for_chat_completions(
    tmp_path: Path,
) -> None:
    kept_call = ToolCall(
        name="Read",
        arguments={"file_path": "kept.md"},
        reason="inspect",
        call_id="call_kept",
    )
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="deepseek",
            protocol="chat_completions",
            model="deepseek-v4-flash",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            developer_sections=(),
            contextual_user_sections=(),
            conversation_messages=(
                Message(role="user", content="inspect files"),
                Message(
                    role="tool",
                    content="[archived: earlier tool result. call_id: call_orphan]",
                    tool_call_id="call_orphan",
                ),
                Message(
                    role="assistant",
                    content="",
                    tool_calls=(kept_call,),
                ),
                Message(
                    role="tool",
                    content="kept contents",
                    tool_call_id="call_kept",
                ),
            ),
            current_user_request="finish",
        ),
        tools=(_tool("Read"),),
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "user",
        "assistant",
        "tool",
        "user",
    ]
    assert all(
        message.metadata.get("tool_call_id") != "call_orphan"
        for message in shape.provider_messages
    )
    assert shape.provider_messages[3].metadata["tool_call_id"] == "call_kept"


def test_request_shape_builder_keeps_current_user_query_in_replay_for_tool_loop_prefix(
    tmp_path: Path,
) -> None:
    builder = RequestShapeBuilder()
    config = AgentConfig(workspace_root=tmp_path)
    first = builder.build(
        config=config,
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=(Message(role="user", content="inspect repo"),),
            current_user_request="inspect repo",
        ),
        tools=(_tool("read_file"),),
    )
    second = builder.build(
        config=config,
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=(
                Message(role="user", content="inspect repo"),
                Message(role="assistant", content="I will inspect README."),
                Message(role="tool", content="Read README.md"),
            ),
            current_user_request="inspect repo",
        ),
        tools=(_tool("read_file"),),
    )

    assert [message.content for message in first.provider_messages] == [
        "Stable system rules.",
        "inspect repo",
    ]
    assert [message.content for message in second.provider_messages[:2]] == [
        "Stable system rules.",
        "inspect repo",
    ]
    assert first.provider_messages[1].role == "user"
    assert second.provider_messages[1].role == "user"
    assert "user: inspect repo" in first.fragments[2].content


def test_request_shape_builder_splits_contextual_sections_for_diagnostics(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            protocol=ProtocolId.ANTHROPIC_MESSAGES,
        ),
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
                    kind="runtime_reminders",
                    title="Runtime reminders",
                    content="Runtime reminders: use compact answers",
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
    assert fragments["volatile:runtime_reminders"].kind is RequestFragmentKind.VOLATILE
    assert shape.provider_messages[-1].content == "\n".join(
        [
            "Workspace root: /tmp/demo",
            "Memory: prefers concise replies",
            "Current plan: inspect",
            "Runtime reminders: use compact answers",
        ]
    )


def test_request_shape_builder_uses_replayed_current_user_request_without_duplicate_intent_message(
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

    assert user_messages == ["current task"]
    assert "user: current task" in shape.fragments[2].content
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


def test_request_shape_builder_does_not_duplicate_tool_names_in_developer_payload(
    tmp_path: Path,
) -> None:
    first = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            developer_sections=(
                InstructionFragment(
                    kind="tool_exposure",
                    title="Tool exposure",
                    content=(
                        "Use exposed tools only.\n"
                        "Available tools: read_file, search_text"
                    ),
                ),
            ),
            current_user_request="inspect",
        ),
        tools=(_tool("read_file"), _tool("search_text")),
    )
    second = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            developer_sections=(
                InstructionFragment(
                    kind="tool_exposure",
                    title="Tool exposure",
                    content="Use exposed tools only.\nAvailable tools: run_shell",
                ),
            ),
            current_user_request="inspect",
        ),
        tools=(_tool("read_file"), _tool("search_text")),
    )

    first_developer = next(
        message for message in first.provider_messages if message.role == "developer"
    )
    second_developer = next(
        message for message in second.provider_messages if message.role == "developer"
    )

    assert first_developer.content == second_developer.content
    assert "Available tools:" not in first_developer.content
    assert "read_file" not in first_developer.content
    assert "run_shell" not in second_developer.content


def test_request_shape_builder_keeps_reasoning_blocks_out_of_textual_replay(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=(
                Message(
                    role="assistant",
                    content="Private reasoning that must not become assistant text.",
                    blocks=(
                        RuntimeBlock(
                            type="reasoning",
                            text="Private reasoning that must not become assistant text.",
                            metadata={"deepseek": {"reasoning_content": "private"}},
                        ),
                    ),
                ),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("read_file"),),
    )

    assert "Private reasoning" not in shape.fragments[2].content
    assert not any(
        message.role == "assistant" and "Private reasoning" in message.content
        for message in shape.provider_messages
    )
    assistant_item = next(item for item in shape.provider_runtime_items if item.role == "assistant")
    assert assistant_item.blocks[0].type == "reasoning"


def test_request_shape_builder_includes_skill_catalog_in_responses_delta_context(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path, protocol=ProtocolId.RESPONSES),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                ),
            ),
            current_user_request="review this",
        ),
        tools=(_tool("Skill"),),
    )

    user_messages = [
        message.content for message in shape.provider_messages if message.role == "user"
    ]

    assert any("Available skills" in str(content) for content in user_messages)
