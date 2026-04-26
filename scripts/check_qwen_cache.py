#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI


DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen3.6-plus"
DEFAULT_TIMEOUT_SECONDS = 60.0

FUNCTION_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "get_current_weather",
        "description": "Return weather information for a city.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City or district name, for example 北京市.",
                }
            },
            "required": ["location"],
            "additionalProperties": False,
        },
    }
]


@dataclass(slots=True)
class ProbeResult:
    phase: str
    round_index: int
    ok: bool
    response_id: str | None
    cached_tokens: int | None
    input_tokens: int | None
    output_tokens: int | None
    output_text: str | None
    tool_name: str | None = None
    call_id: str | None = None
    output_item_types: list[str] | None = None
    error_type: str | None = None
    error_message: str | None = None
    status_code: int | None = None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate whether Qwen on DashScope hits prompt cache for plain text "
            "requests and during function-tool continuation."
        )
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("DASHSCOPE_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or DEFAULT_BASE_URL,
        help="Responses API base URL.",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("DASHSCOPE_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("MYCLI_API_KEY"),
        help="API key. Defaults to DASHSCOPE_API_KEY / OPENAI_API_KEY / MYCLI_API_KEY.",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("DASHSCOPE_MODEL")
        or os.environ.get("OPENAI_MODEL")
        or DEFAULT_MODEL,
        help="Model name.",
    )
    parser.add_argument(
        "--text-rounds",
        type=int,
        default=3,
        help="How many plain-text cache probe rounds to run.",
    )
    parser.add_argument(
        "--tool-rounds",
        type=int,
        default=2,
        help="How many tool cache probe rounds to run.",
    )
    parser.add_argument(
        "--dialog-rounds",
        type=int,
        default=2,
        help="How many multi-turn dialog cache probe rounds to run.",
    )
    parser.add_argument(
        "--prefix-repeats",
        type=int,
        default=180,
        help="How many stable prefix lines to repeat to exceed the cache floor.",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=160,
        help="max_output_tokens passed to the provider.",
    )
    parser.add_argument(
        "--prompt-cache-key",
        default="qwen-cache-probe-v1",
        help="Stable prompt_cache_key used across requests.",
    )
    parser.add_argument(
        "--prompt-cache-retention",
        default=None,
        help="Optional prompt_cache_retention, for example in-memory or 24h.",
    )
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=0.5,
        help="Delay between rounds to keep requests near each other.",
    )
    parser.add_argument(
        "--save-dir",
        default=None,
        help="Optional directory to save JSON request and response artifacts.",
    )
    return parser


def stable_prefix(repeats: int) -> str:
    line = (
        "Stable cache prefix block: keep these shared instructions, tool schema, "
        "and framing identical across requests so prompt caching can be reused."
    )
    return "\n".join(f"{index + 1}. {line}" for index in range(repeats))


def build_instructions(prefix: str) -> str:
    return (
        "You are a cache probe assistant. Follow the request exactly and stay concise.\n"
        "Keep the stable prefix semantically unchanged across rounds.\n"
        "When asked to use a tool, call it before answering.\n"
        f"{prefix}"
    )


def build_text_probe_input(prefix: str, round_index: int) -> str:
    return (
        "Shared probe context:\n"
        f"{prefix}\n"
        f"Round {round_index}: reply with exactly CACHE-TEXT-{round_index}."
    )


def build_tool_probe_input(prefix: str, round_index: int) -> str:
    return (
        "Shared probe context:\n"
        f"{prefix}\n"
        "User question:\n"
        "北京天气咋样\n"
        "You must call get_current_weather exactly once before answering.\n"
        "Do not answer in plain text before the tool call."
    )


def dialog_turn_one_input(prefix: str, round_index: int) -> str:
    return (
        "Shared probe context:\n"
        f"{prefix}\n"
        f"Dialog round {round_index}: 请记住我的项目代号是 ALPHA-BEIJING。只回复：记住了。"
    )


def dialog_turn_two_input() -> str:
    return "我刚才让你记住的项目代号是什么？只回复代号本身。"


def usage_value(payload: dict[str, Any], key: str) -> int | None:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    value = usage.get(key)
    if isinstance(value, int):
        return value
    return None


def cached_tokens(payload: dict[str, Any]) -> int | None:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("input_tokens_details")
    if not isinstance(details, dict):
        return None
    value = details.get("cached_tokens")
    if isinstance(value, int):
        return value
    return None


def output_item_types(payload: dict[str, Any]) -> list[str]:
    output = payload.get("output")
    if not isinstance(output, list):
        return []
    item_types: list[str] = []
    for item in output:
        if isinstance(item, dict) and isinstance(item.get("type"), str):
            item_types.append(item["type"])
    return item_types


def output_text_from_response(payload: dict[str, Any]) -> str | None:
    output = payload.get("output")
    if not isinstance(output, list):
        return None
    fragments: list[str] = []
    for item in output:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        content_items = item.get("content")
        if not isinstance(content_items, list):
            continue
        for content_item in content_items:
            if not isinstance(content_item, dict):
                continue
            if content_item.get("type") != "output_text":
                continue
            text = content_item.get("text")
            if isinstance(text, str):
                fragments.append(text)
    if not fragments:
        return None
    return "".join(fragments)


def first_function_call(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    output = payload.get("output")
    if not isinstance(output, list):
        return None, None
    for item in output:
        if not isinstance(item, dict) or item.get("type") != "function_call":
            continue
        tool_name = item.get("name")
        call_id = item.get("call_id")
        if isinstance(tool_name, str) and isinstance(call_id, str):
            return tool_name, call_id
    return None, None


def to_dict(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    for attr in ("to_dict", "model_dump", "dict"):
        serializer = getattr(payload, attr, None)
        if callable(serializer):
            data = serializer()
            if isinstance(data, dict):
                return data
    raise TypeError("SDK response could not be converted to dict.")


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def request_body_summary(body: dict[str, Any]) -> dict[str, Any]:
    input_payload = body.get("input")
    return {
        "model": body.get("model"),
        "instructions_length": (
            len(body["instructions"]) if isinstance(body.get("instructions"), str) else None
        ),
        "previous_response_id": body.get("previous_response_id"),
        "store": body.get("store"),
        "input_type": type(input_payload).__name__ if input_payload is not None else None,
        "tool_count": len(body.get("tools", [])) if isinstance(body.get("tools"), list) else None,
        "tool_choice": body.get("tool_choice"),
        "prompt_cache_key": body.get("prompt_cache_key"),
        "prompt_cache_retention": body.get("prompt_cache_retention"),
    }


def call_responses_api(
    client: OpenAI,
    *,
    body: dict[str, Any],
    save_dir: Path | None,
    artifact_name: str,
) -> dict[str, Any]:
    if save_dir is not None:
        save_json(save_dir / f"{artifact_name}-request.json", request_body_summary(body))
    response = client.responses.create(**body)
    payload = to_dict(response)
    if save_dir is not None:
        save_json(save_dir / f"{artifact_name}-response.json", payload)
    return payload


def build_client(api_key: str, base_url: str) -> OpenAI:
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=DEFAULT_TIMEOUT_SECONDS,
        max_retries=0,
    )


def base_body(
    *,
    model: str,
    instructions: str,
    tools: list[dict[str, Any]],
    max_output_tokens: int,
    prompt_cache_key: str,
    prompt_cache_retention: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "instructions": instructions,
        "tools": tools,
        "parallel_tool_calls": False,
        "max_output_tokens": max_output_tokens,
        "prompt_cache_key": prompt_cache_key,
    }
    if prompt_cache_retention:
        body["prompt_cache_retention"] = prompt_cache_retention
    return body


def print_result(result: ProbeResult) -> None:
    status = "OK" if result.ok else "ERR"
    cached = "n/a" if result.cached_tokens is None else str(result.cached_tokens)
    input_tokens = "n/a" if result.input_tokens is None else str(result.input_tokens)
    output_tokens = "n/a" if result.output_tokens is None else str(result.output_tokens)
    print(
        f"[{status}] {result.phase} round={result.round_index} "
        f"cached_tokens={cached} input_tokens={input_tokens} output_tokens={output_tokens}"
    )
    if result.response_id:
        print(f"  response_id: {result.response_id}")
    if result.tool_name or result.call_id:
        print(f"  tool_name: {result.tool_name} call_id: {result.call_id}")
    if result.output_item_types:
        print(f"  output_item_types: {', '.join(result.output_item_types)}")
    if result.output_text:
        print(f"  output_text: {result.output_text}")
    if result.error_message:
        print(f"  error: {result.error_type} status={result.status_code} {result.error_message}")


def run_text_probe(
    client: OpenAI,
    *,
    model: str,
    prefix: str,
    rounds: int,
    max_output_tokens: int,
    prompt_cache_key: str,
    prompt_cache_retention: str | None,
    save_dir: Path | None,
) -> list[ProbeResult]:
    results: list[ProbeResult] = []
    instructions = build_instructions(prefix)
    for round_index in range(1, rounds + 1):
        body = base_body(
            model=model,
            instructions=instructions,
            tools=[],
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
        )
        body["input"] = build_text_probe_input(prefix, round_index)
        try:
            payload = call_responses_api(
                client,
                body=body,
                save_dir=save_dir,
                artifact_name=f"text-round-{round_index}",
            )
            result = ProbeResult(
                phase="text",
                round_index=round_index,
                ok=True,
                response_id=payload.get("id") if isinstance(payload.get("id"), str) else None,
                cached_tokens=cached_tokens(payload),
                input_tokens=usage_value(payload, "input_tokens"),
                output_tokens=usage_value(payload, "output_tokens"),
                output_text=output_text_from_response(payload),
                output_item_types=output_item_types(payload),
            )
        except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
            result = ProbeResult(
                phase="text",
                round_index=round_index,
                ok=False,
                response_id=None,
                cached_tokens=None,
                input_tokens=None,
                output_tokens=None,
                output_text=None,
                error_type=type(exc).__name__,
                error_message=error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
        print_result(result)
        results.append(result)
    return results


def fixed_weather_output() -> str:
    return "北京今天是晴天。"


def run_tool_probe(
    client: OpenAI,
    *,
    model: str,
    prefix: str,
    rounds: int,
    max_output_tokens: int,
    prompt_cache_key: str,
    prompt_cache_retention: str | None,
    save_dir: Path | None,
) -> list[ProbeResult]:
    results: list[ProbeResult] = []
    instructions = build_instructions(prefix)
    for round_index in range(1, rounds + 1):
        initial_body = base_body(
            model=model,
            instructions=instructions,
            tools=FUNCTION_TOOLS,
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
        )
        initial_body["input"] = build_tool_probe_input(prefix, round_index)
        initial_body["tool_choice"] = "auto"
        initial_body["store"] = True
        try:
            initial_payload = call_responses_api(
                client,
                body=initial_body,
                save_dir=save_dir,
                artifact_name=f"tool-round-{round_index}-initial",
            )
            tool_name, call_id = first_function_call(initial_payload)
            initial_result = ProbeResult(
                phase="tool-initial",
                round_index=round_index,
                ok=call_id is not None,
                response_id=initial_payload.get("id")
                if isinstance(initial_payload.get("id"), str)
                else None,
                cached_tokens=cached_tokens(initial_payload),
                input_tokens=usage_value(initial_payload, "input_tokens"),
                output_tokens=usage_value(initial_payload, "output_tokens"),
                output_text=output_text_from_response(initial_payload),
                tool_name=tool_name,
                call_id=call_id,
                output_item_types=output_item_types(initial_payload),
                error_message=None if call_id is not None else "No function_call returned.",
            )
        except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
            initial_result = ProbeResult(
                phase="tool-initial",
                round_index=round_index,
                ok=False,
                response_id=None,
                cached_tokens=None,
                input_tokens=None,
                output_tokens=None,
                output_text=None,
                error_type=type(exc).__name__,
                error_message=error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
        print_result(initial_result)
        results.append(initial_result)

        if not initial_result.ok or initial_result.call_id is None:
            continue

        raw_arguments = None
        output_items = initial_payload.get("output")
        if isinstance(output_items, list):
            for item in output_items:
                if not isinstance(item, dict) or item.get("type") != "function_call":
                    continue
                if item.get("call_id") != initial_result.call_id:
                    continue
                raw_arguments = item.get("arguments")
                break

        replay_body = base_body(
            model=model,
            instructions=instructions,
            tools=FUNCTION_TOOLS,
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
        )
        replay_body["input"] = [
            {
                "role": "user",
                "content": build_tool_probe_input(prefix, round_index),
            },
            {
                "type": "function_call",
                "name": initial_result.tool_name,
                "arguments": raw_arguments if isinstance(raw_arguments, str) else json.dumps(
                    {"location": "北京"},
                    ensure_ascii=False,
                ),
                "call_id": initial_result.call_id,
            },
            {
                "type": "function_call_output",
                "call_id": initial_result.call_id,
                "output": fixed_weather_output(),
            }
        ]
        replay_body["tool_choice"] = "auto"
        try:
            followup_payload = call_responses_api(
                client,
                body=replay_body,
                save_dir=save_dir,
                artifact_name=f"tool-round-{round_index}-replay",
            )
            followup_result = ProbeResult(
                phase="tool-replay",
                round_index=round_index,
                ok=True,
                response_id=followup_payload.get("id")
                if isinstance(followup_payload.get("id"), str)
                else None,
                cached_tokens=cached_tokens(followup_payload),
                input_tokens=usage_value(followup_payload, "input_tokens"),
                output_tokens=usage_value(followup_payload, "output_tokens"),
                output_text=output_text_from_response(followup_payload),
                tool_name=initial_result.tool_name,
                call_id=initial_result.call_id,
                output_item_types=output_item_types(followup_payload),
            )
        except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
            followup_result = ProbeResult(
                phase="tool-replay",
                round_index=round_index,
                ok=False,
                response_id=None,
                cached_tokens=None,
                input_tokens=None,
                output_tokens=None,
                output_text=None,
                tool_name=initial_result.tool_name,
                call_id=initial_result.call_id,
                error_type=type(exc).__name__,
                error_message=error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
        print_result(followup_result)
        results.append(followup_result)
    return results


def run_dialog_probe(
    client: OpenAI,
    *,
    model: str,
    prefix: str,
    rounds: int,
    max_output_tokens: int,
    prompt_cache_key: str,
    prompt_cache_retention: str | None,
    save_dir: Path | None,
) -> list[ProbeResult]:
    results: list[ProbeResult] = []
    instructions = build_instructions(prefix)
    for round_index in range(1, rounds + 1):
        turn_one_body = base_body(
            model=model,
            instructions=instructions,
            tools=[],
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
        )
        turn_one_body["input"] = dialog_turn_one_input(prefix, round_index)
        turn_one_body["store"] = True
        try:
            turn_one_payload = call_responses_api(
                client,
                body=turn_one_body,
                save_dir=save_dir,
                artifact_name=f"dialog-round-{round_index}-turn-1",
            )
            turn_one_result = ProbeResult(
                phase="dialog-turn-1",
                round_index=round_index,
                ok=True,
                response_id=turn_one_payload.get("id")
                if isinstance(turn_one_payload.get("id"), str)
                else None,
                cached_tokens=cached_tokens(turn_one_payload),
                input_tokens=usage_value(turn_one_payload, "input_tokens"),
                output_tokens=usage_value(turn_one_payload, "output_tokens"),
                output_text=output_text_from_response(turn_one_payload),
                output_item_types=output_item_types(turn_one_payload),
            )
        except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
            turn_one_result = ProbeResult(
                phase="dialog-turn-1",
                round_index=round_index,
                ok=False,
                response_id=None,
                cached_tokens=None,
                input_tokens=None,
                output_tokens=None,
                output_text=None,
                error_type=type(exc).__name__,
                error_message=error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
        print_result(turn_one_result)
        results.append(turn_one_result)

        if not turn_one_result.ok:
            continue

        turn_two_prev_body = base_body(
            model=model,
            instructions=instructions,
            tools=[],
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
        )
        turn_two_prev_body["previous_response_id"] = turn_one_result.response_id
        turn_two_prev_body["input"] = dialog_turn_two_input()
        turn_two_prev_body["store"] = True
        try:
            turn_two_prev_payload = call_responses_api(
                client,
                body=turn_two_prev_body,
                save_dir=save_dir,
                artifact_name=f"dialog-round-{round_index}-prev-turn-2",
            )
            turn_two_prev_result = ProbeResult(
                phase="dialog-prev-turn-2",
                round_index=round_index,
                ok=True,
                response_id=turn_two_prev_payload.get("id")
                if isinstance(turn_two_prev_payload.get("id"), str)
                else None,
                cached_tokens=cached_tokens(turn_two_prev_payload),
                input_tokens=usage_value(turn_two_prev_payload, "input_tokens"),
                output_tokens=usage_value(turn_two_prev_payload, "output_tokens"),
                output_text=output_text_from_response(turn_two_prev_payload),
                output_item_types=output_item_types(turn_two_prev_payload),
            )
        except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
            turn_two_prev_result = ProbeResult(
                phase="dialog-prev-turn-2",
                round_index=round_index,
                ok=False,
                response_id=None,
                cached_tokens=None,
                input_tokens=None,
                output_tokens=None,
                output_text=None,
                error_type=type(exc).__name__,
                error_message=error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
        print_result(turn_two_prev_result)
        results.append(turn_two_prev_result)

        replay_body = base_body(
            model=model,
            instructions=instructions,
            tools=[],
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
        )
        replay_body["input"] = [
            {
                "role": "user",
                "content": dialog_turn_one_input(prefix, round_index),
            },
            {
                "role": "assistant",
                "content": turn_one_result.output_text or "记住了。",
            },
            {
                "role": "user",
                "content": dialog_turn_two_input(),
            },
        ]
        try:
            replay_payload = call_responses_api(
                client,
                body=replay_body,
                save_dir=save_dir,
                artifact_name=f"dialog-round-{round_index}-replay-turn-2",
            )
            replay_result = ProbeResult(
                phase="dialog-replay-turn-2",
                round_index=round_index,
                ok=True,
                response_id=replay_payload.get("id")
                if isinstance(replay_payload.get("id"), str)
                else None,
                cached_tokens=cached_tokens(replay_payload),
                input_tokens=usage_value(replay_payload, "input_tokens"),
                output_tokens=usage_value(replay_payload, "output_tokens"),
                output_text=output_text_from_response(replay_payload),
                output_item_types=output_item_types(replay_payload),
            )
        except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
            replay_result = ProbeResult(
                phase="dialog-replay-turn-2",
                round_index=round_index,
                ok=False,
                response_id=None,
                cached_tokens=None,
                input_tokens=None,
                output_tokens=None,
                output_text=None,
                error_type=type(exc).__name__,
                error_message=error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
        print_result(replay_result)
        results.append(replay_result)
    return results


def error_message(exc: Exception) -> str:
    if isinstance(exc, APIStatusError):
        body = exc.body
        if isinstance(body, dict):
            error_payload = body.get("error")
            if isinstance(error_payload, dict):
                message = error_payload.get("message")
                if isinstance(message, str):
                    return message
            message = body.get("message")
            if isinstance(message, str):
                return message
            return json.dumps(body, ensure_ascii=False)
    return str(exc)


def summarize(results: list[ProbeResult]) -> None:
    grouped: dict[str, list[ProbeResult]] = {}
    for result in results:
        grouped.setdefault(result.phase, []).append(result)

    print()
    print("Summary")
    for phase, phase_results in grouped.items():
        positive_cache = [
            result
            for result in phase_results
            if result.ok and isinstance(result.cached_tokens, int) and result.cached_tokens > 0
        ]
        print(
            f"  {phase}: total={len(phase_results)} "
            f"ok={sum(1 for result in phase_results if result.ok)} "
            f"cache_hits_gt_zero={len(positive_cache)}"
        )
        if positive_cache:
            print(f"    max_cached_tokens={max(result.cached_tokens or 0 for result in positive_cache)}")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.api_key:
        parser.error("API key is required via --api-key or DASHSCOPE_API_KEY / OPENAI_API_KEY.")

    save_dir = None if args.save_dir is None else Path(args.save_dir)
    prefix = stable_prefix(args.prefix_repeats)
    client = build_client(api_key=args.api_key, base_url=args.base_url)

    print("Qwen cache probe configuration")
    print(f"  base_url: {args.base_url}")
    print(f"  model: {args.model}")
    print(f"  prompt_cache_key: {args.prompt_cache_key}")
    print(f"  prompt_cache_retention: {args.prompt_cache_retention or 'default'}")
    print(f"  stable_prefix_chars: {len(prefix)}")
    print()

    results: list[ProbeResult] = []
    results.extend(
        run_text_probe(
            client,
            model=args.model,
            prefix=prefix,
            rounds=args.text_rounds,
            max_output_tokens=args.max_output_tokens,
            prompt_cache_key=args.prompt_cache_key,
            prompt_cache_retention=args.prompt_cache_retention,
            save_dir=save_dir,
        )
    )
    time.sleep(args.sleep_seconds)
    results.extend(
        run_tool_probe(
            client,
            model=args.model,
            prefix=prefix,
            rounds=args.tool_rounds,
            max_output_tokens=args.max_output_tokens,
            prompt_cache_key=args.prompt_cache_key,
            prompt_cache_retention=args.prompt_cache_retention,
            save_dir=save_dir,
        )
    )
    time.sleep(args.sleep_seconds)
    results.extend(
        run_dialog_probe(
            client,
            model=args.model,
            prefix=prefix,
            rounds=args.dialog_rounds,
            max_output_tokens=args.max_output_tokens,
            prompt_cache_key=args.prompt_cache_key,
            prompt_cache_retention=args.prompt_cache_retention,
            save_dir=save_dir,
        )
    )
    summarize(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
