from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Protocol

from mycli.domain.logging import LogLevel, ModelLogContext
from mycli.domain.runtime import StopReason
from mycli.domain.runtime.blocks import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.infrastructure.models.base import ModelToolDefinition
from mycli.infrastructure.openai_client import ModelResponseError
from mycli.schemas.responses_protocol import (
    ResponsesCompletedEvent,
    ResponsesFailedEvent,
    ResponsesFunctionCallArgumentsDeltaEvent,
    ResponsesFunctionCallArgumentsDoneEvent,
    ResponsesInProgressEvent,
    ResponsesFunctionCallOutputPayload,
    ResponsesFunctionCallOutputItem,
    ResponsesMcpCallCompletedEvent,
    ResponsesMcpCallOutputItem,
    ResponsesMessageOutputItem,
    ResponsesOutputItemAddedEvent,
    ResponsesOutputItemDoneEvent,
    ResponsesOutputTextDeltaEvent,
    ResponsesReasoningOutputItem,
    ResponsesReasoningSummaryTextDeltaEvent,
    ResponsesUnknownEvent,
    parse_responses_output_item,
    parse_responses_stream_event,
)
from mycli.services.workspace_log_service import WorkspaceLogService

LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class _StreamFunctionCallState:
    item_id: str
    name: str | None = None
    call_id: str | None = None
    arguments_fragments: list[str] = field(default_factory=list)
    emitted: bool = False


class ResponsesClient(Protocol):
    def create_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        ...


class ResponsesModelAdapter:
    def __init__(
        self,
        client: ResponsesClient,
        log_service: WorkspaceLogService | None = None,
    ) -> None:
        self._client = client
        self._log_service = log_service
        self._log_context_provider: Callable[[], ModelLogContext] | None = None

    def set_log_context_provider(
        self,
        provider: Callable[[], ModelLogContext],
    ) -> None:
        self._log_context_provider = provider
        setter = getattr(self._client, "set_log_context_provider", None)
        if callable(setter):
            setter(provider)

    def set_runtime_event_recorder(
        self,
        recorder: Callable[[str, dict[str, object]], None] | None,
    ) -> None:
        setter = getattr(self._client, "set_runtime_event_recorder", None)
        if callable(setter):
            setter(recorder)

    def set_reasoning_effort(self, reasoning_effort: str | None) -> None:
        setter = getattr(self._client, "set_reasoning_effort", None)
        if callable(setter):
            setter(reasoning_effort)

    def set_thinking_config(self, *, enabled: bool, effort: object) -> None:
        setter = getattr(self._client, "set_thinking_config", None)
        if callable(setter):
            setter(enabled=enabled, effort=effort)
            return
        if enabled:
            self.set_reasoning_effort(str(getattr(effort, "value", effort)))
            return
        self.set_reasoning_effort(None)

    def set_continuation_state(self, state: object) -> None:
        setter = getattr(self._client, "set_continuation_state", None)
        if callable(setter):
            setter(state)

    def get_continuation_state(self) -> object | None:
        getter = getattr(self._client, "get_continuation_state", None)
        if callable(getter):
            return getter()
        return None

    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        payload = self._client.create_response(
            input_items=self._serialize_items(items),
            tools=self._serialize_tools(tools),
        )
        turn_result = self._to_model_turn_result(payload)
        self._record_client_completion(turn_result)
        return turn_result

    def stream_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> Iterator[dict[str, object]]:
        stream_response = getattr(self._client, "stream_response", None)
        if not callable(stream_response):
            raise ModelResponseError("Responses client does not support stream_response.")
        function_call_states: dict[str, _StreamFunctionCallState] = {}
        accumulated_blocks: list[RuntimeBlock] = []
        completed_response_id: str | None = None

        for event in stream_response(
            input_items=self._serialize_items(items),
            tools=self._serialize_tools(tools),
        ):
            if isinstance(event, dict) and not event:
                continue
            typed_event = self._coerce_stream_event(event)

            if isinstance(typed_event, ResponsesReasoningSummaryTextDeltaEvent):
                if typed_event.delta:
                    accumulated_blocks.append(RuntimeBlock(type="reasoning", text=typed_event.delta))
                    yield {"type": "reasoning", "text": typed_event.delta}
                continue

            if isinstance(typed_event, ResponsesOutputTextDeltaEvent):
                if typed_event.delta:
                    accumulated_blocks.append(RuntimeBlock(type="text", text=typed_event.delta))
                    yield {"type": "text_delta", "text": typed_event.delta}
                continue

            if isinstance(typed_event, ResponsesInProgressEvent):
                continue

            if isinstance(typed_event, ResponsesOutputItemAddedEvent):
                self._record_stream_output_item_added(
                    event=self._output_item_added_event_to_payload(typed_event),
                    function_call_states=function_call_states,
                )
                continue

            if isinstance(typed_event, ResponsesFunctionCallArgumentsDeltaEvent):
                self._record_stream_function_call_delta(
                    event=self._function_call_arguments_delta_to_payload(typed_event),
                    function_call_states=function_call_states,
                )
                continue

            if isinstance(typed_event, ResponsesMcpCallCompletedEvent):
                reasoning_event = self._build_stream_mcp_call_event(
                    event=self._mcp_call_completed_to_payload(typed_event)
                )
                if reasoning_event is not None:
                    text = reasoning_event.get("text")
                    if isinstance(text, str) and text:
                        accumulated_blocks.append(RuntimeBlock(type="reasoning", text=text))
                    yield reasoning_event
                continue

            if isinstance(typed_event, ResponsesFunctionCallArgumentsDoneEvent):
                tool_call_event = self._build_stream_tool_call_event(
                    event=self._function_call_arguments_done_to_payload(typed_event),
                    function_call_states=function_call_states,
                )
                if tool_call_event is not None:
                    block = tool_call_event.get("block")
                    if isinstance(block, RuntimeBlock):
                        accumulated_blocks.append(block)
                    yield tool_call_event
                continue

            if isinstance(typed_event, ResponsesOutputItemDoneEvent):
                tool_call_event = self._build_stream_tool_call_event_from_output_item_done(
                    event=self._output_item_done_to_payload(typed_event),
                    function_call_states=function_call_states,
                )
                if tool_call_event is not None:
                    block = tool_call_event.get("block")
                    if isinstance(block, RuntimeBlock):
                        accumulated_blocks.append(block)
                    yield tool_call_event
                continue
            if isinstance(typed_event, ResponsesCompletedEvent):
                completed_response_id = typed_event.response_id
                self._record_client_completion(
                    ModelTurnResult(
                        items=(
                            RuntimeItem(
                                role="assistant",
                                blocks=tuple(accumulated_blocks),
                            ),
                        )
                        if accumulated_blocks
                        else (),
                        done=not any(block.type == "tool_call" for block in accumulated_blocks),
                        response_id=typed_event.response_id,
                        metadata={
                            "response_status": typed_event.response_status,
                            "usage": typed_event.usage,
                        },
                    )
                )
                yield {
                    "type": "completed",
                    "response_id": typed_event.response_id,
                    "metadata": {
                        "response_status": typed_event.response_status,
                        "usage": typed_event.usage,
                    },
                }
                continue

            if isinstance(typed_event, ResponsesFailedEvent):
                self._record_client_failure(typed_event.error_message)
                raise self._response_failed_error(event=typed_event)

            if isinstance(typed_event, ResponsesUnknownEvent):
                if typed_event.event_type.endswith(".done") or typed_event.event_type.startswith("response.created") or typed_event.event_type in {
                    "response.content_part.added",
                    "response.in_progress",
                    "response.mcp_call_arguments.delta",
                }:
                    continue
                self._warn_unsupported_stream_event(event_type=typed_event.event_type)
                continue

            raise ModelResponseError("Unsupported typed Responses stream event.")

        if completed_response_id is None:
            self._record_client_failure("Responses stream ended without completion.")

    def _serialize_items(self, items: list[RuntimeItem]) -> list[dict[str, object]]:
        serialized_items: list[dict[str, object]] = []
        for item in items:
            content: list[dict[str, object]] = []

            def flush_message_content() -> None:
                nonlocal content
                if not content:
                    return
                if item.role not in ("system", "developer", "user", "assistant"):
                    raise ModelResponseError(
                        "Responses input_text blocks only support system/developer/user/assistant roles."
                    )
                serialized_items.append(
                    {
                        "role": item.role,
                        "content": content,
                    }
                )
                content = []

            for block in item.blocks:
                if block.type in ("text", "reasoning"):
                    if block.text is None:
                        continue
                    content.append(
                        {
                            "type": "input_text",
                            "text": block.text,
                        }
                    )
                    continue

                flush_message_content()

                if block.type == "tool_call":
                    if not block.call_id:
                        raise ModelResponseError(
                            "Runtime tool_call block requires call_id for Responses input."
                        )
                    raw_name = block.tool_name
                    if not isinstance(raw_name, str) or not raw_name:
                        raise ModelResponseError(
                            "Runtime tool_call block requires tool_name for Responses input."
                        )
                    raw_arguments = block.tool_arguments
                    arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
                    serialized_items.append(
                        {
                            "type": "function_call",
                            "name": raw_name,
                            "arguments": json.dumps(arguments, ensure_ascii=False),
                            "call_id": block.call_id,
                        }
                    )
                    continue
                if block.type == "tool_result":
                    if not block.call_id:
                        raise ModelResponseError(
                            "Runtime tool_result block requires call_id for Responses input."
                        )
                    payload = self._function_call_output_payload_for_block(block=block)
                    serialized_items.append(
                        {
                            "type": "function_call_output",
                            "call_id": block.call_id,
                            "output": payload.to_wire_output(),
                        }
                    )
                    continue
                raise ModelResponseError(
                    f"Unsupported runtime block type for Responses input: {block.type}."
                )

            flush_message_content()
        return serialized_items

    def _function_call_output_payload_for_block(
        self,
        *,
        block: RuntimeBlock,
    ) -> ResponsesFunctionCallOutputPayload:
        raw_payload = block.metadata.get("function_call_output_payload")
        if isinstance(raw_payload, dict):
            return ResponsesFunctionCallOutputPayload.from_dict(raw_payload)
        success = block.metadata.get("success")
        success_flag = success if isinstance(success, bool) else None
        return ResponsesFunctionCallOutputPayload.from_text(
            "" if block.text is None else block.text,
            success=success_flag,
        )

    def _serialize_tools(self, tools: list[ModelToolDefinition]) -> list[dict[str, object]]:
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": [
                    (
                        {
                            "name": parameter.name,
                            "type": parameter.type,
                            "required": parameter.required,
                            "description": parameter.description,
                        }
                        if parameter.items_schema is None
                        else {
                            "name": parameter.name,
                            "type": parameter.type,
                            "required": parameter.required,
                            "description": parameter.description,
                            "items_schema": dict(parameter.items_schema),
                        }
                    )
                    for parameter in tool.parameters
                ],
            }
            for tool in tools
        ]

    def _to_model_turn_result(self, payload: dict[str, object]) -> ModelTurnResult:
        if not isinstance(payload, dict):
            raise ModelResponseError("Responses payload must be a JSON object.")

        raw_output = payload.get("output", [])
        if not isinstance(raw_output, list):
            raise ModelResponseError("Responses payload field 'output' must be a list.")
        output_items = raw_output

        blocks: list[RuntimeBlock] = []
        has_tool_call = False
        for index, item in enumerate(output_items):
            if not isinstance(item, dict):
                raise ModelResponseError(
                    f"Responses output item at index {index} must be an object."
                )

            item_type = item.get("type")
            if not isinstance(item_type, str) or not item_type:
                raise ModelResponseError(
                    f"Responses output item at index {index} is missing required 'type'."
                )
            parsed_item = parse_responses_output_item(item)
            if isinstance(parsed_item, ResponsesReasoningOutputItem):
                blocks.extend(
                    RuntimeBlock(
                        type="reasoning",
                        text=summary_text,
                        provider_id=parsed_item.provider_id,
                        metadata={
                            "provider_item_type": "reasoning",
                            "status": parsed_item.status,
                        },
                    )
                    for summary_text in parsed_item.summaries
                )
                continue
            if isinstance(parsed_item, ResponsesFunctionCallOutputItem):
                if not parsed_item.name:
                    raise ModelResponseError(
                        f"Responses function_call item at index {index} is missing required 'name'."
                    )
                if not parsed_item.call_id:
                    raise ModelResponseError(
                        f"Responses function_call item at index {index} is missing required 'call_id'."
                    )
                arguments = self._parse_function_call_arguments(
                    item={"arguments": parsed_item.arguments},
                    index=index,
                )

                blocks.append(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=parsed_item.name,
                        tool_arguments=arguments,
                        call_id=parsed_item.call_id,
                        provider_id=parsed_item.provider_id,
                        metadata={
                            "provider_item_type": "function_call",
                            "status": parsed_item.status,
                        },
                    )
                )
                has_tool_call = True
                continue

            if isinstance(parsed_item, ResponsesMessageOutputItem):
                message_blocks = [
                    RuntimeBlock(
                        type="text",
                        text=raw_text,
                        provider_id=parsed_item.provider_id,
                        metadata={
                            "provider_item_type": "message.output_text",
                            "status": parsed_item.status,
                        },
                    )
                    for raw_text in parsed_item.texts
                ]
                if not message_blocks and item_type == "message":
                    raise ModelResponseError(
                        "Responses message item did not contain supported output_text content."
                    )
                blocks.extend(message_blocks)
                continue

            if isinstance(parsed_item, ResponsesMcpCallOutputItem):
                blocks.append(
                    RuntimeBlock(
                        type="reasoning",
                        text=self._render_mcp_call_summary(
                            name=parsed_item.name,
                            output=parsed_item.output,
                        ),
                        provider_id=parsed_item.provider_id,
                        metadata={
                            "provider_item_type": "mcp_call",
                            "status": parsed_item.status,
                            "name": parsed_item.name,
                            "arguments": self._parse_optional_arguments(
                                item={"arguments": parsed_item.arguments},
                                index=index,
                            ) if parsed_item.arguments not in (None, "") else {},
                        },
                    )
                )
                continue

            self._warn_unsupported_item(
                item_type=item_type,
                provider_id=None if item.get("id") is None else str(item["id"]),
                index=index,
            )

        runtime_items: tuple[RuntimeItem, ...]
        if blocks:
            runtime_items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),)
        else:
            runtime_items = ()

        response_id = None if payload.get("id") is None else str(payload["id"])
        return ModelTurnResult(
            items=runtime_items,
            done=not has_tool_call,
            response_id=response_id,
            metadata={
                "response_status": payload.get("status"),
                "usage": payload.get("usage"),
            },
        )

    def _parse_function_call_arguments(
        self,
        *,
        item: dict[str, object],
        index: int,
    ) -> dict[str, object]:
        raw_arguments = item.get("arguments", {})
        if isinstance(raw_arguments, dict):
            return raw_arguments
        if isinstance(raw_arguments, str):
            try:
                loaded_arguments = json.loads(raw_arguments)
            except json.JSONDecodeError as exc:
                raise ModelResponseError(
                    f"Responses function_call item at index {index} has invalid JSON arguments."
                ) from exc
            if not isinstance(loaded_arguments, dict):
                raise ModelResponseError(
                    f"Responses function_call item at index {index} must have object arguments."
                )
            return loaded_arguments
        raise ModelResponseError(
            f"Responses function_call item at index {index} has malformed 'arguments'."
        )

    def _message_text_blocks(
        self,
        *,
        item: dict[str, object],
        output_index: int,
        provider_id: str | None,
    ) -> list[RuntimeBlock]:
        raw_content = item.get("content", [])
        if not isinstance(raw_content, list):
            raise ModelResponseError(
                f"Responses message item at index {output_index} has malformed 'content'."
            )

        blocks: list[RuntimeBlock] = []
        for content_index, content_item in enumerate(raw_content):
            if not isinstance(content_item, dict):
                raise ModelResponseError(
                    "Responses message content item at index "
                    f"{output_index}:{content_index} must be an object."
                )
            if content_item.get("type") != "output_text":
                continue
            raw_text = content_item.get("text")
            if not isinstance(raw_text, str) or not raw_text:
                raise ModelResponseError(
                    "Responses output_text content item at index "
                    f"{output_index}:{content_index} is missing required 'text'."
                )
            blocks.append(
                RuntimeBlock(
                    type="text",
                    text=raw_text,
                    provider_id=provider_id,
                    metadata={
                        "provider_item_type": "message.output_text",
                        "status": item.get("status"),
                    },
                )
            )
        return blocks

    def _mcp_call_reasoning_block(
        self,
        *,
        item: dict[str, object],
        index: int,
        provider_id: str | None,
        item_status: str | None,
    ) -> RuntimeBlock | None:
        raw_name = item.get("name")
        if not isinstance(raw_name, str) or not raw_name:
            raise ModelResponseError(
                f"Responses mcp_call item at index {index} is missing required 'name'."
            )
        raw_output = item.get("output")
        output = raw_output if isinstance(raw_output, str) else None
        arguments = self._parse_optional_arguments(item=item, index=index)
        return RuntimeBlock(
            type="reasoning",
            text=self._render_mcp_call_summary(name=raw_name, output=output),
            provider_id=provider_id,
            metadata={
                "provider_item_type": "mcp_call",
                "status": item_status,
                "name": raw_name,
                "arguments": arguments,
            },
        )

    def _reasoning_texts(
        self,
        *,
        item: dict[str, object],
        index: int,
    ) -> list[str]:
        raw_summary = item.get("summary", [])
        if not isinstance(raw_summary, list):
            raise ModelResponseError(
                f"Responses reasoning item at index {index} has malformed 'summary'."
            )
        texts: list[str] = []
        for summary_index, summary_item in enumerate(raw_summary):
            if not isinstance(summary_item, dict):
                raise ModelResponseError(
                    "Responses reasoning summary item at index "
                    f"{index}:{summary_index} must be an object."
                )
            raw_text = summary_item.get("text")
            if not isinstance(raw_text, str) or not raw_text.strip():
                continue
            texts.append(raw_text)
        return texts

    def _parse_optional_arguments(
        self,
        *,
        item: dict[str, object],
        index: int,
    ) -> dict[str, object]:
        if "arguments" not in item or item.get("arguments") in ("", None):
            return {}
        return self._parse_function_call_arguments(item=item, index=index)

    def _render_mcp_call_summary(self, *, name: str, output: str | None) -> str:
        if output and output.strip():
            return f"Provider MCP call {name} completed: {output}"
        return f"Provider MCP call {name} completed."

    def _warn_unsupported_item(
        self,
        *,
        item_type: str,
        provider_id: str | None,
        index: int,
    ) -> None:
        message = f"Ignored unsupported Responses item type={item_type} provider_id={provider_id} index={index}"
        LOGGER.warning(
            message,
        )
        self._log_warning(
            event="responses_item_ignored",
            message=message,
            context={
                "item_type": item_type,
                "provider_id": provider_id,
                "index": index,
            },
        )

    def _warn_unsupported_stream_event(self, *, event_type: str) -> None:
        message = f"Ignored unsupported Responses stream event type={event_type}"
        LOGGER.warning(message)
        self._log_warning(
            event="responses_stream_event_ignored",
            message=message,
            context={"event_type": event_type},
        )

    def _log_warning(
        self,
        *,
        event: str,
        message: str,
        context: dict[str, object],
    ) -> None:
        if self._log_service is None:
            return
        log_context = self._log_context()
        self._log_service.log(
            level=LogLevel.WARNING,
            event=event,
            message=message,
            context={
                "session_id": log_context.session_id,
                "turn_id": log_context.turn_id,
                **context,
            },
        )

    def _log_context(self) -> ModelLogContext:
        if self._log_context_provider is None:
            return ModelLogContext()
        return self._log_context_provider()

    def _response_failed_error(self, *, event: ResponsesFailedEvent | dict[str, object]) -> ModelResponseError:
        def classify(
            message: str | None,
            code: str | None,
        ) -> tuple[StopReason | None, str | None]:
            normalized_message = message.lower() if isinstance(message, str) else ""
            normalized_code = code.lower() if isinstance(code, str) else ""
            if normalized_code in {"context_length_exceeded", "context_window_exceeded"} or any(
                marker in normalized_message
                for marker in ("context length", "maximum context length", "context window")
            ):
                return StopReason.CONTEXT_WINDOW_EXCEEDED, "context_window_exceeded"
            return StopReason.MODEL_ERROR, "provider_error"

        if isinstance(event, ResponsesFailedEvent):
            if event.error_message:
                stop_reason, failure_kind = classify(event.error_message, event.error_code)
                if event.error_code:
                    return ModelResponseError(
                        f"Model provider returned response.failed ({event.error_code}): {event.error_message}",
                        stop_reason=stop_reason,
                        failure_kind=failure_kind,
                    )
                return ModelResponseError(
                    f"Model provider returned response.failed: {event.error_message}",
                    stop_reason=stop_reason,
                    failure_kind=failure_kind,
                )
            return ModelResponseError(
                "Model provider returned response.failed.",
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="provider_error",
            )
        response = event.get("response", {})
        if not isinstance(response, dict):
            return ModelResponseError(
                "Model provider returned response.failed without a response payload.",
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="provider_error",
            )
        error = response.get("error", {})
        if isinstance(error, dict):
            message = error.get("message")
            code = error.get("code")
            if isinstance(message, str) and message.strip():
                stop_reason, failure_kind = classify(
                    message,
                    code if isinstance(code, str) else None,
                )
                if isinstance(code, str) and code.strip():
                    return ModelResponseError(
                        f"Model provider returned response.failed ({code}): {message}",
                        stop_reason=stop_reason,
                        failure_kind=failure_kind,
                    )
                return ModelResponseError(
                    f"Model provider returned response.failed: {message}",
                    stop_reason=stop_reason,
                    failure_kind=failure_kind,
                )
        return ModelResponseError(
            "Model provider returned response.failed.",
            stop_reason=StopReason.MODEL_ERROR,
            failure_kind="provider_error",
        )

    def _record_client_completion(self, turn_result: ModelTurnResult) -> None:
        recorder = getattr(self._client, "record_response_completion", None)
        if not callable(recorder):
            return
        recorder(
            response_id=turn_result.response_id,
            response_output_items=self._serialize_model_output_items(turn_result.items),
        )

    def _record_client_failure(self, reason: str | None) -> None:
        recorder = getattr(self._client, "record_response_failure", None)
        if callable(recorder):
            recorder(reason)

    def _serialize_model_output_items(
        self,
        items: tuple[RuntimeItem, ...],
    ) -> list[dict[str, object]]:
        serialized: list[dict[str, object]] = []
        for item in items:
            if item.role != "assistant":
                continue
            persisted_blocks = tuple(
                block for block in item.blocks if block.type in {"text", "tool_call"}
            )
            if not persisted_blocks:
                continue
            serialized.extend(
                self._serialize_items([RuntimeItem(role="assistant", blocks=persisted_blocks)])
            )
        return serialized

    def _coerce_stream_event(
        self,
        event: object,
    ) -> object:
        if isinstance(
            event,
            (
                ResponsesReasoningSummaryTextDeltaEvent,
                ResponsesOutputTextDeltaEvent,
                ResponsesInProgressEvent,
                ResponsesOutputItemAddedEvent,
                ResponsesFunctionCallArgumentsDeltaEvent,
                ResponsesFunctionCallArgumentsDoneEvent,
                ResponsesOutputItemDoneEvent,
                ResponsesMcpCallCompletedEvent,
                ResponsesCompletedEvent,
                ResponsesFailedEvent,
                ResponsesUnknownEvent,
            ),
        ):
            return event
        if not isinstance(event, dict):
            raise ModelResponseError("Responses stream event must be a JSON object.")
        return parse_responses_stream_event(event)

    def _output_item_added_event_to_payload(
        self,
        event: ResponsesOutputItemAddedEvent,
    ) -> dict[str, object]:
        return {
            "type": "response.output_item.added",
            "item_id": event.item_id,
            "item": {
                "id": event.item_id,
                "type": event.item_type,
                "name": event.name,
                "call_id": event.call_id,
                "arguments": event.arguments or "",
            },
        }

    def _function_call_arguments_delta_to_payload(
        self,
        event: ResponsesFunctionCallArgumentsDeltaEvent,
    ) -> dict[str, object]:
        return {
            "type": "response.function_call_arguments.delta",
            "item_id": event.item_id,
            "delta": event.delta,
        }

    def _function_call_arguments_done_to_payload(
        self,
        event: ResponsesFunctionCallArgumentsDoneEvent,
    ) -> dict[str, object]:
        return {
            "type": "response.function_call_arguments.done",
            "item_id": event.item_id,
            "name": event.name,
            "arguments": event.arguments,
            "call_id": event.call_id,
        }

    def _output_item_done_to_payload(
        self,
        event: ResponsesOutputItemDoneEvent,
    ) -> dict[str, object]:
        return {
            "type": "response.output_item.done",
            "item_id": event.item_id,
            "item": {
                "id": event.item_id,
                "type": event.item_type,
                "name": event.name,
                "call_id": event.call_id,
                "arguments": event.arguments,
                "status": event.status,
            },
        }

    def _mcp_call_completed_to_payload(
        self,
        event: ResponsesMcpCallCompletedEvent,
    ) -> dict[str, object]:
        return {
            "type": "response.mcp_call.completed",
            "item_id": event.item_id,
            "name": event.name,
            "arguments": event.arguments,
            "output": event.output,
        }

    def _record_stream_output_item_added(
        self,
        *,
        event: dict[str, object],
        function_call_states: dict[str, _StreamFunctionCallState],
    ) -> None:
        item = event.get("item")
        if not isinstance(item, dict):
            return
        item_type = item.get("type")
        if item_type != "function_call":
            return
        item_id = self._stream_item_id(event=event, item=item)
        if item_id is None:
            return
        state = function_call_states.setdefault(
            item_id,
            _StreamFunctionCallState(item_id=item_id),
        )
        raw_name = item.get("name")
        if isinstance(raw_name, str) and raw_name:
            state.name = raw_name
        raw_call_id = item.get("call_id")
        if isinstance(raw_call_id, str) and raw_call_id:
            state.call_id = raw_call_id
        raw_arguments = item.get("arguments")
        if isinstance(raw_arguments, str) and raw_arguments:
            state.arguments_fragments = [raw_arguments]

    def _record_stream_function_call_delta(
        self,
        *,
        event: dict[str, object],
        function_call_states: dict[str, _StreamFunctionCallState],
    ) -> None:
        item_id = self._stream_item_id(event=event)
        if item_id is None:
            return
        state = function_call_states.setdefault(
            item_id,
            _StreamFunctionCallState(item_id=item_id),
        )
        raw_name = event.get("name")
        if isinstance(raw_name, str) and raw_name:
            state.name = raw_name
        raw_call_id = event.get("call_id")
        if isinstance(raw_call_id, str) and raw_call_id:
            state.call_id = raw_call_id
        delta = event.get("delta")
        if isinstance(delta, str) and delta:
            state.arguments_fragments.append(delta)

    def _build_stream_tool_call_event(
        self,
        *,
        event: dict[str, object],
        function_call_states: dict[str, _StreamFunctionCallState],
    ) -> dict[str, object] | None:
        item_id = self._stream_item_id(event=event)
        state = None if item_id is None else function_call_states.get(item_id)
        if state is not None and state.emitted:
            return None

        raw_name = event.get("name")
        name = raw_name if isinstance(raw_name, str) and raw_name else None
        if name is None and state is not None:
            name = state.name
        if name is None:
            raise ModelResponseError(
                "Responses stream function_call_arguments.done is missing required 'name'."
            )

        raw_call_id = event.get("call_id")
        call_id = raw_call_id if isinstance(raw_call_id, str) and raw_call_id else None
        if call_id is None and state is not None:
            call_id = state.call_id
        if call_id is None and item_id is not None:
            call_id = item_id
        if call_id is None:
            raise ModelResponseError(
                "Responses stream function_call_arguments.done is missing required 'call_id'."
            )

        arguments_payload = event.get("arguments")
        if not isinstance(arguments_payload, (str, dict)) and state is not None:
            buffered_arguments = "".join(state.arguments_fragments)
            if buffered_arguments:
                arguments_payload = buffered_arguments
        arguments = self._parse_function_call_arguments(
            item={"arguments": arguments_payload if arguments_payload is not None else {}},
            index=-1,
        )
        if state is not None:
            state.emitted = True
            state.name = name
            state.call_id = call_id

        provider_id = item_id
        return {
            "type": "tool_call",
            "block": RuntimeBlock(
                type="tool_call",
                tool_name=name,
                tool_arguments=arguments,
                call_id=call_id,
                provider_id=provider_id,
                metadata={
                    "provider_item_type": "function_call",
                    "provider_event_type": "response.function_call_arguments.done",
                },
            ),
        }

    def _build_stream_tool_call_event_from_output_item_done(
        self,
        *,
        event: dict[str, object],
        function_call_states: dict[str, _StreamFunctionCallState],
    ) -> dict[str, object] | None:
        item = event.get("item")
        if not isinstance(item, dict) or item.get("type") != "function_call":
            return None
        merged_event = dict(item)
        merged_event["type"] = "response.function_call_arguments.done"
        item_id = self._stream_item_id(event=event, item=item)
        if item_id is not None:
            merged_event["item_id"] = item_id
        return self._build_stream_tool_call_event(
            event=merged_event,
            function_call_states=function_call_states,
        )

    def _build_stream_mcp_call_event(
        self,
        *,
        event: dict[str, object],
    ) -> dict[str, object] | None:
        raw_name = event.get("name")
        if not isinstance(raw_name, str) or not raw_name:
            return None
        raw_output = event.get("output")
        output = raw_output if isinstance(raw_output, str) else None
        return {
            "type": "reasoning",
            "text": self._render_mcp_call_summary(name=raw_name, output=output),
        }

    def _stream_item_id(
        self,
        *,
        event: dict[str, object],
        item: dict[str, object] | None = None,
    ) -> str | None:
        raw_item_id = event.get("item_id")
        if isinstance(raw_item_id, str) and raw_item_id:
            return raw_item_id
        if item is None:
            return None
        raw_item_id = item.get("id")
        if isinstance(raw_item_id, str) and raw_item_id:
            return raw_item_id
        return None
