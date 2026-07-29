from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class CanonicalTimelineRole(StrEnum):
    SYSTEM = "system"
    DEVELOPER = "developer"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    REASONING = "reasoning"
    SUMMARY = "summary"


class CanonicalTimelineDurability(StrEnum):
    PERSISTENT = "persistent"
    API_ONLY = "api_only"


class CanonicalTimelineScope(StrEnum):
    REQUEST = "request"
    TURN = "turn"
    SESSION = "session"
    TRANSCRIPT = "transcript"


@dataclass(slots=True, frozen=True)
class CanonicalTimelineItem:
    role: CanonicalTimelineRole | str
    kind: str
    content: str
    source: str | None = None
    durability: CanonicalTimelineDurability = CanonicalTimelineDurability.PERSISTENT
    scope: CanonicalTimelineScope = CanonicalTimelineScope.TRANSCRIPT
    cache_class: Any = "dynamic"
    metadata: dict[str, Any] = field(default_factory=dict)
    provider_state: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not str(self.role).strip():
            raise ValueError("canonical timeline role cannot be blank")
        if not self.kind.strip():
            raise ValueError("canonical timeline kind cannot be blank")

    @property
    def is_model_visible(self) -> bool:
        return self.durability is not CanonicalTimelineDurability.API_ONLY

    @property
    def is_replayable(self) -> bool:
        return (
            self.durability is CanonicalTimelineDurability.PERSISTENT
            and self.scope is CanonicalTimelineScope.TRANSCRIPT
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": str(self.role),
            "kind": self.kind,
            "content": self.content,
            "source": self.source,
            "durability": self.durability.value,
            "scope": self.scope.value,
            "cache_class": self._cache_class_value(self.cache_class),
            "metadata": self.metadata,
            "provider_state": self.provider_state,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CanonicalTimelineItem":
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        provider_state = payload.get("provider_state")
        if not isinstance(provider_state, dict):
            provider_state = {}
        source = payload.get("source")
        return cls(
            role=CanonicalTimelineRole(str(payload["role"])),
            kind=str(payload["kind"]),
            content=str(payload.get("content", "")),
            source=source if isinstance(source, str) else None,
            durability=CanonicalTimelineDurability(
                str(payload.get("durability", CanonicalTimelineDurability.PERSISTENT.value))
            ),
            scope=CanonicalTimelineScope(
                str(payload.get("scope", CanonicalTimelineScope.TRANSCRIPT.value))
            ),
            cache_class=cls._coerce_cache_class(payload.get("cache_class", "dynamic")),
            metadata=metadata,
            provider_state=provider_state,
        )

    @staticmethod
    def _cache_class_value(value: Any) -> str:
        raw_value = getattr(value, "value", value)
        return str(raw_value)

    @staticmethod
    def _coerce_cache_class(value: Any) -> Any:
        from mycli.domain.runtime.turn_context import TurnContextCacheClass

        raw_value = CanonicalTimelineItem._cache_class_value(value)
        try:
            return TurnContextCacheClass(raw_value)
        except ValueError:
            return raw_value
