from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from urllib.parse import urlparse

from openai import APIConnectionError, APIResponseValidationError, APIStatusError, APITimeoutError

from mycli.domain.logging import LogLevel, ModelLogContext, ModelLogEvent
from mycli.domain.runtime import StopReason
from mycli.infrastructure.responses_request_builder import ResponsesRequestBuilder
from mycli.infrastructure.openai_client import (
    ModelResponseError,
    _api_status_error_detail,
    _build_openai_sdk_client,
    _sdk_payload_to_dict,
)
from mycli.infrastructure.ssl import ensure_certifi_ca_bundle
from mycli.schemas.responses_protocol import (
    ResponsesCapabilityProfile,
    ResponsesContinuationState,
)
from mycli.services.workspace_log_service import WorkspaceLogService


@dataclass(slots=True, frozen=True)
class _FailureClassification:
    stop_reason: StopReason
    is_retryable: bool
    failure_kind: str


class OpenAIResponsesClient:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        max_output_tokens: int,
        capability_profile: ResponsesCapabilityProfile | None = None,
        log_service: WorkspaceLogService | None = None,
        log_context_provider: Callable[[], ModelLogContext] | None = None,
    ) -> None:
        ensure_certifi_ca_bundle()
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._sdk_client = _build_openai_sdk_client(api_key=api_key, base_url=base_url)
        self._thinking_enabled = True
        self._reasoning_effort: str | None = None
        self._capability_profile = capability_profile or ResponsesCapabilityProfile.for_base_url(
            base_url
        )
        self._request_builder = ResponsesRequestBuilder(
            capability_profile=self._capability_profile
        )
        self._continuation_state: ResponsesContinuationState | None = None
        self._pending_request_signature: str | None = None
        self._pending_request_input: tuple[dict[str, object], ...] = ()
        self._stream_transport_disabled = False
        self._runtime_event_recorder: Callable[[str, dict[str, object]], None] | None = None
        self._log_service = log_service
        self._log_context_provider = log_context_provider

    def set_log_context_provider(
        self,
        provider: Callable[[], ModelLogContext],
    ) -> None:
        self._log_context_provider = provider

    def set_runtime_event_recorder(
        self,
        recorder: Callable[[str, dict[str, object]], None] | None,
    ) -> None:
        self._runtime_event_recorder = recorder

    def set_reasoning_effort(self, reasoning_effort: str | None) -> None:
        self._reasoning_effort = reasoning_effort

    def set_thinking_config(
        self,
        *,
        enabled: bool,
        effort: object,
    ) -> None:
        self._thinking_enabled = enabled
        if not enabled:
            self._reasoning_effort = None
            return
        value = getattr(effort, "value", effort)
        self._reasoning_effort = str(value) if value is not None else None

    def set_continuation_state(
        self,
        state: ResponsesContinuationState | None,
    ) -> None:
        self._continuation_state = state

    def get_continuation_state(self) -> ResponsesContinuationState | None:
        return self._continuation_state

    def record_response_completion(
        self,
        *,
        response_id: str | None,
        response_output_items: list[dict[str, object]],
    ) -> None:
        if self._pending_request_signature is None:
            return
        self._continuation_state = ResponsesContinuationState(
            response_id=response_id,
            request_signature=self._pending_request_signature,
            request_input=tuple(dict(item) for item in self._pending_request_input),
            response_output=tuple(dict(item) for item in response_output_items),
            eligible=bool(response_id),
            failure_reason=None,
        )
        self._pending_request_signature = None
        self._pending_request_input = ()

    def record_response_failure(self, reason: str | None = None) -> None:
        if self._pending_request_signature is None:
            if self._continuation_state is not None:
                self._continuation_state = ResponsesContinuationState(
                    response_id=self._continuation_state.response_id,
                    request_signature=self._continuation_state.request_signature,
                    request_input=self._continuation_state.request_input,
                    response_output=self._continuation_state.response_output,
                    eligible=False,
                    failure_reason=reason,
                )
            return
        if (
            self._continuation_state is not None
            and self._continuation_state.response_id
            and self._pending_request_has_function_call_output()
        ):
            self._continuation_state = ResponsesContinuationState(
                response_id=self._continuation_state.response_id,
                request_signature=self._continuation_state.request_signature,
                request_input=self._continuation_state.request_input,
                response_output=self._continuation_state.response_output,
                eligible=True,
                failure_reason=reason,
            )
            self._pending_request_signature = None
            self._pending_request_input = ()
            return
        self._continuation_state = ResponsesContinuationState(
            response_id=None,
            request_signature=self._pending_request_signature,
            request_input=tuple(dict(item) for item in self._pending_request_input),
            response_output=(),
            eligible=False,
            failure_reason=reason,
        )
        self._pending_request_signature = None
        self._pending_request_input = ()

    def _pending_request_has_function_call_output(self) -> bool:
        return any(
            isinstance(item, dict) and item.get("type") == "function_call_output"
            for item in self._pending_request_input
        )

    def _normalize_tool_definitions(
        self,
        tools: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        normalized_tools: list[dict[str, object]] = []
        for tool in tools:
            raw_parameters = tool.get("parameters", [])
            parameters = raw_parameters if isinstance(raw_parameters, list) else []
            properties: dict[str, object] = {}
            required: list[str] = []
            for parameter in parameters:
                if not isinstance(parameter, dict):
                    continue
                name = str(parameter["name"])
                property_schema: dict[str, object] = {
                    "type": str(parameter["type"]),
                }
                description = parameter.get("description")
                if description is not None:
                    property_schema["description"] = str(description)
                items_schema = parameter.get("items_schema")
                if isinstance(items_schema, dict):
                    property_schema["items"] = dict(items_schema)
                properties[name] = property_schema
                if bool(parameter.get("required", True)):
                    required.append(name)

            normalized_tools.append(
                {
                    "type": "function",
                    "name": str(tool["name"]),
                    "description": str(tool["description"]),
                    "parameters": {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                        "additionalProperties": False,
                    },
                }
            )
        return normalized_tools

    def create_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        normalized_tools = self._normalize_tool_definitions(tools or [])
        allow_continuation_retry = True

        while True:
            continuation_state = self._continuation_state if allow_continuation_retry else None
            build_result = self._request_builder.build(
                model=self._model,
                input_items=input_items,
                tools=normalized_tools,
                max_output_tokens=self._max_output_tokens,
                reasoning_effort=self._reasoning_effort,
                thinking_enabled=self._thinking_enabled,
                stream=False,
                continuation_state=continuation_state,
            )
            payload_body = build_result.payload_body
            self._pending_request_signature = build_result.request_signature
            self._pending_request_input = build_result.normalized_input
            request_path = self._log_request(
                url=f"{self._base_url}/responses",
                payload_body=payload_body,
                continuation_decision=build_result.continuation_decision,
                previous_response_id=build_result.used_previous_response_id,
            )

            self._emit_runtime_event(
                "responses_request",
                {
                    "transport": "create",
                    "continuation_decision": build_result.continuation_decision,
                    "used_previous_response_id": build_result.used_previous_response_id,
                },
            )

            try:
                payload = _sdk_payload_to_dict(
                    self._sdk_client.responses.create(**payload_body)
                )
            except APIStatusError as exc:
                continuation_retry_reason = self._continuation_retry_reason(
                    exc=exc,
                    used_previous_response_id=build_result.used_previous_response_id,
                )
                if continuation_retry_reason is not None:
                    detail = self._api_status_error_detail(exc)
                    self._invalidate_continuation_state(
                        reason=f"{continuation_retry_reason}: {detail}"
                    )
                    self._emit_runtime_event(
                        "responses_continuation_retry",
                        {
                            "reason": continuation_retry_reason,
                            "previous_response_id": build_result.used_previous_response_id,
                        },
                    )
                    allow_continuation_retry = False
                    continue
                error = self._build_http_error(exc=exc, request_path=request_path)
                self.record_response_failure(str(error))
                raise error from exc
            except (APIConnectionError, APITimeoutError) as exc:
                error = self._build_transport_error(exc=exc, request_path=request_path)
                self.record_response_failure(str(error))
                raise error from exc
            except (APIResponseValidationError, TypeError) as exc:
                raw_response = exc.body if isinstance(exc, APIResponseValidationError) else None
                error_path = self._log_failure(
                    error_type=type(exc).__name__,
                    message=str(exc),
                    request_path=request_path,
                    payload={
                        "error_type": type(exc).__name__,
                        "message": str(exc),
                        "raw_response": raw_response,
                    },
                )
                raise ModelResponseError(
                    "Model provider did not return valid JSON.",
                    error_path=error_path,
                    log_path=self._default_error_log_path(),
                    stop_reason=StopReason.MODEL_ERROR,
                    failure_kind="invalid_json_response",
                ) from exc
            break

        if not isinstance(payload, dict):
            error_path = self._log_failure(
                error_type="ModelResponseError",
                message="Model provider response must decode to a JSON object.",
                request_path=request_path,
                payload={
                    "error_type": "ModelResponseError",
                    "message": "Model provider response must decode to a JSON object.",
                    "raw_response": payload,
                },
            )
            raise ModelResponseError(
                "Model provider response must decode to a JSON object.",
                error_path=error_path,
                log_path=self._default_error_log_path(),
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="invalid_response_shape",
            )
        response_path = self._log_response(payload)
        self._log_service_event(
            level=LogLevel.INFO,
            event="model_response_received",
            message="Received model response",
            request_path=request_path,
            response_path=response_path,
        )
        return payload

    def stream_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> Iterator[dict[str, object]]:
        if self._stream_transport_disabled:
            yield from self._fallback_create_response_as_stream(
                input_items=input_items,
                tools=tools,
                reason="stream transport already disabled",
            )
            return

        normalized_tools = self._normalize_tool_definitions(tools or [])
        max_retries = max(0, self._capability_profile.stream_max_retries)
        attempt = 0
        allow_continuation_retry = True

        while True:
            continuation_state = self._continuation_state if allow_continuation_retry else None
            build_result = self._request_builder.build(
                model=self._model,
                input_items=input_items,
                tools=normalized_tools,
                max_output_tokens=self._max_output_tokens,
                reasoning_effort=self._reasoning_effort,
                thinking_enabled=self._thinking_enabled,
                stream=True,
                continuation_state=continuation_state,
            )
            payload_body = build_result.payload_body
            self._pending_request_signature = build_result.request_signature
            self._pending_request_input = build_result.normalized_input
            request_path = self._log_request(
                url=f"{self._base_url}/responses",
                payload_body=payload_body,
                continuation_decision=build_result.continuation_decision,
                previous_response_id=build_result.used_previous_response_id,
            )
            self._log_service_event(
                level=LogLevel.INFO,
                event="model_stream_started",
                message=f"Started model stream (attempt {attempt + 1})",
                request_path=request_path,
            )
            self._emit_runtime_event(
                "responses_request",
                {
                    "transport": "stream",
                    "attempt": attempt + 1,
                    "continuation_decision": build_result.continuation_decision,
                    "used_previous_response_id": build_result.used_previous_response_id,
                },
            )

            try:
                terminated = False
                stream_response = self._sdk_client.responses.create(**payload_body)
                try:
                    for raw_event in stream_response:
                        for event in self._iter_stream_events(
                            raw_event=raw_event,
                            request_path=request_path,
                        ):
                            event_type = event.get("type")
                            if event_type == "response.completed":
                                terminated = True
                                response_path = self._log_stream_completion(event)
                                self._log_service_event(
                                    level=LogLevel.INFO,
                                    event="model_stream_completed",
                                    message="Completed model stream",
                                    request_path=request_path,
                                    response_path=response_path,
                                )
                                yield event
                                return
                            if event_type == "response.failed":
                                raise self._build_response_failed_error(
                                    event=event,
                                    request_path=request_path,
                                )
                            yield event
                    if not terminated:
                        raise self._build_stream_disconnect_error(request_path=request_path)
                finally:
                    close = getattr(stream_response, "close", None)
                    if callable(close):
                        close()
            except APIStatusError as exc:
                continuation_retry_reason = self._continuation_retry_reason(
                    exc=exc,
                    used_previous_response_id=build_result.used_previous_response_id,
                )
                if continuation_retry_reason is not None:
                    detail = self._api_status_error_detail(exc)
                    self._invalidate_continuation_state(
                        reason=f"{continuation_retry_reason}: {detail}"
                    )
                    self._emit_runtime_event(
                        "responses_continuation_retry",
                        {
                            "reason": continuation_retry_reason,
                            "previous_response_id": build_result.used_previous_response_id,
                        },
                    )
                    allow_continuation_retry = False
                    continue
                error = self._build_http_error(exc=exc, request_path=request_path)
            except (APIConnectionError, APITimeoutError) as exc:
                error = self._build_transport_error(exc=exc, request_path=request_path)
            except ModelResponseError as exc:
                error = exc

            if error.is_retryable and attempt < max_retries:
                attempt += 1
                self._log_service_event(
                    level=LogLevel.WARNING,
                    event="model_stream_retrying",
                    message=f"Retrying model stream after {error.failure_kind or 'transport failure'} (attempt {attempt + 1})",
                    request_path=request_path,
                    error_path=error.error_path,
                )
                self._emit_runtime_event(
                    "model_stream_retrying",
                    {
                        "attempt": attempt + 1,
                        "failure_kind": error.failure_kind,
                        "stop_reason": None if error.stop_reason is None else error.stop_reason.value,
                    },
                )
                continue

            if error.is_retryable and self._capability_profile.supports_stream_fallback_to_create:
                self._stream_transport_disabled = True
                self._log_service_event(
                    level=LogLevel.WARNING,
                    event="model_stream_fallback_activated",
                    message=f"Falling back to create_response after {error.failure_kind or 'transport failure'}",
                    request_path=request_path,
                    error_path=error.error_path,
                )
                self._emit_runtime_event(
                    "model_stream_fallback_activated",
                    {
                        "failure_kind": error.failure_kind,
                        "stop_reason": None if error.stop_reason is None else error.stop_reason.value,
                    },
                )
                yield from self._fallback_create_response_as_stream(
                    input_items=input_items,
                    tools=tools,
                    reason=error.failure_kind or "transport failure",
                )
                return

            if error.is_retryable:
                exhausted_error = self._build_retry_exhausted_error(
                    cause=error,
                    request_path=request_path,
                    attempts=attempt + 1,
                )
                self.record_response_failure(str(exhausted_error))
                raise exhausted_error from error

            self.record_response_failure(str(error))
            raise error

    def _iter_stream_events(
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
                error_path = self._log_failure(
                    error_type="ModelResponseError",
                    message="Model provider stream event must decode to a JSON object.",
                    request_path=request_path,
                    payload={
                        "error_type": "ModelResponseError",
                        "message": "Model provider stream event must decode to a JSON object.",
                        "raw_response": payload,
                    },
                )
                raise ModelResponseError(
                    "Model provider stream event must decode to a JSON object.",
                    error_path=error_path,
                    log_path=self._default_error_log_path(),
                    stop_reason=StopReason.MODEL_ERROR,
                    failure_kind="invalid_stream_event_shape",
                )
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
                error_path = self._log_failure(
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
                    log_path=self._default_error_log_path(),
                    stop_reason=StopReason.MODEL_ERROR,
                    failure_kind="invalid_json_stream_event",
                ) from exc
            if not isinstance(payload, dict):
                error_path = self._log_failure(
                    error_type="ModelResponseError",
                    message="Model provider stream event must decode to a JSON object.",
                    request_path=request_path,
                    payload={
                        "error_type": "ModelResponseError",
                        "message": "Model provider stream event must decode to a JSON object.",
                        "raw_response": payload,
                    },
                )
                raise ModelResponseError(
                    "Model provider stream event must decode to a JSON object.",
                    error_path=error_path,
                    log_path=self._default_error_log_path(),
                    stop_reason=StopReason.MODEL_ERROR,
                    failure_kind="invalid_stream_event_shape",
                )
            yield payload

    def _fallback_create_response_as_stream(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None,
        reason: str,
    ) -> Iterator[dict[str, object]]:
        self._log_service_event(
            level=LogLevel.WARNING,
            event="model_stream_fallback_running",
            message=f"Using create_response fallback because {reason}",
        )
        self._emit_runtime_event(
            "model_stream_fallback_running",
            {"reason": reason},
        )
        payload = self.create_response(
            input_items=input_items,
            tools=tools,
        )
        yield from self._payload_to_synthetic_stream(payload)

    def _payload_to_synthetic_stream(
        self,
        payload: dict[str, object],
    ) -> Iterator[dict[str, object]]:
        raw_output = payload.get("output", [])
        if isinstance(raw_output, list):
            for index, item in enumerate(raw_output):
                if not isinstance(item, dict):
                    continue
                item_id = item.get("id")
                provider_item_id = item_id if isinstance(item_id, str) else f"item_{index}"
                item_type = item.get("type")
                if item_type == "reasoning":
                    raw_summary = item.get("summary", [])
                    if isinstance(raw_summary, list):
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
                    continue
                if item_type == "message":
                    raw_content = item.get("content", [])
                    if isinstance(raw_content, list):
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
                    continue
                if item_type == "function_call":
                    yield {
                        "type": "response.output_item.done",
                        "item_id": provider_item_id,
                        "item": item,
                    }
                    continue
                if item_type == "mcp_call":
                    yield {
                        "type": "response.mcp_call.completed",
                        "item_id": provider_item_id,
                        "name": item.get("name", ""),
                        "arguments": item.get("arguments"),
                        "output": item.get("output"),
                    }
        yield {
            "type": "response.completed",
            "response": {
                "id": payload.get("id"),
                "status": payload.get("status", "completed"),
                "usage": payload.get("usage"),
            },
        }

    def _log_stream_completion(self, event: dict[str, object]) -> str | None:
        response_payload = event.get("response")
        if not isinstance(response_payload, dict):
            return None
        return self._log_response(response_payload)

    def _build_stream_disconnect_error(
        self,
        *,
        request_path: str | None,
    ) -> ModelResponseError:
        detail = "Responses stream disconnected before completion."
        error_path = self._log_failure(
            error_type="ModelResponseError",
            message=detail,
            request_path=request_path,
            payload={
                "error_type": "ModelResponseError",
                "message": detail,
                "failure_kind": "stream_disconnected",
            },
        )
        self._log_service_event(
            level=LogLevel.ERROR,
            event="model_stream_disconnected",
            message=detail,
            request_path=request_path,
            error_path=error_path,
        )
        return ModelResponseError(
            detail,
            error_path=error_path,
            log_path=self._default_error_log_path(),
            stop_reason=StopReason.TRANSPORT_FAILED,
            is_retryable=True,
            failure_kind="stream_disconnected",
        )

    def _emit_runtime_event(self, kind: str, payload: dict[str, object]) -> None:
        if self._runtime_event_recorder is None:
            return
        self._runtime_event_recorder(kind, dict(payload))

    def _invalidate_continuation_state(self, *, reason: str) -> None:
        if self._continuation_state is None:
            return
        self._continuation_state = ResponsesContinuationState(
            response_id=self._continuation_state.response_id,
            request_signature=self._continuation_state.request_signature,
            request_input=self._continuation_state.request_input,
            response_output=self._continuation_state.response_output,
            eligible=False,
            failure_reason=reason,
        )

    def _api_status_error_detail(self, exc: APIStatusError) -> str:
        cached = getattr(exc, "_mycli_cached_detail", None)
        if isinstance(cached, str):
            return cached
        detail = _api_status_error_detail(exc)
        setattr(exc, "_mycli_cached_detail", detail)
        return detail

    def _continuation_retry_reason(
        self,
        *,
        exc: APIStatusError,
        used_previous_response_id: str | None,
    ) -> str | None:
        if not used_previous_response_id:
            return None
        if exc.status_code in {500, 502, 503, 504}:
            return "provider_failed_previous_response_id_continuation"
        if exc.status_code not in {400, 404, 409}:
            return None
        detail = self._api_status_error_detail(exc).lower()
        if "previous_response_id" in detail:
            return "provider_rejected_previous_response_id"
        if "response_id" in detail and any(marker in detail for marker in ("not found", "invalid", "expired")):
            return "provider_rejected_previous_response_id"
        if "response id" in detail and any(marker in detail for marker in ("not found", "invalid", "expired")):
            return "provider_rejected_previous_response_id"
        return None

    def _build_response_failed_error(
        self,
        *,
        event: dict[str, object],
        request_path: str | None,
    ) -> ModelResponseError:
        response = event.get("response", {})
        error_payload = response.get("error", {}) if isinstance(response, dict) else {}
        detail = "Model provider returned response.failed."
        error_code: str | None = None
        if isinstance(error_payload, dict):
            raw_message = error_payload.get("message")
            if isinstance(raw_message, str) and raw_message.strip():
                detail = raw_message
            raw_code = error_payload.get("code")
            if isinstance(raw_code, str) and raw_code.strip():
                error_code = raw_code
        classification = self._classify_provider_failure(
            detail=detail,
            status_code=None,
            provider_error_code=error_code,
        )
        error_path = self._log_failure(
            error_type="ModelResponseError",
            message=detail,
            request_path=request_path,
            payload={
                "error_type": "ModelResponseError",
                "message": detail,
                "failure_kind": classification.failure_kind,
                "response": response if isinstance(response, dict) else {},
            },
        )
        self._log_service_event(
            level=LogLevel.ERROR,
            event="model_stream_failed",
            message=detail,
            request_path=request_path,
            error_path=error_path,
        )
        return ModelResponseError(
            detail,
            error_path=error_path,
            log_path=self._default_error_log_path(),
            stop_reason=classification.stop_reason,
            is_retryable=classification.is_retryable,
            failure_kind=classification.failure_kind,
        )

    def _is_unsupported_responses_provider_error(self, *, status_code: int, detail: str) -> bool:
        normalized_detail = detail.lower()
        has_responses_hint = "/responses" in normalized_detail or "responses api" in normalized_detail
        has_unsupported_hint = any(
            marker in normalized_detail
            for marker in ("not found", "unsupported", "not available", "does not support")
        )
        if has_responses_hint and has_unsupported_hint:
            return True
        return status_code in (404, 405) and has_responses_hint

    def _provider_name(self) -> str:
        parsed = urlparse(self._base_url)
        return parsed.netloc or self._base_url

    def _default_error_log_path(self) -> str:
        if self._log_service is None:
            return "log/error.log"
        return self._log_service.error_log_display_path()

    def _log_request(
        self,
        *,
        url: str,
        payload_body: dict[str, object],
        continuation_decision: str,
        previous_response_id: str | None,
    ) -> str | None:
        if self._log_service is None:
            return None
        context = self._log_context()
        path = self._log_service.write_raw_model_payload(
            kind="request",
            payload={
                "url": url,
                "method": "POST",
                "body": payload_body,
                "continuation": {
                    "decision": continuation_decision,
                    "previous_response_id": previous_response_id,
                },
            },
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        relative_path = self._log_service.relative_path(path)
        self._log_service_event(
            level=LogLevel.INFO,
            event="model_request_started",
            message="Sent model request",
            request_path=relative_path,
        )
        return relative_path

    def _log_response(self, payload: dict[str, object]) -> str | None:
        if self._log_service is None:
            return None
        context = self._log_context()
        path = self._log_service.write_raw_model_payload(
            kind="response",
            payload=payload,
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        return self._log_service.relative_path(path)

    def _build_http_error(
        self,
        *,
        exc: APIStatusError,
        request_path: str | None,
    ) -> ModelResponseError:
        detail = self._api_status_error_detail(exc)
        error_body = exc.body
        if self._is_unsupported_responses_provider_error(
            status_code=exc.status_code,
            detail=detail,
        ):
            error_path = self._log_failure(
                error_type=type(exc).__name__,
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                    "status_code": exc.status_code,
                    "response_body": error_body,
                },
            )
            return ModelResponseError(
                "Responses API is not available for the current provider. "
                "Switch to a provider/model that supports Responses or set protocol=legacy_chat.",
                error_path=error_path,
                log_path=self._default_error_log_path(),
                stop_reason=StopReason.MODEL_ERROR,
                is_retryable=False,
                failure_kind="unsupported_responses_provider",
            )
        provider_name = self._provider_name()
        classification = self._classify_provider_failure(
            detail=detail,
            status_code=exc.code,
            provider_error_code=None,
        )
        error_path = self._log_failure(
            error_type=type(exc).__name__,
            message=detail,
            request_path=request_path,
            payload={
                "error_type": type(exc).__name__,
                "message": detail,
                "status_code": exc.status_code,
                "response_body": error_body,
                "failure_kind": classification.failure_kind,
            },
        )
        return ModelResponseError(
            f"Model provider '{provider_name}' returned HTTP {exc.status_code}: {detail}",
            error_path=error_path,
            log_path=self._default_error_log_path(),
            stop_reason=classification.stop_reason,
            is_retryable=classification.is_retryable,
            failure_kind=classification.failure_kind,
        )

    def _build_transport_error(
        self,
        *,
        exc: APIConnectionError | APITimeoutError,
        request_path: str | None,
    ) -> ModelResponseError:
        reason = str(exc)
        error_path = self._log_failure(
            error_type=type(exc).__name__,
            message=str(reason),
            request_path=request_path,
            payload={
                "error_type": type(exc).__name__,
                "message": str(reason),
                "failure_kind": "transport_error",
            },
        )
        return ModelResponseError(
            f"Failed to reach model provider: {reason}",
            error_path=error_path,
            log_path=self._default_error_log_path(),
            stop_reason=StopReason.TRANSPORT_FAILED,
            is_retryable=True,
            failure_kind="transport_error",
        )

    def _build_retry_exhausted_error(
        self,
        *,
        cause: ModelResponseError,
        request_path: str | None,
        attempts: int,
    ) -> ModelResponseError:
        detail = f"Model stream retry budget exhausted after {attempts} attempt(s): {cause}"
        error_path = self._log_failure(
            error_type="ModelResponseError",
            message=detail,
            request_path=request_path,
            payload={
                "error_type": "ModelResponseError",
                "message": detail,
                "failure_kind": "retry_exhausted",
                "attempts": attempts,
                "cause": cause.failure_kind,
            },
        )
        self._log_service_event(
            level=LogLevel.ERROR,
            event="model_stream_retry_exhausted",
            message=detail,
            request_path=request_path,
            error_path=error_path,
        )
        return ModelResponseError(
            detail,
            error_path=error_path,
            log_path=self._default_error_log_path(),
            stop_reason=StopReason.RETRY_EXHAUSTED,
            is_retryable=False,
            failure_kind="retry_exhausted",
        )

    def _classify_provider_failure(
        self,
        *,
        detail: str,
        status_code: int | None,
        provider_error_code: str | None,
    ) -> _FailureClassification:
        normalized_detail = detail.lower()
        normalized_code = provider_error_code.lower() if isinstance(provider_error_code, str) else ""
        context_markers = (
            "context length",
            "maximum context length",
            "context window",
            "too many tokens",
            "input too long",
        )
        if normalized_code in {"context_length_exceeded", "context_window_exceeded"} or any(
            marker in normalized_detail for marker in context_markers
        ):
            return _FailureClassification(
                stop_reason=StopReason.CONTEXT_WINDOW_EXCEEDED,
                is_retryable=False,
                failure_kind="context_window_exceeded",
            )
        if status_code in {408, 409, 429, 500, 502, 503, 504}:
            return _FailureClassification(
                stop_reason=StopReason.TRANSPORT_FAILED,
                is_retryable=True,
                failure_kind="http_error",
            )
        return _FailureClassification(
            stop_reason=StopReason.MODEL_ERROR,
            is_retryable=False,
            failure_kind="provider_error",
        )

    def _log_failure(
        self,
        *,
        error_type: str,
        message: str,
        request_path: str | None,
        payload: dict[str, object],
    ) -> str | None:
        if self._log_service is None:
            return None
        context = self._log_context()
        path = self._log_service.write_error_payload(
            payload=payload,
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        relative_path = self._log_service.relative_path(path)
        self._log_service_event(
            level=LogLevel.ERROR,
            event="model_request_failed",
            message=message,
            request_path=request_path,
            error_path=relative_path,
        )
        return relative_path

    def _log_service_event(
        self,
        *,
        level: LogLevel,
        event: str,
        message: str,
        request_path: str | None = None,
        response_path: str | None = None,
        error_path: str | None = None,
    ) -> None:
        if self._log_service is None:
            return
        context = self._log_context()
        self._log_service.log_model_event(
            ModelLogEvent(
                timestamp=self._log_service.new_timestamp(),
                level=level,
                event=event,
                session_id=context.session_id,
                turn_id=context.turn_id,
                protocol="responses",
                model=self._model,
                provider=self._provider_name(),
                message=message,
                request_path=request_path,
                response_path=response_path,
                error_path=error_path,
            )
        )

    def _log_context(self) -> ModelLogContext:
        if self._log_context_provider is None:
            return ModelLogContext()
        return self._log_context_provider()
