from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from typing import Any, Protocol, cast
from urllib.parse import urlparse

from openai import APIConnectionError, APIResponseValidationError, APIStatusError, APITimeoutError, OpenAI

from mycli.domain.logging import LogLevel, ModelLogContext, ModelLogEvent
from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource
from mycli.domain.runtime import ModelDecision
from mycli.domain.tooling.calls import ToolCall
from mycli.infrastructure.providers.chat import (
    ChatProviderAdapter,
    ChatProviderSettings,
    DefaultChatProviderAdapter,
)
from mycli.infrastructure.ssl import ensure_certifi_ca_bundle
from mycli.llms.clients.openai_chat_errors import ModelResponseError
from mycli.llms.clients.openai_chat_payloads import (
    NATIVE_TOOL_ARGUMENTS_PARSE_ERROR,
    decode_native_tool_arguments as _decode_native_tool_arguments,
    decode_native_tool_call as _decode_native_tool_call,
    load_native_tool_argument_candidate as _load_native_tool_argument_candidate,
    native_tool_argument_candidates as _native_tool_argument_candidates,
    with_response_metadata as _with_response_metadata,
)
from mycli.llms.clients.openai_sdk import (
    DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS,
    api_status_error_detail as _api_status_error_detail,
    sdk_payload_to_dict as _sdk_payload_to_dict,
)
from mycli.utils.workspace_logger import WorkspaceLogService

__all__ = [
    "DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS",
    "NATIVE_TOOL_ARGUMENTS_PARSE_ERROR",
    "ModelClient",
    "ModelResponseError",
    "OpenAIChatClient",
    "_api_status_error_detail",
    "_build_openai_sdk_client",
    "_decode_native_tool_arguments",
    "_decode_native_tool_call",
    "_load_native_tool_argument_candidate",
    "_native_tool_argument_candidates",
    "_sdk_payload_to_dict",
    "_with_response_metadata",
]


class ModelClient(Protocol):
    def decide(self, prompt: str) -> ModelDecision:
        """Return the next model decision for the current ReAct step."""


def _build_openai_sdk_client(*, api_key: str, base_url: str) -> OpenAI:
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS,
        max_retries=0,
    )


class OpenAIChatClient:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        max_output_tokens: int,
        log_service: WorkspaceLogService | None = None,
        log_context_provider: Callable[[], ModelLogContext] | None = None,
        provider_adapter: ChatProviderAdapter | None = None,
    ) -> None:
        ensure_certifi_ca_bundle()
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._sdk_client = _build_openai_sdk_client(api_key=api_key, base_url=base_url)
        self._thinking_enabled = True
        self._thinking_effort: str | None = None
        self._log_service = log_service
        self._log_context_provider = log_context_provider
        self._provider_adapter = provider_adapter or DefaultChatProviderAdapter()
        self._tool_choice: str | None = None

    def set_log_context_provider(
        self,
        provider: Callable[[], ModelLogContext],
    ) -> None:
        self._log_context_provider = provider

    def set_thinking_config(
        self,
        *,
        enabled: bool,
        effort: object,
    ) -> None:
        self._thinking_enabled = enabled
        value = getattr(effort, "value", effort)
        self._thinking_effort = str(value) if enabled and value is not None else None

    def set_tool_choice(self, tool_choice: str | None) -> None:
        self._tool_choice = tool_choice

    def set_model(self, model: str) -> None:
        self._model = model

    def set_max_output_tokens(self, value: int) -> None:
        self._max_output_tokens = value

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
                    "function": {
                        "name": str(tool["name"]),
                        "description": str(tool["description"]),
                        "parameters": {
                            "type": "object",
                            "properties": properties,
                            "required": required,
                            "additionalProperties": False,
                        },
                    },
                }
            )
        return normalized_tools

    def _chat_payload_body(
        self,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        adapted_messages = self._provider_adapter.adapt_messages(messages)
        payload_body: dict[str, object] = {
            "model": self._model,
            "messages": adapted_messages,
            "max_tokens": self._max_output_tokens,
            "temperature": 0,
        }
        if tools:
            payload_body["tools"] = self._normalize_tool_definitions(tools)
            if self._tool_choice is not None:
                payload_body["tool_choice"] = self._tool_choice
        return self._provider_adapter.adapt_request_body(
            payload_body,
            settings=ChatProviderSettings(
                thinking_enabled=self._thinking_enabled,
                thinking_effort=self._thinking_effort,
            ),
        )

    def complete(
        self,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        payload_body = self._chat_payload_body(messages, tools)
        request_path = self._log_request(
            url=f"{self._base_url}/chat/completions",
            payload_body=payload_body,
        )
        try:
            payload = _sdk_payload_to_dict(
                cast(Any, self._sdk_client.chat.completions.create)(**payload_body)
            )
        except APIStatusError as exc:
            detail = _api_status_error_detail(exc)
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                    "status_code": exc.status_code,
                    "response_body": exc.body,
                },
            )
            raise ModelResponseError(
                f"Model provider returned HTTP {exc.status_code}: {detail}",
                error_path=error_path,
                log_path=self._default_error_log_path(),
            ) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            detail = str(exc)
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                },
            )
            raise ModelResponseError(
                f"Failed to reach model provider: {detail}",
                error_path=error_path,
                log_path=self._default_error_log_path(),
            ) from exc
        except (APIResponseValidationError, TypeError) as exc:
            detail = str(exc)
            response_body = exc.body if isinstance(exc, APIResponseValidationError) else None
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                    "response_body": response_body,
                },
            )
            raise ModelResponseError(
                "Model provider did not return valid JSON.",
                error_path=error_path,
                log_path=self._default_error_log_path(),
            ) from exc
        self._log_service_event(
            level=LogLevel.INFO,
            event="model_response_received",
            message="Received model response",
            request_path=request_path,
            response_path=self._log_response(payload),
        )

        raw_choices = payload.get("choices", [])
        if not isinstance(raw_choices, list) or not raw_choices:
            raise ModelResponseError("Model provider response did not include choices.")
        first_choice = raw_choices[0]
        if not isinstance(first_choice, dict):
            raise ModelResponseError("Model provider response choice was not an object.")
        raw_message = first_choice.get("message", {})
        if not isinstance(raw_message, dict):
            raise ModelResponseError("Model provider response message was not an object.")
        message = raw_message
        provider_metadata = self._provider_adapter.extract_message_metadata(message)
        raw_tool_calls = message.get("tool_calls")
        if isinstance(raw_tool_calls, list) and raw_tool_calls:
            tool_call_payloads = [
                _decode_native_tool_call(
                    cast("dict[str, object]", raw_tool_call),
                    provider_metadata=provider_metadata,
                )
                for raw_tool_call in raw_tool_calls
                if isinstance(raw_tool_call, dict)
            ]
            if tool_call_payloads:
                return _with_response_metadata({
                    "assistant_message": (
                        None
                        if message.get("content") is None
                        else str(message["content"])
                    ),
                    "progress_message": None,
                    "tool_call": tool_call_payloads[0],
                    "tool_calls": tool_call_payloads,
                    "done": False,
                }, provider_metadata=provider_metadata, response_payload=payload)
        if tools:
            content = "" if message.get("content") is None else str(message["content"])
            return _with_response_metadata({
                "assistant_message": content.strip(),
                "progress_message": None,
                "tool_call": None,
                "done": True,
            }, provider_metadata=provider_metadata, response_payload=payload)

        content = message["content"]
        try:
            decision_payload = json.loads(content)
        except json.JSONDecodeError:
            plain_text = content.strip()
            return _with_response_metadata({
                "assistant_message": plain_text,
                "progress_message": None,
                "tool_name": None,
                "arguments": {},
                "reason": "plain text fallback",
                "done": True,
            }, provider_metadata=provider_metadata, response_payload=payload)
        if not isinstance(decision_payload, dict):
            raise ValueError("Model response content must decode to a JSON object.")
        usage = payload.get("usage")
        if isinstance(usage, dict):
            decision_payload["usage"] = usage
        return decision_payload

    def decide(self, prompt: str) -> ModelDecision:
        decision_payload = self.complete([{"role": "user", "content": prompt}])
        tool_call = None
        if decision_payload.get("tool_name"):
            raw_arguments = decision_payload.get("arguments", {})
            tool_call = ToolCall(
                name=str(decision_payload["tool_name"]),
                arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
                reason=str(decision_payload.get("reason", "model requested tool")),
            )
        return ModelDecision(
            assistant_message=(
                None
                if decision_payload.get("assistant_message") is None
                else str(decision_payload["assistant_message"])
            ),
            progress_message=(
                None
                if decision_payload.get("progress_message") is None
                else str(decision_payload["progress_message"])
            ),
            tool_call=tool_call,
            done=bool(decision_payload.get("done", False)),
        )

    def stream_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> Iterator[ModelEvent]:
        payload_body = self._chat_payload_body(input_items, tools)
        payload_body["stream"] = True
        payload_body["stream_options"] = {"include_usage": True}
        request_path = self._log_request(
            url=f"{self._base_url}/chat/completions",
            payload_body=payload_body,
        )
        try:
            stream = cast(Any, self._sdk_client.chat.completions.create)(**payload_body)
            yield from self._events_from_chat_stream(stream)
        except APIStatusError as exc:
            detail = _api_status_error_detail(exc)
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                    "status_code": exc.status_code,
                    "response_body": exc.body,
                },
            )
            raise ModelResponseError(
                f"Model provider returned HTTP {exc.status_code}: {detail}",
                error_path=error_path,
                log_path=self._default_error_log_path(),
            ) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            detail = str(exc)
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                },
            )
            raise ModelResponseError(
                f"Failed to reach model provider: {detail}",
                error_path=error_path,
                log_path=self._default_error_log_path(),
            ) from exc
        except (APIResponseValidationError, TypeError) as exc:
            detail = str(exc)
            response_body = exc.body if isinstance(exc, APIResponseValidationError) else None
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                    "response_body": response_body,
                },
            )
            raise ModelResponseError(
                "Model provider did not return valid JSON.",
                error_path=error_path,
                log_path=self._default_error_log_path(),
            ) from exc
        self._log_service_event(
            level=LogLevel.INFO,
            event="model_response_received",
            message="Received streaming model response",
            request_path=request_path,
        )

    def _events_from_chat_stream(self, stream: object) -> Iterator[ModelEvent]:
        response_id: str | None = None
        usage: dict[str, object] | None = None
        tool_call_states: dict[int, dict[str, str]] = {}
        emitted_tool_calls = False

        for raw_chunk in stream:
            chunk = _sdk_payload_to_dict(raw_chunk)
            raw_id = chunk.get("id")
            if isinstance(raw_id, str) and raw_id:
                response_id = raw_id
            raw_usage = chunk.get("usage")
            if isinstance(raw_usage, dict):
                usage = raw_usage

            raw_choices = chunk.get("choices", [])
            if not isinstance(raw_choices, list):
                continue
            for raw_choice in raw_choices:
                if not isinstance(raw_choice, dict):
                    continue
                raw_delta = raw_choice.get("delta", {})
                delta = raw_delta if isinstance(raw_delta, dict) else {}
                reasoning = delta.get("reasoning_content")
                if isinstance(reasoning, str) and reasoning:
                    yield ModelEvent(
                        type=ModelEventType.REASONING_DELTA,
                        text=reasoning,
                        provider_id=response_id,
                    )
                content = delta.get("content")
                if isinstance(content, str) and content:
                    yield ModelEvent.message_delta(
                        text=content,
                        provider_id=response_id,
                    )
                self._accumulate_stream_tool_calls(
                    delta.get("tool_calls"),
                    tool_call_states,
                )
                if raw_choice.get("finish_reason") == "tool_calls":
                    yield from self._stream_tool_call_events(
                        tool_call_states,
                        response_id=response_id,
                    )
                    emitted_tool_calls = True

        if tool_call_states and not emitted_tool_calls:
            yield from self._stream_tool_call_events(
                tool_call_states,
                response_id=response_id,
            )
        yield ModelEvent(
            type=ModelEventType.TURN_COMPLETED,
            response_id=response_id,
            usage=usage,
        )

    def _accumulate_stream_tool_calls(
        self,
        raw_tool_calls: object,
        tool_call_states: dict[int, dict[str, str]],
    ) -> None:
        if not isinstance(raw_tool_calls, list):
            return
        for fallback_index, raw_tool_call in enumerate(raw_tool_calls):
            if not isinstance(raw_tool_call, dict):
                continue
            raw_index = raw_tool_call.get("index")
            index = raw_index if isinstance(raw_index, int) else fallback_index
            state = tool_call_states.setdefault(
                index,
                {"id": "", "name": "", "arguments": ""},
            )
            raw_id = raw_tool_call.get("id")
            if isinstance(raw_id, str) and raw_id:
                state["id"] = raw_id
            raw_function = raw_tool_call.get("function", {})
            if not isinstance(raw_function, dict):
                continue
            raw_name = raw_function.get("name")
            if isinstance(raw_name, str) and raw_name:
                state["name"] += raw_name
            raw_arguments = raw_function.get("arguments")
            if isinstance(raw_arguments, str) and raw_arguments:
                state["arguments"] += raw_arguments

    def _stream_tool_call_events(
        self,
        tool_call_states: dict[int, dict[str, str]],
        *,
        response_id: str | None,
    ) -> Iterator[ModelEvent]:
        for index in sorted(tool_call_states):
            state = tool_call_states[index]
            raw_tool_call: dict[str, object] = {
                "id": state["id"] or f"tool_call_{index}",
                "type": "function",
                "function": {
                    "name": state["name"],
                    "arguments": state["arguments"],
                },
            }
            decoded = _decode_native_tool_call(raw_tool_call, provider_metadata={})
            raw_arguments = decoded.get("arguments", {})
            yield ModelEvent.tool_call_requested(
                tool_name=str(decoded["name"]),
                tool_arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
                call_id=str(decoded.get("id") or f"tool_call_{index}"),
                source=ToolExecutionSource.NATIVE,
                provider_id=response_id,
                metadata=(
                    decoded.get("metadata")
                    if isinstance(decoded.get("metadata"), dict)
                    else {}
                ),
            )

    def create_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> list[ModelEvent]:
        payload = self.complete(messages=input_items, tools=tools)
        events: list[ModelEvent] = []
        assistant_message = payload.get("assistant_message")
        if isinstance(assistant_message, str) and assistant_message:
            metadata = payload.get("metadata")
            response_id = self._response_id(payload)
            events.append(
                ModelEvent.message_delta(
                    text=assistant_message,
                    provider_id=response_id,
                    metadata=(
                        cast("dict[str, object]", metadata)
                        if isinstance(metadata, dict)
                        else None
                    ),
                )
            )
        raw_tool_call = payload.get("tool_call")
        raw_tool_calls = payload.get("tool_calls")
        if isinstance(raw_tool_calls, list):
            tool_calls = [
                raw_item for raw_item in raw_tool_calls if isinstance(raw_item, dict)
            ]
        elif isinstance(raw_tool_call, dict):
            tool_calls = [raw_tool_call]
        else:
            tool_calls = []
        for raw_tool_call in tool_calls:
            raw_arguments = raw_tool_call.get("arguments", {})
            response_id = self._response_id(payload)
            events.append(
                ModelEvent.tool_call_requested(
                    tool_name=str(raw_tool_call["name"]),
                    tool_arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
                    call_id=str(
                        raw_tool_call.get("id")
                        or raw_tool_call.get("call_id")
                        or "tool_call"
                    ),
                    source=ToolExecutionSource.NATIVE,
                    provider_id=response_id,
                    metadata=(
                        raw_tool_call.get("metadata")
                        if isinstance(raw_tool_call.get("metadata"), dict)
                        else {}
                    ),
                )
            )
        usage = payload.get("usage")
        events.append(
            ModelEvent(
                type=ModelEventType.TURN_COMPLETED,
                response_id=self._response_id(payload),
                usage=usage if isinstance(usage, dict) else None,
                metadata={"done": bool(payload.get("done", False))},
            )
        )
        return events

    def _response_id(self, payload: dict[str, object]) -> str | None:
        response_id = payload.get("response_id")
        if isinstance(response_id, str) and response_id:
            return response_id
        return None

    def _log_request(
        self,
        *,
        url: str,
        payload_body: dict[str, object],
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

    def _log_failure(
        self,
        *,
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
                protocol="chat_completions",
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

    def _provider_name(self) -> str:
        parsed = urlparse(self._base_url)
        return parsed.netloc or self._base_url

    def _default_error_log_path(self) -> str:
        if self._log_service is None:
            return "log/error.log"
        return self._log_service.error_log_display_path()
