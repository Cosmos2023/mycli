from __future__ import annotations

import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest


_SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "demo_responses_cache.py"
_SPEC = spec_from_file_location("demo_responses_cache", _SCRIPT_PATH)
assert _SPEC is not None
assert _SPEC.loader is not None
_MODULE = module_from_spec(_SPEC)
sys.modules["demo_responses_cache"] = _MODULE
_SPEC.loader.exec_module(_MODULE)

StreamProtocolError = _MODULE.StreamProtocolError
build_request_body = _MODULE.build_request_body
consume_response_stream = _MODULE.consume_response_stream
extract_cache_usage = _MODULE.extract_cache_usage
main = _MODULE.main
run_cache_probe = _MODULE.run_cache_probe
user_message = _MODULE.user_message


def stream_events(*, cached_tokens: int, text: str) -> list[dict[str, Any]]:
    output = {
        "id": f"msg_{text}",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text}],
    }
    return [
        {"type": "response.output_text.delta", "delta": text},
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 2_048,
                    "input_tokens_details": {"cached_tokens": cached_tokens},
                },
                "output": [output],
            },
        },
    ]


class FakeResponses:
    def __init__(self, cached_tokens: list[int]) -> None:
        self._cached_tokens = iter(cached_tokens)
        self.calls: list[dict[str, Any]] = []

    def create(self, **body: Any) -> object:
        self.calls.append(body)
        turn_index = len(self.calls)
        return iter(
            stream_events(
                cached_tokens=next(self._cached_tokens),
                text=f"turn-{turn_index}",
            )
        )


class FakeClient:
    def __init__(self, cached_tokens: list[int]) -> None:
        self.responses = FakeResponses(cached_tokens)


def test_build_request_body_enables_streaming_without_continuation() -> None:
    input_items = [user_message(1)]

    body = build_request_body(model="gpt-test", input_items=input_items)
    input_items.append(user_message(2))

    assert body["model"] == "gpt-test"
    assert body["stream"] is True
    assert body["store"] is True
    assert body["tool_choice"] == "none"
    assert len(body["input"]) == 1
    assert "previous_response_id" not in body


def test_consume_stream_forwards_deltas_and_returns_completion() -> None:
    deltas: list[str] = []

    completion = consume_response_stream(
        iter(stream_events(cached_tokens=1_920, text="hello")),
        emit_delta=deltas.append,
    )

    assert deltas == ["hello"]
    assert completion.usage.input_tokens == 2_048
    assert completion.usage.cached_tokens == 1_920
    assert completion.usage.hit_rate == 0.9375
    assert completion.output_items[0]["type"] == "message"


def test_extract_cache_usage_reads_completed_response_mapping() -> None:
    response = {
        "usage": {
            "input_tokens": 2_048,
            "input_tokens_details": {"cached_tokens": 1_920},
        }
    }

    usage = extract_cache_usage(response)

    assert usage.input_tokens == 2_048
    assert usage.cached_tokens == 1_920


def test_run_cache_probe_uses_streaming_append_only_full_replay() -> None:
    client = FakeClient([0, 1_920, 1_920])
    lines: list[str] = []
    deltas: list[str] = []

    hit = run_cache_probe(
        client.responses.create,
        model="gpt-test",
        attempts=3,
        delay_seconds=0,
        emit=lines.append,
        emit_delta=deltas.append,
        sleep=lambda _seconds: None,
    )

    assert hit is True
    assert len(client.responses.calls) == 2
    assert all(call["stream"] is True for call in client.responses.calls)
    assert all("previous_response_id" not in call for call in client.responses.calls)
    assert len(client.responses.calls[0]["input"]) == 1
    assert len(client.responses.calls[1]["input"]) == 3
    assert deltas == ["turn-1", "turn-2"]
    assert lines[-1] == "CACHE HIT"


def test_run_cache_probe_fails_when_no_turn_hits_cache() -> None:
    client = FakeClient([0, 0])
    lines: list[str] = []

    hit = run_cache_probe(
        client.responses.create,
        model="gpt-test",
        attempts=2,
        delay_seconds=0,
        emit=lines.append,
        emit_delta=lambda _text: None,
        sleep=lambda _seconds: None,
    )

    assert hit is False
    assert len(client.responses.calls) == 2
    assert lines[-1] == "CACHE MISS: no positive cached_tokens value observed"


def test_consume_stream_rejects_missing_completed_event() -> None:
    with pytest.raises(StreamProtocolError, match="response.completed"):
        consume_response_stream(
            iter([{"type": "response.output_text.delta", "delta": "partial"}]),
            emit_delta=lambda _text: None,
        )


def test_main_rejects_missing_api_key(capsys: Any) -> None:
    exit_code = main([], environ={})

    assert exit_code == 2
    assert "OPENAI_API_KEY is required" in capsys.readouterr().err


def test_main_requires_at_least_two_streaming_turns(capsys: Any) -> None:
    exit_code = main(
        ["--attempts", "1"],
        environ={"OPENAI_API_KEY": "test-key"},
    )

    assert exit_code == 2
    assert "--attempts must be at least 2" in capsys.readouterr().err


def test_main_returns_success_after_streaming_cache_hit(monkeypatch: Any) -> None:
    fake_client = FakeClient([0, 1_920])
    monkeypatch.setattr(_MODULE, "OpenAI", lambda **_kwargs: fake_client)

    exit_code = main(
        ["--attempts", "2", "--delay-seconds", "0"],
        environ={"OPENAI_API_KEY": "test-key", "OPENAI_MODEL": "gpt-test"},
    )

    assert exit_code == 0


def test_main_reports_provider_failure(monkeypatch: Any, capsys: Any) -> None:
    fake_client = FakeClient([0])
    monkeypatch.setattr(_MODULE, "OpenAI", lambda **_kwargs: fake_client)

    def fail_probe(*_args: Any, **_kwargs: Any) -> bool:
        raise _MODULE.OpenAIError("provider unavailable")

    monkeypatch.setattr(_MODULE, "run_cache_probe", fail_probe)

    exit_code = main([], environ={"OPENAI_API_KEY": "test-key"})

    assert exit_code == 1
    assert "provider request failed (OpenAIError)" in capsys.readouterr().err
