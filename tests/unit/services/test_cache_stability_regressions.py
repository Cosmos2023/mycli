from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.request import RequestShapeBuilder, RequestShapePayloadFormatter
from mycli.domain.conversation import Message
from mycli.domain.providers import ProviderId, ProtocolId
from mycli.domain.runtime import AgentConfig, InstructionContract, InstructionFragment
from mycli.llms.adapters.anthropic_messages_adapter import AnthropicMessagesModelAdapter
from mycli.llms.adapters.base import ModelToolDefinition, ModelToolParameter


class _FakeAnthropicClient:
    def __init__(self) -> None:
        self.system: object | None = None
        self.messages: list[dict[str, object]] = []

    def create_message(
        self,
        *,
        system: object | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        del tools
        self.system = system
        self.messages = messages
        return {"id": "msg_1", "content": [], "stop_reason": "end_turn"}


def _tool(
    name: str,
    *,
    description: str | None = None,
    parameters: tuple[ModelToolParameter, ...] = (),
) -> ModelToolDefinition:
    return ModelToolDefinition(
        name=name,
        description=description or f"Tool {name}",
        parameters=parameters,
    )


def _contract(
    current_user_request: str,
    *,
    stable_workspace: str = "Stable workspace rules.",
    dynamic_summary: str = "Dynamic compaction summary.",
) -> InstructionContract:
    return InstructionContract(
        base_instructions="Stable system rules.",
        contextual_user_sections=(
            InstructionFragment(
                kind="workspace_instructions",
                title="Workspace",
                content=f"<workspace-context>{stable_workspace}</workspace-context>",
                metadata={"cache_class": "static"},
            ),
            InstructionFragment(
                kind="compaction_rehydration",
                title="Compaction rehydration",
                content=f"<compaction-context>{dynamic_summary}</compaction-context>",
                metadata={"cache_class": "dynamic"},
            ),
        ),
        conversation_messages=(Message(role="assistant", content="Prior answer."),),
        current_user_request=current_user_request,
    )


def _shape(
    tmp_path: Path,
    current_user_request: str,
    *,
    protocol: ProtocolId = ProtocolId.RESPONSES,
    provider: ProviderId = ProviderId.OPENAI,
    stable_workspace: str = "Stable workspace rules.",
    dynamic_summary: str = "Dynamic compaction summary.",
    tools: tuple[ModelToolDefinition, ...] = (),
):
    return RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider=provider,
            protocol=protocol,
            model="model-test",
        ),
        contract=_contract(
            current_user_request,
            stable_workspace=stable_workspace,
            dynamic_summary=dynamic_summary,
        ),
        tools=tools,
    )


def test_user_intent_changes_keep_stable_prefix_and_prompt_cache_key(
    tmp_path: Path,
) -> None:
    first = _shape(tmp_path, "inspect cache behavior")
    second = _shape(tmp_path, "summarize cache behavior differently")

    assert first.cacheable_prefix_hash() == second.cacheable_prefix_hash()
    assert first.provider_request_policy is not None
    assert second.provider_request_policy is not None
    assert (
        first.provider_request_policy.prompt_cache_key
        == second.provider_request_policy.prompt_cache_key
    )


def test_tool_schema_ordering_does_not_affect_stable_hash_or_prompt_cache_key(
    tmp_path: Path,
) -> None:
    first = _shape(tmp_path, "inspect", tools=(_tool("read_file"), _tool("search_text")))
    second = _shape(tmp_path, "inspect", tools=(_tool("search_text"), _tool("read_file")))

    assert first.cacheable_prefix_hash() == second.cacheable_prefix_hash()
    assert first.provider_request_policy is not None
    assert second.provider_request_policy is not None
    assert (
        first.provider_request_policy.prompt_cache_key
        == second.provider_request_policy.prompt_cache_key
    )


def test_tool_schema_content_changes_stable_hash_and_prompt_cache_key(
    tmp_path: Path,
) -> None:
    first = _shape(tmp_path, "inspect", tools=(_tool("read_file"),))
    second = _shape(
        tmp_path,
        "inspect",
        tools=(
            _tool(
                "read_file",
                parameters=(
                    ModelToolParameter(
                        name="path",
                        type="string",
                        required=True,
                    ),
                ),
            ),
        ),
    )

    assert first.cacheable_prefix_hash() != second.cacheable_prefix_hash()
    assert first.provider_request_policy is not None
    assert second.provider_request_policy is not None
    assert (
        first.provider_request_policy.prompt_cache_key
        != second.provider_request_policy.prompt_cache_key
    )


def test_workspace_static_context_changes_stable_prefix_hash(tmp_path: Path) -> None:
    first = _shape(tmp_path, "inspect", stable_workspace="Rule A")
    second = _shape(tmp_path, "inspect", stable_workspace="Rule B")

    assert first.cacheable_prefix_hash() != second.cacheable_prefix_hash()


def test_dynamic_rehydration_changes_do_not_affect_stable_prefix_hash(
    tmp_path: Path,
) -> None:
    first = _shape(tmp_path, "inspect", dynamic_summary="Summary one.")
    second = _shape(tmp_path, "inspect", dynamic_summary="Summary two.")

    assert first.cacheable_prefix_hash() == second.cacheable_prefix_hash()
    assert first.provider_request_policy is not None
    assert second.provider_request_policy is not None
    assert (
        first.provider_request_policy.prompt_cache_key
        == second.provider_request_policy.prompt_cache_key
    )


def test_anthropic_wire_cache_control_does_not_enter_canonical_timeline(
    tmp_path: Path,
) -> None:
    shape = _shape(
        tmp_path,
        "inspect anthropic",
        protocol=ProtocolId.ANTHROPIC_MESSAGES,
        provider=ProviderId.ANTHROPIC,
    )
    client = _FakeAnthropicClient()

    AnthropicMessagesModelAdapter(client=client).next_turn(
        items=RequestShapePayloadFormatter().runtime_items(shape),
        tools=[],
    )

    assert "cache_control" in str({"system": client.system, "messages": client.messages})
    assert all("cache_control" not in fragment.metadata for fragment in shape.fragments)
    assert all(
        "cache_control" not in block.metadata
        for item in shape.provider_runtime_items
        for block in item.blocks
    )
