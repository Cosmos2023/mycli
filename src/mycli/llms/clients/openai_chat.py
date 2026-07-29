from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from typing import Any, Protocol, cast
from urllib.parse import urlparse

from openai import APIConnectionError, APIResponseValidationError, APIStatusError, APITimeoutError, OpenAI

from mycli.domain.logging import LogLevel, ModelLogContext, ModelLogEvent
from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource
from mycli.domain.runtime import ModelDecision, RuntimeInterruptToken, StopReason
from mycli.domain.runtime.images import image_block_to_provider_content
from mycli.domain.tooling.calls import ToolCall
from mycli.infrastructure.providers.chat import (
    ChatProviderAdapter,
    ChatProviderSettings,
    DefaultChatProviderAdapter,
)
from mycli.infrastructure.ssl import ensure_certifi_ca_bundle
from mycli.llms.clients.openai_chat_errors import (
    ModelResponseError,
    retry_after_seconds_from_status_error,
)
from mycli.llms.clients.openai_chat_payloads import (
    NATIVE_TOOL_ARGUMENTS_PARSE_ERROR,
    decode_native_tool_arguments as _decode_native_tool_arguments,
    decode_native_tool_call as _decode_native_tool_call,
    load_native_tool_argument_candidate as _load_native_tool_argument_candidate,
    native_tool_argument_candidates as _native_tool_argument_candidates,
    tool_parameters_schema as _tool_parameters_schema,
    with_response_metadata as _with_response_metadata,
)
from mycli.llms.clients.openai_sdk import (
    DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS,
    api_status_error_detail as _api_status_error_detail,
    sdk_payload_to_dict as _sdk_payload_to_dict,
)
from mycli.llms.clients.responses_errors import FailureClassification, classify_provider_failure
from mycli.llms.clients.user_agent import model_request_headers
from mycli.utils.workspace_logger import WorkspaceLogService

__all__ = [
    "DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS",
    "NATIVE_TOOL_ARGUMENTS_PARSE_ERROR",
    "ModelClient",
    "ModelResponseError",
    "OpenAIChatClient",
    "_api_status_error_detail",
    "_build_openai_sdk_client",
    "classify_chat_provider_failure",
    "_decode_native_tool_arguments",
    "_decode_native_tool_call",
    "_load_native_tool_argument_candidate",
    "_native_tool_argument_candidates",
    "_sdk_payload_to_dict",
    "_with_response_metadata",
]


def classify_chat_provider_failure(
    *,
    detail: str,
    status_code: int | None,
    provider_error_code: str | None,
) -> FailureClassification:
    return classify_provider_failure(
        detail=detail,
        status_code=status_code,
        provider_error_code=provider_error_code,
    )


class ModelClient(Protocol):
    def decide(self, prompt: str) -> ModelDecision:
        """Return the next model decision for the current ReAct step."""


_CHAT_TOOL_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
_CHAT_TOOL_NAME_INVALID_PATTERN = re.compile(r"[^a-zA-Z0-9_-]+")
_CHAT_TOOL_NAME_MAX_LENGTH = 64


@dataclass(slots=True, frozen=True)
class _ToolNameAliases:
    canonical_to_wire: dict[str, str]
    wire_to_canonical: dict[str, str]

    @classmethod
    def from_names(cls, names: Iterable[str]) -> _ToolNameAliases:
        canonical_names = tuple(dict.fromkeys(names))
        if not canonical_names:
            return cls(canonical_to_wire={}, wire_to_canonical={})

        bases = {name: _wire_tool_name_base(name) for name in canonical_names}
        base_counts: dict[str, int] = {}
        for base in bases.values():
            base_counts[base] = base_counts.get(base, 0) + 1

        canonical_to_wire: dict[str, str] = {}
        wire_to_canonical: dict[str, str] = {}
        for canonical_name in canonical_names:
            base = bases[canonical_name]
            needs_suffix = (
                base_counts[base] > 1
                or len(base) > _CHAT_TOOL_NAME_MAX_LENGTH
            )
            wire_name = (
                _wire_tool_name_with_hash(base, canonical_name)
                if needs_suffix
                else base
            )
            canonical_to_wire[canonical_name] = wire_name
            wire_to_canonical[wire_name] = canonical_name

        return cls(
            canonical_to_wire=canonical_to_wire,
            wire_to_canonical=wire_to_canonical,
        )

    @classmethod
    def from_tools(cls, tools: list[dict[str, object]] | None) -> _ToolNameAliases:
        return cls.from_names(str(tool["name"]) for tool in tools or [])

    def wire_name(self, canonical_name: str) -> str:
        return self.canonical_to_wire.get(canonical_name, canonical_name)

    def canonical_name(self, wire_name: str) -> str:
        return self.wire_to_canonical.get(wire_name, wire_name)


def _wire_tool_name_base(canonical_name: str) -> str:
    stripped = canonical_name.strip()
    if _CHAT_TOOL_NAME_PATTERN.fullmatch(stripped) and len(stripped) <= _CHAT_TOOL_NAME_MAX_LENGTH:
        return stripped
    sanitized = _CHAT_TOOL_NAME_INVALID_PATTERN.sub("_", stripped).strip("_")
    return sanitized or "tool"


def _wire_tool_name_with_hash(base: str, canonical_name: str) -> str:
    digest = hashlib.sha256(canonical_name.encode("utf-8")).hexdigest()[:8]
    suffix = f"_{digest}"
    prefix_length = _CHAT_TOOL_NAME_MAX_LENGTH - len(suffix)
    prefix = base[:prefix_length].rstrip("_-") or "tool"
    return f"{prefix}{suffix}"


def _build_openai_sdk_client(
    *,
    api_key: str,
    base_url: str,
    max_retries: int = 4,
) -> OpenAI:
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers=model_request_headers(),
        timeout=DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS,
        max_retries=max(0, min(100, max_retries)),
    )


class OpenAIChatClient:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        log_service: WorkspaceLogService | None = None,
        log_context_provider: Callable[[], ModelLogContext] | None = None,
        provider_adapter: ChatProviderAdapter | None = None,
        request_max_retries: int = 4,
    ) -> None:
        ensure_certifi_ca_bundle()
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._request_max_retries = max(0, min(100, request_max_retries))
        self._sdk_client = _build_openai_sdk_client(
            api_key=api_key,
            base_url=base_url,
            max_retries=self._request_max_retries,
        )
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

    def _normalize_tool_definitions(
        self,
        tools: list[dict[str, object]],
        *,
        aliases: _ToolNameAliases | None = None,
    ) -> list[dict[str, object]]:
        tool_name_aliases = aliases or _ToolNameAliases.from_tools(tools)
        normalized_tools: list[dict[str, object]] = []
        for tool in tools:
            normalized_tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": tool_name_aliases.wire_name(str(tool["name"])),
                        "description": str(tool["description"]),
                        "parameters": _tool_parameters_schema(tool),
                    },
                }
            )
        return normalized_tools

    def _chat_payload_body_with_tool_aliases(
        self,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> tuple[dict[str, object], _ToolNameAliases]:
        prompt_cache_key = self._prompt_cache_key_from_messages(messages)
        tool_name_aliases = _ToolNameAliases.from_names(
            self._tool_names_for_wire_aliases(messages=messages, tools=tools)
        )
        adapted_messages = self._provider_adapter.adapt_messages(
            self._messages_with_multimodal_content(
                self._messages_with_wire_tool_names(messages, tool_name_aliases)
            )
        )
        payload_body: dict[str, object] = {
            "model": self._model,
            "messages": adapted_messages,
            "temperature": 0,
        }
        if prompt_cache_key:
            payload_body["prompt_cache_key"] = prompt_cache_key
        if tools:
            payload_body["tools"] = self._normalize_tool_definitions(
                tools,
                aliases=tool_name_aliases,
            )
            if self._tool_choice is not None:
                payload_body["tool_choice"] = self._tool_choice
        return (
            self._provider_adapter.adapt_request_body(
                payload_body,
                settings=ChatProviderSettings(
                    thinking_enabled=self._thinking_enabled,
                    thinking_effort=self._thinking_effort,
                ),
            ),
            tool_name_aliases,
        )

    def _prompt_cache_key_from_messages(
        self,
        messages: list[dict[str, object]],
    ) -> str | None:
        for message in messages:
            metadata = message.get("metadata")
            if not isinstance(metadata, dict):
                continue
            policy = metadata.get("provider_request_policy")
            if not isinstance(policy, dict):
                continue
            value = policy.get("prompt_cache_key")
            if isinstance(value, str) and value:
                return value
        return None

    def _tool_names_for_wire_aliases(
        self,
        *,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]] | None,
    ) -> Iterable[str]:
        for tool in tools or []:
            yield str(tool["name"])
        for message in messages:
            raw_tool_calls = message.get("tool_calls")
            if not isinstance(raw_tool_calls, list):
                continue
            for raw_tool_call in raw_tool_calls:
                if not isinstance(raw_tool_call, dict):
                    continue
                raw_function = raw_tool_call.get("function")
                if not isinstance(raw_function, dict):
                    continue
                raw_name = raw_function.get("name")
                if isinstance(raw_name, str) and raw_name.strip():
                    yield raw_name

    def _messages_with_wire_tool_names(
        self,
        messages: list[dict[str, object]],
        aliases: _ToolNameAliases,
    ) -> list[dict[str, object]]:
        if not aliases.canonical_to_wire:
            return messages

        aliased_messages: list[dict[str, object]] = []
        for message in messages:
            aliased_message = dict(message)
            raw_tool_calls = aliased_message.get("tool_calls")
            if isinstance(raw_tool_calls, list):
                aliased_message["tool_calls"] = [
                    self._tool_call_with_wire_name(raw_tool_call, aliases)
                    for raw_tool_call in raw_tool_calls
                ]
            aliased_messages.append(aliased_message)
        return aliased_messages

    def _messages_with_multimodal_content(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        projected_messages: list[dict[str, object]] = []
        for message in messages:
            blocks = message.get("blocks")
            if not isinstance(blocks, tuple) or not blocks:
                projected_messages.append(self._without_internal_blocks(message))
                continue
            if not any(hasattr(block, "type") and block.type == "image" for block in blocks):
                projected_messages.append(self._without_internal_blocks(message))
                continue
            content_blocks: list[dict[str, object]] = []
            for block in blocks:
                if not hasattr(block, "type"):
                    continue
                if block.type in {"text", "reasoning"} and block.text:
                    content_blocks.append({"type": "text", "text": block.text})
                    continue
                if block.type == "image":
                    content_blocks.append(
                        image_block_to_provider_content(block, format="openai")
                    )
            if not content_blocks:
                projected_messages.append(self._without_internal_blocks(message))
                continue
            projected = self._without_internal_blocks(message)
            projected["content"] = content_blocks
            projected_messages.append(projected)
        return projected_messages

    def _without_internal_blocks(
        self,
        message: dict[str, object],
    ) -> dict[str, object]:
        if "blocks" not in message:
            return message
        projected = dict(message)
        projected.pop("blocks", None)
        return projected

    def _tool_call_with_wire_name(
        self,
        raw_tool_call: object,
        aliases: _ToolNameAliases,
    ) -> object:
        if not isinstance(raw_tool_call, dict):
            return raw_tool_call
        aliased_tool_call = dict(raw_tool_call)
        raw_function = aliased_tool_call.get("function")
        if not isinstance(raw_function, dict):
            return aliased_tool_call
        function_payload = dict(raw_function)
        raw_name = function_payload.get("name")
        if isinstance(raw_name, str):
            function_payload["name"] = aliases.wire_name(raw_name)
        aliased_tool_call["function"] = function_payload
        return aliased_tool_call

    def _decoded_tool_call_with_canonical_name(
        self,
        payload: dict[str, object],
        aliases: _ToolNameAliases,
    ) -> dict[str, object]:
        raw_name = payload.get("name")
        if not isinstance(raw_name, str):
            return payload
        canonical_name = aliases.canonical_name(raw_name)
        if canonical_name == raw_name:
            return payload
        decoded_payload = dict(payload)
        decoded_payload["name"] = canonical_name
        return decoded_payload

    def complete(
        self,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        payload_body, tool_name_aliases = self._chat_payload_body_with_tool_aliases(
            messages,
            tools,
        )
        request_path = self._log_request(
            url=f"{self._base_url}/chat/completions",
            payload_body=payload_body,
        )
        try:
            payload = _sdk_payload_to_dict(
                cast(Any, self._sdk_client.chat.completions.create)(**payload_body)
            )
        except APIStatusError as exc:
            raise self._status_error(exc=exc, request_path=request_path) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise self._connection_error(exc, request_path) from exc
        except (APIResponseValidationError, TypeError) as exc:
            raise self._response_validation_error(exc, request_path) from exc
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
        self._raise_for_finish_reason(first_choice.get("finish_reason"))
        raw_message = first_choice.get("message", {})
        if not isinstance(raw_message, dict):
            raise ModelResponseError("Model provider response message was not an object.")
        message = raw_message
        provider_metadata = self._provider_adapter.extract_message_metadata(message)
        raw_tool_calls = message.get("tool_calls")
        if isinstance(raw_tool_calls, list) and raw_tool_calls:
            tool_call_payloads = [
                self._decoded_tool_call_with_canonical_name(
                    _decode_native_tool_call(
                        cast("dict[str, object]", raw_tool_call),
                        provider_metadata=provider_metadata,
                    ),
                    tool_name_aliases,
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
            content_tool_call_payloads = self._content_tool_call_payloads(
                content,
                provider_metadata=provider_metadata,
                aliases=tool_name_aliases,
                response_id=_response_id_from_payload(payload),
            )
            if content_tool_call_payloads:
                return _with_response_metadata({
                    "assistant_message": None,
                    "progress_message": None,
                    "tool_call": content_tool_call_payloads[0],
                    "tool_calls": content_tool_call_payloads,
                    "done": False,
                }, provider_metadata=provider_metadata, response_payload=payload)
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
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> Iterator[ModelEvent]:
        yield from self._stream_events(
            input_items=input_items,
            tools=tools,
            interrupt_token=interrupt_token,
        )

    def stream_events_with_interrupt(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
        interrupt_token: RuntimeInterruptToken,
    ) -> Iterator[ModelEvent]:
        yield from self._stream_events(
            input_items=input_items,
            tools=tools,
            interrupt_token=interrupt_token,
        )

    def _stream_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None,
        interrupt_token: RuntimeInterruptToken | None,
    ) -> Iterator[ModelEvent]:
        payload_body, tool_name_aliases = self._chat_payload_body_with_tool_aliases(
            input_items,
            tools,
        )
        payload_body["stream"] = True
        payload_body["stream_options"] = {"include_usage": True}
        request_path = self._log_request(
            url=f"{self._base_url}/chat/completions",
            payload_body=payload_body,
        )
        unregister_interrupt_callbacks: list[Callable[[], None]] = []
        try:
            if interrupt_token is not None:
                unregister_interrupt_callbacks.append(
                    interrupt_token.add_callback(self._close_stream_and_reset_client)
                )
            stream = cast(Any, self._sdk_client.chat.completions.create)(**payload_body)
            if interrupt_token is not None:
                unregister_interrupt_callbacks[-1]()
                unregister_interrupt_callbacks.append(
                    interrupt_token.add_callback(
                        lambda: self._close_stream_and_reset_client(stream)
                    )
                )
            yield from self._events_from_chat_stream(
                stream,
                tool_name_aliases=tool_name_aliases,
                interrupt_token=interrupt_token,
            )
        except APIStatusError as exc:
            raise self._status_error(exc=exc, request_path=request_path) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise self._connection_error(exc, request_path) from exc
        except (APIResponseValidationError, TypeError) as exc:
            raise self._response_validation_error(exc, request_path) from exc
        finally:
            for unregister in reversed(unregister_interrupt_callbacks):
                unregister()
        self._log_service_event(
            level=LogLevel.INFO,
            event="model_response_received",
            message="Received streaming model response",
            request_path=request_path,
        )

    def _events_from_chat_stream(
        self,
        stream: object,
        *,
        tool_name_aliases: _ToolNameAliases | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> Iterator[ModelEvent]:
        aliases = tool_name_aliases or _ToolNameAliases.from_tools(None)
        response_id: str | None = None
        usage: dict[str, object] | None = None
        tool_call_states: dict[int, dict[str, str]] = {}
        emitted_tool_calls = False
        pending_content = ""
        finish_reason: object = None

        for raw_chunk in cast(Iterable[object], stream):
            if interrupt_token is not None and interrupt_token.interrupted:
                _close_stream(stream)
                return
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
                if raw_choice.get("finish_reason") is not None:
                    finish_reason = raw_choice["finish_reason"]
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
                    pending_content += content
                    if self._provider_adapter.may_contain_content_tool_calls(
                        pending_content
                    ):
                        continue
                    yield ModelEvent.message_delta(
                        text=pending_content,
                        provider_id=response_id,
                    )
                    pending_content = ""
                self._accumulate_stream_tool_calls(
                    delta.get("tool_calls"),
                    tool_call_states,
                )
                if raw_choice.get("finish_reason") == "tool_calls":
                    if pending_content:
                        yield ModelEvent.message_delta(
                            text=pending_content,
                            provider_id=response_id,
                        )
                        pending_content = ""
                    yield from self._stream_tool_call_events(
                        tool_call_states,
                        response_id=response_id,
                        aliases=aliases,
                    )
                    emitted_tool_calls = True

        if pending_content:
            content_tool_call_payloads = self._content_tool_call_payloads(
                pending_content,
                provider_metadata={},
                aliases=aliases,
                response_id=response_id,
            )
            if content_tool_call_payloads:
                for index, payload in enumerate(content_tool_call_payloads):
                    raw_arguments = payload.get("arguments", {})
                    raw_metadata = payload.get("metadata")
                    metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
                    yield ModelEvent.tool_call_requested(
                        tool_name=str(payload["name"]),
                        tool_arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
                        call_id=str(payload.get("id") or f"dsml_tool_call_{index}"),
                        source=ToolExecutionSource.NATIVE,
                        provider_id=response_id,
                        metadata=metadata,
                    )
                emitted_tool_calls = True
            else:
                yield ModelEvent.message_delta(
                    text=pending_content,
                    provider_id=response_id,
                )

        if tool_call_states and not emitted_tool_calls:
            yield from self._stream_tool_call_events(
                tool_call_states,
                response_id=response_id,
                aliases=aliases,
            )
        self._raise_for_finish_reason(finish_reason)
        yield ModelEvent(
            type=ModelEventType.TURN_COMPLETED,
            response_id=response_id,
            usage=usage,
        )

    @staticmethod
    def _raise_for_finish_reason(finish_reason: object) -> None:
        if finish_reason != "length":
            return
        raise ModelResponseError(
            "Model output reached the provider token limit.",
            stop_reason=StopReason.MODEL_ERROR,
            failure_kind="output_token_limit",
        )

    def _content_tool_call_payloads(
        self,
        content: str,
        *,
        provider_metadata: dict[str, object],
        aliases: _ToolNameAliases,
        response_id: str | None = None,
    ) -> list[dict[str, object]]:
        payloads = [
            self._decoded_tool_call_with_canonical_name(payload, aliases)
            for payload in self._provider_adapter.decode_content_tool_calls(
                content,
                provider_metadata=provider_metadata,
            )
        ]
        return [
            {
                **payload,
                "id": _response_scoped_content_tool_call_id(
                    payload.get("id"),
                    response_id=response_id,
                    index=index,
                ),
            }
            for index, payload in enumerate(payloads)
        ]

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
        aliases: _ToolNameAliases,
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
            decoded = self._decoded_tool_call_with_canonical_name(
                _decode_native_tool_call(raw_tool_call, provider_metadata={}),
                aliases,
            )
            raw_arguments = decoded.get("arguments", {})
            raw_metadata = decoded.get("metadata")
            metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
            yield ModelEvent.tool_call_requested(
                tool_name=str(decoded["name"]),
                tool_arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
                call_id=str(decoded.get("id") or f"tool_call_{index}"),
                source=ToolExecutionSource.NATIVE,
                provider_id=response_id,
                metadata=metadata,
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

    def _connection_error(
        self,
        exc: APIConnectionError | APITimeoutError,
        request_path: str | None,
    ) -> ModelResponseError:
        detail = str(exc)
        error_path = self._log_failure(
            message=detail,
            request_path=request_path,
            payload={"error_type": type(exc).__name__, "message": detail},
        )
        return ModelResponseError(
            f"Failed to reach model provider: {detail}",
            error_path=error_path,
            log_path=self._default_error_log_path(),
            stop_reason=StopReason.TRANSPORT_FAILED,
            is_retryable=True,
            failure_kind="transport_error",
        )

    def _response_validation_error(
        self,
        exc: APIResponseValidationError | TypeError,
        request_path: str | None,
    ) -> ModelResponseError:
        detail = str(exc)
        error_path = self._log_failure(
            message=detail,
            request_path=request_path,
            payload={
                "error_type": type(exc).__name__,
                "message": detail,
                "response_body": (
                    exc.body if isinstance(exc, APIResponseValidationError) else None
                ),
            },
        )
        return ModelResponseError(
            "Model provider did not return valid JSON.",
            error_path=error_path,
            log_path=self._default_error_log_path(),
        )

    def _status_error(
        self,
        *,
        exc: APIStatusError,
        request_path: str | None,
    ) -> ModelResponseError:
        detail = _api_status_error_detail(exc)
        provider_error_code: str | None = None
        if isinstance(exc.body, dict):
            error_payload = exc.body.get("error")
            if isinstance(error_payload, dict):
                raw_code = error_payload.get("code")
                if isinstance(raw_code, str) and raw_code.strip():
                    provider_error_code = raw_code
        classification = classify_chat_provider_failure(
            detail=detail,
            status_code=exc.status_code,
            provider_error_code=provider_error_code,
        )
        error_path = self._log_failure(
            message=detail,
            request_path=request_path,
            payload={
                "error_type": type(exc).__name__,
                "message": detail,
                "status_code": exc.status_code,
                "response_body": exc.body,
                "failure_kind": classification.failure_kind,
            },
        )
        return ModelResponseError(
            f"Model provider returned HTTP {exc.status_code}: {detail}",
            error_path=error_path,
            log_path=self._default_error_log_path(),
            stop_reason=classification.stop_reason,
            is_retryable=classification.is_retryable,
            failure_kind=classification.failure_kind,
            retry_after_seconds=retry_after_seconds_from_status_error(exc),
        )

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
            return "log/errors.log"
        return self._log_service.error_log_display_path()

    def _reset_sdk_client(self) -> None:
        _close_stream(self._sdk_client)
        self._sdk_client = _build_openai_sdk_client(
            api_key=self._api_key,
            base_url=self._base_url,
            max_retries=self._request_max_retries,
        )

    def _close_stream_and_reset_client(self, stream: object | None = None) -> None:
        if stream is not None:
            _close_stream(stream)
        self._reset_sdk_client()


def _close_stream(stream: object) -> None:
    closer = getattr(stream, "close", None)
    if not callable(closer):
        return
    try:
        closer()
    except Exception:
        return


def _response_id_from_payload(payload: dict[str, object]) -> str | None:
    response_id = payload.get("id")
    if isinstance(response_id, str) and response_id:
        return response_id
    return None


def _response_scoped_content_tool_call_id(
    raw_id: object,
    *,
    response_id: str | None,
    index: int,
) -> str:
    call_id = str(raw_id or f"dsml_tool_call_{index}")
    if response_id and call_id.startswith("dsml_tool_call_"):
        return f"{response_id}_{call_id}"
    return call_id
