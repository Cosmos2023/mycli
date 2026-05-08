from __future__ import annotations

import hashlib
import math
from collections import OrderedDict
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, cast

from mycli.domain.conversation import Message


class _TokenEncoder(Protocol):
    def encode(self, text: str) -> list[int]: ...


class FragmentKind(StrEnum):
    SYSTEM = "system"
    HISTORY_USER = "history_user"
    HISTORY_ASSISTANT = "history_assistant"
    HISTORY_TOOL = "history_tool"
    TOOL_RESULT = "tool_result"


class Priority(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class CachePolicy(StrEnum):
    STATIC = "STATIC"
    DYNAMIC = "DYNAMIC"
    EPHEMERAL = "EPHEMERAL"


@dataclass(slots=True, frozen=True)
class Fragment:
    id: str
    kind: FragmentKind
    priority: Priority
    cache_policy: CachePolicy
    content: str
    tokens: int = 0


class TokenCounter:
    """Count tokens using tiktoken when available with a small LRU cache."""

    def __init__(self, *, max_cache: int = 10_000) -> None:
        self._cache: OrderedDict[str, int] = OrderedDict()
        self._cache_hits = 0
        self._max_cache = max_cache
        self._encoder = self._load_encoder()

    def count(self, text: str) -> int:
        if not text:
            return 0
        key = hashlib.md5(text.encode("utf-8"), usedforsecurity=False).hexdigest()
        cached = self._cache.get(key)
        if cached is not None:
            self._cache_hits += 1
            self._cache.move_to_end(key)
            return cached

        tokens = self._do_count(text)
        self._cache[key] = tokens
        if len(self._cache) > self._max_cache:
            self._cache.popitem(last=False)
        return tokens

    def count_fragment(self, fragment: Fragment) -> int:
        if fragment.tokens > 0:
            return fragment.tokens
        return self.count(fragment.content)

    def count_message(self, message: Message) -> int:
        return self.count(self.render_message(message))

    def count_all(self, fragments: list[Fragment]) -> int:
        return len(fragments) * 4 + sum(self.count_fragment(fragment) for fragment in fragments)

    @staticmethod
    def render_message(message: Message) -> str:
        return f"{message.role}: {message.content}"

    def _do_count(self, text: str) -> int:
        if self._encoder is not None:
            return len(self._encoder.encode(text))

        ascii_chars = sum(1 for char in text if ord(char) <= 127)
        non_ascii_chars = len(text) - ascii_chars
        estimated = math.ceil(ascii_chars / 4) + non_ascii_chars
        return max(1, estimated)

    @staticmethod
    def _load_encoder() -> _TokenEncoder | None:
        try:
            import tiktoken
        except ImportError:
            return None
        return cast(_TokenEncoder, tiktoken.get_encoding("o200k_base"))


__all__ = [
    "CachePolicy",
    "Fragment",
    "FragmentKind",
    "Priority",
    "TokenCounter",
]
