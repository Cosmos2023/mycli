from __future__ import annotations

from dataclasses import dataclass, field

from mycli.domain.runtime.blocks import RuntimeBlock
from mycli.llms.adapters.responses_output_parser import ResponsesOutputParser
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.schemas.responses_protocol import (
    ResponsesCompletedEvent,
    ResponsesFailedEvent,
    ResponsesFunctionCallArgumentsDeltaEvent,
    ResponsesFunctionCallArgumentsDoneEvent,
    ResponsesInProgressEvent,
    ResponsesMcpCallCompletedEvent,
    ResponsesOutputItemAddedEvent,
    ResponsesOutputItemDoneEvent,
    ResponsesOutputTextDeltaEvent,
    ResponsesReasoningSummaryTextDeltaEvent,
    ResponsesUnknownEvent,
    parse_responses_stream_event,
)


@dataclass(slots=True)
class StreamFunctionCallState:
    item_id: str
    name: str | None = None
    call_id: str | None = None
    arguments_fragments: list[str] = field(default_factory=list)
    emitted: bool = False


class ResponsesStreamEventAdapter:
    def __init__(self, output_parser: ResponsesOutputParser) -> None:
        self._output_parser = output_parser

    def coerce_event(self, event: object) -> object:
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

    def output_item_added_payload(
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

    def function_call_arguments_delta_payload(
        self,
        event: ResponsesFunctionCallArgumentsDeltaEvent,
    ) -> dict[str, object]:
        return {
            "type": "response.function_call_arguments.delta",
            "item_id": event.item_id,
            "delta": event.delta,
        }

    def function_call_arguments_done_payload(
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

    def output_item_done_payload(
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

    def mcp_call_completed_payload(
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

    def record_output_item_added(
        self,
        *,
        event: dict[str, object],
        function_call_states: dict[str, StreamFunctionCallState],
    ) -> None:
        item = event.get("item")
        if not isinstance(item, dict):
            return
        item_type = item.get("type")
        if item_type != "function_call":
            return
        item_id = self.stream_item_id(event=event, item=item)
        if item_id is None:
            return
        state = function_call_states.setdefault(
            item_id,
            StreamFunctionCallState(item_id=item_id),
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

    def record_function_call_delta(
        self,
        *,
        event: dict[str, object],
        function_call_states: dict[str, StreamFunctionCallState],
    ) -> None:
        item_id = self.stream_item_id(event=event)
        if item_id is None:
            return
        state = function_call_states.setdefault(
            item_id,
            StreamFunctionCallState(item_id=item_id),
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

    def build_tool_call_event(
        self,
        *,
        event: dict[str, object],
        function_call_states: dict[str, StreamFunctionCallState],
    ) -> dict[str, object] | None:
        item_id = self.stream_item_id(event=event)
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
        arguments = self._output_parser.parse_function_call_arguments(
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

    def build_tool_call_event_from_output_item_done(
        self,
        *,
        event: dict[str, object],
        function_call_states: dict[str, StreamFunctionCallState],
    ) -> dict[str, object] | None:
        item = event.get("item")
        if not isinstance(item, dict) or item.get("type") != "function_call":
            return None
        merged_event = dict(item)
        merged_event["type"] = "response.function_call_arguments.done"
        item_id = self.stream_item_id(event=event, item=item)
        if item_id is not None:
            merged_event["item_id"] = item_id
        return self.build_tool_call_event(
            event=merged_event,
            function_call_states=function_call_states,
        )

    def build_mcp_call_event(
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
            "text": self._output_parser.render_mcp_call_summary(name=raw_name, output=output),
        }

    def stream_item_id(
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
