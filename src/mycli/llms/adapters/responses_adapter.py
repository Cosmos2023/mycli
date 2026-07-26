from __future__ import annotations

import logging
import inspect
from collections.abc import Callable, Iterator
from typing import Protocol, cast

from mycli.domain.logging import LogLevel, ModelLogContext
from mycli.domain.runtime import RuntimeInterruptToken, StopReason
from mycli.domain.runtime.blocks import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.llms.adapters.base import ModelToolDefinition
from mycli.llms.adapters.responses_output_parser import ResponsesOutputParser
from mycli.llms.adapters.responses_serialization import ResponsesInputSerializer
from mycli.llms.adapters.responses_stream_events import (
    ResponsesStreamEventAdapter,
    StreamFunctionCallState,
)
from mycli.llms.adapters.turn_event_aggregator import TurnEventAggregator
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.schemas.responses_protocol import (
    ResponsesCompletedEvent,
    ResponsesFailedEvent,
    ResponsesFunctionCallArgumentsDeltaEvent,
    ResponsesFunctionCallArgumentsDoneEvent,
    ResponsesInProgressEvent,
    ResponsesFunctionCallOutputPayload,
    ResponsesMcpCallCompletedEvent,
    ResponsesOutputItemAddedEvent,
    ResponsesOutputItemDoneEvent,
    ResponsesOutputTextDeltaEvent,
    ResponsesReasoningSummaryTextDeltaEvent,
    ResponsesUnknownEvent,
)
from mycli.utils.workspace_logger import WorkspaceLogService

LOGGER = logging.getLogger(__name__)


class ResponsesClient(Protocol):
    def create_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        instructions: str | None = None,
        prompt_cache_key: str | None = None,
        tool_choice: str | None = None,
    ) -> dict[str, object]:
        ...


class ResponsesModelAdapter:
    def __init__(
        self,
        client: ResponsesClient,
        log_service: WorkspaceLogService | None = None,
    ) -> None:
        self._client = client
        self._aggregator = TurnEventAggregator()
        self._serializer = ResponsesInputSerializer()
        self._output_parser = ResponsesOutputParser(
            warn_unsupported_item=lambda item_type, provider_id, index: self._warn_unsupported_item(
                item_type=item_type,
                provider_id=provider_id,
                index=index,
            ),
        )
        self._stream_events = ResponsesStreamEventAdapter(self._output_parser)
        self._log_service = log_service
        self._log_context_provider: Callable[[], ModelLogContext] | None = None
        self._tool_choice: str | None = None

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

    def set_tool_choice(self, tool_choice: str | None) -> None:
        self._tool_choice = tool_choice
        setter = getattr(self._client, "set_tool_choice", None)
        if callable(setter):
            setter(tool_choice)

    def supports_tool_choice(self) -> bool:
        return callable(getattr(self._client, "set_tool_choice", None))

    def set_model(self, model: str) -> None:
        setter = getattr(self._client, "set_model", None)
        if callable(setter):
            setter(model)

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
            return cast(object | None, getter())
        return None

    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        input_items = self._serializer.serialize_items(items)
        serialized_tools = self._serializer.serialize_tools(tools)
        instructions = self._wire_instructions_from_items(items)
        prompt_cache_key = self._prompt_cache_key_from_items(items)
        create_events = getattr(self._client, "create_events", None)
        if callable(create_events):
            event_kwargs: dict[str, object] = {
                "input_items": input_items,
                "tools": serialized_tools,
            }
            if instructions and self._callable_accepts_instructions(create_events):
                event_kwargs["instructions"] = instructions
            if prompt_cache_key and self._callable_accepts_prompt_cache_key(create_events):
                event_kwargs["prompt_cache_key"] = prompt_cache_key
            if self._tool_choice is not None and self._callable_accepts_tool_choice(
                create_events
            ):
                event_kwargs["tool_choice"] = self._tool_choice
            turn_result = self._aggregator.collect(create_events(**event_kwargs))
        else:
            if prompt_cache_key and self._callable_accepts_prompt_cache_key(
                self._client.create_response
            ):
                create_kwargs: dict[str, object] = {
                    "input_items": input_items,
                    "tools": serialized_tools,
                    "prompt_cache_key": prompt_cache_key,
                }
            else:
                create_kwargs = {
                    "input_items": input_items,
                    "tools": serialized_tools,
                }
            if instructions and self._callable_accepts_instructions(
                self._client.create_response
            ):
                create_kwargs["instructions"] = instructions
            if self._tool_choice is not None and self._callable_accepts_tool_choice(
                self._client.create_response
            ):
                create_kwargs["tool_choice"] = self._tool_choice
            create_response = cast(
                Callable[..., dict[str, object]],
                self._client.create_response,
            )
            payload = create_response(**create_kwargs)
            turn_result = self._output_parser.to_model_turn_result(payload)
        self._record_client_completion(turn_result)
        return turn_result

    def stream_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> Iterator[dict[str, object]]:
        yield from self._stream_turn(items=items, tools=tools)

    def stream_turn_with_interrupt(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
        interrupt_token: RuntimeInterruptToken,
    ) -> Iterator[dict[str, object]]:
        yield from self._stream_turn(
            items=items,
            tools=tools,
            interrupt_token=interrupt_token,
        )

    def _stream_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> Iterator[dict[str, object]]:
        stream_response = self._stream_response_callable(interrupt_token)
        if not callable(stream_response):
            raise ModelResponseError("Responses client does not support stream_response.")
        function_call_states: dict[str, StreamFunctionCallState] = {}
        accumulated_blocks: list[RuntimeBlock] = []
        completed_response_id: str | None = None

        stream_kwargs: dict[str, object] = {
            "input_items": self._serializer.serialize_items(items),
            "tools": self._serializer.serialize_tools(tools),
        }
        instructions = self._wire_instructions_from_items(items)
        if instructions and self._callable_accepts_instructions(stream_response):
            stream_kwargs["instructions"] = instructions
        prompt_cache_key = self._prompt_cache_key_from_items(items)
        if prompt_cache_key and self._callable_accepts_prompt_cache_key(stream_response):
            stream_kwargs["prompt_cache_key"] = prompt_cache_key
        if self._tool_choice is not None and self._callable_accepts_tool_choice(
            stream_response
        ):
            stream_kwargs["tool_choice"] = self._tool_choice
        for event in stream_response(**stream_kwargs):
            if isinstance(event, dict) and not event:
                continue
            typed_event = self._stream_events.coerce_event(event)

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
                self._stream_events.record_output_item_added(
                    event=self._stream_events.output_item_added_payload(typed_event),
                    function_call_states=function_call_states,
                )
                continue

            if isinstance(typed_event, ResponsesFunctionCallArgumentsDeltaEvent):
                self._stream_events.record_function_call_delta(
                    event=self._stream_events.function_call_arguments_delta_payload(typed_event),
                    function_call_states=function_call_states,
                )
                continue

            if isinstance(typed_event, ResponsesMcpCallCompletedEvent):
                reasoning_event = self._stream_events.build_mcp_call_event(
                    event=self._stream_events.mcp_call_completed_payload(typed_event)
                )
                if reasoning_event is not None:
                    text = reasoning_event.get("text")
                    if isinstance(text, str) and text:
                        accumulated_blocks.append(RuntimeBlock(type="reasoning", text=text))
                    yield reasoning_event
                continue

            if isinstance(typed_event, ResponsesFunctionCallArgumentsDoneEvent):
                tool_call_event = self._stream_events.build_tool_call_event(
                    event=self._stream_events.function_call_arguments_done_payload(typed_event),
                    function_call_states=function_call_states,
                )
                if tool_call_event is not None:
                    block = tool_call_event.get("block")
                    if isinstance(block, RuntimeBlock):
                        accumulated_blocks.append(block)
                    yield tool_call_event
                continue

            if isinstance(typed_event, ResponsesOutputItemDoneEvent):
                done_payload = self._stream_events.output_item_done_payload(typed_event)
                tool_call_event = self._stream_events.build_tool_call_event_from_output_item_done(
                    event=done_payload,
                    function_call_states=function_call_states,
                )
                if tool_call_event is not None:
                    block = tool_call_event.get("block")
                    if isinstance(block, RuntimeBlock):
                        accumulated_blocks.append(block)
                    yield tool_call_event
                completed_item_result = self._output_parser.to_model_turn_result(
                    {"output": [typed_event.raw_item]}
                )
                if completed_item_result.items:
                    yield {
                        "type": "item_completed",
                        "item": completed_item_result.items[0],
                    }
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

    def _stream_response_callable(
        self,
        interrupt_token: RuntimeInterruptToken | None,
    ) -> object:
        if interrupt_token is not None:
            stream_response_with_interrupt = getattr(
                self._client,
                "stream_response_with_interrupt",
                None,
            )
            if callable(stream_response_with_interrupt):
                return lambda **kwargs: stream_response_with_interrupt(
                    **kwargs,
                    interrupt_token=interrupt_token,
                )
        return getattr(self._client, "stream_response", None)

    def _function_call_output_payload_for_block(
        self,
        *,
        block: RuntimeBlock,
    ) -> ResponsesFunctionCallOutputPayload:
        return self._serializer.function_call_output_payload_for_block(block=block)

    def _serialize_tools(self, tools: list[ModelToolDefinition]) -> list[dict[str, object]]:
        return self._serializer.serialize_tools(tools)

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

    def _prompt_cache_key_from_items(self, items: list[RuntimeItem]) -> str | None:
        for item in items:
            policy = item.metadata.get("provider_request_policy")
            if not isinstance(policy, dict):
                continue
            value = policy.get("prompt_cache_key")
            if isinstance(value, str) and value:
                return value
        return None

    def _wire_instructions_from_items(self, items: list[RuntimeItem]) -> str | None:
        for item in items:
            value = item.metadata.get("wire_instructions")
            if isinstance(value, str) and value.strip():
                return value
        return None

    def _callable_accepts_instructions(self, func: Callable[..., object]) -> bool:
        try:
            signature = inspect.signature(func)
        except (TypeError, ValueError):
            return False
        for parameter in signature.parameters.values():
            if parameter.kind is parameter.VAR_KEYWORD:
                return True
            if parameter.name == "instructions":
                return True
        return False

    def _callable_accepts_prompt_cache_key(self, func: Callable[..., object]) -> bool:
        try:
            signature = inspect.signature(func)
        except (TypeError, ValueError):
            return False
        for parameter in signature.parameters.values():
            if parameter.kind is parameter.VAR_KEYWORD:
                return True
            if parameter.name == "prompt_cache_key":
                return True
        return False

    def _callable_accepts_tool_choice(self, func: Callable[..., object]) -> bool:
        try:
            signature = inspect.signature(func)
        except (TypeError, ValueError):
            return False
        for parameter in signature.parameters.values():
            if parameter.kind is parameter.VAR_KEYWORD:
                return True
            if parameter.name == "tool_choice":
                return True
        return False

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
                self._serializer.serialize_items(
                    [RuntimeItem(role="assistant", blocks=persisted_blocks)]
                )
            )
        return serialized
