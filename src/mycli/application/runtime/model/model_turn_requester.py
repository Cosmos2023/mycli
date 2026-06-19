from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from queue import Empty, Queue
from threading import Thread
from time import monotonic

from mycli.domain.runtime import (
    ModelTurnResult,
    RuntimeBlock,
    RuntimeInterruptToken,
    RuntimeItem,
    RuntimeStreamEvent,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelAdapter, ModelMessage, ModelToolDefinition
from mycli.llms.clients.openai_chat import ModelResponseError


@dataclass(slots=True, frozen=True)
class ModelStreamDiagnostics:
    success: bool
    elapsed_ms: int
    ttfb_ms: int | None
    provider_event_count: int
    text_event_count: int
    tool_call_event_count: int
    completed_event_count: int
    text_bytes: int
    failure_kind: str | None = None
    failure_message: str | None = None


class ModelTurnRequester:
    """Normalizes model-adapter request styles into `ModelTurnResult`."""

    def __init__(
        self,
        *,
        model_adapter: ModelAdapter,
        normalize_tool_call: Callable[[ToolCall], ToolCall],
        stream_diagnostics_sink: Callable[[ModelStreamDiagnostics], None] | None = None,
    ) -> None:
        self._model_adapter = model_adapter
        self._normalize_tool_call = normalize_tool_call
        self._stream_diagnostics_sink = stream_diagnostics_sink

    def request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        _raise_if_interrupted(interrupt_token)
        stream_turn = (
            getattr(self._model_adapter, "stream_turn_with_interrupt", None)
            if interrupt_token is not None
            else None
        )
        stream_turn_uses_interrupt = callable(stream_turn)
        if not stream_turn_uses_interrupt:
            stream_turn = getattr(self._model_adapter, "stream_turn", None)
        if callable(stream_turn):
            return self._request_streaming_turn(
                stream_turn=stream_turn,
                stream_turn_uses_interrupt=stream_turn_uses_interrupt,
                runtime_items=runtime_items,
                tools=tools,
                stream_sink=stream_sink,
                interrupt_token=interrupt_token,
            )

        next_turn = getattr(self._model_adapter, "next_turn", None)
        if callable(next_turn):
            _raise_if_interrupted(interrupt_token)
            turn_result = next_turn(items=runtime_items, tools=tools)
            _raise_if_interrupted(interrupt_token)
            if isinstance(turn_result, ModelTurnResult):
                return turn_result, ()
            raise ModelResponseError("Model adapter next_turn must return ModelTurnResult.")

        action = self._model_adapter.next_action(
            messages=legacy_messages,
            tools=tools,
        )
        _raise_if_interrupted(interrupt_token)
        return self._legacy_action_to_turn_result(action), ()

    def _request_streaming_turn(
        self,
        *,
        stream_turn: object,
        stream_turn_uses_interrupt: bool = False,
        runtime_items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        interrupt_token: RuntimeInterruptToken | None,
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
        if not callable(stream_turn):
            raise ModelResponseError("Model adapter stream_turn must be callable.")
        blocks: list[RuntimeBlock] = []
        streamed_chunks: list[str] = []
        response_id: str | None = None
        metadata: dict[str, object] = {}
        has_tool_call = False
        start_time = monotonic()
        first_event_time: float | None = None
        provider_event_count = 0
        text_event_count = 0
        tool_call_event_count = 0
        completed_event_count = 0
        text_bytes = 0

        try:
            stream = (
                stream_turn(
                    items=runtime_items,
                    tools=tools,
                    interrupt_token=interrupt_token,
                )
                if stream_turn_uses_interrupt
                else stream_turn(items=runtime_items, tools=tools)
            )
            for event in _interruptible_events(
                stream,
                interrupt_token=interrupt_token,
                threaded=stream_turn_uses_interrupt,
            ):
                _raise_if_interrupted(interrupt_token)
                now = monotonic()
                if first_event_time is None:
                    first_event_time = now
                provider_event_count += 1
                if not isinstance(event, dict):
                    raise ModelResponseError("Model adapter stream_turn must yield dict events.")
                event_type = event.get("type")
                if event_type == "reasoning":
                    text = event.get("text")
                    if isinstance(text, str) and text:
                        blocks.append(RuntimeBlock(type="reasoning", text=text))
                        self._notify_stream_sink(
                            stream_sink,
                            RuntimeStreamEvent(kind="reasoning", text=text),
                        )
                    continue
                if event_type == "text_delta":
                    text = event.get("text")
                    if isinstance(text, str) and text:
                        text_event_count += 1
                        text_bytes += len(text.encode("utf-8"))
                        blocks.append(RuntimeBlock(type="text", text=text))
                        streamed_chunks.append(text)
                        self._notify_stream_sink(
                            stream_sink,
                            RuntimeStreamEvent(kind="text_delta", text=text),
                        )
                    continue
                if event_type == "tool_call":
                    block = event.get("block")
                    if not isinstance(block, RuntimeBlock) or block.type != "tool_call":
                        raise ModelResponseError(
                            "Model adapter tool_call stream event must include tool_call RuntimeBlock."
                        )
                    blocks.append(block)
                    has_tool_call = True
                    tool_call_event_count += 1
                    event_metadata = dict(block.metadata)
                    if block.tool_arguments is not None:
                        event_metadata["arguments"] = dict(block.tool_arguments)
                    self._notify_stream_sink(
                        stream_sink,
                        RuntimeStreamEvent(
                            kind="tool_call",
                            tool_name=block.tool_name or "",
                            metadata=event_metadata,
                        ),
                    )
                    continue
                if event_type == "completed":
                    completed_event_count += 1
                    raw_response_id = event.get("response_id")
                    if isinstance(raw_response_id, str) and raw_response_id:
                        response_id = raw_response_id
                    raw_metadata = event.get("metadata")
                    if isinstance(raw_metadata, dict):
                        metadata = raw_metadata
                    self._notify_stream_sink(
                        stream_sink,
                        RuntimeStreamEvent(kind="completed", metadata=metadata),
                    )
                    continue
                raise ModelResponseError(f"Unsupported model stream event type: {event_type!r}.")
        except ModelResponseError as exc:
            self._notify_stream_diagnostics(
                self._stream_diagnostics(
                    success=False,
                    start_time=start_time,
                    first_event_time=first_event_time,
                    provider_event_count=provider_event_count,
                    text_event_count=text_event_count,
                    tool_call_event_count=tool_call_event_count,
                    completed_event_count=completed_event_count,
                    text_bytes=text_bytes,
                    failure_kind=self._stream_failure_kind(exc),
                    failure_message=str(exc),
                )
            )
            raise
        except Exception as exc:
            self._notify_stream_diagnostics(
                self._stream_diagnostics(
                    success=False,
                    start_time=start_time,
                    first_event_time=first_event_time,
                    provider_event_count=provider_event_count,
                    text_event_count=text_event_count,
                    tool_call_event_count=tool_call_event_count,
                    completed_event_count=completed_event_count,
                    text_bytes=text_bytes,
                    failure_kind=type(exc).__name__,
                    failure_message=str(exc),
                )
            )
            raise

        items: tuple[RuntimeItem, ...] = ()
        if blocks:
            items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),)
        self._notify_stream_diagnostics(
            self._stream_diagnostics(
                success=True,
                start_time=start_time,
                first_event_time=first_event_time,
                provider_event_count=provider_event_count,
                text_event_count=text_event_count,
                tool_call_event_count=tool_call_event_count,
                completed_event_count=completed_event_count,
                text_bytes=text_bytes,
            )
        )
        return (
            ModelTurnResult(
                items=items,
                done=not has_tool_call,
                response_id=response_id,
                metadata=metadata,
            ),
            tuple(streamed_chunks),
        )

    @staticmethod
    def _notify_stream_sink(
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        event: RuntimeStreamEvent,
    ) -> None:
        if stream_sink is None:
            return
        try:
            stream_sink(event)
        except Exception:
            return

    def _notify_stream_diagnostics(self, diagnostics: ModelStreamDiagnostics) -> None:
        if self._stream_diagnostics_sink is None:
            return
        try:
            self._stream_diagnostics_sink(diagnostics)
        except Exception:
            return

    @staticmethod
    def _stream_diagnostics(
        *,
        success: bool,
        start_time: float,
        first_event_time: float | None,
        provider_event_count: int,
        text_event_count: int,
        tool_call_event_count: int,
        completed_event_count: int,
        text_bytes: int,
        failure_kind: str | None = None,
        failure_message: str | None = None,
    ) -> ModelStreamDiagnostics:
        now = monotonic()
        return ModelStreamDiagnostics(
            success=success,
            elapsed_ms=max(0, int((now - start_time) * 1000)),
            ttfb_ms=(
                None
                if first_event_time is None
                else max(0, int((first_event_time - start_time) * 1000))
            ),
            provider_event_count=provider_event_count,
            text_event_count=text_event_count,
            tool_call_event_count=tool_call_event_count,
            completed_event_count=completed_event_count,
            text_bytes=text_bytes,
            failure_kind=failure_kind,
            failure_message=(
                None
                if failure_message is None
                else ModelTurnRequester._bounded_failure_message(failure_message)
            ),
        )

    @staticmethod
    def _bounded_failure_message(message: str, limit: int = 240) -> str:
        if len(message) <= limit:
            return message
        return message[:limit] + "..."

    @staticmethod
    def _stream_failure_kind(exc: ModelResponseError) -> str:
        message = str(exc)
        if "must yield dict events" in message:
            return "invalid_stream_event_shape"
        if "Unsupported model stream event type" in message:
            return "unsupported_stream_event_type"
        if "tool_call stream event" in message:
            return "invalid_tool_call_stream_event"
        return "model_stream_error"

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


def _raise_if_interrupted(interrupt_token: RuntimeInterruptToken | None) -> None:
    if interrupt_token is not None:
        interrupt_token.raise_if_interrupted()


_QUEUE_DONE = object()


def _interruptible_events(
    stream: object,
    *,
    interrupt_token: RuntimeInterruptToken | None,
    threaded: bool,
) -> object:
    if interrupt_token is None or not threaded:
        yield from stream  # type: ignore[misc]
        return

    queue: Queue[object] = Queue()

    def pump() -> None:
        try:
            for event in stream:  # type: ignore[misc]
                queue.put(event)
        except BaseException as exc:  # noqa: BLE001 - re-raised by consumer thread.
            queue.put(exc)
        finally:
            queue.put(_QUEUE_DONE)

    worker = Thread(target=pump, name="mycli-model-stream", daemon=True)
    worker.start()
    while True:
        _raise_if_interrupted(interrupt_token)
        try:
            item = queue.get(timeout=0.02)
        except Empty:
            continue
        if item is _QUEUE_DONE:
            return
        if isinstance(item, BaseException):
            raise item
        yield item
