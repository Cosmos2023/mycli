from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
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
from mycli.domain.runtime import ReasoningEffort
from mycli.domain.tooling.calls import ToolCall


@dataclass(slots=True, frozen=True)
class ModelMessage:
    role: str
    content: str
    tool_call_id: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()
    metadata: dict[str, object] = field(default_factory=dict)
    blocks: tuple[RuntimeBlock, ...] = ()


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

    def __post_init__(self) -> None:
        object.__setattr__(self, "parameters", tuple(self.parameters))


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


class EventProducingModelClient(Protocol):
    def create_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        tool_choice: str | None = None,
    ) -> list[ModelEvent]:
        ...

    def stream_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        tool_choice: str | None = None,
    ) -> Iterator[ModelEvent]:
        ...


class ThinkingConfigurableClient(Protocol):
    def set_thinking_config(
        self,
        *,
        enabled: bool,
        effort: ReasoningEffort | str | None,
    ) -> None:
        ...


__all__ = [
    "BlockType",
    "EventProducingModelClient",
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
    "ThinkingConfigurableClient",
    "ToolExecutionSource",
]
