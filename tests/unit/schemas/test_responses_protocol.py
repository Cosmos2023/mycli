from __future__ import annotations

from mycli.domain.providers import ProviderId
from mycli.schemas.responses_protocol import (
    ResponsesCapabilityProfile,
    ResponsesCompletedEvent,
    ResponsesContinuationState,
    ResponsesFailedEvent,
    ResponsesFunctionCallInputItem,
    ResponsesFunctionCallOutputImageItem,
    ResponsesFunctionCallOutputInputItem,
    ResponsesFunctionCallOutputPayload,
    ResponsesFunctionCallOutputTextItem,
    ResponsesMessageInputItem,
    ResponsesOutputTextDeltaEvent,
    ResponsesTextContentItem,
    parse_responses_stream_event,
)


def test_responses_function_call_output_payload_round_trips_text_wire_value() -> None:
    payload = ResponsesFunctionCallOutputPayload.from_text(
        "Tool returned no output.",
        success=True,
    )

    assert payload.to_wire_output() == "Tool returned no output."
    assert payload.to_text() == "Tool returned no output."


def test_responses_function_call_output_payload_round_trips_structured_metadata() -> None:
    payload = ResponsesFunctionCallOutputPayload.from_wire_output(
        {"path": "README.md", "exists": True},
        success=True,
    )

    assert payload.to_text() == '{"path": "README.md", "exists": true}'
    assert payload.structured_content == ({"path": "README.md", "exists": True},)
    assert ResponsesFunctionCallOutputPayload.from_dict(payload.to_dict()) == payload


def test_responses_function_call_output_payload_prefers_content_items_on_wire() -> None:
    payload = ResponsesFunctionCallOutputPayload.from_content_items(
        (
            ResponsesFunctionCallOutputTextItem(text="bounded output"),
            ResponsesFunctionCallOutputImageItem(
                image_url="https://example.com/result.png",
                detail="high",
            ),
        ),
        fallback_text="bounded output\n[image: https://example.com/result.png]",
        success=True,
        structured_content=({"count": 2},),
    )

    assert payload.to_wire_output() == [
        {"type": "input_text", "text": "bounded output"},
        {
            "type": "input_image",
            "image_url": "https://example.com/result.png",
            "detail": "high",
        },
    ]
    assert payload.to_text() == "bounded output\n[image: https://example.com/result.png]"
    assert ResponsesFunctionCallOutputPayload.from_dict(payload.to_dict()) == payload


def test_responses_input_items_round_trip_to_wire_shape() -> None:
    items = (
        ResponsesMessageInputItem(
            role="assistant",
            content=(ResponsesTextContentItem(type="output_text", text="hello"),),
        ),
        ResponsesFunctionCallInputItem(
            name="read_file",
            arguments='{"path":"README.md"}',
            call_id="call_read_1",
        ),
        ResponsesFunctionCallOutputInputItem(
            call_id="call_read_1",
            output=ResponsesFunctionCallOutputPayload.from_text("README contents"),
        ),
    )

    assert [item.to_wire() for item in items] == [
        {
            "role": "assistant",
            "content": [{"type": "output_text", "text": "hello"}],
        },
        {
            "type": "function_call",
            "name": "read_file",
            "arguments": '{"path":"README.md"}',
            "call_id": "call_read_1",
        },
        {
            "type": "function_call_output",
            "call_id": "call_read_1",
            "output": "README contents",
        },
    ]


def test_parse_responses_stream_event_maps_completed_and_failed_events() -> None:
    completed = parse_responses_stream_event(
        {
            "type": "response.completed",
            "response": {
                "id": "resp_123",
                "status": "completed",
                "usage": {"output_tokens": 42},
            },
        }
    )
    failed = parse_responses_stream_event(
        {
            "type": "response.failed",
            "response": {
                "id": "resp_456",
                "status": "failed",
                "error": {"message": "bad request", "code": "server_error"},
            },
        }
    )

    assert completed == ResponsesCompletedEvent(
        response_id="resp_123",
        response_status="completed",
        usage={"output_tokens": 42},
    )
    assert failed == ResponsesFailedEvent(
        response_id="resp_456",
        response_status="failed",
        error_message="bad request",
        error_code="server_error",
    )


def test_parse_responses_stream_event_maps_text_delta() -> None:
    event = parse_responses_stream_event(
        {
            "type": "response.output_text.delta",
            "item_id": "msg_1",
            "delta": "hello",
        }
    )

    assert event == ResponsesOutputTextDeltaEvent(item_id="msg_1", delta="hello")


def test_responses_continuation_state_round_trips_dict_payload() -> None:
    state = ResponsesContinuationState(
        response_id="resp_123",
        request_signature='{"model":"gpt-test"}',
        request_input=(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
        ),
        response_output=(
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "done"}],
            },
        ),
        eligible=True,
        failure_reason=None,
    )

    assert ResponsesContinuationState.from_dict(state.to_dict()) == state


def test_responses_capability_profile_for_dashscope_supports_previous_response_id() -> None:
    profile = ResponsesCapabilityProfile.for_base_url(
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )

    assert profile.requires_assistant_output_text is True
    assert profile.disallows_empty_function_call_output is True
    assert profile.supports_previous_response_id is True
    assert profile.supports_parallel_tool_calls is False
    assert profile.stream_max_retries == 2
    assert profile.supports_stream_fallback_to_create is True


def test_responses_capability_profile_for_base_url_stays_provider_agnostic() -> None:
    profile = ResponsesCapabilityProfile.for_base_url("https://api.openai.com/v1")

    assert profile.supports_parallel_tool_calls is False


def test_responses_capability_profile_enables_parallel_tool_calls_for_codex_provider() -> None:
    profile = ResponsesCapabilityProfile.for_provider(
        provider=ProviderId.CODEX,
        base_url="https://codex-gateway.example.invalid/v1",
    )

    assert profile.supports_parallel_tool_calls is True


def test_responses_capability_profile_round_trips_retry_and_fallback_settings() -> None:
    profile = ResponsesCapabilityProfile(
        stream_max_retries=4,
        supports_stream_fallback_to_create=False,
    )

    assert ResponsesCapabilityProfile.from_dict(profile.to_dict()) == profile


def test_responses_capability_profile_defaults_to_assistant_output_text() -> None:
    profile = ResponsesCapabilityProfile()

    assert profile.requires_assistant_output_text is True
