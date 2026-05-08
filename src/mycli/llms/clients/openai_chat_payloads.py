from __future__ import annotations

import ast
import json
from typing import cast

from mycli.llms.clients.openai_chat_errors import ModelResponseError

NATIVE_TOOL_ARGUMENTS_PARSE_ERROR = "Native tool call arguments were not valid JSON."


def decode_native_tool_call(
    raw_tool_call: dict[str, object],
    *,
    provider_metadata: dict[str, object],
) -> dict[str, object]:
    function_payload = raw_tool_call.get("function", {})
    if not isinstance(function_payload, dict):
        raise ModelResponseError("Native tool call function payload was invalid.")
    function_name = function_payload.get("name")
    if not isinstance(function_name, str) or not function_name.strip():
        raise ModelResponseError("Native tool call function name was invalid.")
    arguments_payload = function_payload.get("arguments", {})
    arguments, parse_metadata = decode_native_tool_arguments(arguments_payload)
    tool_call_payload: dict[str, object] = {
        "id": (
            None
            if raw_tool_call.get("id") is None
            else str(raw_tool_call["id"])
        ),
        "name": function_name,
        "arguments": arguments,
        "reason": "model requested tool",
    }
    metadata = {**provider_metadata, **parse_metadata}
    if metadata:
        tool_call_payload["metadata"] = metadata
    return tool_call_payload


def decode_native_tool_arguments(
    arguments_payload: object,
) -> tuple[dict[str, object], dict[str, object]]:
    if isinstance(arguments_payload, dict):
        return arguments_payload, {}
    if not isinstance(arguments_payload, str):
        return {}, {}

    raw_arguments = arguments_payload.strip()
    if not raw_arguments:
        return {}, {}

    for candidate in native_tool_argument_candidates(raw_arguments):
        loaded = load_native_tool_argument_candidate(candidate)
        if isinstance(loaded, dict):
            return cast("dict[str, object]", loaded), {}

    return {}, {
        "native_tool_arguments_parse_error": NATIVE_TOOL_ARGUMENTS_PARSE_ERROR,
        "native_tool_arguments_raw": raw_arguments,
    }


def native_tool_argument_candidates(raw_arguments: str) -> tuple[str, ...]:
    candidates = [raw_arguments]
    if raw_arguments.startswith("```") and raw_arguments.endswith("```"):
        lines = raw_arguments.splitlines()
        if len(lines) >= 3:
            candidates.append("\n".join(lines[1:-1]).strip())
    object_start = raw_arguments.find("{")
    object_end = raw_arguments.rfind("}")
    if 0 <= object_start < object_end:
        candidates.append(raw_arguments[object_start : object_end + 1])
    return tuple(dict.fromkeys(candidate for candidate in candidates if candidate))


def load_native_tool_argument_candidate(candidate: str) -> object:
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass
    try:
        return ast.literal_eval(candidate)
    except (SyntaxError, ValueError):
        return None


def with_response_metadata(
    payload: dict[str, object],
    *,
    provider_metadata: dict[str, object],
    response_payload: dict[str, object],
) -> dict[str, object]:
    if provider_metadata:
        payload["metadata"] = provider_metadata
    response_id = response_payload.get("id")
    if isinstance(response_id, str) and response_id:
        payload["response_id"] = response_id
    usage = response_payload.get("usage")
    if isinstance(usage, dict):
        payload["usage"] = usage
    return payload
