from __future__ import annotations

import json

from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.schemas.responses_wire_protocol import parse_responses_output_item


class ResponsesEventMapper:
    def events_from_output_item(self, raw_item: dict[str, object]) -> list[ModelEvent]:
        item = parse_responses_output_item(raw_item)
        if item.item_type == "function_call":
            return [self._function_call_event_from_output_item(item.payload, item.provider_id)]
        if item.item_type == "message":
            return self._message_events_from_output_item(item.payload, item.provider_id)
        if item.item_type == "reasoning":
            return self._reasoning_events_from_output_item(item.payload, item.provider_id)
        return []

    def _function_call_event_from_output_item(
        self,
        payload: dict[str, object],
        provider_id: str | None,
    ) -> ModelEvent:
        raw_arguments = payload.get("arguments", "{}")
        arguments: dict[str, object] = {}
        if isinstance(raw_arguments, str) and raw_arguments:
            try:
                parsed_arguments = json.loads(raw_arguments)
            except json.JSONDecodeError as exc:
                raise ModelResponseError("Function call arguments were not valid JSON.") from exc
            if isinstance(parsed_arguments, dict):
                arguments = parsed_arguments
        call_id = payload.get("call_id")
        return ModelEvent.tool_call_requested(
            tool_name=str(payload.get("name", "")),
            tool_arguments=arguments,
            call_id=str(call_id or provider_id or ""),
            source=ToolExecutionSource.NATIVE,
            provider_id=provider_id,
        )

    def _message_events_from_output_item(
        self,
        payload: dict[str, object],
        provider_id: str | None,
    ) -> list[ModelEvent]:
        events: list[ModelEvent] = []
        raw_content = payload.get("content", [])
        if isinstance(raw_content, list):
            for content_item in raw_content:
                if not isinstance(content_item, dict):
                    continue
                if content_item.get("type") != "output_text":
                    continue
                text = content_item.get("text")
                if isinstance(text, str) and text:
                    events.append(ModelEvent.message_delta(text=text, provider_id=provider_id))
        return events

    def _reasoning_events_from_output_item(
        self,
        payload: dict[str, object],
        provider_id: str | None,
    ) -> list[ModelEvent]:
        events: list[ModelEvent] = []
        raw_summary = payload.get("summary", [])
        if isinstance(raw_summary, list):
            for summary_item in raw_summary:
                if not isinstance(summary_item, dict):
                    continue
                if summary_item.get("type") != "summary_text":
                    continue
                text = summary_item.get("text")
                if isinstance(text, str) and text:
                    events.append(
                        ModelEvent(
                            type=ModelEventType.REASONING_DELTA,
                            text=text,
                            provider_id=provider_id,
                        )
                    )
        return events
