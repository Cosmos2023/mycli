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
from uuid import uuid4

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
    }
]


@dataclass(slots=True)
class RequestResult:
    mode: str
    request_index: int
    phase: str
    ok: bool
    response_id: str | None
    previous_response_id: str | None
    logical_input_items: int
    wire_input_items: int
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    output_item_types: list[str]
    function_call_names: list[str]
    request_artifact: str | None = None
    response_artifact: str | None = None
    error_type: str | None = None
    error_message: str | None = None
    status_code: int | None = None

    @property
    def cache_hit_rate(self) -> float:
        if self.input_tokens <= 0:
            return 0.0
        return self.cached_tokens / self.input_tokens

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "request_index": self.request_index,
            "phase": self.phase,
            "ok": self.ok,
            "response_id": self.response_id,
            "previous_response_id": self.previous_response_id,
            "logical_input_items": self.logical_input_items,
            "wire_input_items": self.wire_input_items,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "cache_hit_rate": self.cache_hit_rate,
            "output_item_types": self.output_item_types,
            "function_call_names": self.function_call_names,
            "request_artifact": self.request_artifact,
            "response_artifact": self.response_artifact,
            "error_type": self.error_type,
            "error_message": self.error_message,
            "status_code": self.status_code,
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Compare Codex-style Responses transport shapes: full append-only replay "
            "versus previous_response_id + delta input."
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
        help="API key. Prefer OPENAI_API_KEY or MYCLI_API_KEY to avoid shell history leaks.",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("OPENAI_MODEL") or os.environ.get("MYCLI_MODEL") or DEFAULT_MODEL,
        help="Model name.",
    )
    parser.add_argument(
        "--rounds",
        type=int,
        default=3,
        help="Number of tool-call rounds per mode.",
    )
    parser.add_argument(
        "--prefix-repeats",
        type=int,
        default=180,
        help="Stable instruction prefix repeat count.",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=160,
        help="max_output_tokens passed to the provider.",
    )
    parser.add_argument(
        "--prompt-cache-key",
        default=f"codex-responses-transport-probe-{uuid4().hex[:8]}",
        help="Stable prompt_cache_key shared by both modes in this run.",
    )
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=0.5,
        help="Delay between requests.",
    )
    parser.add_argument(
        "--mode",
        choices=("full_replay", "codex_delta", "both"),
        default="both",
        help="Which transport mode to run.",
    )
    parser.add_argument(
        "--save-dir",
        type=Path,
        default=None,
        help="Directory for raw request/response artifacts.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional JSON report path.",
    )
    return parser


def stable_prefix(repeats: int) -> str:
    line = (
        "Stable cache prefix for Responses transport probing. Keep this exact text, "
        "tools, model, schema, and prompt_cache_key unchanged across requests."
    )
    return "\n".join(f"{index + 1}. {line}" for index in range(repeats))


def build_instructions(prefix: str) -> str:
    return (
        "You are a cache probe assistant. Use emit_marker when explicitly requested. "
        "After a tool result, answer in one short sentence containing the marker.\n\n"
        f"{prefix}"
    )


def user_message(text: str) -> dict[str, Any]:
    return {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": text}],
    }


def tool_output(call_id: str, output: str) -> dict[str, Any]:
    return {
        "type": "function_call_output",
        "call_id": call_id,
        "output": output,
    }


def request_user_text(round_index: int, marker: str) -> str:
    return (
        f"Round {round_index}: call emit_marker exactly once with marker "
        f"{json.dumps(marker, ensure_ascii=False)}. Do not answer before the tool call."
    )


def base_body(
    *,
    model: str,
    instructions: str,
    max_output_tokens: int,
    prompt_cache_key: str,
) -> dict[str, Any]:
    return {
        "model": model,
        "instructions": instructions,
        "tools": FUNCTION_TOOLS,
        "tool_choice": {"type": "function", "name": "emit_marker"},
        "parallel_tool_calls": False,
        "store": True,
        "max_output_tokens": max_output_tokens,
        "prompt_cache_key": prompt_cache_key,
    }


def answer_body(
    *,
    model: str,
    instructions: str,
    max_output_tokens: int,
    prompt_cache_key: str,
) -> dict[str, Any]:
    body = base_body(
        model=model,
        instructions=instructions,
        max_output_tokens=max_output_tokens,
        prompt_cache_key=prompt_cache_key,
    )
    body["tool_choice"] = "auto"
    return body


def run_mode(
    *,
    client: OpenAI,
    mode: str,
    model: str,
    instructions: str,
    rounds: int,
    max_output_tokens: int,
    prompt_cache_key: str,
    sleep_seconds: float,
    save_dir: Path | None,
) -> list[RequestResult]:
    logical_input: list[dict[str, Any]] = []
    previous_response_id: str | None = None
    results: list[RequestResult] = []

    for round_index in range(1, rounds + 1):
        marker = f"CODEX-TRANSPORT-{mode.upper()}-{round_index}"
        user_item = user_message(request_user_text(round_index, marker))
        logical_input.append(user_item)

        call_body = base_body(
            model=model,
            instructions=instructions,
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
        )
        call_wire_input = [user_item] if mode == "codex_delta" and previous_response_id else logical_input
        call_body["input"] = call_wire_input
        if mode == "codex_delta" and previous_response_id:
            call_body["previous_response_id"] = previous_response_id

        call_result, call_payload = call_provider(
            client=client,
            mode=mode,
            phase=f"round-{round_index}-tool-call",
            request_index=len(results) + 1,
            body=call_body,
            logical_input_items=len(logical_input),
            save_dir=save_dir,
        )
        print_result(call_result)
        results.append(call_result)
        if not call_result.ok:
            break

        call_items = output_items(call_payload)
        logical_input.extend(call_items)
        function_call = first_function_call(call_items)
        previous_response_id = call_result.response_id
        if function_call is None or previous_response_id is None:
            break

        output_item = tool_output(function_call["call_id"], marker)
        logical_input.append(output_item)

        followup_body = answer_body(
            model=model,
            instructions=instructions,
            max_output_tokens=max_output_tokens,
            prompt_cache_key=prompt_cache_key,
        )
        followup_wire_input = (
            [output_item]
            if mode == "codex_delta" and previous_response_id
            else logical_input
        )
        followup_body["input"] = followup_wire_input
        if mode == "codex_delta" and previous_response_id:
            followup_body["previous_response_id"] = previous_response_id

        followup_result, followup_payload = call_provider(
            client=client,
            mode=mode,
            phase=f"round-{round_index}-tool-output",
            request_index=len(results) + 1,
            body=followup_body,
            logical_input_items=len(logical_input),
            save_dir=save_dir,
        )
        print_result(followup_result)
        results.append(followup_result)
        if not followup_result.ok:
            break

        logical_input.extend(output_items(followup_payload))
        previous_response_id = followup_result.response_id
        time.sleep(sleep_seconds)

    return results


def call_provider(
    *,
    client: OpenAI,
    mode: str,
    phase: str,
    request_index: int,
    body: dict[str, Any],
    logical_input_items: int,
    save_dir: Path | None,
) -> tuple[RequestResult, dict[str, Any]]:
    request_artifact = None
    response_artifact = None
    artifact_prefix = f"{mode}-{request_index:02d}-{phase}"
    if save_dir is not None:
        request_path = save_dir / f"{artifact_prefix}-request.json"
        save_json(request_path, sanitize_request(body, logical_input_items))
        request_artifact = str(request_path)
    try:
        response = client.responses.create(**body)
        payload = to_dict(response)
        if save_dir is not None:
            response_path = save_dir / f"{artifact_prefix}-response.json"
            save_json(response_path, payload)
            response_artifact = str(response_path)
        return (
            result_from_payload(
                mode=mode,
                phase=phase,
                request_index=request_index,
                body=body,
                logical_input_items=logical_input_items,
                payload=payload,
                request_artifact=request_artifact,
                response_artifact=response_artifact,
            ),
            payload,
        )
    except (APIConnectionError, APITimeoutError, APIStatusError) as exc:
        return (
            error_result(
                mode=mode,
                phase=phase,
                request_index=request_index,
                body=body,
                logical_input_items=logical_input_items,
                request_artifact=request_artifact,
                exc=exc,
            ),
            {},
        )


def result_from_payload(
    *,
    mode: str,
    phase: str,
    request_index: int,
    body: dict[str, Any],
    logical_input_items: int,
    payload: dict[str, Any],
    request_artifact: str | None,
    response_artifact: str | None,
) -> RequestResult:
    return RequestResult(
        mode=mode,
        request_index=request_index,
        phase=phase,
        ok=True,
        response_id=payload.get("id") if isinstance(payload.get("id"), str) else None,
        previous_response_id=optional_str(body.get("previous_response_id")),
        logical_input_items=logical_input_items,
        wire_input_items=list_len(body.get("input")),
        input_tokens=usage_int(payload, "input_tokens"),
        output_tokens=usage_int(payload, "output_tokens"),
        cached_tokens=cached_tokens(payload),
        output_item_types=[str(item.get("type")) for item in output_items(payload)],
        function_call_names=function_call_names(output_items(payload)),
        request_artifact=request_artifact,
        response_artifact=response_artifact,
    )


def error_result(
    *,
    mode: str,
    phase: str,
    request_index: int,
    body: dict[str, Any],
    logical_input_items: int,
    request_artifact: str | None,
    exc: Exception,
) -> RequestResult:
    return RequestResult(
        mode=mode,
        request_index=request_index,
        phase=phase,
        ok=False,
        response_id=None,
        previous_response_id=optional_str(body.get("previous_response_id")),
        logical_input_items=logical_input_items,
        wire_input_items=list_len(body.get("input")),
        input_tokens=0,
        output_tokens=0,
        cached_tokens=0,
        output_item_types=[],
        function_call_names=[],
        request_artifact=request_artifact,
        error_type=type(exc).__name__,
        error_message=error_message(exc),
        status_code=getattr(exc, "status_code", None),
    )


def output_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    output = payload.get("output")
    if not isinstance(output, list):
        return []
    return [dict(item) for item in output if isinstance(item, dict)]


def first_function_call(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    for item in items:
        if item.get("type") == "function_call" and isinstance(item.get("call_id"), str):
            return item
    return None


def function_call_names(items: list[dict[str, Any]]) -> list[str]:
    return [
        str(item["name"])
        for item in items
        if item.get("type") == "function_call" and isinstance(item.get("name"), str)
    ]


def usage_int(payload: dict[str, Any], key: str) -> int:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return 0
    value = usage.get(key)
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0


def cached_tokens(payload: dict[str, Any]) -> int:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return 0
    details = usage.get("input_tokens_details")
    if isinstance(details, dict):
        value = details.get("cached_tokens")
        if isinstance(value, int | float) and not isinstance(value, bool):
            return int(value)
    for key in ("prompt_cache_hit_tokens", "cache_read_input_tokens", "cache_read_tokens"):
        value = usage.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool):
            return int(value)
    return 0


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


def sanitize_request(body: dict[str, Any], logical_input_items: int) -> dict[str, Any]:
    return {
        "body": body,
        "summary": {
            "previous_response_id_present": bool(body.get("previous_response_id")),
            "logical_input_items": logical_input_items,
            "wire_input_items": list_len(body.get("input")),
            "prompt_cache_key_present": bool(body.get("prompt_cache_key")),
        },
    }


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def list_len(value: object) -> int:
    return len(value) if isinstance(value, list) else 0


def error_message(exc: Exception) -> str:
    if isinstance(exc, APIStatusError):
        body = exc.body
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                return str(error["message"])
            return json.dumps(body, ensure_ascii=False)
    return str(exc)


def print_result(result: RequestResult) -> None:
    status = "OK" if result.ok else "ERR"
    print(
        f"[{status}] {result.mode} #{result.request_index} {result.phase} "
        f"prev={'yes' if result.previous_response_id else 'no'} "
        f"logical_items={result.logical_input_items} wire_items={result.wire_input_items} "
        f"cached={result.cached_tokens} input={result.input_tokens} "
        f"hit={result.cache_hit_rate:.1%} calls={','.join(result.function_call_names) or 'none'}"
    )
    if result.error_message:
        print(f"  error={result.error_type} status={result.status_code} {result.error_message}")


def summarize(results: list[RequestResult]) -> dict[str, Any]:
    by_mode: dict[str, dict[str, Any]] = {}
    for mode in sorted({result.mode for result in results}):
        mode_results = [result for result in results if result.mode == mode and result.ok]
        input_tokens = sum(result.input_tokens for result in mode_results)
        cached = sum(result.cached_tokens for result in mode_results)
        by_mode[mode] = {
            "request_count": len(mode_results),
            "input_tokens": input_tokens,
            "cached_tokens": cached,
            "cache_hit_rate": 0.0 if input_tokens <= 0 else cached / input_tokens,
            "previous_response_id_request_count": sum(
                1 for result in mode_results if result.previous_response_id
            ),
            "max_wire_input_items": max(
                (result.wire_input_items for result in mode_results),
                default=0,
            ),
            "max_logical_input_items": max(
                (result.logical_input_items for result in mode_results),
                default=0,
            ),
        }
    return by_mode


def build_client(api_key: str, base_url: str) -> OpenAI:
    return OpenAI(
        api_key=api_key,
        base_url=base_url.rstrip("/"),
        timeout=DEFAULT_TIMEOUT_SECONDS,
        max_retries=0,
    )


def selected_modes(mode: str) -> tuple[str, ...]:
    if mode == "both":
        return ("full_replay", "codex_delta")
    return (mode,)


def main() -> int:
    args = build_parser().parse_args()
    if not args.api_key:
        raise SystemExit("OPENAI_API_KEY or MYCLI_API_KEY is required.")

    prefix = stable_prefix(args.prefix_repeats)
    instructions = build_instructions(prefix)
    client = build_client(args.api_key, args.base_url)
    all_results: list[RequestResult] = []

    print("Codex-style Responses transport probe")
    print(f"  base_url: {args.base_url.rstrip('/')}")
    print(f"  model: {args.model}")
    print(f"  modes: {', '.join(selected_modes(args.mode))}")
    print(f"  prompt_cache_key: {args.prompt_cache_key}")
    print(f"  stable_prefix_chars: {len(prefix)}")
    print()

    for mode in selected_modes(args.mode):
        results = run_mode(
            client=client,
            mode=mode,
            model=args.model,
            instructions=instructions,
            rounds=args.rounds,
            max_output_tokens=args.max_output_tokens,
            prompt_cache_key=args.prompt_cache_key,
            sleep_seconds=args.sleep_seconds,
            save_dir=args.save_dir,
        )
        all_results.extend(results)
        if mode != selected_modes(args.mode)[-1]:
            time.sleep(args.sleep_seconds)

    report = {
        "base_url": args.base_url.rstrip("/"),
        "model": args.model,
        "rounds": args.rounds,
        "prompt_cache_key": args.prompt_cache_key,
        "results": [result.to_dict() for result in all_results],
        "summary": summarize(all_results),
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"report={args.output}")

    print()
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    return 0 if all(result.ok for result in all_results) else 1


if __name__ == "__main__":
    sys.exit(main())
