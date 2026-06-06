from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.request import (
    ProviderPayloadSnapshot,
    ProviderRequestDryRun,
    RequestShapeBuilder,
    RequestShapePayloadFormatter,
)
from mycli.domain.conversation import Message
from mycli.domain.providers import ProviderId, ProtocolId
from mycli.domain.runtime import AgentConfig, InstructionContract, InstructionFragment
from mycli.infrastructure.providers import DefaultChatProviderAdapter


def _contract(current_user_request: str, *, dynamic: str = "Dynamic summary."):
    return InstructionContract(
        base_instructions="Stable system rules.",
        contextual_user_sections=(
            InstructionFragment(
                kind="workspace_instructions",
                title="Workspace",
                content="<workspace-context>Stable workspace.</workspace-context>",
                metadata={"cache_class": "static"},
            ),
            InstructionFragment(
                kind="compaction_rehydration",
                title="Compaction",
                content=f"<compaction>{dynamic}</compaction>",
                metadata={"cache_class": "dynamic"},
            ),
        ),
        conversation_messages=(Message(role="assistant", content="Prior answer."),),
        current_user_request=current_user_request,
    )


def _shape(tmp_path: Path, protocol: ProtocolId, current_user_request: str):
    provider = (
        ProviderId.ANTHROPIC
        if protocol is ProtocolId.ANTHROPIC_MESSAGES
        else ProviderId.OPENAI
    )
    return RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider=provider,
            protocol=protocol,
            model="model-test",
        ),
        contract=_contract(current_user_request),
        tools=(),
    )


def test_provider_payload_snapshot_reports_redacted_responses_cache_shape(
    tmp_path: Path,
) -> None:
    shape = _shape(tmp_path, ProtocolId.RESPONSES, "secret user text")

    snapshot = ProviderPayloadSnapshot.from_request_shape(shape)
    payload = snapshot.to_dict()

    assert payload["lane"] == "responses"
    assert payload["runtime_item_count"] > 0
    assert payload["message_count"] > 0
    assert payload["request_option_hints"]["prompt_cache_key"] is True
    assert payload["prompt_cache_key_hash"]
    assert payload["prompt_cache_key_preview"].startswith("mycli:openai:responses:")
    assert "prompt_cache_key" not in payload
    assert "secret user text" not in str(payload)


def test_provider_payload_snapshot_counts_chat_private_field_sanitization(
    tmp_path: Path,
) -> None:
    shape = _shape(tmp_path, ProtocolId.CHAT_COMPLETIONS, "private user text")
    messages = [
        {
            "role": message.role,
            "content": message.content,
            "metadata": message.metadata,
            "cache_control": {"type": "ephemeral"},
            "anthropic": {"thinking": "private"},
            "_provider_state": {"secret": "value"},
        }
        for message in RequestShapePayloadFormatter().legacy_messages(shape)
    ]

    snapshot = ProviderPayloadSnapshot.from_chat_messages(
        messages,
        adapter=DefaultChatProviderAdapter(),
    )
    payload = snapshot.to_dict()

    assert payload["lane"] == "chat_completions"
    assert payload["sanitized_provider_private_field_count"] >= 4
    assert payload["request_option_hints"]["prompt_cache_key"] is True
    assert "private user text" not in str(payload)
    assert "secret" not in str(payload)


def test_provider_payload_snapshot_counts_anthropic_cache_control_blocks(
    tmp_path: Path,
) -> None:
    shape = _shape(tmp_path, ProtocolId.ANTHROPIC_MESSAGES, "private anthropic text")

    snapshot = ProviderPayloadSnapshot.from_request_shape(shape)
    payload = snapshot.to_dict()

    assert payload["lane"] == "anthropic_messages"
    assert payload["anthropic_cache_control_block_count"] == 2
    assert payload["request_option_hints"]["cache_control"] is True
    assert "private anthropic text" not in str(payload)


def test_provider_request_dry_run_compares_two_turns_without_raw_prompt(
    tmp_path: Path,
) -> None:
    previous = _shape(tmp_path, ProtocolId.RESPONSES, "first private request")
    current = _shape(tmp_path, ProtocolId.RESPONSES, "second private request")

    comparison = ProviderRequestDryRun.compare(previous=previous, current=current)
    payload = comparison.to_dict()

    assert payload["provider_lane"] == "responses"
    assert payload["first_changed_cache_class"] == "ephemeral"
    assert payload["cache_boundary_hash_stable"] is True
    assert payload["prompt_cache_key_hash_stable"] is True
    assert "first private request" not in str(payload)
    assert "second private request" not in str(payload)
