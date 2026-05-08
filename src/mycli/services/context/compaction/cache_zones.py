from __future__ import annotations

from dataclasses import dataclass
import hashlib

from mycli.domain.conversation import Conversation


@dataclass(slots=True, frozen=True)
class CacheZones:
    frozen_boundary: int
    fresh_start: int
    frozen_fingerprint: str = ""

    def is_frozen(self, message_index: int) -> bool:
        return message_index < self.frozen_boundary

    def is_fresh(self, message_index: int) -> bool:
        return message_index >= self.fresh_start

    @classmethod
    def from_conversation(cls, conversation: Conversation) -> CacheZones:
        boundary = cls._find_first_dynamic_message(conversation)
        return cls(
            frozen_boundary=boundary,
            fresh_start=boundary,
            frozen_fingerprint=cls._fingerprint_static_prefix(conversation, boundary),
        )

    def validate(self, previous: "CacheZones") -> bool:
        return (
            self.frozen_boundary == previous.frozen_boundary
            and self.frozen_fingerprint == previous.frozen_fingerprint
        )

    @staticmethod
    def _find_first_dynamic_message(conversation: Conversation) -> int:
        for index, message in enumerate(conversation.messages):
            policy = message.metadata.get("cache_policy", "DYNAMIC")
            if policy in {"DYNAMIC", "EPHEMERAL"}:
                return index
        return len(conversation.messages)

    @staticmethod
    def _fingerprint_static_prefix(conversation: Conversation, boundary: int) -> str:
        hasher = hashlib.sha256()
        for message in conversation.messages[:boundary]:
            hasher.update(message.role.encode("utf-8"))
            hasher.update(b"\0")
            hasher.update(message.content.encode("utf-8"))
            hasher.update(b"\0")
            policy = str(message.metadata.get("cache_policy", "DYNAMIC"))
            hasher.update(policy.encode("utf-8"))
            hasher.update(b"\0")
        return hasher.hexdigest()
