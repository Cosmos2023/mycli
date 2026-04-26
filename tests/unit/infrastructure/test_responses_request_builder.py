from __future__ import annotations

from mycli.infrastructure.responses_request_builder import ResponsesRequestBuilder
from mycli.schemas.responses_protocol import ResponsesCapabilityProfile, ResponsesContinuationState


def test_responses_request_builder_uses_previous_response_id_when_input_is_strict_extension() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile(supports_previous_response_id=True)
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
        ),
        response_output=(
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I will inspect."}],
            },
        ),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I will inspect."}],
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "README.md",
            },
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort="medium",
        stream=True,
        continuation_state=state,
    )

    assert result.payload_body["previous_response_id"] == "resp_prev_1"
    assert result.payload_body["input"] == [
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "README.md",
        }
    ]
    assert result.used_previous_response_id == "resp_prev_1"
    assert result.continuation_decision == "used_previous_response_id"


def test_responses_request_builder_falls_back_to_full_create_when_signature_changes() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile(supports_previous_response_id=True)
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(),
        response_output=(),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[{"role": "user", "content": [{"type": "input_text", "text": "inspect"}]}],
        tools=[
            {
                "type": "function",
                "name": "list_directory",
                "description": "List entries in a directory",
                "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
            }
        ],
        max_output_tokens=128,
        reasoning_effort="medium",
        stream=True,
        continuation_state=state,
    )

    assert "previous_response_id" not in result.payload_body
    assert result.payload_body["input"] == [
        {"role": "user", "content": [{"type": "input_text", "text": "inspect"}]}
    ]
    assert result.used_previous_response_id is None
    assert result.continuation_decision == "signature_mismatch"


def test_responses_request_builder_uses_previous_response_id_for_tool_results_even_when_signature_changes() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile(supports_previous_response_id=True)
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
        ),
        response_output=(),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {"role": "system", "content": [{"type": "input_text", "text": "context changed"}]},
            {"type": "function_call_output", "call_id": "call_1", "output": "README.md"},
            {"role": "user", "content": [{"type": "input_text", "text": "continue"}]},
        ],
        tools=[
            {
                "type": "function",
                "name": "list_directory",
                "description": "List entries in a directory",
                "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
            }
        ],
        max_output_tokens=128,
        reasoning_effort="medium",
        stream=True,
        continuation_state=state,
    )

    assert result.payload_body["previous_response_id"] == "resp_prev_1"
    assert result.payload_body["store"] is True
    assert result.payload_body["input"] == [
        {"type": "function_call_output", "call_id": "call_1", "output": "README.md"},
        {"role": "user", "content": [{"type": "input_text", "text": "continue"}]},
    ]
    assert result.continuation_decision == "used_previous_response_id"


def test_responses_request_builder_normalizes_dashscope_compatibility_fields() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile(
            requires_assistant_output_text=True,
            disallows_empty_function_call_output=True,
        )
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {
                "role": "assistant",
                "content": [{"type": "input_text", "text": "hello"}],
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "",
            },
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort=None,
        stream=True,
    )

    assert result.payload_body["input"] == [
        {
            "role": "assistant",
            "content": [{"type": "output_text", "text": "hello"}],
        },
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "Tool returned no output.",
        },
    ]


def test_responses_request_builder_normalizes_assistant_content_by_default() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile()
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {
                "role": "assistant",
                "content": [{"type": "input_text", "text": "hello"}],
            }
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort=None,
        stream=True,
    )

    assert result.payload_body["input"] == [
        {
            "role": "assistant",
            "content": [{"type": "output_text", "text": "hello"}],
        }
    ]


def test_responses_request_builder_uses_previous_response_id_for_dashscope_profile() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile.for_base_url(
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        )
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
        ),
        response_output=(
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I will inspect."}],
            },
        ),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
            {
                "role": "assistant",
                "content": [{"type": "input_text", "text": "I will inspect."}],
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "",
            },
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort="medium",
        stream=True,
        continuation_state=state,
    )

    assert result.payload_body["previous_response_id"] == "resp_prev_1"
    assert result.payload_body["input"] == [
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "Tool returned no output.",
        }
    ]
    assert result.continuation_decision == "used_previous_response_id"


def test_responses_request_builder_reports_prefix_mismatch_when_input_is_not_strict_extension() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile(supports_previous_response_id=True)
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
        ),
        response_output=(
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I will inspect."}],
            },
        ),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {
                "role": "system",
                "content": [{"type": "input_text", "text": "context changed"}],
            },
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "different assistant reply"}],
            },
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort="medium",
        stream=True,
        continuation_state=state,
    )

    assert "previous_response_id" not in result.payload_body
    assert result.continuation_decision == "input_prefix_mismatch"


def test_responses_request_builder_sets_store_when_using_previous_response_id() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile(supports_previous_response_id=True)
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(
            {"role": "user", "content": [{"type": "input_text", "text": "inspect"}]},
        ),
        response_output=(
            {"role": "assistant", "content": [{"type": "output_text", "text": "I will inspect."}]},
        ),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {"role": "user", "content": [{"type": "input_text", "text": "inspect"}]},
            {"role": "assistant", "content": [{"type": "output_text", "text": "I will inspect."}]},
            {"type": "function_call_output", "call_id": "call_1", "output": "README.md"},
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort="medium",
        stream=True,
        continuation_state=state,
    )

    assert result.payload_body["store"] is True


def test_responses_request_builder_ignores_reasoning_effort_drift_for_continuation() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile(supports_previous_response_id=True)
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
        ),
        response_output=(
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I will inspect."}],
            },
        ),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "inspect"}],
            },
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I will inspect."}],
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "README.md",
            },
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort="high",
        stream=True,
        continuation_state=state,
    )

    assert result.payload_body["previous_response_id"] == "resp_prev_1"
    assert result.payload_body["input"] == [
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "README.md",
        }
    ]
    assert result.continuation_decision == "used_previous_response_id"


def test_responses_request_builder_uses_response_output_tail_when_seed_context_drifts() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile(supports_previous_response_id=True)
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(
            {
                "role": "system",
                "content": [{"type": "input_text", "text": "seed instructions"}],
            },
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "seed context v1"}],
            },
        ),
        response_output=(
            {
                "type": "function_call",
                "name": "list_directory",
                "arguments": "{\"path\":\".\"}",
                "call_id": "call_1",
            },
        ),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {
                "role": "system",
                "content": [{"type": "input_text", "text": "seed instructions"}],
            },
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "seed context v2"}],
            },
            {
                "type": "function_call",
                "name": "list_directory",
                "arguments": "{\"path\":\".\"}",
                "call_id": "call_1",
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "README.md",
            },
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort="medium",
        stream=True,
        continuation_state=state,
    )

    assert result.payload_body["previous_response_id"] == "resp_prev_1"
    assert result.payload_body["input"] == [
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "README.md",
        }
    ]
    assert result.continuation_decision == "used_previous_response_id"


def test_responses_request_builder_normalizes_state_response_output_for_cross_turn_tail_match() -> None:
    builder = ResponsesRequestBuilder(
        capability_profile=ResponsesCapabilityProfile.for_base_url(
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        )
    )
    state = ResponsesContinuationState(
        response_id="resp_prev_1",
        request_signature='{"max_output_tokens":128,"model":"gpt-test","stream":true,"tools":[]}',
        request_input=(
            {
                "role": "system",
                "content": [{"type": "input_text", "text": "seed"}],
            },
        ),
        response_output=(
            {
                "role": "assistant",
                "content": [
                    {"type": "input_text", "text": "**编程副"},
                    {"type": "input_text", "text": "驾**"},
                ],
            },
        ),
        eligible=True,
    )

    result = builder.build(
        model="gpt-test",
        input_items=[
            {
                "role": "system",
                "content": [{"type": "input_text", "text": "seed changed"}],
            },
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "**编程副驾**"}],
            },
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "继续"}],
            },
        ],
        tools=[],
        max_output_tokens=128,
        reasoning_effort="medium",
        stream=True,
        continuation_state=state,
    )

    assert result.payload_body["previous_response_id"] == "resp_prev_1"
    assert result.payload_body["input"] == [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "继续"}],
        }
    ]
    assert result.continuation_decision == "used_previous_response_id"
