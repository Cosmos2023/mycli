from __future__ import annotations

import json
import tempfile
from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.providers import ProviderId, ProtocolId
from mycli.domain.runtime import AgentConfig, InstructionContract, InstructionFragment
from mycli.application.runtime.request import (
    CacheShapeDiagnostics,
    ProviderPayloadSnapshot,
    ProviderRequestDryRun,
    ProviderRequestDryRunRenderer,
    RequestShapeBuilder,
    RequestShapePayloadFormatter,
)
from mycli.application.runtime.recovery import (
    ErrorClassifier,
    RecoveryPolicy,
    recovery_diagnostic_metadata,
)
from mycli.infrastructure.providers import resolve_provider_cache_policy_capability
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.llms.adapters.anthropic_messages_adapter import AnthropicMessagesModelAdapter
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter
from mycli.llms.clients.openai_chat import OpenAIChatClient


class _FakeResponsesClient:
    def __init__(self) -> None:
        self.prompt_cache_key: str | None = None

    def create_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        prompt_cache_key: str | None = None,
    ) -> dict[str, object]:
        del input_items, tools
        self.prompt_cache_key = prompt_cache_key
        return {"id": "resp_smoke", "output": []}


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
        return {
            "id": "msg_smoke",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }


class _FakeChatCompletions:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        return _FakeSdkPayload({"choices": [{"message": {"content": "ok"}}]})


class _FakeChatSdkClient:
    def __init__(self) -> None:
        self.chat_completions = _FakeChatCompletions()
        self.chat = type("_FakeChat", (), {"completions": self.chat_completions})()


class _FakeSdkPayload:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def to_dict(self) -> dict[str, object]:
        return dict(self._payload)


def _contract(current_user_request: str) -> InstructionContract:
    return InstructionContract(
        base_instructions="Stable system rules.",
        contextual_user_sections=(
            InstructionFragment(
                kind="workspace_instructions",
                title="Workspace",
                content="<workspace-context>stable workspace</workspace-context>",
                metadata={"cache_class": "static"},
            ),
            InstructionFragment(
                kind="compaction_rehydration",
                title="Compaction",
                content="<compaction>dynamic summary</compaction>",
                metadata={"cache_class": "dynamic"},
            ),
        ),
        conversation_messages=(Message(role="assistant", content="Previous answer"),),
        current_user_request=current_user_request,
    )


def _contains_cache_control(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            key == "cache_control" or _contains_cache_control(item)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_cache_control(item) for item in value)
    return False


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mycli-provider-cache-smoke-") as raw:
        workspace = Path(raw)
        formatter = RequestShapePayloadFormatter()

        responses_shape = RequestShapeBuilder().build(
            config=AgentConfig(
                workspace_root=workspace,
                provider=ProviderId.OPENAI,
                protocol=ProtocolId.RESPONSES,
                model="gpt-test",
            ),
            contract=_contract("inspect responses"),
            tools=(),
        )
        responses_client = _FakeResponsesClient()
        ResponsesModelAdapter(responses_client).next_turn(
            items=formatter.runtime_items(responses_shape),
            tools=[],
        )

        second_responses_shape = RequestShapeBuilder().build(
            config=AgentConfig(
                workspace_root=workspace,
                provider=ProviderId.OPENAI,
                protocol=ProtocolId.RESPONSES,
                model="gpt-test",
            ),
            contract=_contract("different current user intent"),
            tools=(),
        )

        anthropic_shape = RequestShapeBuilder().build(
            config=AgentConfig(
                workspace_root=workspace,
                provider=ProviderId.ANTHROPIC,
                protocol=ProtocolId.ANTHROPIC_MESSAGES,
                model="claude-test",
            ),
            contract=_contract("inspect anthropic"),
            tools=(),
        )
        anthropic_client = _FakeAnthropicClient()
        AnthropicMessagesModelAdapter(client=anthropic_client).next_turn(
            items=formatter.runtime_items(anthropic_shape),
            tools=[],
        )

        chat_shape = RequestShapeBuilder().build(
            config=AgentConfig(
                workspace_root=workspace,
                provider=ProviderId.OPENAI,
                protocol=ProtocolId.CHAT_COMPLETIONS,
                model="gpt-test",
            ),
            contract=_contract("inspect chat"),
            tools=(),
        )
        chat_messages = [
            {
                "role": message.role,
                "content": message.content,
                "metadata": message.metadata,
                "cache_control": {"type": "ephemeral"},
                "anthropic": {"type": "thinking"},
                "responses": {"opaque": True},
            }
            for message in formatter.legacy_messages(chat_shape)
        ]
        chat_sdk = _FakeChatSdkClient()
        client = OpenAIChatClient(
            api_key="test",
            base_url="https://example.invalid/v1",
            model="gpt-test",
            max_output_tokens=128,
        )
        client._sdk_client = chat_sdk  # noqa: SLF001 - smoke injects fake transport.
        client.complete(chat_messages)

        chat_payload = chat_sdk.chat_completions.calls[-1]
        dry_run = ProviderRequestDryRun.compare(
            previous=responses_shape,
            current=second_responses_shape,
            recovery_counts={"invalid_encrypted_content": 1},
            latest_recovery=recovery_diagnostic_metadata(
                classification=ErrorClassifier().classify(
                    ModelResponseError(
                        "invalid encrypted_content: sk-do-not-print",
                        failure_kind="invalid_encrypted_content",
                    )
                ),
                decision=RecoveryPolicy().decide(
                    ErrorClassifier().classify(
                        ModelResponseError(
                            "invalid encrypted_content",
                            failure_kind="invalid_encrypted_content",
                        )
                    )
                ),
                attempt=1,
            ),
        ).to_dict()
        dry_run_summary = ProviderRequestDryRunRenderer().render(
            ProviderRequestDryRun.compare(
                previous=responses_shape,
                current=second_responses_shape,
                recovery_counts={"invalid_encrypted_content": 1},
                latest_recovery=dry_run["latest_recovery"],
            )
        )
        anthropic_snapshot = ProviderPayloadSnapshot.from_request_shape(
            anthropic_shape
        ).to_dict()
        anthropic_cache_diagnostic = CacheShapeDiagnostics().build(
            current=anthropic_shape,
            usage={
                "input_tokens": 100,
                "cache_read_input_tokens": 80,
                "cache_creation_input_tokens": 12,
            },
        ).to_dict()
        payload = {
            "openai_resolved_prompt_cache_key_enabled": (
                resolve_provider_cache_policy_capability(
                    provider=ProviderId.OPENAI
                ).prompt_cache_key_enabled
            ),
            "anthropic_resolved_cache_control_enabled": (
                resolve_provider_cache_policy_capability(
                    provider=ProviderId.ANTHROPIC
                ).cache_control_enabled
            ),
            "responses_prompt_cache_key": responses_client.prompt_cache_key,
            "responses_prompt_cache_key_stable": (
                responses_shape.provider_request_policy is not None
                and second_responses_shape.provider_request_policy is not None
                and responses_shape.provider_request_policy.prompt_cache_key
                == second_responses_shape.provider_request_policy.prompt_cache_key
            ),
            "anthropic_wire_has_cache_control": _contains_cache_control(
                {
                    "system": anthropic_client.system,
                    "messages": anthropic_client.messages,
                }
            ),
            "anthropic_canonical_has_cache_control": _contains_cache_control(
                anthropic_shape.summary()
            ),
            "chat_prompt_cache_key": chat_payload.get("prompt_cache_key"),
            "chat_messages_have_provider_private_fields": _contains_cache_control(
                chat_payload.get("messages")
            )
            or any(
                isinstance(message, dict)
                and any(
                    key in message
                    for key in ("metadata", "anthropic", "responses", "_provider_state")
                )
                for message in chat_payload.get("messages", [])
            ),
            "dry_run_cache_boundary_hash_stable": dry_run[
                "cache_boundary_hash_stable"
            ],
            "dry_run_prompt_cache_key_hash_stable": dry_run[
                "prompt_cache_key_hash_stable"
            ],
            "dry_run_first_changed_cache_class": dry_run[
                "first_changed_cache_class"
            ],
            "dry_run_wire_hint_state": dry_run_summary["wire_hint_state"],
            "dry_run_snapshot_counts": dry_run_summary["snapshot_counts"],
            "anthropic_snapshot_cache_control_blocks": anthropic_snapshot[
                "anthropic_cache_control_block_count"
            ],
            "anthropic_cache_usage_telemetry_status": (
                anthropic_cache_diagnostic["metadata"]["provider_cache_usage"][
                    "telemetry_status"
                ]
            ),
            "anthropic_provider_cached_tokens": (
                anthropic_cache_diagnostic["metadata"]["provider_cached_tokens"]
            ),
            "dry_run_recovery_counts": dry_run_summary["recovery_counts"],
            "dry_run_latest_recovery": dry_run_summary["latest_recovery"],
        }
        print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        ok = (
            isinstance(payload["responses_prompt_cache_key"], str)
            and payload["responses_prompt_cache_key_stable"] is True
            and payload["anthropic_wire_has_cache_control"] is True
            and payload["anthropic_canonical_has_cache_control"] is False
            and isinstance(payload["chat_prompt_cache_key"], str)
            and payload["chat_messages_have_provider_private_fields"] is False
            and payload["dry_run_cache_boundary_hash_stable"] is True
            and payload["dry_run_prompt_cache_key_hash_stable"] is True
            and payload["dry_run_first_changed_cache_class"] == "ephemeral"
            and payload["dry_run_wire_hint_state"] == "enabled_and_emitted"
            and payload["anthropic_snapshot_cache_control_blocks"] == 2
            and payload["anthropic_cache_usage_telemetry_status"] == "present"
            and payload["anthropic_provider_cached_tokens"] == 80
            and payload["dry_run_recovery_counts"] == {
                "invalid_encrypted_content": 1
            }
            and payload["dry_run_latest_recovery"] == {
                "error_class": "invalid_encrypted_content",
                "action": "strip_encrypted_reasoning_retry",
                "will_retry": True,
            }
            and "sk-do-not-print" not in json.dumps(payload, ensure_ascii=False)
        )
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
