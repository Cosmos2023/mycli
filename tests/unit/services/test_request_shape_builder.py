from __future__ import annotations

from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.providers import ProviderId
from mycli.domain.runtime import (
    AgentConfig,
    CanonicalTimelineDurability,
    CanonicalTimelineScope,
    InstructionContract,
    InstructionFragment,
    ProtocolId,
    RuntimeBlock,
)
from mycli.domain.runtime.request_shape import (
    FragmentStability,
    ProviderCachePolicyCapability,
    RequestFragmentKind,
)
from mycli.llms.adapters.base import (
    ModelToolDefinition,
    ModelToolParameter,
)
from mycli.application.runtime.request import RequestShapeBuilder, RequestShapePayloadFormatter
from mycli.application.runtime.request.cache_shape_diagnostics import CacheShapeDiagnostics
from mycli.application.runtime.request.request_pipeline import RequestPipeline
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.trace_service import TraceService
from mycli.utils.workspace_logger import WorkspaceLogService
from mycli.domain.tools import ToolCall
from mycli.tools.base import ToolEffectProfile, tool_effects_for_tool
from mycli.tools.write import WriteTool


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
    assert first.provider_request_policy is not None
    assert second.provider_request_policy is not None
    assert first.provider_request_policy.prompt_cache_key == (
        second.provider_request_policy.prompt_cache_key
    )


def test_request_shape_builder_preserves_context_section_metadata(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="memory",
                    title="Memory",
                    content="<memory-context>reference only</memory-context>",
                    source="memory",
                    metadata={
                        "cache_class": "dynamic",
                        "record_count": 1,
                    },
                ),
            ),
            current_user_request="continue",
        ),
        tools=(),
    )

    fragment = next(item for item in shape.fragments if item.id == "replay:retrieved_memory")
    assert fragment.metadata["cache_class"] == "dynamic"
    assert fragment.metadata["record_count"] == 1
    assert fragment.metadata["instruction_fragment_kind"] == "memory"


def test_request_shape_builder_preserves_canonical_persistence_metadata(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="memory",
                    title="Memory",
                    content="<memory-context>reference only</memory-context>",
                    source="memory",
                    metadata={
                        "cache_class": "dynamic",
                        "durability": CanonicalTimelineDurability.PERSISTENT.value,
                        "scope": CanonicalTimelineScope.TRANSCRIPT.value,
                        "provider_state": {
                            "codex_reasoning_items": [{"encrypted_content": "opaque"}],
                        },
                    },
                ),
                InstructionFragment(
                    kind="compaction_rehydration",
                    title="Compaction rehydration",
                    content="<compaction-rehydration>continue current turn</compaction-rehydration>",
                    source="compact",
                    metadata={
                        "cache_class": "dynamic",
                        "durability": CanonicalTimelineDurability.PERSISTENT.value,
                        "scope": CanonicalTimelineScope.TURN.value,
                    },
                ),
            ),
            current_user_request="continue",
        ),
        tools=(),
    )

    memory_fragment = next(
        item for item in shape.fragments if item.id == "replay:retrieved_memory"
    )
    rehydration_fragment = next(
        item for item in shape.fragments if item.id == "replay:compaction_rehydration"
    )

    assert memory_fragment.metadata["durability"] == "persistent"
    assert memory_fragment.metadata["scope"] == "transcript"
    assert memory_fragment.metadata["model_visible"] is True
    assert memory_fragment.metadata["replayable"] is True
    assert "provider_state" not in memory_fragment.metadata
    assert memory_fragment.metadata["provider_state_keys"] == ("codex_reasoning_items",)
    assert rehydration_fragment.metadata["durability"] == "persistent"
    assert rehydration_fragment.metadata["scope"] == "turn"
    assert rehydration_fragment.metadata["replayable"] is False
    assert shape.fragments[-1].id == "intent:current"


def test_request_shape_builder_marks_replay_fragment_with_cache_metadata(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=(
                Message(role="user", content="Earlier request"),
                Message(role="assistant", content="Earlier answer"),
            ),
            current_user_request="continue",
        ),
        tools=(),
    )

    fragment = next(item for item in shape.fragments if item.id == "replay:conversation")
    assert fragment.metadata["cache_class"] == "dynamic"
    assert fragment.metadata["source"] == "conversation_replay"
    assert fragment.metadata["section_hash"] == fragment.content_hash


def test_request_shape_builder_uses_cache_class_for_fragment_stability_and_prefix(
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
                    kind="runtime_reminders",
                    title="Runtime reminders",
                    content="Runtime reminders: current turn only",
                    metadata={"cache_class": "ephemeral"},
                ),
                InstructionFragment(
                    kind="memory",
                    title="Memory",
                    content="Memory: stable enough for this task",
                    metadata={"cache_class": "dynamic"},
                ),
                InstructionFragment(
                    kind="workspace_instructions",
                    title="Workspace",
                    content="<workspace-context>Use pytest.</workspace-context>",
                    source=".mycli.md",
                    metadata={"cache_class": "static"},
                ),
            ),
            conversation_messages=(
                Message(role="user", content="previous request"),
            ),
            current_user_request="current request",
        ),
        tools=(_tool("read_file"),),
    )

    fragment_ids = [fragment.id for fragment in shape.fragments]
    assert fragment_ids == [
        "stable:system",
        "stable:tool_schema",
        "stable:workspace_instructions",
        "replay:conversation",
        "replay:retrieved_memory",
        "volatile:runtime_reminders",
        "intent:current",
    ]
    assert shape.fragments[2].stability is FragmentStability.STABLE
    assert shape.fragments[4].stability is FragmentStability.REPLAY
    assert shape.fragments[6].stability is FragmentStability.VOLATILE
    assert shape.cacheable_prefix_fragment_ids() == (
        "stable:system",
        "stable:tool_schema",
        "stable:workspace_instructions",
    )
    assert shape.estimated_cacheable_prefix_chars() > len("Stable system rules.")
    assert shape.fragments[2].metadata["source"] == ".mycli.md"
    assert shape.fragments[2].metadata["section_hash"]
    assert [message.content for message in shape.provider_messages] == [
        "Stable system rules.",
        "<workspace-context>Use pytest.</workspace-context>",
        "previous request",
        "Memory: stable enough for this task",
        "Current user request: current request",
    ]
    assert shape.provider_projection is not None
    assert shape.provider_projection.to_dict() == {
        "lane": "anthropic_messages",
        "message_count": 5,
        "runtime_item_count": 5,
        "cacheable_prefix_fragment_count": 3,
        "first_dynamic_fragment_index": 3,
        "first_ephemeral_fragment_index": 5,
        "cache_hint": "cache_control_breakpoint_candidates",
        "wire_only_hints": ("cache_control",),
    }
    assert shape.compact_policy_summary() == {
        "engine": "canonical",
        "cheap_pruning_scope": "dynamic_replay",
        "stable_prefix_protected": True,
        "rehydration_cache_class": "dynamic",
        "provider_specific_compact": False,
    }


def test_request_shape_builder_keeps_cacheable_prefix_stable_for_new_user_request(
    tmp_path: Path,
) -> None:
    builder = RequestShapeBuilder()
    config = AgentConfig(
        workspace_root=tmp_path,
        protocol=ProtocolId.ANTHROPIC_MESSAGES,
    )

    def contract(user_request: str) -> InstructionContract:
        return InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="workspace_instructions",
                    title="Workspace",
                    content="<workspace-context>Use pytest.</workspace-context>",
                    source=".mycli.md",
                    metadata={"cache_class": "static"},
                ),
                InstructionFragment(
                    kind="runtime_reminders",
                    title="Runtime reminders",
                    content=f"Runtime reminders for {user_request}",
                    metadata={"cache_class": "ephemeral"},
                ),
            ),
            current_user_request=user_request,
        )

    first = builder.build(config=config, contract=contract("first task"), tools=(_tool("Read"),))
    second = builder.build(config=config, contract=contract("second task"), tools=(_tool("Read"),))

    assert first.cacheable_prefix_hash() == second.cacheable_prefix_hash()
    assert first.volatile_hash != second.volatile_hash
    assert first.provider_projection is not None
    assert second.provider_projection is not None
    assert first.provider_projection.cache_hint == second.provider_projection.cache_hint
    assert first.provider_projection.wire_only_hints == ("cache_control",)


def test_request_shape_builder_marks_anthropic_cache_policy_on_wire_items(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="anthropic",
            protocol=ProtocolId.ANTHROPIC_MESSAGES,
            model="claude-test",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="workspace_instructions",
                    title="Workspace",
                    content="<workspace>static</workspace>",
                    metadata={"cache_class": "static"},
                ),
                InstructionFragment(
                    kind="compaction_rehydration",
                    title="Compaction rehydration",
                    content="<compaction>summary</compaction>",
                    metadata={"cache_class": "dynamic"},
                ),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("read_file"),),
    )

    assert shape.provider_request_policy is not None
    assert shape.provider_request_policy.anthropic_cache_control_breakpoints == (
        "system_static",
        "dynamic_boundary",
        "long_context_1",
        "long_context_2",
    )
    assert shape.provider_runtime_items[0].metadata[
        "anthropic_cache_control_breakpoint"
    ] == "system_static"
    assert shape.provider_runtime_items[1].metadata["cache_class"] == "static"
    assert (
        "anthropic_cache_control_breakpoint"
        not in shape.provider_runtime_items[1].metadata
    )
    dynamic_item = next(
        item
        for item in shape.provider_runtime_items
        if item.metadata.get("cache_class") == "dynamic"
    )
    assert dynamic_item.metadata["anthropic_cache_control_breakpoint"] == (
        "dynamic_boundary"
    )


def test_request_shape_builder_reports_responses_projection_contract(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="openai",
            protocol=ProtocolId.RESPONSES,
            model="gpt-5",
        ),
        contract=_contract(
            current_user_request="inspect",
            contextual_content="Runtime reminders: current turn only",
        ),
        tools=(_tool("read_file"),),
    )

    assert shape.provider_projection is not None
    assert shape.provider_projection.to_dict()["lane"] == "responses"
    assert shape.provider_projection.cache_hint == "prompt_cache_key_candidate"
    assert shape.provider_projection.wire_only_hints == ("prompt_cache_key",)


def test_request_shape_builder_reports_chat_completion_projection_contract(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="compatible",
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="compatible-model",
        ),
        contract=_contract(
            current_user_request="inspect",
            contextual_content="Runtime reminders: current turn only",
        ),
        tools=(_tool("read_file"),),
    )

    assert shape.provider_projection is not None
    assert shape.provider_projection.to_dict()["lane"] == "chat_completions"
    assert shape.provider_projection.cache_hint == "stable_transcript_prefix"
    assert shape.provider_projection.wire_only_hints == ()


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


def test_request_shape_builder_ignores_tool_mutation_metadata_for_stable_hashes(
    tmp_path: Path,
) -> None:
    builder = RequestShapeBuilder()
    config = AgentConfig(workspace_root=tmp_path)
    contract = _contract(
        current_user_request="update notes",
        contextual_content="Runtime reminders: keep cache stable",
    )
    write_tool = WriteTool(tmp_path)
    rendered_tool = _tool(
        write_tool.spec.name,
        parameters=(
            ModelToolParameter(
                name=parameter.name,
                type=parameter.type,
                required=parameter.required,
                description=parameter.description,
                items_schema=parameter.items_schema,
            )
            for parameter in write_tool.spec.parameters
        ),
    )

    first = builder.build(config=config, contract=contract, tools=(rendered_tool,))
    assert write_tool.mutation_targets(
        {"file_path": "notes.txt", "content": "after\n"}
    ) == ("notes.txt",)
    second = builder.build(config=config, contract=contract, tools=(rendered_tool,))

    assert first.system_hash == second.system_hash
    assert first.tool_schema_hash == second.tool_schema_hash
    assert first.tool_order_hash == second.tool_order_hash


def test_request_shape_builder_ignores_tool_effect_metadata_for_stable_hashes(
    tmp_path: Path,
) -> None:
    builder = RequestShapeBuilder()
    config = AgentConfig(workspace_root=tmp_path)
    contract = _contract(
        current_user_request="inspect tool effects",
        contextual_content="Runtime reminders: keep cache stable",
    )
    write_tool = WriteTool(tmp_path)
    rendered_tool = _tool(
        write_tool.spec.name,
        parameters=tuple(
            ModelToolParameter(
                name=parameter.name,
                type=parameter.type,
                required=parameter.required,
                description=parameter.description,
                items_schema=parameter.items_schema,
            )
            for parameter in write_tool.spec.parameters
        ),
    )

    first = builder.build(config=config, contract=contract, tools=(rendered_tool,))
    assert tool_effects_for_tool(write_tool) == ToolEffectProfile(filesystem="write")
    second = builder.build(config=config, contract=contract, tools=(rendered_tool,))

    assert first.system_hash == second.system_hash
    assert first.tool_schema_hash == second.tool_schema_hash
    assert first.tool_order_hash == second.tool_order_hash


def test_request_shape_builder_ignores_write_diagnostics_metadata_for_stable_hashes(
    tmp_path: Path,
) -> None:
    builder = RequestShapeBuilder()
    config = AgentConfig(workspace_root=tmp_path)
    tool_message = Message(
        role="tool",
        content="Wrote notes.txt",
        tool_call_id="call_write_1",
        metadata={
            "write_diagnostics": {
                "diagnostics": [{"file": "notes.txt", "message": "later local metadata"}],
                "count": 1,
                "truncated": False,
            }
        },
    )
    base_contract = _contract(
        current_user_request="continue",
        contextual_content="Runtime reminders: keep cache stable",
    )
    diagnostics_contract = InstructionContract(
        base_instructions=base_contract.base_instructions,
        developer_sections=base_contract.developer_sections,
        contextual_user_sections=base_contract.contextual_user_sections,
        conversation_messages=(*base_contract.conversation_messages, tool_message),
        current_user_request=base_contract.current_user_request,
    )
    no_diagnostics_contract = InstructionContract(
        base_instructions=base_contract.base_instructions,
        developer_sections=base_contract.developer_sections,
        contextual_user_sections=base_contract.contextual_user_sections,
        conversation_messages=(
            *base_contract.conversation_messages,
            Message(
                role="tool",
                content="Wrote notes.txt",
                tool_call_id="call_write_1",
            ),
        ),
        current_user_request=base_contract.current_user_request,
    )
    rendered_tool = _tool("Write")

    first = builder.build(config=config, contract=diagnostics_contract, tools=(rendered_tool,))
    second = builder.build(config=config, contract=no_diagnostics_contract, tools=(rendered_tool,))

    assert first.system_hash == second.system_hash
    assert first.tool_schema_hash == second.tool_schema_hash
    assert first.tool_order_hash == second.tool_order_hash
    assert first.replay_hash == second.replay_hash


def test_request_shape_builder_places_current_user_input_after_volatile_context(
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
        "volatile:runtime_reminders",
        "intent:current",
    ]
    assert shape.fragments[2].kind is RequestFragmentKind.REPLAY
    assert shape.fragments[2].stability is FragmentStability.REPLAY
    assert provider_roles == ["system", "developer", "user", "assistant", "user"]
    assert "volatile runtime context" not in "\n".join(provider_contents)
    assert provider_contents[-1] == "Current user request: current task"


def test_request_shape_builder_omits_runtime_reminders_from_responses_payload(
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
    ]
    assert [item.role for item in shape.provider_runtime_items] == [
        "system",
        "developer",
        "user",
        "assistant",
        "user",
    ]
    assert shape.provider_runtime_items[-1].blocks == (
        RuntimeBlock(type="text", text="new query"),
    )
    assert shape.provider_messages[-1].content == "new query"
    assert "Conversation summary:" not in provider_payload
    assert "[file_excerpt]" not in provider_payload
    assert "Current user request:" not in provider_payload
    assert "Runtime reminders: use compact answers" not in provider_payload
    assert "Conversation summary:" not in runtime_payload
    assert "[file_excerpt]" not in runtime_payload
    assert "Current user request:" not in runtime_payload
    assert "Runtime reminders: use compact answers" not in runtime_payload
    assert any(
        fragment.id == "replay:conversation_context"
        and "Conversation summary:" in fragment.content
        for fragment in shape.fragments
    )


def test_request_shape_builder_appends_responses_post_tool_context_to_tool_result(
    tmp_path: Path,
) -> None:
    tool_call = ToolCall(
        name="Bash",
        arguments={"command": "ls"},
        reason="inspect files",
        call_id="call_ls",
    )
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            protocol=ProtocolId.RESPONSES,
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=(
                Message(role="user", content="inspect files"),
                Message(role="assistant", content="", tool_calls=(tool_call,)),
                Message(
                    role="tool",
                    content="README.md",
                    tool_call_id="call_ls",
                    metadata={
                        "post_tool_additional_contexts": (
                            "Use the ls result; do not repeat ls.",
                        )
                    },
                ),
            ),
            current_user_request="inspect files",
        ),
        tools=(_tool("Bash"),),
    )

    tool_item = next(item for item in shape.provider_runtime_items if item.role == "tool")
    assert tool_item.blocks == (
        RuntimeBlock(
            type="tool_result",
            text=(
                "README.md\n\n"
                "<tool_runtime_reminder>\n"
                "Use the ls result; do not repeat ls.\n"
                "</tool_runtime_reminder>"
            ),
            metadata={
                "post_tool_additional_contexts": (
                    "Use the ls result; do not repeat ls.",
                )
            },
            call_id="call_ls",
        ),
    )
    assert [item.role for item in shape.provider_runtime_items] == [
        "system",
        "user",
        "assistant",
        "tool",
    ]


def test_request_shape_builder_appends_anthropic_post_tool_context_to_tool_result(
    tmp_path: Path,
) -> None:
    tool_call = ToolCall(
        name="Bash",
        arguments={"command": "ls"},
        reason="inspect files",
        call_id="call_ls",
    )
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="anthropic",
            protocol=ProtocolId.ANTHROPIC_MESSAGES,
            model="claude-test",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            conversation_messages=(
                Message(role="user", content="inspect files"),
                Message(role="assistant", content="", tool_calls=(tool_call,)),
                Message(
                    role="tool",
                    content="README.md",
                    tool_call_id="call_ls",
                    metadata={
                        "post_tool_additional_contexts": (
                            "Use the ls result; do not repeat ls.",
                        )
                    },
                ),
            ),
            current_user_request="inspect files",
        ),
        tools=(_tool("Bash"),),
    )

    tool_item = next(item for item in shape.provider_runtime_items if item.role == "tool")
    assert tool_item.blocks == (
        RuntimeBlock(
            type="tool_result",
            text=(
                "README.md\n\n"
                "<tool_runtime_reminder>\n"
                "Use the ls result; do not repeat ls.\n"
                "</tool_runtime_reminder>"
            ),
            metadata={
                "post_tool_additional_contexts": (
                    "Use the ls result; do not repeat ls.",
                )
            },
            call_id="call_ls",
        ),
    )
    assert "do not repeat ls" not in "\n".join(
        message.content
        for message in shape.provider_messages
        if message.role == "user"
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
        "user",
        "assistant",
        "tool",
        "user",
    ]
    assert "Stable system rules." in shape.provider_messages[0].content
    assert "Available skills:\n- code-review: Review code" in shape.provider_messages[0].content
    assert [message.content for message in shape.provider_messages[1:]] == [
        "Workspace root: /tmp/demo",
        "inspect README",
        "I will read README.",
        "README contents",
        "summarize the result",
    ]
    assert [item.role for item in shape.provider_runtime_items] == [
        "system",
        "user",
        "user",
        "assistant",
        "tool",
        "user",
    ]
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
    assert runtime_payload.count("Runtime reminders:") == 0
    assert "Workspace root:" in runtime_payload
    assert "Available skills:" in runtime_payload
    provider_payload = "\n".join(message.content for message in shape.provider_messages)
    assert provider_payload.count("Runtime reminders:") == 0
    assert "Workspace root:" in provider_payload
    assert "Available skills:" in provider_payload
    assistant_message = shape.provider_messages[3]
    assert assistant_message.metadata["tool_calls"] == (tool_call,)
    assert assistant_message.metadata["model_metadata"] == {
        "deepseek": {"reasoning_content": "Need the README before answering."}
    }
    legacy_messages = RequestShapePayloadFormatter().legacy_messages(shape)
    assert legacy_messages[3].content == "I will read README."
    assert legacy_messages[3].tool_calls == (tool_call,)
    assert legacy_messages[3].metadata == {
        "deepseek": {"reasoning_content": "Need the README before answering."}
    }


def test_request_shape_builder_puts_chat_static_context_in_system_prefix(
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
            developer_sections=(
                InstructionFragment(
                    kind="tool_exposure",
                    title="Tool exposure",
                    content="Available tools: read_file, search_text",
                ),
            ),
            contextual_user_sections=(
                InstructionFragment(
                    kind="workspace_instructions",
                    title="Workspace",
                    content="<workspace-context>Use pytest.</workspace-context>",
                    source=".mycli.md",
                    metadata={"cache_class": "static"},
                ),
                InstructionFragment(
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                    metadata={"cache_class": "static"},
                ),
                InstructionFragment(
                    kind="memory",
                    title="Memory",
                    content="<memory-context>Remember concise output.</memory-context>",
                    metadata={"cache_class": "dynamic"},
                ),
                InstructionFragment(
                    kind="runtime_reminders",
                    title="Runtime reminders",
                    content="Runtime reminders: current turn only",
                    metadata={"cache_class": "ephemeral"},
                ),
            ),
            conversation_messages=(
                Message(role="user", content="inspect README"),
                Message(role="assistant", content="I will inspect README."),
            ),
            current_user_request="summarize now",
        ),
        tools=(_tool("read_file"), _tool("search_text")),
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "user",
        "user",
        "assistant",
        "user",
    ]
    assert "Stable system rules." in shape.provider_messages[0].content
    assert "Use the tool schema attached to this request" in shape.provider_messages[0].content
    assert "<workspace-context>Use pytest.</workspace-context>" in shape.provider_messages[0].content
    assert "Available skills:" in shape.provider_messages[0].content
    assert "<memory-context>Remember concise output.</memory-context>" not in (
        shape.provider_messages[0].content
    )
    assert "Runtime reminders:" not in shape.provider_messages[0].content
    assert shape.provider_messages[1].content == (
        "<memory-context>Remember concise output.</memory-context>"
    )
    assert shape.provider_messages[1].metadata["cache_class"] == "dynamic"
    assert shape.provider_messages[2].content == "inspect README"
    assert shape.provider_messages[3].content == "I will inspect README."
    assert shape.provider_messages[-1].content == "summarize now"
    assert "dynamic_context_injection" not in shape.provider_messages[-1].metadata
    assert "Available skills:" not in "\n".join(
        message.content for message in shape.provider_messages[1:]
    )
    assert shape.provider_runtime_items[0].blocks == (
        RuntimeBlock(type="text", text=shape.provider_messages[0].content),
    )


def test_request_shape_builder_uses_single_chat_system_snapshot_plus_transcript(
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
            developer_sections=(
                InstructionFragment(
                    kind="tool_exposure",
                    title="Tool exposure",
                    content="Available tools: read_file, search_text",
                ),
            ),
            contextual_user_sections=(
                InstructionFragment(
                    kind="workspace_instructions",
                    title="Workspace",
                    content="<workspace-context>Use pytest.</workspace-context>",
                    metadata={"cache_class": "static"},
                ),
                InstructionFragment(
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                    metadata={"cache_class": "static"},
                ),
                InstructionFragment(
                    kind="memory",
                    title="Memory",
                    content="<memory-context>Remember concise output.</memory-context>",
                    metadata={"cache_class": "dynamic"},
                ),
                InstructionFragment(
                    kind="plan",
                    title="Current plan",
                    content="Plan: update the report.",
                    metadata={"cache_class": "dynamic"},
                ),
                InstructionFragment(
                    kind="runtime_reminders",
                    title="Runtime reminders",
                    content="Runtime reminders: current turn only",
                    metadata={"cache_class": "ephemeral"},
                ),
            ),
            conversation_messages=(
                Message(role="user", content="inspect README"),
                Message(role="assistant", content="I will inspect README."),
            ),
            current_user_request="summarize now",
        ),
        tools=(_tool("read_file"), _tool("search_text")),
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "user",
        "user",
        "assistant",
        "user",
    ]
    system = shape.provider_messages[0].content
    assert "Stable system rules." in system
    assert "Use the tool schema attached to this request" in system
    assert "<workspace-context>Use pytest.</workspace-context>" in system
    assert "Available skills:" in system
    assert "<memory-context>Remember concise output.</memory-context>" not in system
    assert "Plan: update the report." not in system
    assert "Runtime reminders: current turn only" not in system
    assert [message.content for message in shape.provider_messages[1:]] == [
        "<memory-context>Remember concise output.</memory-context>\n"
        "Plan: update the report.",
        "inspect README",
        "I will inspect README.",
        "summarize now",
    ]
    assert shape.provider_messages[1].metadata["cache_class"] == "dynamic"
    assert shape.provider_runtime_items[0].blocks == (
        RuntimeBlock(type="text", text=system),
    )
    assert [item.role for item in shape.provider_runtime_items] == [
        "system",
        "user",
        "user",
        "assistant",
        "user",
    ]
    assert shape.provider_runtime_items[1].metadata["cache_class"] == "dynamic"


def test_request_shape_builder_keeps_chat_system_prefix_stable_for_dynamic_context_changes(
    tmp_path: Path,
) -> None:
    builder = RequestShapeBuilder()
    config = AgentConfig(
        workspace_root=tmp_path,
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
    )

    def contract(*, environment: str, memory: str, plan: str) -> InstructionContract:
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
                    kind="workspace_instructions",
                    title="Workspace",
                    content="<workspace-context>Use pytest.</workspace-context>",
                    metadata={"cache_class": "static"},
                ),
                InstructionFragment(
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                    metadata={"cache_class": "static"},
                ),
                InstructionFragment(
                    kind="environment_context",
                    title="Environment",
                    content=environment,
                    metadata={"cache_class": "dynamic"},
                ),
                InstructionFragment(
                    kind="memory",
                    title="Memory",
                    content=memory,
                    metadata={"cache_class": "dynamic"},
                ),
                InstructionFragment(
                    kind="plan",
                    title="Current plan",
                    content=plan,
                    metadata={"cache_class": "dynamic"},
                ),
            ),
            conversation_messages=(
                Message(role="user", content="inspect README"),
                Message(role="assistant", content="I will inspect README."),
            ),
            current_user_request="continue",
        )

    first = builder.build(
        config=config,
        contract=contract(
            environment="Workspace root: /tmp/one",
            memory="<memory-context>Remember one.</memory-context>",
            plan="Plan: one.",
        ),
        tools=(_tool("read_file"),),
    )
    second = builder.build(
        config=config,
        contract=contract(
            environment="Workspace root: /tmp/two",
            memory="<memory-context>Remember two.</memory-context>",
            plan="Plan: two.",
        ),
        tools=(_tool("read_file"),),
    )

    assert first.provider_messages[0].content == second.provider_messages[0].content
    assert first.provider_messages[0].content_hash == second.provider_messages[0].content_hash
    assert first.stable_system == second.stable_system
    assert first.cacheable_prefix_hash() == second.cacheable_prefix_hash()
    assert "Workspace root: /tmp/one" not in first.provider_messages[0].content
    assert "Remember one" not in first.provider_messages[0].content
    assert "Plan: one." not in first.provider_messages[0].content
    assert first.provider_messages[1].content == "\n".join(
        [
            "Workspace root: /tmp/one",
            "<memory-context>Remember one.</memory-context>",
            "Plan: one.",
        ]
    )
    assert second.provider_messages[1].content == "\n".join(
        [
            "Workspace root: /tmp/two",
            "<memory-context>Remember two.</memory-context>",
            "Plan: two.",
        ]
    )


def test_request_shape_builder_keeps_chat_transcript_context_before_tool_followup(
    tmp_path: Path,
) -> None:
    tool_call = ToolCall(
        name="Write",
        arguments={"file_path": "note.txt", "content": "done"},
        reason="write requested file",
        call_id="call_write_1",
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
            contextual_user_sections=(
                InstructionFragment(
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                ),
            ),
            conversation_messages=(
                Message(role="user", content="write note"),
                Message(
                    role="assistant",
                    content="",
                    tool_calls=(tool_call,),
                ),
                Message(
                    role="tool",
                    content="Wrote note.txt",
                    tool_call_id="call_write_1",
                ),
            ),
            current_user_request="write note",
        ),
        tools=(_tool("Write"),),
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "user",
        "assistant",
        "tool",
    ]
    assert "Available skills:" in shape.provider_messages[0].content
    assert shape.provider_messages[-1].content == "Wrote note.txt"
    assert [item.role for item in shape.provider_runtime_items] == [
        "system",
        "user",
        "assistant",
        "tool",
    ]
    assert shape.provider_runtime_items[-1].blocks == (
        RuntimeBlock(type="tool_result", text="Wrote note.txt", call_id="call_write_1"),
    )


def test_request_shape_builder_appends_chat_post_tool_context_to_last_tool_output(
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
            conversation_messages=(
                Message(role="user", content="review this"),
                Message(
                    role="assistant",
                    content="",
                    tool_calls=(
                        ToolCall(
                            name="Bash",
                            arguments={"cmd": "ls"},
                            reason="inspect files",
                            call_id="call_ls",
                        ),
                    ),
                ),
                Message(
                    role="tool",
                    content="README.md\nsrc",
                    tool_call_id="call_ls",
                    metadata={
                        "post_tool_additional_contexts": (
                            "Use this directory listing; do not repeat ls.",
                        )
                    },
                ),
            ),
            current_user_request="review this",
        ),
        tools=(_tool("Skill"),),
    )

    user_messages = [
        message.content for message in shape.provider_messages if message.role == "user"
    ]
    payload = "\n".join(message.content for message in shape.provider_messages)

    assert user_messages == ["review this"]
    tool_messages = [
        message.content for message in shape.provider_messages if message.role == "tool"
    ]
    assert tool_messages == [
        "README.md\nsrc\n\n"
        "<tool_runtime_reminder>\n"
        "Use this directory listing; do not repeat ls.\n"
        "</tool_runtime_reminder>"
    ]
    assert payload.count("do not repeat ls") == 1
    assert not any(fragment.id == "volatile:runtime_reminders" for fragment in shape.fragments)
    user_items = [item for item in shape.provider_runtime_items if item.role == "user"]
    assert len(user_items) == 1
    assert user_items[0].blocks == (
        RuntimeBlock(
            type="text",
            text="review this",
        ),
    )
    tool_items = [item for item in shape.provider_runtime_items if item.role == "tool"]
    assert len(tool_items) == 1
    assert tool_items[0].blocks == (
        RuntimeBlock(
            type="tool_result",
            text=(
                "README.md\nsrc\n\n"
                "<tool_runtime_reminder>\n"
                "Use this directory listing; do not repeat ls.\n"
                "</tool_runtime_reminder>"
            ),
            metadata={
                "post_tool_additional_contexts": (
                    "Use this directory listing; do not repeat ls.",
                )
            },
            call_id="call_ls",
        ),
    )


def test_request_shape_builder_does_not_inject_chat_runtime_reminders_without_tool_result(
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
                    content="Runtime reminders: answer from compacted context",
                ),
            ),
            conversation_messages=(
                Message(role="user", content="older request"),
                Message(role="assistant", content="older answer"),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("Skill"),),
    )

    user_messages = [
        message.content for message in shape.provider_messages if message.role == "user"
    ]

    assert user_messages == ["older request", "continue"]
    assert "Runtime reminders:" not in shape.provider_messages[1].content
    assert shape.provider_runtime_items[-1].blocks == (
        RuntimeBlock(
            type="text",
            text="continue",
        ),
    )


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


def test_request_shape_builder_deduplicates_pending_tool_calls_for_chat_completions(
    tmp_path: Path,
) -> None:
    duplicated_call = ToolCall(
        name="Bash",
        arguments={"command": "identify image.jpg"},
        reason="inspect image",
        call_id="call_identify",
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
                Message(role="user", content="what is this image"),
                Message(role="assistant", content="", tool_calls=(duplicated_call,)),
                Message(role="assistant", content="", tool_calls=(duplicated_call,)),
                Message(
                    role="tool",
                    content="identify failed: command not found",
                    tool_call_id="call_identify",
                ),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("Bash"),),
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "user",
        "assistant",
        "tool",
        "user",
    ]
    tool_call_messages = [
        message
        for message in shape.provider_messages
        if message.role == "assistant" and message.metadata.get("tool_calls")
    ]
    assert len(tool_call_messages) == 1
    assert shape.provider_messages[3].metadata["tool_call_id"] == "call_identify"


def test_request_shape_builder_moves_interleaved_skill_context_after_tool_result_for_chat_completions(
    tmp_path: Path,
) -> None:
    skill_call = ToolCall(
        name="Skill",
        arguments={"skill_name": "repository-analysis"},
        reason="load skill",
        call_id="call_skill",
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
                Message(role="user", content="load repo skill"),
                Message(role="assistant", content="", tool_calls=(skill_call,)),
                Message(
                    role="user",
                    content="<skill_instructions>repository-analysis</skill_instructions>",
                    metadata={"kind": "skill_instructions"},
                ),
                Message(
                    role="tool",
                    content="Inspect the repository before answering.",
                    tool_call_id="call_skill",
                ),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("Skill"),),
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "user",
        "assistant",
        "tool",
        "user",
        "user",
    ]
    assert shape.provider_messages[3].metadata["tool_call_id"] == "call_skill"
    assert shape.provider_messages[4].content == (
        "<skill_instructions>repository-analysis</skill_instructions>"
    )


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
    assert fragments["replay:environment_context"].kind is RequestFragmentKind.VOLATILE
    assert fragments["replay:environment_context"].stability is FragmentStability.REPLAY
    assert fragments["replay:retrieved_memory"].kind is RequestFragmentKind.RETRIEVED_MEMORY
    assert fragments["replay:retrieved_memory"].stability is FragmentStability.REPLAY
    assert fragments["replay:plan"].kind is RequestFragmentKind.VOLATILE
    assert fragments["replay:plan"].stability is FragmentStability.REPLAY
    assert fragments["volatile:runtime_reminders"].kind is RequestFragmentKind.VOLATILE
    assert fragments["volatile:runtime_reminders"].stability is FragmentStability.VOLATILE
    assert shape.provider_messages[-2].content == "\n".join(
        [
            "Workspace root: /tmp/demo",
            "Memory: prefers concise replies",
            "Current plan: inspect",
        ]
    )
    assert "Runtime reminders: use compact answers" not in "\n".join(
        message.content for message in shape.provider_messages
    )
    assert shape.provider_messages[-1].content == "Current user request: inspect"


def test_request_shape_builder_keeps_runtime_environment_dynamic_before_user_tail(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            protocol=ProtocolId.RESPONSES,
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="environment_context",
                    title="Environment",
                    content="\n".join(
                        [
                            "这是本轮相关的环境事实。",
                            "Runtime environment:",
                            f"- workspace_root: {tmp_path}",
                            "- filesystem: workspace_write",
                            "- network: enabled",
                            "- shell: restricted",
                            "- approval_policy: safety_policy",
                            "- execpolicy: enabled",
                            "- execpolicy_rule_count: 2",
                            "- execpolicy_sources: project, user",
                        ]
                    ),
                ),
            ),
            current_user_request="inspect runtime",
        ),
        tools=(_tool("read_file"),),
    )

    fragments = tuple(shape.fragments)
    environment = next(
        fragment for fragment in fragments if fragment.id == "replay:environment_context"
    )

    assert environment.stability is FragmentStability.REPLAY
    assert environment.metadata["cache_class"] == "dynamic"
    assert "Runtime environment:" in environment.content
    assert "prefix_rule" not in environment.content
    assert "git push" not in environment.content
    assert fragments[-1].id == "intent:current"
    assert fragments[-1].content == "Current user request: inspect runtime"


def test_request_shape_builder_emits_chat_dynamic_context_before_tool_replay(
    tmp_path: Path,
) -> None:
    tool_call = ToolCall(
        name="Bash",
        arguments={"command": "lsof -i"},
        reason="inspect ports",
        call_id="call_lsof",
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
            contextual_user_sections=(
                InstructionFragment(
                    kind="environment_context",
                    title="Environment",
                    content="\n".join(
                        [
                            "这是本轮相关的环境事实。",
                            "Runtime environment:",
                            f"- workspace_root: {tmp_path}",
                            "- shell: restricted",
                        ]
                    ),
                ),
            ),
            conversation_messages=(
                Message(role="user", content="check ports"),
                Message(role="assistant", content="", tool_calls=(tool_call,)),
                Message(
                    role="tool",
                    content="LISTEN 127.0.0.1:4001",
                    tool_call_id="call_lsof",
                ),
            ),
            current_user_request="check ports",
        ),
        tools=(_tool("Bash"),),
    )

    assert [message.role for message in shape.provider_messages] == [
        "system",
        "user",
        "user",
        "assistant",
        "tool",
    ]
    assert shape.provider_messages[1].content == "\n".join(
        [
            "这是本轮相关的环境事实。",
            "Runtime environment:",
            f"- workspace_root: {tmp_path}",
            "- shell: restricted",
        ]
    )
    assert shape.provider_messages[1].metadata["cache_class"] == "dynamic"
    assert shape.provider_messages[2].content == "check ports"
    assert all(
        "Runtime environment:" not in message.content
        for message in shape.provider_messages[2:]
    )
    assert [item.role for item in shape.provider_runtime_items] == [
        "system",
        "user",
        "user",
        "assistant",
        "tool",
    ]
    assert shape.provider_runtime_items[1].blocks == (
        RuntimeBlock(
            type="text",
            text="\n".join(
                [
                    "这是本轮相关的环境事实。",
                    "Runtime environment:",
                    f"- workspace_root: {tmp_path}",
                    "- shell: restricted",
                ]
            ),
        ),
    )
    assert shape.provider_runtime_items[1].metadata["cache_class"] == "dynamic"
    assert shape.provider_runtime_items[2].blocks == (
        RuntimeBlock(type="text", text="check ports"),
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


def test_request_shape_builder_places_responses_dynamic_context_before_replayed_current_user(
    tmp_path: Path,
) -> None:
    assistant_tool_call = Message(
        role="assistant",
        content="",
        tool_calls=(
            ToolCall(
                name="LS",
                arguments={"path": "."},
                reason="inspect root",
                call_id="call_ls_1",
            ),
        ),
        blocks=(
            RuntimeBlock(
                type="tool_call",
                tool_name="LS",
                tool_arguments={"path": "."},
                call_id="call_ls_1",
            ),
        ),
    )
    tool_result = Message(
        role="tool",
        content="README.md",
        tool_call_id="call_ls_1",
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text="README.md",
                call_id="call_ls_1",
            ),
        ),
    )
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path, protocol=ProtocolId.RESPONSES),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="environment_context",
                    title="Environment",
                    content="这是本轮相关的环境事实。\nRuntime environment:\n- shell: restricted",
                    metadata={"cache_class": "dynamic"},
                ),
            ),
            conversation_messages=(
                Message(role="user", content="inspect repo"),
                assistant_tool_call,
                tool_result,
            ),
            current_user_request="inspect repo",
        ),
        tools=(_tool("LS"),),
    )

    item_signatures = [
        (
            item.role,
            "".join(block.text or "" for block in item.blocks)
            or ",".join(block.type for block in item.blocks),
        )
        for item in shape.provider_runtime_items
    ]

    environment_index = item_signatures.index(
        (
            "user",
            "这是本轮相关的环境事实。\nRuntime environment:\n- shell: restricted",
        )
    )
    assert item_signatures[environment_index:] == [
        (
            "user",
            "这是本轮相关的环境事实。\nRuntime environment:\n- shell: restricted",
        ),
        ("user", "inspect repo"),
        ("assistant", "tool_call"),
        ("tool", "README.md"),
    ]


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

    replay_fragment = next(
        fragment for fragment in shape.fragments if fragment.id == "replay:conversation_context"
    )
    replay_payload = shape.provider_messages[-1].content

    assert "Conversation summary: User asked for a repo inspection." in replay_fragment.content
    assert "user: inspect repo" not in replay_fragment.content
    assert "assistant: I will inspect README." not in replay_fragment.content
    assert "tool: Tool read_file: README content" not in replay_fragment.content
    assert "user: inspect repo" not in replay_payload
    assert "assistant: I will inspect README." not in replay_payload
    assert "tool: Tool read_file: README content" not in replay_payload


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


def test_request_shape_builder_projects_chat_rehydration_as_transcript_message(
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
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                ),
                InstructionFragment(
                    kind="compaction_rehydration",
                    title="Compaction rehydration",
                    content="[Compaction file rehydration]\n### src/app.py",
                ),
            ),
            conversation_messages=(
                Message(role="assistant", content="Compacted summary"),
                Message(role="assistant", content="Tail answer"),
            ),
            current_user_request="continue now",
        ),
        tools=(_tool("Skill"),),
    )

    contents = [message.content for message in shape.provider_messages]
    joined = "\n".join(contents)

    assert "Available skills" in shape.provider_messages[0].content
    assert "[Compaction file rehydration]" not in shape.provider_messages[0].content
    assert contents == [
        shape.provider_messages[0].content,
        "Compacted summary",
        "Tail answer",
        "[Compaction file rehydration]\n### src/app.py",
        "continue now",
    ]
    assert shape.provider_messages[-2].role == "assistant"
    assert shape.provider_messages[-2].metadata["ephemeral_context"] == {
        "kind": "compaction_rehydration",
        "source": "provider_transcript_projection",
    }
    assert "[Compaction file rehydration]" in joined


def test_request_shape_builder_includes_compaction_rehydration_in_responses_delta(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path, protocol=ProtocolId.RESPONSES),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="compaction_rehydration",
                    title="Compaction rehydration",
                    content="[Invoked skills after compaction]\n## code-review",
                ),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("Skill"),),
    )

    assert any(
        "[Invoked skills after compaction]" in message.content
        for message in shape.provider_messages
        if message.role == "user"
    )
    assert any(
        fragment.id == "replay:compaction_rehydration"
        and fragment.metadata["instruction_fragment_kind"] == "compaction_rehydration"
        for fragment in shape.fragments
    )


def test_request_shape_builder_applies_provider_cache_policy_capability(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.OPENAI,
            protocol=ProtocolId.RESPONSES,
            model="gpt-test",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            current_user_request="inspect",
        ),
        tools=(),
        cache_policy_capability=ProviderCachePolicyCapability(
            prompt_cache_key_enabled=False
        ),
    )

    assert shape.provider_request_policy is not None
    assert shape.provider_request_policy.prompt_cache_key is None
    assert shape.provider_request_policy.wire_cache_hint_enabled is False


def test_request_pipeline_resolves_cache_policy_capability_from_runtime_config(
    tmp_path: Path,
) -> None:
    pipeline = RequestPipeline(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.COMPATIBLE,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="compatible-model",
            cache_policy_capability=ProviderCachePolicyCapability(
                prompt_cache_key_enabled=False,
                cache_control_enabled=False,
            ),
        ),
        instruction_contract_assembler=InstructionContractAssembler(),
        request_shape_builder=RequestShapeBuilder(),
        request_shape_payload_formatter=RequestShapePayloadFormatter(),
        trace_service=TraceService(home_dir=tmp_path / "home"),
        workspace_log_service=WorkspaceLogService(workspace_root=tmp_path),
    )

    shape = pipeline.build_and_trace_request_shape(
        turn_id="turn_policy",
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            current_user_request="inspect",
        ),
        tools=[],
    )

    assert shape.provider_request_policy is not None
    assert shape.provider_request_policy.prompt_cache_key is None
    assert shape.provider_request_policy.wire_cache_hint_enabled is False


def test_request_pipeline_disables_cache_control_for_deepseek_anthropic_endpoint(
    tmp_path: Path,
) -> None:
    pipeline = RequestPipeline(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.ANTHROPIC,
            protocol=ProtocolId.ANTHROPIC_MESSAGES,
            model="deepseek-v4-flash",
            api_base_url="https://api.deepseek.com/anthropic",
        ),
        instruction_contract_assembler=InstructionContractAssembler(),
        request_shape_builder=RequestShapeBuilder(),
        request_shape_payload_formatter=RequestShapePayloadFormatter(),
        trace_service=TraceService(home_dir=tmp_path / "home"),
        workspace_log_service=WorkspaceLogService(workspace_root=tmp_path),
    )

    shape = pipeline.build_and_trace_request_shape(
        turn_id="turn_deepseek_anthropic_policy",
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            current_user_request="inspect",
        ),
        tools=[],
    )

    assert shape.provider_request_policy is not None
    assert shape.provider_request_policy.anthropic_cache_control_breakpoints == ()
    assert shape.provider_request_policy.wire_hint_state == "unsupported"

    diagnostic = CacheShapeDiagnostics().build(current=shape).to_dict()
    policy = diagnostic["metadata"]["provider_request_policy"]
    assert isinstance(policy, dict)
    assert policy["wire_hint_state"] == "unsupported"
    assert policy["provider_family"] == "deepseek"
    assert policy["cache_strategy"] == "automatic_prefix_cache"
