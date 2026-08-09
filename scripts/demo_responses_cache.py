#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Literal, Protocol, TypedDict, cast

from openai import OpenAI, OpenAIError
from openai.types.responses.function_tool_param import FunctionToolParam
from openai.types.responses.response_input_param import (
    Message,
    ResponseInputItemParam,
    ResponseInputParam,
)
from openai.types.responses.tool_choice_options import ToolChoiceOptions
from openai.types.responses.tool_param import ToolParam
from openai.types.shared_params.responses_model import ResponsesModel


DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-5.4"
DEFAULT_ATTEMPTS = 6
DEFAULT_DELAY_SECONDS = 0.5
PROMPT_CACHE_KEY = "mycli-responses-streaming-cache-demo-v1"
STABLE_PREFIX_LINE = (
    "Stable mycli streaming cache context: keep this instruction prefix, model, and "
    "tool schema identical so the provider can reuse the prompt prefix."
)
DEMO_TOOLS: list[FunctionToolParam] = [
    {
        "type": "function",
        "name": "emit_marker",
        "description": "Return a marker string for the Responses cache demo.",
        "parameters": {
            "type": "object",
            "properties": {"marker": {"type": "string"}},
            "required": ["marker"],
            "additionalProperties": False,
        },
        "strict": True,
    }
]


class ResponseCreator(Protocol):
    def __call__(
        self,
        *,
        model: ResponsesModel,
        instructions: str,
        input: str | ResponseInputParam,
        tools: Iterable[ToolParam],
        tool_choice: ToolChoiceOptions,
        prompt_cache_key: str,
        max_output_tokens: int,
        store: bool,
        stream: Literal[True],
    ) -> Iterable[object]: ...


class CacheProbeRequest(TypedDict):
    model: ResponsesModel
    instructions: str
    input: ResponseInputParam
    tools: list[FunctionToolParam]
    tool_choice: ToolChoiceOptions
    prompt_cache_key: str
    max_output_tokens: int
    store: bool
    stream: Literal[True]


@dataclass(frozen=True, slots=True)
class CacheUsage:
    input_tokens: int
    cached_tokens: int

    @property
    def hit_rate(self) -> float:
        if self.input_tokens <= 0:
            return 0.0
        return self.cached_tokens / self.input_tokens


@dataclass(frozen=True, slots=True)
class StreamCompletion:
    usage: CacheUsage
    output_items: tuple[ResponseInputItemParam, ...]


class StreamProtocolError(RuntimeError):
    pass


def stable_prefix(repeats: int = 180) -> str:
    return "\n".join(f"{index + 1}. {STABLE_PREFIX_LINE}" for index in range(repeats))


def user_message(round_index: int) -> Message:
    return {
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": (
                    f"Streaming cache turn {round_index}. Reply with exactly "
                    f"STREAM_CACHE_TURN_{round_index}. Do not call tools."
                ),
            }
        ],
    }


def build_request_body(
    *,
    model: str,
    input_items: ResponseInputParam,
) -> CacheProbeRequest:
    return {
        "model": model,
        "instructions": stable_prefix(),
        "input": list(input_items),
        "tools": DEMO_TOOLS,
        "tool_choice": "none",
        "prompt_cache_key": PROMPT_CACHE_KEY,
        "max_output_tokens": 64,
        "store": True,
        "stream": True,
    }


def _field(value: object, key: str) -> object:
    if isinstance(value, Mapping):
        return value.get(key)
    return getattr(value, key, None)


def _usage_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    return value if isinstance(value, int) else 0


def extract_cache_usage(response: object) -> CacheUsage:
    usage = _field(response, "usage")
    details = _field(usage, "input_tokens_details")
    return CacheUsage(
        input_tokens=_usage_int(_field(usage, "input_tokens")),
        cached_tokens=_usage_int(_field(details, "cached_tokens")),
    )


def _to_dict(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return {str(key): item for key, item in value.items()}
    for attribute in ("model_dump", "to_dict", "dict"):
        serializer = getattr(value, attribute, None)
        if not callable(serializer):
            continue
        payload = serializer()
        if isinstance(payload, dict):
            return {str(key): item for key, item in payload.items()}
    raise StreamProtocolError("Responses stream event was not a JSON object")


def consume_response_stream(
    stream: Iterable[object],
    *,
    emit_delta: Callable[[str], None],
) -> StreamCompletion:
    try:
        for raw_event in stream:
            event = _to_dict(raw_event)
            event_type = event.get("type")
            if event_type == "response.output_text.delta":
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    emit_delta(delta)
                continue
            if event_type != "response.completed":
                continue
            response = event.get("response")
            if not isinstance(response, dict):
                break
            raw_output = response.get("output")
            output_items = (
                tuple(
                    cast(ResponseInputItemParam, dict(item))
                    for item in raw_output
                    if isinstance(item, dict)
                )
                if isinstance(raw_output, list)
                else ()
            )
            return StreamCompletion(
                usage=extract_cache_usage(response),
                output_items=output_items,
            )
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            close()
    raise StreamProtocolError("Responses stream ended before response.completed")


def _print_delta(text: str) -> None:
    print(text, end="", flush=True)


def run_cache_probe(
    create_response: ResponseCreator,
    *,
    model: str,
    attempts: int,
    delay_seconds: float,
    emit: Callable[[str], None] = print,
    emit_delta: Callable[[str], None] = _print_delta,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    logical_input: ResponseInputParam = []
    for round_index in range(1, attempts + 1):
        logical_input.append(user_message(round_index))
        stream = create_response(**build_request_body(model=model, input_items=logical_input))
        completion = consume_response_stream(stream, emit_delta=emit_delta)
        logical_input.extend(completion.output_items)
        emit("")
        emit(
            f"turn={round_index} input_tokens={completion.usage.input_tokens} "
            f"cached_tokens={completion.usage.cached_tokens} "
            f"hit_rate={completion.usage.hit_rate:.1%}"
        )
        if round_index >= 2 and completion.usage.cached_tokens > 0:
            emit("CACHE HIT")
            return True
        if round_index < attempts and delay_seconds > 0:
            sleep(delay_seconds)
    emit("CACHE MISS: no positive cached_tokens value observed")
    return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Stream append-only Responses turns until provider prompt-cache telemetry "
            "reports a hit."
        )
    )
    parser.add_argument("--attempts", type=int, default=DEFAULT_ATTEMPTS)
    parser.add_argument("--delay-seconds", type=float, default=DEFAULT_DELAY_SECONDS)
    return parser


def main(
    argv: list[str] | None = None,
    *,
    environ: Mapping[str, str] = os.environ,
) -> int:
    args = build_parser().parse_args(argv)
    api_key = environ.get("OPENAI_API_KEY")
    if not api_key:
        print("error: OPENAI_API_KEY is required", file=sys.stderr)
        return 2
    if args.attempts < 2:
        print("error: --attempts must be at least 2", file=sys.stderr)
        return 2
    if args.delay_seconds < 0:
        print("error: --delay-seconds must be non-negative", file=sys.stderr)
        return 2

    client = OpenAI(
        api_key=api_key,
        base_url=environ.get("OPENAI_BASE_URL", DEFAULT_BASE_URL),
        max_retries=0,
    )
    try:
        hit = run_cache_probe(
            client.responses.create,
            model=environ.get("OPENAI_MODEL", DEFAULT_MODEL),
            attempts=args.attempts,
            delay_seconds=args.delay_seconds,
        )
    except (OpenAIError, StreamProtocolError) as exc:
        print(
            f"error: provider request failed ({type(exc).__name__})",
            file=sys.stderr,
        )
        return 1
    return 0 if hit else 1


if __name__ == "__main__":
    raise SystemExit(main())
