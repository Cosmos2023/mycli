from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from mycli.domain.runtime import (
    ProviderProjectionLane,
    RequestShape,
    stable_hash,
)
from mycli.infrastructure.providers import ChatProviderAdapter
from mycli.llms.adapters.anthropic_messages_adapter import AnthropicMessagesModelAdapter
from mycli.llms.adapters.base import RuntimeItem


class _SnapshotAnthropicClient:
    def create_message(
        self,
        *,
        system: object | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        del system, messages, tools
        return {"id": "snapshot", "content": []}


@dataclass(slots=True, frozen=True)
class ProviderPayloadSnapshot:
    """Redacted provider payload diagnostics.

    The snapshot is intentionally count/hash based. It must not store raw
    message text, raw tool output, secrets, or a full provider cache key.
    """

    lane: str
    message_count: int = 0
    runtime_item_count: int = 0
    request_option_hints: dict[str, bool] = field(default_factory=dict)
    sanitized_provider_private_field_count: int = 0
    anthropic_cache_control_block_count: int = 0
    prompt_cache_key_hash: str | None = None
    prompt_cache_key_preview: str | None = None

    @classmethod
    def from_request_shape(cls, shape: RequestShape) -> ProviderPayloadSnapshot:
        policy = shape.provider_request_policy
        lane = (
            shape.provider_projection.lane.value
            if shape.provider_projection is not None
            else _lane_from_protocol(shape.protocol)
        )
        prompt_cache_key = policy.prompt_cache_key if policy is not None else None
        cache_control_count = 0
        if lane == ProviderProjectionLane.ANTHROPIC_MESSAGES.value:
            cache_control_count = cls._anthropic_cache_control_block_count(
                [
                    RuntimeItem(
                        role=item.role,
                        blocks=item.blocks,
                        metadata=dict(item.metadata),
                    )
                    for item in shape.provider_runtime_items
                    if item.blocks
                ]
            )
        return cls(
            lane=lane,
            message_count=len(shape.provider_messages),
            runtime_item_count=len(shape.provider_runtime_items),
            request_option_hints={
                "prompt_cache_key": bool(prompt_cache_key),
                "cache_control": cache_control_count > 0,
            },
            anthropic_cache_control_block_count=cache_control_count,
            prompt_cache_key_hash=stable_hash(prompt_cache_key)
            if prompt_cache_key
            else None,
            prompt_cache_key_preview=_bounded_preview(prompt_cache_key),
        )

    @classmethod
    def from_chat_messages(
        cls,
        messages: list[dict[str, object]],
        *,
        adapter: ChatProviderAdapter,
    ) -> ProviderPayloadSnapshot:
        prompt_cache_key = _prompt_cache_key_from_messages(messages)
        adapted = adapter.adapt_messages(messages)
        return cls(
            lane=ProviderProjectionLane.CHAT_COMPLETIONS.value,
            message_count=len(messages),
            request_option_hints={
                "prompt_cache_key": bool(prompt_cache_key),
                "cache_control": False,
            },
            sanitized_provider_private_field_count=_removed_key_count(
                before=messages,
                after=adapted,
            ),
            prompt_cache_key_hash=stable_hash(prompt_cache_key)
            if prompt_cache_key
            else None,
            prompt_cache_key_preview=_bounded_preview(prompt_cache_key),
        )

    @staticmethod
    def _anthropic_cache_control_block_count(items: list[RuntimeItem]) -> int:
        adapter = AnthropicMessagesModelAdapter(client=_SnapshotAnthropicClient())
        system, messages = adapter._serialize_items(items)  # noqa: SLF001
        return _count_cache_control({"system": system, "messages": messages})

    def to_dict(self) -> dict[str, object]:
        return {
            "lane": self.lane,
            "message_count": self.message_count,
            "runtime_item_count": self.runtime_item_count,
            "request_option_hints": dict(self.request_option_hints),
            "sanitized_provider_private_field_count": (
                self.sanitized_provider_private_field_count
            ),
            "anthropic_cache_control_block_count": (
                self.anthropic_cache_control_block_count
            ),
            "prompt_cache_key_hash": self.prompt_cache_key_hash,
            "prompt_cache_key_preview": self.prompt_cache_key_preview,
        }


def _lane_from_protocol(protocol: str) -> str:
    if protocol == "responses":
        return ProviderProjectionLane.RESPONSES.value
    if protocol == "anthropic_messages":
        return ProviderProjectionLane.ANTHROPIC_MESSAGES.value
    return ProviderProjectionLane.CHAT_COMPLETIONS.value


def _bounded_preview(value: str | None, *, limit: int = 48) -> str | None:
    if not value:
        return None
    if len(value) <= limit:
        return value
    return f"{value[:limit]}..."


def _prompt_cache_key_from_messages(messages: list[dict[str, object]]) -> str | None:
    for message in messages:
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        policy = metadata.get("provider_request_policy")
        if not isinstance(policy, dict):
            continue
        value = policy.get("prompt_cache_key")
        if isinstance(value, str) and value:
            return value
    return None


def _removed_key_count(
    *,
    before: list[dict[str, object]],
    after: list[dict[str, object]],
) -> int:
    count = 0
    for before_message, after_message in zip(before, after, strict=False):
        removed = set(before_message) - set(after_message)
        count += len(removed)
    return count


def _count_cache_control(value: Any) -> int:
    if isinstance(value, dict):
        count = 1 if value.get("cache_control") is not None else 0
        return count + sum(_count_cache_control(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return sum(_count_cache_control(item) for item in value)
    return 0
