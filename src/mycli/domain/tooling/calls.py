from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True, frozen=True)
class ToolCall:
    name: str
    arguments: dict[str, Any]
    reason: str
    call_id: str | None = None


@dataclass(slots=True, frozen=True)
class ToolEvidence:
    kind: str
    title: str
    path: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    snippet: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class ToolResult:
    success: bool
    summary: str
    artifacts: dict[str, Any] = field(default_factory=dict)
    raw_payload: dict[str, Any] = field(default_factory=dict)
    evidence: tuple[ToolEvidence, ...] = field(default_factory=tuple)
    error: str | None = None
