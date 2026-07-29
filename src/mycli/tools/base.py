from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.model_output import ToolModelOutputAdapter, compact_model_output

__all__ = [
    "MutationAwareTool",
    "SchemaTool",
    "ToolEffectProfile",
    "ToolParameter",
    "ToolResult",
    "ToolSpec",
    "mutation_targets_for_tool",
    "tool_effects_for_tool",
    "tool_has_mutation_contract",
]


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
    supports_parallel_tool_calls: bool = False
    model_output_adapter: ToolModelOutputAdapter = compact_model_output


FilesystemEffect = Literal["none", "read", "write", "unknown"]


@dataclass(slots=True, frozen=True)
class ToolEffectProfile:
    filesystem: FilesystemEffect = "unknown"
    network: bool = False
    process: bool = False


class SchemaTool(Protocol):
    spec: ToolSpec

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        ...

    def run(self, call: ToolCall) -> ToolResult:
        ...


class MutationAwareTool(Protocol):
    spec: ToolSpec

    def mutation_targets(self, arguments: dict[str, Any]) -> tuple[str, ...]:
        ...


def tool_has_mutation_contract(tool: object) -> bool:
    return callable(getattr(tool, "mutation_targets", None))


def tool_effects_for_tool(tool: object) -> ToolEffectProfile:
    method = getattr(tool, "effect_profile", None)
    if callable(method):
        profile = method()
        if isinstance(profile, ToolEffectProfile):
            return profile
    if tool_has_mutation_contract(tool):
        return ToolEffectProfile(filesystem="write")
    return ToolEffectProfile()


def mutation_targets_for_tool(
    tool: object,
    arguments: dict[str, Any],
) -> tuple[str, ...]:
    method = getattr(tool, "mutation_targets", None)
    if not callable(method):
        return ()
    targets = method(arguments)
    return tuple(path for path in targets if isinstance(path, str) and path)
