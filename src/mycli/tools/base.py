from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from mycli.domain.tooling.calls import ToolCall, ToolResult

__all__ = ["SchemaTool", "ToolParameter", "ToolResult", "ToolSpec"]


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


class SchemaTool(Protocol):
    spec: ToolSpec

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        ...

    def run(self, call: ToolCall) -> ToolResult:
        ...
