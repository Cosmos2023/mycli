from __future__ import annotations

from dataclasses import dataclass
from threading import Lock


@dataclass(frozen=True, slots=True)
class ShellOutputSnapshot:
    text: str
    total_chars: int
    retained_chars: int
    omitted_chars: int


@dataclass(frozen=True, slots=True)
class ShellOutputChunk:
    text: str
    next_cursor: int
    cursor_was_evicted: bool
    omitted_before_chunk: int


class ShellOutputBuffer:
    """Retain a bounded output prefix and suffix with absolute cursors."""

    def __init__(self, *, max_chars: int) -> None:
        if max_chars < 0:
            raise ValueError("max_chars must be non-negative")
        self._max_chars = max_chars
        self._head_budget = max_chars // 2
        self._tail_budget = max_chars - self._head_budget
        self._head = ""
        self._tail = ""
        self._total_chars = 0
        self._lock = Lock()

    @property
    def end_cursor(self) -> int:
        with self._lock:
            return self._total_chars

    def append(self, text: str) -> None:
        if not text:
            return
        with self._lock:
            self._total_chars += len(text)
            remaining = text
            if len(self._head) < self._head_budget:
                available = self._head_budget - len(self._head)
                self._head += remaining[:available]
                remaining = remaining[available:]
            if not remaining or self._tail_budget == 0:
                return
            self._tail = (self._tail + remaining)[-self._tail_budget :]

    def snapshot(self) -> ShellOutputSnapshot:
        with self._lock:
            retained = len(self._head) + len(self._tail)
            return ShellOutputSnapshot(
                text=self._head + self._tail,
                total_chars=self._total_chars,
                retained_chars=retained,
                omitted_chars=max(0, self._total_chars - retained),
            )

    def read_from(self, cursor: int) -> ShellOutputChunk:
        with self._lock:
            effective_cursor = min(max(0, cursor), self._total_chars)
            head_end = len(self._head)
            tail_start = self._total_chars - len(self._tail)
            parts: list[str] = []
            omitted = 0

            if effective_cursor < head_end:
                parts.append(self._head[effective_cursor:])
                omitted = max(0, tail_start - head_end)
                parts.append(self._tail)
            elif effective_cursor < tail_start:
                omitted = tail_start - effective_cursor
                parts.append(self._tail)
            else:
                parts.append(self._tail[effective_cursor - tail_start :])

            return ShellOutputChunk(
                text="".join(parts),
                next_cursor=self._total_chars,
                cursor_was_evicted=omitted > 0,
                omitted_before_chunk=omitted,
            )

