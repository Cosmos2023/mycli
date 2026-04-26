from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from mycli.domain.tools import ToolCall, ToolEvidence, ToolResult


@dataclass(slots=True, frozen=True)
class ToolParameter:
    name: str
    type: str
    required: bool = True
    description: str | None = None
    items_schema: dict[str, Any] | None = None


@dataclass(slots=True, frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: tuple[ToolParameter, ...] = field(default_factory=tuple)
    risk_level: str = "low"


@dataclass(slots=True, frozen=True)
class ToolResultV2:
    success: bool
    summary: str
    artifacts: dict[str, Any] = field(default_factory=dict)
    raw_payload: dict[str, Any] = field(default_factory=dict)
    evidence: tuple[ToolEvidence, ...] = field(default_factory=tuple)
    error: str | None = None

    def to_legacy(self) -> ToolResult:
        return ToolResult(
            success=self.success,
            summary=self.summary,
            artifacts=self.artifacts,
            raw_payload=self.raw_payload,
            evidence=self.evidence,
            error=self.error,
        )


class SchemaTool(Protocol):
    spec: ToolSpec

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        ...

    def run(self, call: ToolCall) -> ToolResult:
        ...
