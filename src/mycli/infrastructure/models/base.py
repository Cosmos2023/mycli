from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from typing import Protocol

from mycli.domain.runtime.blocks import (
    BlockType,
    ModelTurnResult,
    RuntimeBlock,
    RuntimeItem,
    RuntimeRole,
)
from mycli.domain.model_events import (
    ModelEvent,
    ModelEventType,
    ToolExecutionSource,
)
from mycli.domain.tools import ToolCall


@dataclass(slots=True, frozen=True)
class ModelMessage:
    role: str
    content: str
    tool_call_id: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()


@dataclass(slots=True, frozen=True)
class ModelToolParameter:
    name: str
    type: str
    required: bool = True
    description: str | None = None
    items_schema: dict[str, Any] | None = None


@dataclass(slots=True, frozen=True)
class ModelToolDefinition:
    name: str
    description: str
    parameters: tuple[ModelToolParameter, ...]


@dataclass(slots=True, frozen=True)
class ModelAction:
    assistant_message: str | None = None
    progress_message: str | None = None
    tool_call: ToolCall | None = None
    done: bool = False


class ModelAdapter(Protocol):
    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        ...


__all__ = [
    "BlockType",
    "ModelAction",
    "ModelAdapter",
    "ModelEvent",
    "ModelEventType",
    "ModelMessage",
    "ModelToolDefinition",
    "ModelToolParameter",
    "ModelTurnResult",
    "RuntimeBlock",
    "RuntimeItem",
    "RuntimeRole",
    "ToolExecutionSource",
]
