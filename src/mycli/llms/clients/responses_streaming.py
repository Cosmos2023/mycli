from __future__ import annotations

import json
from collections.abc import Iterator

from mycli.domain.logging import LogLevel
from mycli.domain.runtime import StopReason
from mycli.llms.clients.openai_chat import ModelResponseError, _sdk_payload_to_dict
from mycli.llms.clients.responses_logging import ResponsesClientLogger


class ResponsesStreamHelper:
    def __init__(self, *, logger: ResponsesClientLogger) -> None:
        self._logger = logger

    def iter_stream_events(
        self,
        *,
        raw_event: object,
        request_path: str | None,
    ) -> Iterator[dict[str, object]]:
        if isinstance(raw_event, (bytes, bytearray)):
            decoded = bytes(raw_event).decode("utf-8", errors="replace")
        elif isinstance(raw_event, str):
            decoded = raw_event
        else:
            payload = _sdk_payload_to_dict(raw_event)
            if not isinstance(payload, dict):
                self._raise_invalid_shape(request_path=request_path, raw_response=payload)
            yield payload
            return

        for line in decoded.splitlines():
            stripped = line.strip()
            if not stripped or not stripped.startswith("data:"):
                continue
            payload_text = stripped.removeprefix("data:").strip()
            if payload_text == "[DONE]":
                continue
            try:
                payload = json.loads(payload_text)
            except json.JSONDecodeError as exc:
                error_path = self._logger.log_failure(
                    error_type=type(exc).__name__,
                    message=str(exc),
                    request_path=request_path,
                    payload={
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                        "raw_response": payload_text,
                    },
                )
                raise ModelResponseError(
                    "Model provider did not return valid JSON stream events.",
                    error_path=error_path,
                    log_path=self._logger.default_error_log_path(),
                    stop_reason=StopReason.MODEL_ERROR,
                    failure_kind="invalid_json_stream_event",
                ) from exc
            if not isinstance(payload, dict):
                self._raise_invalid_shape(request_path=request_path, raw_response=payload)
            yield payload

    def payload_to_synthetic_stream(
        self,
        payload: dict[str, object],
    ) -> Iterator[dict[str, object]]:
        raw_output = payload.get("output", [])
        if isinstance(raw_output, list):
            for index, item in enumerate(raw_output):
                if not isinstance(item, dict):
                    continue
                yield from self._synthetic_events_from_output_item(index=index, item=item)
        yield {
            "type": "response.completed",
            "response": {
                "id": payload.get("id"),
                "status": payload.get("status", "completed"),
                "usage": payload.get("usage"),
            },
        }

    def build_stream_disconnect_error(
        self,
        *,
        request_path: str | None,
    ) -> ModelResponseError:
        detail = "Responses stream disconnected before completion."
        error_path = self._logger.log_failure(
            error_type="ModelResponseError",
            message=detail,
            request_path=request_path,
            payload={
                "error_type": "ModelResponseError",
                "message": detail,
                "failure_kind": "stream_disconnected",
            },
        )
        self._logger.log_service_event(
            level=LogLevel.ERROR,
            event="model_stream_disconnected",
            message=detail,
            request_path=request_path,
            error_path=error_path,
        )
        return ModelResponseError(
            detail,
            error_path=error_path,
            log_path=self._logger.default_error_log_path(),
            stop_reason=StopReason.TRANSPORT_FAILED,
            is_retryable=True,
            failure_kind="stream_disconnected",
        )

    def _raise_invalid_shape(
        self,
        *,
        request_path: str | None,
        raw_response: object,
    ) -> None:
        error_path = self._logger.log_failure(
            error_type="ModelResponseError",
            message="Model provider stream event must decode to a JSON object.",
            request_path=request_path,
            payload={
                "error_type": "ModelResponseError",
                "message": "Model provider stream event must decode to a JSON object.",
                "raw_response": raw_response,
            },
        )
        raise ModelResponseError(
            "Model provider stream event must decode to a JSON object.",
            error_path=error_path,
            log_path=self._logger.default_error_log_path(),
            stop_reason=StopReason.MODEL_ERROR,
            failure_kind="invalid_stream_event_shape",
        )

    def _synthetic_events_from_output_item(
        self,
        *,
        index: int,
        item: dict[str, object],
    ) -> Iterator[dict[str, object]]:
        item_id = item.get("id")
        provider_item_id = item_id if isinstance(item_id, str) else f"item_{index}"
        item_type = item.get("type")
        if item_type == "reasoning":
            yield from self._synthetic_reasoning_events(
                item=item,
                provider_item_id=provider_item_id,
            )
            yield {
                "type": "response.output_item.done",
                "item_id": provider_item_id,
                "item": item,
            }
            return
        if item_type == "message":
            yield from self._synthetic_message_events(
                item=item,
                provider_item_id=provider_item_id,
            )
            yield {
                "type": "response.output_item.done",
                "item_id": provider_item_id,
                "item": item,
            }
            return
        if item_type == "function_call":
            yield {
                "type": "response.output_item.done",
                "item_id": provider_item_id,
                "item": item,
            }
            return
        if item_type == "mcp_call":
            yield {
                "type": "response.mcp_call.completed",
                "item_id": provider_item_id,
                "name": item.get("name", ""),
                "arguments": item.get("arguments"),
                "output": item.get("output"),
            }

    def _synthetic_reasoning_events(
        self,
        *,
        item: dict[str, object],
        provider_item_id: str,
    ) -> Iterator[dict[str, object]]:
        raw_summary = item.get("summary", [])
        if not isinstance(raw_summary, list):
            return
        for summary_item in raw_summary:
            if not isinstance(summary_item, dict):
                continue
            if summary_item.get("type") != "summary_text":
                continue
            text = summary_item.get("text")
            if isinstance(text, str) and text:
                yield {
                    "type": "response.reasoning_summary_text.delta",
                    "item_id": provider_item_id,
                    "delta": text,
                }

    def _synthetic_message_events(
        self,
        *,
        item: dict[str, object],
        provider_item_id: str,
    ) -> Iterator[dict[str, object]]:
        raw_content = item.get("content", [])
        if not isinstance(raw_content, list):
            return
        for content_item in raw_content:
            if not isinstance(content_item, dict):
                continue
            if content_item.get("type") != "output_text":
                continue
            text = content_item.get("text")
            if isinstance(text, str) and text:
                yield {
                    "type": "response.output_text.delta",
                    "item_id": provider_item_id,
                    "delta": text,
                }
