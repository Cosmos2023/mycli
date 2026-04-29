from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


def stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class FragmentStability(StrEnum):
    STABLE = "stable"
    REPLAY = "replay"
    VOLATILE = "volatile"


class RequestFragmentKind(StrEnum):
    STABLE = "stable"
    REPLAY = "replay"
    INTENT = "intent"
    VOLATILE = "volatile"
    RETRIEVED_MEMORY = "retrieved_memory"
    EVIDENCE_INDEX = "evidence_index"
    TOOL_POLICY = "tool_policy"


@dataclass(slots=True, frozen=True)
class RequestFragment:
    id: str
    kind: RequestFragmentKind
    content: str
    stability: FragmentStability
    dedupe_key: str | None = None
    budget_weight: int = 1
    provider_visibility: tuple[str, ...] = ("all",)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id.strip():
            raise ValueError("fragment id cannot be blank")
        if self.budget_weight < 0:
            raise ValueError("budget_weight cannot be negative")
        if not self.provider_visibility:
            raise ValueError("provider_visibility cannot be empty")

    @property
    def content_hash(self) -> str:
        return stable_hash(self.content)

    @property
    def char_length(self) -> int:
        return len(self.content)


@dataclass(slots=True, frozen=True)
class ProviderMessageShape:
    role: str
    content: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.role.strip():
            raise ValueError("provider message role cannot be blank")

    @property
    def content_hash(self) -> str:
        return stable_hash(f"{self.role}\n{self.content}")

    @property
    def char_length(self) -> int:
        return len(self.content)


@dataclass(slots=True, frozen=True)
class RequestShape:
    provider: str
    protocol: str
    model: str
    stable_system: str
    tool_schema_hash: str | None = None
    tool_order_hash: str | None = None
    fragments: tuple[RequestFragment, ...] = ()
    provider_messages: tuple[ProviderMessageShape, ...] = ()

    def __post_init__(self) -> None:
        if not self.provider.strip():
            raise ValueError("provider cannot be blank")
        if not self.protocol.strip():
            raise ValueError("protocol cannot be blank")
        if not self.model.strip():
            raise ValueError("model cannot be blank")

    @property
    def system_hash(self) -> str:
        return stable_hash(self.stable_system)

    @property
    def replay_hash(self) -> str:
        replay_hashes = [
            fragment.content_hash
            for fragment in self.fragments
            if fragment.stability is FragmentStability.REPLAY
        ]
        return stable_hash("\n".join(replay_hashes))

    @property
    def volatile_hash(self) -> str:
        volatile_hashes = [
            fragment.content_hash
            for fragment in self.fragments
            if fragment.stability is FragmentStability.VOLATILE
        ]
        return stable_hash("\n".join(volatile_hashes))

    def fragment_hashes(self) -> dict[str, str]:
        return {fragment.id: fragment.content_hash for fragment in self.fragments}

    def provider_message_hashes(self) -> tuple[str, ...]:
        return tuple(message.content_hash for message in self.provider_messages)

    def summary(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "protocol": self.protocol,
            "model": self.model,
            "system_hash": self.system_hash,
            "tool_schema_hash": self.tool_schema_hash,
            "tool_order_hash": self.tool_order_hash,
            "replay_hash": self.replay_hash,
            "volatile_hash": self.volatile_hash,
            "fragment_hashes": self.fragment_hashes(),
            "provider_message_hashes": self.provider_message_hashes(),
            "fragment_lengths": {
                fragment.id: fragment.char_length for fragment in self.fragments
            },
            "provider_message_lengths": tuple(
                message.char_length for message in self.provider_messages
            ),
        }
