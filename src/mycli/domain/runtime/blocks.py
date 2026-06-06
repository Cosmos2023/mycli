from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

BlockType = Literal["text", "tool_call", "tool_result", "reasoning"]
RuntimeRole = Literal["system", "developer", "user", "assistant", "tool"]
ToolSource = Literal["provider", "native", "mcp", "skill", "provider_builtin"]


@dataclass(slots=True, frozen=True)
class RuntimeBlock:
    type: BlockType
    text: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, object] | None = None
    call_id: str | None = None
    provider_id: str | None = None
    source: ToolSource | None = None
    metadata: dict[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.type == "tool_call":
            if not self.tool_name:
                raise ValueError("tool_call block requires tool_name")
            if not self.call_id:
                raise ValueError("tool_call block requires call_id")
        if self.type == "text" and not self.text:
            raise ValueError("text block requires text")


@dataclass(slots=True, frozen=True)
class RuntimeItem:
    role: RuntimeRole
    blocks: tuple[RuntimeBlock, ...] = ()
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class ModelTurnResult:
    items: tuple[RuntimeItem, ...]
    done: bool
    response_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


__all__ = [
    "BlockType",
    "ModelTurnResult",
    "RuntimeBlock",
    "RuntimeItem",
    "RuntimeRole",
    "ToolSource",
]
