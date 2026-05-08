from __future__ import annotations

from typing import Callable

from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelAdapter, ModelMessage, ModelToolDefinition
from mycli.llms.clients.openai_chat import ModelResponseError


class ModelTurnRequester:
    """Normalizes model-adapter request styles into `ModelTurnResult`."""

    def __init__(
        self,
        *,
        model_adapter: ModelAdapter,
        normalize_tool_call: Callable[[ToolCall], ToolCall],
    ) -> None:
        self._model_adapter = model_adapter
        self._normalize_tool_call = normalize_tool_call

    def request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        stream_turn = getattr(self._model_adapter, "stream_turn", None)
        if callable(stream_turn):
            return self._request_streaming_turn(
                stream_turn=stream_turn,
                runtime_items=runtime_items,
                tools=tools,
            )

        next_turn = getattr(self._model_adapter, "next_turn", None)
        if callable(next_turn):
            turn_result = next_turn(items=runtime_items, tools=tools)
            if isinstance(turn_result, ModelTurnResult):
                return turn_result, ()
            raise ModelResponseError("Model adapter next_turn must return ModelTurnResult.")

        action = self._model_adapter.next_action(
            messages=legacy_messages,
            tools=tools,
        )
        return self._legacy_action_to_turn_result(action), ()

    def _request_streaming_turn(
        self,
        *,
        stream_turn: object,
        runtime_items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        if not callable(stream_turn):
            raise ModelResponseError("Model adapter stream_turn must be callable.")
        blocks: list[RuntimeBlock] = []
        streamed_chunks: list[str] = []
        response_id: str | None = None
        metadata: dict[str, object] = {}
        has_tool_call = False

        for event in stream_turn(items=runtime_items, tools=tools):
            if not isinstance(event, dict):
                raise ModelResponseError("Model adapter stream_turn must yield dict events.")
            event_type = event.get("type")
            if event_type == "reasoning":
                text = event.get("text")
                if isinstance(text, str) and text:
                    blocks.append(RuntimeBlock(type="reasoning", text=text))
                continue
            if event_type == "text_delta":
                text = event.get("text")
                if isinstance(text, str) and text:
                    blocks.append(RuntimeBlock(type="text", text=text))
                    streamed_chunks.append(text)
                continue
            if event_type == "tool_call":
                block = event.get("block")
                if not isinstance(block, RuntimeBlock) or block.type != "tool_call":
                    raise ModelResponseError(
                        "Model adapter tool_call stream event must include tool_call RuntimeBlock."
                    )
                blocks.append(block)
                has_tool_call = True
                continue
            if event_type == "completed":
                raw_response_id = event.get("response_id")
                if isinstance(raw_response_id, str) and raw_response_id:
                    response_id = raw_response_id
                raw_metadata = event.get("metadata")
                if isinstance(raw_metadata, dict):
                    metadata = raw_metadata
                continue
            raise ModelResponseError(f"Unsupported model stream event type: {event_type!r}.")

        items: tuple[RuntimeItem, ...] = ()
        if blocks:
            items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),)
        return (
            ModelTurnResult(
                items=items,
                done=not has_tool_call,
                response_id=response_id,
                metadata=metadata,
            ),
            tuple(streamed_chunks),
        )

    def _legacy_action_to_turn_result(self, action: object) -> ModelTurnResult:
        blocks: list[RuntimeBlock] = []
        progress_message = getattr(action, "progress_message", None)
        if isinstance(progress_message, str) and progress_message:
            blocks.append(RuntimeBlock(type="reasoning", text=progress_message))

        tool_call = getattr(action, "tool_call", None)
        if isinstance(tool_call, ToolCall):
            normalized_call = self._normalize_tool_call(tool_call)
            blocks.append(
                RuntimeBlock(
                    type="tool_call",
                    tool_name=normalized_call.name,
                    tool_arguments=normalized_call.arguments,
                    call_id=normalized_call.call_id or "",
                )
            )

        assistant_message = getattr(action, "assistant_message", None)
        if isinstance(assistant_message, str) and assistant_message:
            blocks.append(RuntimeBlock(type="text", text=assistant_message))

        items: tuple[RuntimeItem, ...] = ()
        if blocks:
            items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),)

        return ModelTurnResult(
            items=items,
            done=bool(getattr(action, "done", False)),
        )
