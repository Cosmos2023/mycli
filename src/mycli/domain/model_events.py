from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from mycli.domain.runtime.blocks import RuntimeRole


class ModelEventType(StrEnum):
    MESSAGE_DELTA = "message_delta"
    MESSAGE_COMPLETED = "message_completed"
    REASONING_DELTA = "reasoning_delta"
    TOOL_CALL_REQUESTED = "tool_call_requested"
    TOOL_ARGUMENTS_DELTA = "tool_arguments_delta"
    TOOL_RESULT_SUBMITTED = "tool_result_submitted"
    TURN_COMPLETED = "turn_completed"
    TURN_FAILED = "turn_failed"


class ToolExecutionSource(StrEnum):
    PROVIDER = "provider"
    NATIVE = "native"
    MCP = "mcp"
    SKILL = "skill"
    PROVIDER_BUILTIN = "provider_builtin"


@dataclass(slots=True, frozen=True)
class ModelEvent:
    type: ModelEventType
    role: RuntimeRole | None = None
    text: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, object] | None = None
    tool_arguments_text: str | None = None
    call_id: str | None = None
    provider_id: str | None = None
    source: ToolExecutionSource | None = None
    response_id: str | None = None
    error_message: str | None = None
    usage: dict[str, object] | None = None
    metadata: dict[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.type is ModelEventType.TOOL_CALL_REQUESTED:
            if not self.tool_name:
                raise ValueError("tool_call_requested event requires tool_name")
            if not self.call_id:
                raise ValueError("tool_call_requested event requires call_id")
        if self.type is ModelEventType.MESSAGE_DELTA and not self.text:
            raise ValueError("message_delta event requires text")
        if self.type is ModelEventType.REASONING_DELTA and not self.text:
            raise ValueError("reasoning_delta event requires text")

    @classmethod
    def message_delta(
        cls,
        *,
        text: str,
        role: RuntimeRole = "assistant",
        provider_id: str | None = None,
    ) -> ModelEvent:
        return cls(
            type=ModelEventType.MESSAGE_DELTA,
            role=role,
            text=text,
            provider_id=provider_id,
        )

    @classmethod
    def tool_call_requested(
        cls,
        *,
        tool_name: str,
        tool_arguments: dict[str, object],
        call_id: str,
        source: ToolExecutionSource,
        provider_id: str | None = None,
    ) -> ModelEvent:
        return cls(
            type=ModelEventType.TOOL_CALL_REQUESTED,
            tool_name=tool_name,
            tool_arguments=tool_arguments,
            call_id=call_id,
            source=source,
            provider_id=provider_id,
        )


__all__ = [
    "ModelEvent",
    "ModelEventType",
    "ToolExecutionSource",
]
