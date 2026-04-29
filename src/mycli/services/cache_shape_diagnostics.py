from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from mycli.domain.runtime import RequestShape


@dataclass(slots=True, frozen=True)
class RequestShapeDiagnostic:
    provider: str
    protocol: str
    model: str
    system_hash: str
    tool_schema_hash: str | None
    tool_order_hash: str | None
    replay_hash: str
    volatile_hash: str
    fragment_hashes: dict[str, str]
    provider_message_hashes: tuple[str, ...]
    fragment_lengths: dict[str, int]
    provider_message_lengths: tuple[int, ...]
    first_changed_fragment_id: str | None = None
    first_changed_provider_message_index: int | None = None
    prompt_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def cache_hit_ratio(self) -> float:
        total = self.cache_hit_tokens + self.cache_miss_tokens
        if total == 0:
            return 0.0
        return self.cache_hit_tokens / total

    def to_dict(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "protocol": self.protocol,
            "model": self.model,
            "system_hash": self.system_hash,
            "tool_schema_hash": self.tool_schema_hash,
            "tool_order_hash": self.tool_order_hash,
            "replay_hash": self.replay_hash,
            "volatile_hash": self.volatile_hash,
            "fragment_hashes": self.fragment_hashes,
            "provider_message_hashes": self.provider_message_hashes,
            "fragment_lengths": self.fragment_lengths,
            "provider_message_lengths": self.provider_message_lengths,
            "first_changed_fragment_id": self.first_changed_fragment_id,
            "first_changed_provider_message_index": self.first_changed_provider_message_index,
            "prompt_tokens": self.prompt_tokens,
            "cache_hit_tokens": self.cache_hit_tokens,
            "cache_miss_tokens": self.cache_miss_tokens,
            "cache_hit_ratio": self.cache_hit_ratio,
            "metadata": self.metadata,
        }


class CacheShapeDiagnostics:
    def build(
        self,
        *,
        current: RequestShape,
        previous: RequestShape | None = None,
        usage: dict[str, object] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RequestShapeDiagnostic:
        current_summary = current.summary()
        previous_summary = None if previous is None else previous.summary()
        usage_payload = {} if usage is None else usage
        return RequestShapeDiagnostic(
            provider=current.provider,
            protocol=current.protocol,
            model=current.model,
            system_hash=current.system_hash,
            tool_schema_hash=current.tool_schema_hash,
            tool_order_hash=current.tool_order_hash,
            replay_hash=current.replay_hash,
            volatile_hash=current.volatile_hash,
            fragment_hashes=self._str_dict(current_summary["fragment_hashes"]),
            provider_message_hashes=self._str_tuple(
                current_summary["provider_message_hashes"]
            ),
            fragment_lengths=self._int_dict(current_summary["fragment_lengths"]),
            provider_message_lengths=self._int_tuple(
                current_summary["provider_message_lengths"]
            ),
            first_changed_fragment_id=self._first_changed_fragment_id(
                current_summary=current_summary,
                previous_summary=previous_summary,
            ),
            first_changed_provider_message_index=self._first_changed_provider_message_index(
                current_summary=current_summary,
                previous_summary=previous_summary,
            ),
            prompt_tokens=self._int_usage(usage_payload, "prompt_tokens"),
            cache_hit_tokens=self._int_usage(usage_payload, "prompt_cache_hit_tokens"),
            cache_miss_tokens=self._int_usage(usage_payload, "prompt_cache_miss_tokens"),
            metadata={} if metadata is None else dict(metadata),
        )

    def _first_changed_fragment_id(
        self,
        *,
        current_summary: dict[str, object],
        previous_summary: dict[str, object] | None,
    ) -> str | None:
        if previous_summary is None:
            return None
        current_hashes = self._str_dict(current_summary["fragment_hashes"])
        previous_hashes = self._str_dict(previous_summary["fragment_hashes"])
        ordered_ids = list(dict.fromkeys([*previous_hashes.keys(), *current_hashes.keys()]))
        for fragment_id in ordered_ids:
            if previous_hashes.get(fragment_id) != current_hashes.get(fragment_id):
                return str(fragment_id)
        return None

    def _first_changed_provider_message_index(
        self,
        *,
        current_summary: dict[str, object],
        previous_summary: dict[str, object] | None,
    ) -> int | None:
        if previous_summary is None:
            return None
        current_hashes = self._str_tuple(current_summary["provider_message_hashes"])
        previous_hashes = self._str_tuple(previous_summary["provider_message_hashes"])
        max_length = max(len(previous_hashes), len(current_hashes))
        for index in range(max_length):
            previous_hash = previous_hashes[index] if index < len(previous_hashes) else None
            current_hash = current_hashes[index] if index < len(current_hashes) else None
            if previous_hash != current_hash:
                return index
        return None

    def _int_usage(self, usage: dict[str, object], key: str) -> int:
        value = usage.get(key, 0)
        if isinstance(value, bool):
            return 0
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        return 0

    def _str_dict(self, value: object) -> dict[str, str]:
        if not isinstance(value, dict):
            return {}
        return {
            str(item_key): str(item_value)
            for item_key, item_value in value.items()
        }

    def _int_dict(self, value: object) -> dict[str, int]:
        if not isinstance(value, dict):
            return {}
        return {
            str(item_key): item_value
            for item_key, item_value in value.items()
            if isinstance(item_value, int) and not isinstance(item_value, bool)
        }

    def _str_tuple(self, value: object) -> tuple[str, ...]:
        if not isinstance(value, tuple):
            return ()
        return tuple(str(item) for item in value)

    def _int_tuple(self, value: object) -> tuple[int, ...]:
        if not isinstance(value, tuple):
            return ()
        return tuple(
            item
            for item in value
            if isinstance(item, int) and not isinstance(item, bool)
        )
