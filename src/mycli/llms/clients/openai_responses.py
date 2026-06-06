from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any, cast

from openai import APIConnectionError, APIResponseValidationError, APIStatusError, APITimeoutError

from mycli.domain.logging import LogLevel, ModelLogContext
from mycli.domain.model_events import ModelEvent, ModelEventType
from mycli.domain.runtime import StopReason
from mycli.infrastructure.responses_request_builder import ResponsesRequestBuilder
from mycli.llms.clients.openai_chat import (
    ModelResponseError,
    _build_openai_sdk_client,
    _sdk_payload_to_dict,
)
from mycli.infrastructure.ssl import ensure_certifi_ca_bundle
from mycli.schemas.responses_protocol import (
    ResponsesCapabilityProfile,
    ResponsesContinuationState,
)
from mycli.llms.clients.responses_errors import ResponsesErrorFactory
from mycli.llms.clients.responses_event_mapper import ResponsesEventMapper
from mycli.llms.clients.responses_logging import ResponsesClientLogger
from mycli.llms.clients.responses_streaming import ResponsesStreamHelper
from mycli.utils.workspace_logger import WorkspaceLogService


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
        self._logger = ResponsesClientLogger(
            base_url=self._base_url,
            model=model,
            log_service=log_service,
            log_context_provider=log_context_provider,
        )
        self._errors = ResponsesErrorFactory(logger=self._logger)
        self._event_mapper = ResponsesEventMapper()
        self._stream_helper = ResponsesStreamHelper(logger=self._logger)

    def set_log_context_provider(
        self,
        provider: Callable[[], ModelLogContext],
    ) -> None:
        self._logger.set_log_context_provider(provider)

    def set_runtime_event_recorder(
        self,
        recorder: Callable[[str, dict[str, object]], None] | None,
    ) -> None:
        self._runtime_event_recorder = recorder

    def set_reasoning_effort(self, reasoning_effort: str | None) -> None:
        self._reasoning_effort = reasoning_effort

    def set_model(self, model: str) -> None:
        self._model = model
        self._logger.set_model(model)

    def set_max_output_tokens(self, value: int) -> None:
        self._max_output_tokens = value

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
        prompt_cache_key: str | None = None,
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
                prompt_cache_key=prompt_cache_key,
            )
            payload_body = build_result.payload_body
            self._pending_request_signature = build_result.request_signature
            self._pending_request_input = build_result.normalized_input
            request_path = self._logger.log_request(
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
                    cast(Any, self._sdk_client.responses.create)(**payload_body)
                )
            except APIStatusError as exc:
                continuation_retry_reason = self._errors.continuation_retry_reason(
                    exc=exc,
                    used_previous_response_id=build_result.used_previous_response_id,
                )
                if continuation_retry_reason is not None:
                    detail = self._errors.api_status_error_detail(exc)
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
                error = self._errors.build_http_error(exc=exc, request_path=request_path)
                self.record_response_failure(str(error))
                raise error from exc
            except (APIConnectionError, APITimeoutError) as exc:
                error = self._errors.build_transport_error(exc=exc, request_path=request_path)
                self.record_response_failure(str(error))
                raise error from exc
            except (APIResponseValidationError, TypeError) as exc:
                raw_response = exc.body if isinstance(exc, APIResponseValidationError) else None
                error_path = self._logger.log_failure(
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
                    log_path=self._logger.default_error_log_path(),
                    stop_reason=StopReason.MODEL_ERROR,
                    failure_kind="invalid_json_response",
                ) from exc
            break

        if not isinstance(payload, dict):
            error_path = self._logger.log_failure(
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
                log_path=self._logger.default_error_log_path(),
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="invalid_response_shape",
            )
        response_path = self._logger.log_response(payload)
        self._logger.log_service_event(
            level=LogLevel.INFO,
            event="model_response_received",
            message="Received model response",
            request_path=request_path,
            response_path=response_path,
        )
        return payload

    def create_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
        prompt_cache_key: str | None = None,
    ) -> list[ModelEvent]:
        payload = self.create_response(
            input_items=input_items,
            tools=tools,
            prompt_cache_key=prompt_cache_key,
        )
        events: list[ModelEvent] = []
        raw_output = payload.get("output", [])
        if isinstance(raw_output, list):
            for raw_item in raw_output:
                if isinstance(raw_item, dict):
                    events.extend(self._event_mapper.events_from_output_item(raw_item))
        response_id = payload.get("id")
        events.append(
            ModelEvent(
                type=ModelEventType.TURN_COMPLETED,
                response_id=response_id if isinstance(response_id, str) else None,
            )
        )
        return events

    def stream_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
        prompt_cache_key: str | None = None,
    ) -> Iterator[dict[str, object]]:
        if self._stream_transport_disabled:
            yield from self._fallback_create_response_as_stream(
                input_items=input_items,
                tools=tools,
                reason="stream transport already disabled",
                prompt_cache_key=prompt_cache_key,
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
                prompt_cache_key=prompt_cache_key,
            )
            payload_body = build_result.payload_body
            self._pending_request_signature = build_result.request_signature
            self._pending_request_input = build_result.normalized_input
            request_path = self._logger.log_request(
                url=f"{self._base_url}/responses",
                payload_body=payload_body,
                continuation_decision=build_result.continuation_decision,
                previous_response_id=build_result.used_previous_response_id,
            )
            self._logger.log_service_event(
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
                stream_response = cast(Any, self._sdk_client.responses.create)(**payload_body)
                try:
                    for raw_event in stream_response:
                        for event in self._stream_helper.iter_stream_events(
                            raw_event=raw_event,
                            request_path=request_path,
                        ):
                            event_type = event.get("type")
                            if event_type == "response.completed":
                                terminated = True
                                response_path = self._log_stream_completion(event)
                                self._logger.log_service_event(
                                    level=LogLevel.INFO,
                                    event="model_stream_completed",
                                    message="Completed model stream",
                                    request_path=request_path,
                                    response_path=response_path,
                                )
                                yield event
                                return
                            if event_type == "response.failed":
                                raise self._errors.build_response_failed_error(
                                    event=event,
                                    request_path=request_path,
                                )
                            yield event
                    if not terminated:
                        raise self._stream_helper.build_stream_disconnect_error(request_path=request_path)
                finally:
                    close = getattr(stream_response, "close", None)
                    if callable(close):
                        close()
            except APIStatusError as exc:
                continuation_retry_reason = self._errors.continuation_retry_reason(
                    exc=exc,
                    used_previous_response_id=build_result.used_previous_response_id,
                )
                if continuation_retry_reason is not None:
                    detail = self._errors.api_status_error_detail(exc)
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
                error = self._errors.build_http_error(exc=exc, request_path=request_path)
            except (APIConnectionError, APITimeoutError) as exc:
                error = self._errors.build_transport_error(exc=exc, request_path=request_path)
            except ModelResponseError as exc:
                error = exc

            if error.is_retryable and attempt < max_retries:
                attempt += 1
                self._logger.log_service_event(
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
                self._logger.log_service_event(
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
                    prompt_cache_key=prompt_cache_key,
                )
                return

            if error.is_retryable:
                exhausted_error = self._errors.build_retry_exhausted_error(
                    cause=error,
                    request_path=request_path,
                    attempts=attempt + 1,
                )
                self.record_response_failure(str(exhausted_error))
                raise exhausted_error from error

            self.record_response_failure(str(error))
            raise error

    def _fallback_create_response_as_stream(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None,
        reason: str,
        prompt_cache_key: str | None = None,
    ) -> Iterator[dict[str, object]]:
        self._logger.log_service_event(
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
            prompt_cache_key=prompt_cache_key,
        )
        yield from self._stream_helper.payload_to_synthetic_stream(payload)

    def _log_stream_completion(self, event: dict[str, object]) -> str | None:
        response_payload = event.get("response")
        if not isinstance(response_payload, dict):
            return None
        return self._logger.log_response(response_payload)

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
