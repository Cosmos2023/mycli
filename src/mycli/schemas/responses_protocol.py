from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, TypeAlias
from urllib.parse import urlparse

from mycli.domain.providers import ProviderId


MessageRole = Literal["system", "developer", "user", "assistant"]
TextContentType = Literal["input_text", "output_text"]
FunctionCallOutputImageDetail = Literal["auto", "low", "high", "original"]


@dataclass(slots=True, frozen=True)
class ResponsesTextContentItem:
    type: TextContentType
    text: str

    def to_wire(self) -> dict[str, object]:
        return {"type": self.type, "text": self.text}


@dataclass(slots=True, frozen=True)
class ResponsesFunctionCallOutputTextItem:
    text: str

    def to_wire(self) -> dict[str, object]:
        return {"type": "input_text", "text": self.text}


@dataclass(slots=True, frozen=True)
class ResponsesFunctionCallOutputImageItem:
    image_url: str
    detail: FunctionCallOutputImageDetail | None = None

    def __post_init__(self) -> None:
        if not self.image_url.strip():
            raise ValueError("function call output image requires image_url")

    def to_wire(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "type": "input_image",
            "image_url": self.image_url,
        }
        if self.detail is not None:
            payload["detail"] = self.detail
        return payload


ResponsesFunctionCallOutputContentItem: TypeAlias = (
    ResponsesFunctionCallOutputTextItem | ResponsesFunctionCallOutputImageItem
)


@dataclass(slots=True, frozen=True)
class ResponsesFunctionCallOutputPayload:
    body: str
    content_items: tuple[ResponsesFunctionCallOutputContentItem, ...] = ()
    structured_content: tuple[object, ...] = ()
    success: bool | None = None

    @classmethod
    def from_text(
        cls,
        text: str,
        success: bool | None = None,
        structured_content: tuple[object, ...] = (),
    ) -> "ResponsesFunctionCallOutputPayload":
        return cls(
            body=text,
            structured_content=structured_content,
            success=success,
        )

    @classmethod
    def from_content_items(
        cls,
        content_items: tuple[ResponsesFunctionCallOutputContentItem, ...],
        *,
        fallback_text: str,
        success: bool | None = None,
        structured_content: tuple[object, ...] = (),
    ) -> "ResponsesFunctionCallOutputPayload":
        return cls(
            body=fallback_text,
            content_items=tuple(content_items),
            structured_content=structured_content,
            success=success,
        )

    def to_wire_output(self) -> str | list[dict[str, object]]:
        if self.content_items:
            return [item.to_wire() for item in self.content_items]
        return self.body

    def to_text(self) -> str:
        return self.body

    def to_dict(self) -> dict[str, object]:
        return {
            "body": self.body,
            "content_items": [item.to_wire() for item in self.content_items],
            "structured_content": list(self.structured_content),
            "success": self.success,
        }

    @classmethod
    def from_dict(
        cls,
        payload: dict[str, object],
    ) -> "ResponsesFunctionCallOutputPayload":
        raw_structured_content = payload.get("structured_content", [])
        structured_content: tuple[object, ...] = ()
        if isinstance(raw_structured_content, list):
            structured_content = tuple(raw_structured_content)
        raw_content_items = payload.get("content_items", [])
        content_items: list[ResponsesFunctionCallOutputContentItem] = []
        if isinstance(raw_content_items, list):
            for raw_item in raw_content_items:
                parsed = _function_call_output_content_item_from_dict(raw_item)
                if parsed is not None:
                    content_items.append(parsed)
        success = payload.get("success")
        return cls(
            body=str(payload.get("body", "")),
            content_items=tuple(content_items),
            structured_content=structured_content,
            success=success if isinstance(success, bool) else None,
        )


def _function_call_output_content_item_from_dict(
    raw_item: object,
) -> ResponsesFunctionCallOutputContentItem | None:
    if not isinstance(raw_item, dict):
        return None
    item_type = raw_item.get("type")
    if item_type == "input_text":
        text = raw_item.get("text")
        if isinstance(text, str):
            return ResponsesFunctionCallOutputTextItem(text=text)
        return None
    if item_type != "input_image":
        return None
    image_url = raw_item.get("image_url")
    if not isinstance(image_url, str) or not image_url.strip():
        return None
    raw_detail = raw_item.get("detail")
    detail: FunctionCallOutputImageDetail | None = None
    if raw_detail in {"auto", "low", "high", "original"}:
        detail = raw_detail
    return ResponsesFunctionCallOutputImageItem(
        image_url=image_url,
        detail=detail,
    )


@dataclass(slots=True, frozen=True)
class ResponsesMessageInputItem:
    role: MessageRole
    content: tuple[ResponsesTextContentItem, ...]

    def to_wire(self) -> dict[str, object]:
        return {
            "role": self.role,
            "content": [item.to_wire() for item in self.content],
        }


@dataclass(slots=True, frozen=True)
class ResponsesFunctionCallInputItem:
    name: str
    arguments: str
    call_id: str

    def to_wire(self) -> dict[str, object]:
        return {
            "type": "function_call",
            "name": self.name,
            "arguments": self.arguments,
            "call_id": self.call_id,
        }


@dataclass(slots=True, frozen=True)
class ResponsesFunctionCallOutputInputItem:
    call_id: str
    output: ResponsesFunctionCallOutputPayload

    def to_wire(self) -> dict[str, object]:
        return {
            "type": "function_call_output",
            "call_id": self.call_id,
            "output": self.output.to_wire_output(),
        }


@dataclass(slots=True, frozen=True)
class ResponsesReasoningOutputItem:
    provider_id: str | None
    summaries: tuple[str, ...]
    status: str | None = None


@dataclass(slots=True, frozen=True)
class ResponsesMessageOutputItem:
    provider_id: str | None
    role: str
    texts: tuple[str, ...]
    status: str | None = None


@dataclass(slots=True, frozen=True)
class ResponsesFunctionCallOutputItem:
    provider_id: str | None
    name: str
    arguments: str
    call_id: str
    status: str | None = None


@dataclass(slots=True, frozen=True)
class ResponsesMcpCallOutputItem:
    provider_id: str | None
    name: str
    arguments: str | None
    output: str | None
    status: str | None = None


@dataclass(slots=True, frozen=True)
class ResponsesUnknownOutputItem:
    provider_id: str | None
    item_type: str
    raw_item: dict[str, object]


@dataclass(slots=True, frozen=True)
class ResponsesReasoningSummaryTextDeltaEvent:
    item_id: str | None
    delta: str


@dataclass(slots=True, frozen=True)
class ResponsesOutputTextDeltaEvent:
    item_id: str | None
    delta: str


@dataclass(slots=True, frozen=True)
class ResponsesInProgressEvent:
    response_id: str | None = None


@dataclass(slots=True, frozen=True)
class ResponsesOutputItemAddedEvent:
    item_id: str
    item_type: str
    name: str | None = None
    call_id: str | None = None
    arguments: str | None = None


@dataclass(slots=True, frozen=True)
class ResponsesFunctionCallArgumentsDeltaEvent:
    item_id: str
    delta: str


@dataclass(slots=True, frozen=True)
class ResponsesFunctionCallArgumentsDoneEvent:
    item_id: str
    name: str | None
    arguments: str | None
    call_id: str | None


@dataclass(slots=True, frozen=True)
class ResponsesOutputItemDoneEvent:
    item_id: str | None
    item_type: str
    name: str | None = None
    call_id: str | None = None
    arguments: str | None = None
    status: str | None = None
    raw_item: dict[str, object] = field(default_factory=dict, compare=False)


@dataclass(slots=True, frozen=True)
class ResponsesMcpCallCompletedEvent:
    item_id: str | None
    name: str
    arguments: str | None
    output: str | None


@dataclass(slots=True, frozen=True)
class ResponsesCompletedEvent:
    response_id: str | None
    response_status: str | None
    usage: dict[str, object] | None = None


@dataclass(slots=True, frozen=True)
class ResponsesFailedEvent:
    response_id: str | None
    response_status: str | None
    error_message: str | None
    error_code: str | None


@dataclass(slots=True, frozen=True)
class ResponsesUnknownEvent:
    event_type: str
    raw_event: dict[str, object]


ResponsesStreamEvent = (
    ResponsesReasoningSummaryTextDeltaEvent
    | ResponsesOutputTextDeltaEvent
    | ResponsesInProgressEvent
    | ResponsesOutputItemAddedEvent
    | ResponsesFunctionCallArgumentsDeltaEvent
    | ResponsesFunctionCallArgumentsDoneEvent
    | ResponsesOutputItemDoneEvent
    | ResponsesMcpCallCompletedEvent
    | ResponsesCompletedEvent
    | ResponsesFailedEvent
    | ResponsesUnknownEvent
)


@dataclass(slots=True, frozen=True)
class ResponsesCapabilityProfile:
    supports_reasoning: bool = True
    supports_reasoning_summaries: bool = True
    supports_parallel_tool_calls: bool = False
    supports_previous_response_id: bool = False
    requires_assistant_output_text: bool = True
    disallows_empty_function_call_output: bool = False
    stream_max_retries: int = 2
    supports_stream_fallback_to_create: bool = True

    @classmethod
    def for_base_url(cls, base_url: str) -> "ResponsesCapabilityProfile":
        host = urlparse(base_url).netloc.lower()
        if "dashscope.aliyuncs.com" in host:
            return cls(
                supports_reasoning=True,
                supports_reasoning_summaries=True,
                supports_parallel_tool_calls=False,
                supports_previous_response_id=True,
                requires_assistant_output_text=True,
                disallows_empty_function_call_output=True,
                stream_max_retries=2,
                supports_stream_fallback_to_create=True,
            )
        return cls()

    @classmethod
    def for_provider(
        cls,
        *,
        provider: ProviderId,
        base_url: str,
    ) -> "ResponsesCapabilityProfile":
        profile = cls.for_base_url(base_url)
        if provider in {ProviderId.OPENAI, ProviderId.CODEX}:
            return cls(
                supports_reasoning=profile.supports_reasoning,
                supports_reasoning_summaries=profile.supports_reasoning_summaries,
                supports_parallel_tool_calls=True,
                supports_previous_response_id=profile.supports_previous_response_id,
                requires_assistant_output_text=profile.requires_assistant_output_text,
                disallows_empty_function_call_output=(
                    profile.disallows_empty_function_call_output
                ),
                stream_max_retries=profile.stream_max_retries,
                supports_stream_fallback_to_create=(
                    profile.supports_stream_fallback_to_create
                ),
            )
        return profile

    def to_dict(self) -> dict[str, object]:
        return {
            "supports_reasoning": self.supports_reasoning,
            "supports_reasoning_summaries": self.supports_reasoning_summaries,
            "supports_parallel_tool_calls": self.supports_parallel_tool_calls,
            "supports_previous_response_id": self.supports_previous_response_id,
            "requires_assistant_output_text": self.requires_assistant_output_text,
            "disallows_empty_function_call_output": self.disallows_empty_function_call_output,
            "stream_max_retries": self.stream_max_retries,
            "supports_stream_fallback_to_create": self.supports_stream_fallback_to_create,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> "ResponsesCapabilityProfile":
        raw_stream_max_retries = payload.get("stream_max_retries", 2)
        stream_max_retries = (
            raw_stream_max_retries
            if isinstance(raw_stream_max_retries, int)
            else 2
        )
        return cls(
            supports_reasoning=bool(payload.get("supports_reasoning", True)),
            supports_reasoning_summaries=bool(payload.get("supports_reasoning_summaries", True)),
            supports_parallel_tool_calls=bool(payload.get("supports_parallel_tool_calls", False)),
            supports_previous_response_id=bool(payload.get("supports_previous_response_id", True)),
            requires_assistant_output_text=bool(payload.get("requires_assistant_output_text", True)),
            disallows_empty_function_call_output=bool(payload.get("disallows_empty_function_call_output", False)),
            stream_max_retries=max(0, stream_max_retries),
            supports_stream_fallback_to_create=bool(
                payload.get("supports_stream_fallback_to_create", True)
            ),
        )


@dataclass(slots=True, frozen=True)
class ResponsesContinuationState:
    response_id: str | None
    request_signature: str
    request_input: tuple[dict[str, object], ...] = field(default_factory=tuple)
    response_output: tuple[dict[str, object], ...] = field(default_factory=tuple)
    eligible: bool = True
    failure_reason: str | None = None

    def baseline_input(self) -> tuple[dict[str, object], ...]:
        return self.request_input + self.response_output

    def to_dict(self) -> dict[str, object]:
        return {
            "response_id": self.response_id,
            "request_signature": self.request_signature,
            "request_input": [dict(item) for item in self.request_input],
            "response_output": [dict(item) for item in self.response_output],
            "eligible": self.eligible,
            "failure_reason": self.failure_reason,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> "ResponsesContinuationState":
        raw_request_input = payload.get("request_input", [])
        raw_response_output = payload.get("response_output", [])
        request_input = raw_request_input if isinstance(raw_request_input, list) else []
        response_output = raw_response_output if isinstance(raw_response_output, list) else []
        return cls(
            response_id=_optional_str(payload.get("response_id")),
            request_signature=str(payload.get("request_signature", "")),
            request_input=tuple(item for item in request_input if isinstance(item, dict)),
            response_output=tuple(item for item in response_output if isinstance(item, dict)),
            eligible=bool(payload.get("eligible", True)),
            failure_reason=_optional_str(payload.get("failure_reason")),
        )


def parse_responses_output_item(item: dict[str, object]) -> (
    ResponsesReasoningOutputItem
    | ResponsesMessageOutputItem
    | ResponsesFunctionCallOutputItem
    | ResponsesMcpCallOutputItem
    | ResponsesUnknownOutputItem
):
    item_type = str(item.get("type", ""))
    provider_id = _optional_str(item.get("id"))
    status = _optional_str(item.get("status"))
    if item_type == "reasoning":
        summaries: list[str] = []
        raw_summary = item.get("summary", [])
        if isinstance(raw_summary, list):
            for summary_item in raw_summary:
                if not isinstance(summary_item, dict):
                    continue
                if summary_item.get("type") != "summary_text":
                    continue
                text = summary_item.get("text")
                if isinstance(text, str) and text:
                    summaries.append(text)
        return ResponsesReasoningOutputItem(provider_id=provider_id, summaries=tuple(summaries), status=status)
    if item_type == "message":
        texts: list[str] = []
        raw_content = item.get("content", [])
        if isinstance(raw_content, list):
            for content_item in raw_content:
                if not isinstance(content_item, dict):
                    continue
                if content_item.get("type") != "output_text":
                    continue
                text = content_item.get("text")
                if isinstance(text, str) and text:
                    texts.append(text)
        return ResponsesMessageOutputItem(
            provider_id=provider_id,
            role=str(item.get("role", "")),
            texts=tuple(texts),
            status=status,
        )
    if item_type == "function_call":
        return ResponsesFunctionCallOutputItem(
            provider_id=provider_id,
            name=str(item.get("name", "")),
            arguments=str(item.get("arguments", "")),
            call_id=str(item.get("call_id", provider_id or "")),
            status=status,
        )
    if item_type == "mcp_call":
        return ResponsesMcpCallOutputItem(
            provider_id=provider_id,
            name=str(item.get("name", "")),
            arguments=_optional_str(item.get("arguments")),
            output=_optional_str(item.get("output")),
            status=status,
        )
    return ResponsesUnknownOutputItem(
        provider_id=provider_id,
        item_type=item_type,
        raw_item=item,
    )


def parse_responses_stream_event(payload: dict[str, object]) -> ResponsesStreamEvent:
    event_type = str(payload.get("type", ""))
    if event_type == "response.reasoning_summary_text.delta":
        return ResponsesReasoningSummaryTextDeltaEvent(
            item_id=_optional_str(payload.get("item_id")),
            delta=str(payload.get("delta", "")),
        )
    if event_type == "response.output_text.delta":
        return ResponsesOutputTextDeltaEvent(
            item_id=_optional_str(payload.get("item_id")),
            delta=str(payload.get("delta", "")),
        )
    if event_type == "response.in_progress":
        response = payload.get("response", {})
        response_id = response.get("id") if isinstance(response, dict) else None
        return ResponsesInProgressEvent(response_id=_optional_str(response_id))
    if event_type == "response.output_item.added":
        item = payload.get("item", {})
        item_id = ""
        item_type = ""
        name = None
        call_id = None
        arguments = None
        if isinstance(item, dict):
            item_id = str(item.get("id", payload.get("item_id", "")))
            item_type = str(item.get("type", ""))
            name = _optional_str(item.get("name"))
            call_id = _optional_str(item.get("call_id"))
            arguments = _optional_str(item.get("arguments"))
        return ResponsesOutputItemAddedEvent(
            item_id=item_id,
            item_type=item_type,
            name=name,
            call_id=call_id,
            arguments=arguments,
        )
    if event_type == "response.function_call_arguments.delta":
        return ResponsesFunctionCallArgumentsDeltaEvent(
            item_id=str(payload.get("item_id", "")),
            delta=str(payload.get("delta", "")),
        )
    if event_type == "response.function_call_arguments.done":
        return ResponsesFunctionCallArgumentsDoneEvent(
            item_id=str(payload.get("item_id", "")),
            name=_optional_str(payload.get("name")),
            arguments=_optional_str(payload.get("arguments")),
            call_id=_optional_str(payload.get("call_id")),
        )
    if event_type == "response.output_item.done":
        item = payload.get("item", {})
        item_id = _optional_str(payload.get("item_id")) or ""
        item_type = ""
        name = None
        call_id = None
        arguments = None
        status = None
        if isinstance(item, dict):
            item_id = _optional_str(item.get("id")) or item_id
            item_type = str(item.get("type", ""))
            name = _optional_str(item.get("name"))
            call_id = _optional_str(item.get("call_id"))
            arguments = _optional_str(item.get("arguments"))
            status = _optional_str(item.get("status"))
        return ResponsesOutputItemDoneEvent(
            item_id=item_id,
            item_type=item_type,
            name=name,
            call_id=call_id,
            arguments=arguments,
            status=status,
            raw_item=dict(item) if isinstance(item, dict) else {},
        )
    if event_type == "response.mcp_call.completed":
        return ResponsesMcpCallCompletedEvent(
            item_id=_optional_str(payload.get("item_id")),
            name=str(payload.get("name", "")),
            arguments=_optional_str(payload.get("arguments")),
            output=_optional_str(payload.get("output")),
        )
    if event_type == "response.completed":
        response = payload.get("response", {})
        if isinstance(response, dict):
            usage = response.get("usage")
            return ResponsesCompletedEvent(
                response_id=_optional_str(response.get("id")),
                response_status=_optional_str(response.get("status")),
                usage=usage if isinstance(usage, dict) else None,
            )
        return ResponsesCompletedEvent(response_id=None, response_status=None, usage=None)
    if event_type == "response.failed":
        response = payload.get("response", {})
        error = response.get("error", {}) if isinstance(response, dict) else {}
        return ResponsesFailedEvent(
            response_id=_optional_str(response.get("id")) if isinstance(response, dict) else None,
            response_status=_optional_str(response.get("status")) if isinstance(response, dict) else None,
            error_message=_optional_str(error.get("message")) if isinstance(error, dict) else None,
            error_code=_optional_str(error.get("code")) if isinstance(error, dict) else None,
        )
    return ResponsesUnknownEvent(event_type=event_type, raw_event=payload)


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None
