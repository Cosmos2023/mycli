from __future__ import annotations

from mycli.domain.runtime import RequestShape
from mycli.infrastructure.models.base import ModelMessage, RuntimeItem
from mycli.domain.tools import ToolCall


class RequestShapePayloadFormatter:
    def legacy_messages(self, shape: RequestShape) -> list[ModelMessage]:
        return [
            ModelMessage(
                role=message.role,
                content=self._legacy_content(message.content, message.metadata),
                tool_call_id=self._tool_call_id(message.metadata),
                tool_calls=self._tool_calls(message.metadata),
                metadata=self._model_metadata(message.metadata),
            )
            for message in shape.provider_messages
            if message.content.strip()
        ]

    def runtime_items(self, shape: RequestShape) -> list[RuntimeItem]:
        return [
            RuntimeItem(
                role=item.role,
                blocks=item.blocks,
            )
            for item in shape.provider_runtime_items
            if item.blocks
        ]

    def _legacy_content(self, content: str, metadata: dict[str, object]) -> str:
        legacy_content = metadata.get("legacy_content")
        if isinstance(legacy_content, str):
            return legacy_content
        return content

    def _tool_call_id(self, metadata: dict[str, object]) -> str | None:
        tool_call_id = metadata.get("tool_call_id")
        return tool_call_id if isinstance(tool_call_id, str) else None

    def _tool_calls(self, metadata: dict[str, object]) -> tuple[ToolCall, ...]:
        tool_calls = metadata.get("tool_calls")
        if not isinstance(tool_calls, tuple):
            return ()
        return tuple(call for call in tool_calls if isinstance(call, ToolCall))

    def _model_metadata(self, metadata: dict[str, object]) -> dict[str, object]:
        model_metadata = metadata.get("model_metadata")
        if isinstance(model_metadata, dict):
            return dict(model_metadata)
        return {
            key: value
            for key, value in metadata.items()
            if key not in {"legacy_content", "tool_call_id", "tool_calls"}
        }
