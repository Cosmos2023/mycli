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


DEFAULT_BASE_URL = "https://codex-gateway.example.invalid"
DEFAULT_MODEL = "gpt-5.4"
DEFAULT_TIMEOUT_SECONDS = 60.0


FUNCTION_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "emit_marker",
        "description": "Return a marker string back to the caller for cache probing.",
        "parameters": {
            "type": "object",
            "properties": {
                "marker": {
                    "type": "string",
                    "description": "The marker to echo back exactly.",
                }
            },
            "required": ["marker"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "summarize_marker",
        "description": "Summarize a marker in one short sentence.",
        "parameters": {
            "type": "object",
            "properties": {
                "marker": {
                    "type": "string",
                    "description": "The marker to summarize.",
                }
            },
            "required": ["marker"],
            "additionalProperties": False,
        },
    },
]

BUILTIN_TOOLS: list[dict[str, Any]] = [
    {
        "type": "web_search",
        "search_context_size": "low",
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
    tool_item_id: str | None = None
    call_id: str | None = None
    call_arguments: dict[str, Any] | None = None
    output_item_types: list[str] | None = None
    previous_response_id: str | None = None
    store: bool | None = None
    error_type: str | None = None
    error_message: str | None = None
    status_code: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "round_index": self.round_index,
            "ok": self.ok,
            "response_id": self.response_id,
            "cached_tokens": self.cached_tokens,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "output_text": self.output_text,
            "tool_name": self.tool_name,
            "tool_item_id": self.tool_item_id,
            "call_id": self.call_id,
            "call_arguments": self.call_arguments,
            "output_item_types": self.output_item_types,
            "previous_response_id": self.previous_response_id,
            "store": self.store,
            "error_type": self.error_type,
            "error_message": self.error_message,
            "status_code": self.status_code,
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Probe whether a Responses-compatible provider such as sub2api "
            "can surface prompt caching and tool-continuation cache behavior."
        )
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("MYCLI_BASE_URL")
        or DEFAULT_BASE_URL,
        help="Responses API base URL.",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("OPENAI_API_KEY") or os.environ.get("MYCLI_API_KEY"),
        help="API key. Defaults to OPENAI_API_KEY or MYCLI_API_KEY.",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("OPENAI_MODEL")
        or os.environ.get("MYCLI_MODEL")
        or DEFAULT_MODEL,
        help="Model name.",
    )
    parser.add_argument(
        "--text-rounds",
        type=int,
        default=3,
        help="How many text-only cache probe rounds to run.",
    )
    parser.add_argument(
        "--tool-rounds",
        type=int,
        default=2,
        help="How many tool continuation probe rounds to run.",
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
        default="sub2api-cache-probe-tools-v1",
        help="Stable prompt_cache_key used across requests.",
    )
    parser.add_argument(
        "--prompt-cache-retention",
        default=None,
        help="Optional prompt_cache_retention, for example in-memory or 24h.",
    )
    parser.add_argument(
        "--tool-choice-mode",
        choices=("auto", "required", "forced", "all"),
        default="all",
        help=(
            "How to request tools during tool rounds. "
            "'auto' leaves tool selection to the model, "
            "'required' forces at least one tool call, "
            "'forced' forces emit_marker specifically, "
            "'all' runs auto/required/forced sequentially."
        ),
    )
    parser.add_argument(
        "--tool-family",
        choices=("function", "builtin", "all"),
        default="all",
        help=(
            "Which tool family to probe. "
            "'function' checks custom function tools, "
            "'builtin' checks hosted web_search, "
            "'all' runs both."
        ),
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
    parser.add_argument(
        "--min-cache-hit-rate",
        type=float,
        default=None,
        help=(
            "Optional pass/fail threshold for cached_tokens / input_tokens across successful "
            "results. Accepts either 0.85 or 85."
        ),
    )
    return parser


def stable_prefix(repeats: int) -> str:
    line = (
        "Stable cache prefix block: keep these shared instructions identical across requests; "
        "tools, schema, and static framing must remain unchanged to maximize prompt caching."
    )
    return "\n".join(f"{index + 1}. {line}" for index in range(repeats))


def build_instructions(prefix: str) -> str:
    return (
        "You are a cache probe assistant. Follow the request exactly, be concise, "
        "and avoid extra commentary.\n"
        "Keep the stable prefix semantically unchanged across rounds. Use tools only "
        "when the request explicitly requires one. When a plain reply is requested, "
        "answer with the exact requested token and nothing else.\n"
        f"{prefix}"
    )


def build_text_probe_input(prefix: str, round_index: int) -> str:
    return (
        "Shared probe context:\n"
        f"{prefix}\n"
        f"Round {round_index}: reply with exactly CACHE-TEXT-{round_index}."
    )


def build_tool_probe_input(prefix: str, round_index: int) -> str:
    marker = f"CACHE-TOOL-{round_index}"
    return (
        "Shared probe context:\n"
        f"{prefix}\n"
        "Tool task:\n"
        "You must use the emit_marker function tool exactly once.\n"
        f"Required tool call: emit_marker(marker={json.dumps(marker, ensure_ascii=False)})\n"
        "Do not answer in plain text before the tool call.\n"
        "If tool calling is unavailable, reply with exactly NO_TOOL."
    )


def build_builtin_tool_probe_input(prefix: str, round_index: int) -> str:
    query = f"CACHE-WEB-{round_index}"
    return (
        "Shared probe context:\n"
        f"{prefix}\n"
        "Hosted tool task:\n"
        "You must use the built-in web search tool exactly once before answering.\n"
        f"Search query: {query}\n"
        "Do not answer in plain text before using web search.\n"
        "If hosted tool calling is unavailable, reply with exactly NO_TOOL."
    )


def output_item_types(payload: dict[str, Any]) -> list[str]:
    output = payload.get("output")
    if not isinstance(output, list):
        return []
    types: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if isinstance(item_type, str):
            types.append(item_type)
    return types


def output_text_from_response(payload: dict[str, Any]) -> str | None:
    output = payload.get("output")
    if not isinstance(output, list):
        return None
    fragments: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "message":
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


def first_function_call(
    payload: dict[str, Any],
) -> tuple[str | None, str | None, str | None, dict[str, Any] | None]:
    output = payload.get("output")
    if not isinstance(output, list):
        return None, None, None, None
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "function_call":
            continue
        raw_arguments = item.get("arguments")
        arguments: dict[str, Any] | None = None
        if isinstance(raw_arguments, str):
            try:
                loaded = json.loads(raw_arguments)
            except json.JSONDecodeError:
                loaded = None
            if isinstance(loaded, dict):
                arguments = loaded
        elif isinstance(raw_arguments, dict):
            arguments = raw_arguments
        return (
            item.get("name") if isinstance(item.get("name"), str) else None,
            item.get("id") if isinstance(item.get("id"), str) else None,
            item.get("call_id") if isinstance(item.get("call_id"), str) else None,
            arguments,
        )
    return None, None, None, None


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


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def save_continuation_sample(
    *,
    path: Path,
    model: str,
    instructions: str,
    tools: list[dict[str, Any]],
    max_output_tokens: int,
    prompt_cache_key: str,
    prompt_cache_retention: str | None,
    previous_response_id: str,
    tool_name: str | None,
    tool_item_id: str | None,
    call_id: str,
    tool_output: str,
) -> None:
    payload: dict[str, Any] = {
        "metadata": {
            "purpose": "Minimal continuation sample captured from a successful first-turn function_call.",
            "tool_name": tool_name,
            "tool_item_id": tool_item_id,
            "call_id": call_id,
            "previous_response_id": previous_response_id,
        },
        "request_body": {
            "model": model,
            "instructions": instructions,
            "previous_response_id": previous_response_id,
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": tool_output,
                }
            ],
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": False,
            "store": True,
            "max_output_tokens": max_output_tokens,
            "prompt_cache_key": prompt_cache_key,
        },
    }
    if prompt_cache_retention:
        payload["request_body"]["prompt_cache_retention"] = prompt_cache_retention
    save_json(path, payload)


def request_body_summary(body: dict[str, Any]) -> dict[str, Any]:
    input_items = body.get("input")
    input_count = len(input_items) if isinstance(input_items, list) else None
    input_roles: list[str] = []
    if isinstance(input_items, list):
        for item in input_items[:12]:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            if isinstance(role, str):
                input_roles.append(role)
                continue
            item_type = item.get("type")
            if isinstance(item_type, str):
                input_roles.append(item_type)
    return {
        "model": body.get("model"),
        "instructions_length": (
            len(body["instructions"]) if isinstance(body.get("instructions"), str) else None
        ),
        "previous_response_id": body.get("previous_response_id"),
        "store": body.get("store"),
        "input_type": type(input_items).__name__ if input_items is not None else None,
        "input_count": input_count,
        "input_preview": input_items[:200] if isinstance(input_items, str) else None,
        "input_roles_preview": input_roles,
        "tool_count": len(body.get("tools", [])) if isinstance(body.get("tools"), list) else None,
        "tool_types": [
            item.get("type")
            for item in body.get("tools", [])
            if isinstance(item, dict) and isinstance(item.get("type"), str)
        ] if isinstance(body.get("tools"), list) else None,
        "tool_choice": body.get("tool_choice"),
        "prompt_cache_key": body.get("prompt_cache_key"),
        "prompt_cache_retention": body.get("prompt_cache_retention"),
    }


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
        "max_output_tokens": max_output_tokens,
        "tools": tools,
        "prompt_cache_key": prompt_cache_key,
        "parallel_tool_calls": False,
    }
    if prompt_cache_retention:
        body["prompt_cache_retention"] = prompt_cache_retention
    return body


def tool_choice_payload(mode: str) -> str | dict[str, Any] | None:
    if mode == "auto":
        return "auto"
    if mode == "required":
        return "required"
    if mode == "forced":
        return {
            "type": "function",
            "name": "emit_marker",
        }
    return None


def selected_tool_choice_modes(mode: str) -> tuple[str, ...]:
    if mode == "all":
        return ("auto", "required", "forced")
    return (mode,)


def selected_tool_families(family: str) -> tuple[str, ...]:
    if family == "all":
        return ("function", "builtin")
    return (family,)


def tool_config(tool_family: str) -> tuple[list[dict[str, Any]], str]:
    if tool_family == "builtin":
        return BUILTIN_TOOLS, "web_search_call"
    return FUNCTION_TOOLS, "function_call"


def tool_choice_payload_for_family(
    *,
    tool_family: str,
    mode: str,
    tools: list[dict[str, Any]],
) -> str | dict[str, Any] | None:
    if tool_family == "builtin":
        if mode == "auto":
            return "auto"
        return {
            "type": "allowed_tools",
            "mode": "required",
            "tools": tools,
        }
    return tool_choice_payload(mode)


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
    if result.previous_response_id:
        print(f"  previous_response_id: {result.previous_response_id}")
    if result.tool_name or result.tool_item_id or result.call_id:
        print(
            "  tool_name: "
            f"{result.tool_name} "
            f"tool_item_id: {result.tool_item_id} "
            f"call_id: {result.call_id}"
        )
    if result.call_arguments:
        print(f"  call_arguments: {json.dumps(result.call_arguments, ensure_ascii=False)}")
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
    for round_index in range(1, rounds + 1):
        body = base_body(
            model=model,
            instructions=build_instructions(prefix),
            tools=FUNCTION_TOOLS,
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
                error_message=_error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
        print_result(result)
        results.append(result)
    return results


def run_tool_probe(
    client: OpenAI,
    *,
    model: str,
    prefix: str,
    rounds: int,
    max_output_tokens: int,
    prompt_cache_key: str,
    prompt_cache_retention: str | None,
    tool_family: str,
    tool_choice_mode: str,
    save_dir: Path | None,
) -> list[ProbeResult]:
    results: list[ProbeResult] = []
    tools, expected_tool_item_type = tool_config(tool_family)
    for round_index in range(1, rounds + 1):
        initial_body = base_body(
            model=model,
            instructions=build_instructions(prefix),
            tools=tools,
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
        )
        initial_body["store"] = True
        if tool_family == "builtin":
            initial_body["input"] = build_builtin_tool_probe_input(prefix, round_index)
        else:
            initial_body["input"] = build_tool_probe_input(prefix, round_index)
        tool_choice = tool_choice_payload_for_family(
            tool_family=tool_family,
            mode=tool_choice_mode,
            tools=tools,
        )
        if tool_choice is not None:
            initial_body["tool_choice"] = tool_choice
        try:
            initial_payload = call_responses_api(
                client,
                body=initial_body,
                save_dir=save_dir,
                artifact_name=f"tool-{tool_family}-{tool_choice_mode}-round-{round_index}-initial",
            )
        except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
            failure = ProbeResult(
                phase=f"tool-initial:{tool_family}:{tool_choice_mode}",
                round_index=round_index,
                ok=False,
                response_id=None,
                cached_tokens=None,
                input_tokens=None,
                output_tokens=None,
                output_text=None,
                error_type=type(exc).__name__,
                error_message=_error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
            print_result(failure)
            results.append(failure)
            continue

        tool_name, tool_item_id, call_id, arguments = first_function_call(initial_payload)
        initial_output_item_types = output_item_types(initial_payload)
        if tool_family == "builtin":
            ok = expected_tool_item_type in initial_output_item_types
            error_message = None if ok else f"No {expected_tool_item_type} returned."
        else:
            ok = call_id is not None
            error_message = None if call_id is not None else "No function_call returned."
        initial_result = ProbeResult(
            phase=f"tool-initial:{tool_family}:{tool_choice_mode}",
            round_index=round_index,
            ok=ok,
            response_id=initial_payload.get("id") if isinstance(initial_payload.get("id"), str) else None,
            cached_tokens=cached_tokens(initial_payload),
            input_tokens=usage_value(initial_payload, "input_tokens"),
            output_tokens=usage_value(initial_payload, "output_tokens"),
            output_text=output_text_from_response(initial_payload),
            tool_name=tool_name,
            tool_item_id=tool_item_id,
            call_id=call_id,
            call_arguments=arguments,
            output_item_types=initial_output_item_types,
            store=True,
            error_message=error_message,
        )
        print_result(initial_result)
        results.append(initial_result)

        if tool_family == "builtin":
            continue
        if call_id is None or initial_result.response_id is None:
            continue

        marker = None if arguments is None else arguments.get("marker")
        tool_output = marker if isinstance(marker, str) else f"CACHE-TOOL-{round_index}"
        if save_dir is not None:
            save_continuation_sample(
                path=save_dir
                / f"tool-{tool_family}-{tool_choice_mode}-round-{round_index}-continuation-sample.json",
                model=model,
                instructions=build_instructions(prefix),
                tools=tools,
                max_output_tokens=max_output_tokens,
                prompt_cache_key=prompt_cache_key,
                prompt_cache_retention=prompt_cache_retention,
                previous_response_id=initial_result.response_id,
                tool_name=tool_name,
                tool_item_id=tool_item_id,
                call_id=call_id,
                tool_output=tool_output,
            )
        followup_body = base_body(
            model=model,
            instructions=build_instructions(prefix),
            tools=tools,
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
        )
        followup_body["previous_response_id"] = initial_result.response_id
        followup_body["store"] = True
        followup_body["input"] = [
            {
                "type": "function_call_output",
                "call_id": call_id,
                "output": tool_output,
            }
        ]
        try:
            followup_payload = call_responses_api(
                client,
                body=followup_body,
                save_dir=save_dir,
                artifact_name=f"tool-{tool_family}-{tool_choice_mode}-round-{round_index}-followup",
            )
            followup_result = ProbeResult(
                phase=f"tool-followup:{tool_family}:{tool_choice_mode}",
                round_index=round_index,
                ok=True,
                response_id=followup_payload.get("id")
                if isinstance(followup_payload.get("id"), str)
                else None,
                cached_tokens=cached_tokens(followup_payload),
                input_tokens=usage_value(followup_payload, "input_tokens"),
                output_tokens=usage_value(followup_payload, "output_tokens"),
                output_text=output_text_from_response(followup_payload),
                tool_name=tool_name,
                call_id=call_id,
                output_item_types=output_item_types(followup_payload),
                previous_response_id=initial_result.response_id,
                store=True,
            )
        except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
            followup_result = ProbeResult(
                phase=f"tool-followup:{tool_family}:{tool_choice_mode}",
                round_index=round_index,
                ok=False,
                response_id=None,
                cached_tokens=None,
                input_tokens=None,
                output_tokens=None,
                output_text=None,
                tool_name=tool_name,
                call_id=call_id,
                previous_response_id=initial_result.response_id,
                store=True,
                error_type=type(exc).__name__,
                error_message=_error_message(exc),
                status_code=getattr(exc, "status_code", None),
            )
        print_result(followup_result)
        results.append(followup_result)
    return results


def _error_message(exc: Exception) -> str:
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


def cache_hit_rate(results: list[ProbeResult]) -> float:
    successful = [result for result in results if result.ok]
    input_total = sum(result.input_tokens or 0 for result in successful)
    cached_total = sum(result.cached_tokens or 0 for result in successful)
    if input_total <= 0:
        return 0.0
    return cached_total / input_total


def normalized_rate_threshold(value: float) -> float:
    if value > 1.0:
        return value / 100.0
    return value


def summarize(results: list[ProbeResult]) -> float:
    successful = [result for result in results if result.ok]
    positive_cache = [
        result
        for result in successful
        if isinstance(result.cached_tokens, int) and result.cached_tokens > 0
    ]
    print()
    print("Summary")
    print(f"  total_results: {len(results)}")
    print(f"  successful_results: {len(successful)}")
    print(f"  cache_hits_gt_zero: {len(positive_cache)}")
    if positive_cache:
        max_hit = max(result.cached_tokens or 0 for result in positive_cache)
        print(f"  max_cached_tokens: {max_hit}")
    else:
        print("  max_cached_tokens: 0")
    rate = cache_hit_rate(results)
    print(f"  cache_hit_rate: {rate:.2%}")
    return rate


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not args.api_key:
        parser.error("API key is required via --api-key or OPENAI_API_KEY / MYCLI_API_KEY.")

    save_dir = None if args.save_dir is None else Path(args.save_dir)
    prefix = stable_prefix(args.prefix_repeats)
    client = build_client(api_key=args.api_key, base_url=args.base_url)

    print("Cache probe configuration")
    print(f"  base_url: {args.base_url}")
    print(f"  model: {args.model}")
    print(f"  prompt_cache_key: {args.prompt_cache_key}")
    print(f"  prompt_cache_retention: {args.prompt_cache_retention or 'default'}")
    print(f"  function_tools_enabled: {len(FUNCTION_TOOLS)}")
    print(f"  builtin_tools_enabled: {len(BUILTIN_TOOLS)}")
    print(f"  tool_family: {args.tool_family}")
    print(f"  tool_choice_mode: {args.tool_choice_mode}")
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
    tool_choice_modes = selected_tool_choice_modes(args.tool_choice_mode)
    tool_families = selected_tool_families(args.tool_family)
    for family_index, tool_family in enumerate(tool_families):
        for mode_index, tool_choice_mode in enumerate(tool_choice_modes):
            results.extend(
                run_tool_probe(
                    client,
                    model=args.model,
                    prefix=prefix,
                    rounds=args.tool_rounds,
                    max_output_tokens=args.max_output_tokens,
                    prompt_cache_key=args.prompt_cache_key,
                    prompt_cache_retention=args.prompt_cache_retention,
                    tool_family=tool_family,
                    tool_choice_mode=tool_choice_mode,
                    save_dir=save_dir,
                )
            )
            last_mode = mode_index == len(tool_choice_modes) - 1
            last_family = family_index == len(tool_families) - 1
            if not (last_mode and last_family):
                time.sleep(args.sleep_seconds)
    rate = summarize(results)
    if args.min_cache_hit_rate is not None:
        threshold = normalized_rate_threshold(args.min_cache_hit_rate)
        if rate < threshold:
            print(
                f"Cache hit rate {rate:.2%} is below required threshold {threshold:.2%}.",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
