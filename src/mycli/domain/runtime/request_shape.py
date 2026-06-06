from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from mycli.domain.runtime.blocks import RuntimeBlock, RuntimeRole


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


class ProviderProjectionLane(StrEnum):
    RESPONSES = "responses"
    CHAT_COMPLETIONS = "chat_completions"
    ANTHROPIC_MESSAGES = "anthropic_messages"


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
class ProviderRuntimeItemShape:
    role: RuntimeRole
    blocks: tuple[RuntimeBlock, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.role.strip():
            raise ValueError("provider runtime item role cannot be blank")

    @property
    def content_hash(self) -> str:
        return stable_hash(
            f"{self.role}\n"
            + json.dumps(
                [self._block_payload(block) for block in self.blocks],
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
        )

    @property
    def char_length(self) -> int:
        return len(
            json.dumps(
                [self._block_payload(block) for block in self.blocks],
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
        )

    def _block_payload(self, block: RuntimeBlock) -> dict[str, object]:
        return {
            "type": block.type,
            "text": block.text,
            "tool_name": block.tool_name,
            "tool_arguments": block.tool_arguments,
            "call_id": block.call_id,
            "provider_id": block.provider_id,
            "source": block.source,
            "metadata": block.metadata,
        }


@dataclass(slots=True, frozen=True)
class ProviderProjectionShape:
    """Provider-facing view of the canonical request shape.

    This is a diagnostic/contract object, not the final wire payload. It records
    which provider lane owns projection decisions while keeping wire-only cache
    hints out of the canonical timeline.
    """

    lane: ProviderProjectionLane
    message_count: int
    runtime_item_count: int
    cacheable_prefix_fragment_count: int
    first_dynamic_fragment_index: int | None
    first_ephemeral_fragment_index: int | None
    cache_hint: str | None = None
    wire_only_hints: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "lane": self.lane.value,
            "message_count": self.message_count,
            "runtime_item_count": self.runtime_item_count,
            "cacheable_prefix_fragment_count": self.cacheable_prefix_fragment_count,
            "first_dynamic_fragment_index": self.first_dynamic_fragment_index,
            "first_ephemeral_fragment_index": self.first_ephemeral_fragment_index,
            "cache_hint": self.cache_hint,
            "wire_only_hints": self.wire_only_hints,
        }


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
    provider_runtime_items: tuple[ProviderRuntimeItemShape, ...] = ()
    provider_projection: ProviderProjectionShape | None = None

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

    def provider_runtime_item_hashes(self) -> tuple[str, ...]:
        return tuple(item.content_hash for item in self.provider_runtime_items)

    def cacheable_prefix_fragment_ids(self) -> tuple[str, ...]:
        ids: list[str] = []
        for fragment in self.fragments:
            if fragment.stability is not FragmentStability.STABLE:
                break
            ids.append(fragment.id)
        return tuple(ids)

    def cacheable_prefix_hash(self) -> str:
        return stable_hash(
            "\n".join(
                self.fragment_hashes()[fragment_id]
                for fragment_id in self.cacheable_prefix_fragment_ids()
            )
        )

    def estimated_cacheable_prefix_chars(self) -> int:
        prefix_ids = set(self.cacheable_prefix_fragment_ids())
        return sum(
            fragment.char_length for fragment in self.fragments if fragment.id in prefix_ids
        )

    def compact_policy_summary(self) -> dict[str, object]:
        return {
            "engine": "canonical",
            "cheap_pruning_scope": "dynamic_replay",
            "stable_prefix_protected": True,
            "rehydration_cache_class": "dynamic",
            "provider_specific_compact": False,
        }

    def fragment_metadata_summary(self) -> dict[str, dict[str, object]]:
        return {
            fragment.id: {
                "kind": fragment.kind.value,
                "stability": fragment.stability.value,
                "source": fragment.metadata.get("source"),
                "cache_class": fragment.metadata.get("cache_class"),
                "section_hash": fragment.metadata.get("section_hash"),
            }
            for fragment in self.fragments
        }

    def section_boundaries(self) -> tuple[dict[str, object], ...]:
        return tuple(
            {
                "fragment_id": fragment.id,
                "cache_class": fragment.metadata.get("cache_class"),
                "stability": fragment.stability.value,
                "kind": fragment.kind.value,
                "source": fragment.metadata.get("source"),
                "length": fragment.char_length,
                "cacheable_prefix": fragment.id in self.cacheable_prefix_fragment_ids(),
            }
            for fragment in self.fragments
        )

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
            "fragment_metadata": self.fragment_metadata_summary(),
            "section_boundaries": self.section_boundaries(),
            "cacheable_prefix_fragment_ids": self.cacheable_prefix_fragment_ids(),
            "cacheable_prefix_hash": self.cacheable_prefix_hash(),
            "estimated_cacheable_prefix_chars": self.estimated_cacheable_prefix_chars(),
            "provider_message_hashes": self.provider_message_hashes(),
            "provider_runtime_item_hashes": self.provider_runtime_item_hashes(),
            "provider_projection": (
                self.provider_projection.to_dict()
                if self.provider_projection is not None
                else None
            ),
            "compact_policy": self.compact_policy_summary(),
            "fragment_lengths": {
                fragment.id: fragment.char_length for fragment in self.fragments
            },
            "provider_message_lengths": tuple(
                message.char_length for message in self.provider_messages
            ),
            "provider_runtime_item_lengths": tuple(
                item.char_length for item in self.provider_runtime_items
            ),
        }
