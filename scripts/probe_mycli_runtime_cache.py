#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from mycli.cli.bootstrap import build_turn_service
from mycli.domain.runtime import TurnResponse
from mycli.schemas.responses_protocol import ResponsesCapabilityProfile


DEFAULT_BASE_URL = "https://codex-gateway.example.invalid"
DEFAULT_MODEL = "gpt-5.4"
DEFAULT_SESSION_ID = "mycli-runtime-cache-probe"


@dataclass(slots=True)
class ProviderUsage:
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    total_tokens: int

    @property
    def cache_hit_rate(self) -> float:
        if self.input_tokens <= 0:
            return 0.0
        return self.cached_tokens / self.input_tokens

    def to_dict(self) -> dict[str, object]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "total_tokens": self.total_tokens,
            "cache_hit_rate": self.cache_hit_rate,
        }


@dataclass(slots=True)
class ModelRequestProbe:
    index: int
    turn_id: str
    request_path: str
    response_path: str
    usage: ProviderUsage | None
    output_item_types: list[str]
    function_call_names: list[str]
    previous_response_id: str | None
    input_item_count: int
    tool_count: int
    prompt_cache_key_present: bool
    post_tool_context_as_developer: bool
    post_tool_context_as_tool_tag: bool

    @property
    def post_tool_context_present(self) -> bool:
        return self.post_tool_context_as_developer or self.post_tool_context_as_tool_tag

    def to_dict(self) -> dict[str, object]:
        return {
            "index": self.index,
            "turn_id": self.turn_id,
            "request_path": self.request_path,
            "response_path": self.response_path,
            "usage": None if self.usage is None else self.usage.to_dict(),
            "output_item_types": self.output_item_types,
            "function_call_names": self.function_call_names,
            "previous_response_id": self.previous_response_id,
            "input_item_count": self.input_item_count,
            "tool_count": self.tool_count,
            "prompt_cache_key_present": self.prompt_cache_key_present,
            "post_tool_context_as_developer": self.post_tool_context_as_developer,
            "post_tool_context_as_tool_tag": self.post_tool_context_as_tool_tag,
        }


@dataclass(slots=True)
class TurnProbe:
    index: int
    prompt: str
    assistant_preview: str
    pending_decision: bool
    activity_kinds: list[str]
    turn_item_types: list[str]
    tool_calls: list[str]
    tool_results: list[str]
    usage: ProviderUsage | None

    def to_dict(self) -> dict[str, object]:
        return {
            "index": self.index,
            "prompt": self.prompt,
            "assistant_preview": self.assistant_preview,
            "pending_decision": self.pending_decision,
            "activity_kinds": self.activity_kinds,
            "turn_item_types": self.turn_item_types,
            "tool_calls": self.tool_calls,
            "tool_results": self.tool_results,
            "usage": None if self.usage is None else self.usage.to_dict(),
        }


@dataclass(slots=True)
class TransportProbe:
    raw_request_count: int
    raw_previous_response_id_request_count: int
    raw_prompt_cache_key_request_count: int
    responses_request_event_count: int
    previous_response_id_attempt_count: int
    continuation_retry_count: int
    trace_event_counts: dict[str, int]

    def to_dict(self) -> dict[str, object]:
        return {
            "raw_request_count": self.raw_request_count,
            "raw_previous_response_id_request_count": (
                self.raw_previous_response_id_request_count
            ),
            "raw_prompt_cache_key_request_count": self.raw_prompt_cache_key_request_count,
            "responses_request_event_count": self.responses_request_event_count,
            "previous_response_id_attempt_count": self.previous_response_id_attempt_count,
            "continuation_retry_count": self.continuation_retry_count,
            "trace_event_counts": self.trace_event_counts,
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run mycli's real runtime against a Responses-compatible endpoint and "
            "summarize tool calls plus provider cache usage."
        )
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("MYCLI_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or DEFAULT_BASE_URL,
        help="OpenAI-compatible base URL. Defaults to MYCLI_BASE_URL, OPENAI_BASE_URL, or sub2api.",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("MYCLI_API_KEY") or os.environ.get("OPENAI_API_KEY"),
        help="API key. Defaults to MYCLI_API_KEY or OPENAI_API_KEY.",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("MYCLI_MODEL") or os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL,
        help="Model name.",
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path.cwd(),
        help="Workspace root used by mycli tools.",
    )
    parser.add_argument(
        "--home",
        type=Path,
        default=None,
        help="Home directory for probe state. Defaults to a temporary directory.",
    )
    parser.add_argument(
        "--session",
        default=f"{DEFAULT_SESSION_ID}-{uuid4().hex[:8]}",
        help="Session id for the probe.",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=512,
        help="MYCLI_MAX_OUTPUT_TOKENS for each model request.",
    )
    parser.add_argument(
        "--keep-home",
        action="store_true",
        help="Keep the temporary home directory after the probe.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional JSON report path.",
    )
    parser.add_argument(
        "--disable-previous-response-id",
        action="store_true",
        help=(
            "Experiment with Hermes-style replay by disabling Responses "
            "previous_response_id continuation for this probe run."
        ),
    )
    parser.add_argument(
        "--codex-http-responses",
        action="store_true",
        help=(
            "Use Codex's HTTP Responses strategy for this probe: full replay with "
            "stable prompt_cache_key and no previous_response_id."
        ),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not args.api_key:
        raise SystemExit("MYCLI_API_KEY or OPENAI_API_KEY is required.")

    workspace = args.workspace.resolve()
    temporary_home: Path | None = None
    if args.home is None:
        temporary_home = Path(tempfile.mkdtemp(prefix="mycli-runtime-cache-probe-"))
        home = temporary_home
    else:
        home = args.home.resolve()
        home.mkdir(parents=True, exist_ok=True)

    prompts = [
        (
            "Use the LS tool on the current workspace root, then answer with one short "
            "sentence containing the number of visible entries you saw."
        ),
        (
            "Use the Glob tool to list Python files under scripts, then answer with only "
            "the count and one representative path."
        ),
        (
            "Use the Read tool to inspect README.md, then answer with one sentence about "
            "what mycli is."
        ),
    ]

    use_codex_http_responses = bool(
        args.codex_http_responses or args.disable_previous_response_id
    )
    original_profile_factory = ResponsesCapabilityProfile.for_base_url
    if use_codex_http_responses:
        ResponsesCapabilityProfile.for_base_url = classmethod(  # type: ignore[method-assign]
            lambda cls, base_url: _without_previous_response_id(
                original_profile_factory(base_url)
            )
        )

    try:
        service = build_turn_service(
            {
                "model": args.model,
                "session": args.session,
            },
            cwd=workspace,
            home=home,
            env={
                **os.environ,
                "MYCLI_API_KEY": args.api_key,
                "MYCLI_BASE_URL": args.base_url.rstrip("/"),
                "MYCLI_PROVIDER": "openai",
                "MYCLI_PROTOCOL": "responses",
                "MYCLI_MODEL": args.model,
                "MYCLI_MAX_OUTPUT_TOKENS": str(args.max_output_tokens),
                "MYCLI_THINKING_ENABLED": "false",
                "MYCLI_MEMORY_ENABLED": "false",
                "MYCLI_STATUSLINE_ENABLED": "false",
                "MYCLI_HEARTBEAT_ENABLED": "false",
            },
        )
        probes: list[TurnProbe] = []
        try:
            for index, prompt in enumerate(prompts, start=1):
                response = service.handle_user_turn(prompt)
                probe = _probe_from_response(index, prompt, response)
                probes.append(probe)
                print(_render_turn_line(probe))
        finally:
            service.close()

        model_requests = _model_request_probes(home=home, session_id=args.session)
        transport_probe = _transport_probe(home=home, session_id=args.session)
        for request_probe in model_requests:
            print(_render_request_line(request_probe))
        report = {
            "session_id": args.session,
            "workspace": str(workspace),
            "home": str(home),
            "base_url": args.base_url.rstrip("/"),
            "model": args.model,
            "request_strategy": (
                "codex_http_responses"
                if args.codex_http_responses
                else (
                    "previous_response_id_disabled"
                    if args.disable_previous_response_id
                    else "mycli_default"
                )
            ),
            "codex_http_responses": args.codex_http_responses,
            "disable_previous_response_id": args.disable_previous_response_id,
            "turns": [probe.to_dict() for probe in probes],
            "model_requests": [probe.to_dict() for probe in model_requests],
            "transport": transport_probe.to_dict(),
            "summary": _summary(
                probes=probes,
                model_requests=model_requests,
                transport_probe=transport_probe,
            ),
        }
        output_path = args.output or workspace / ".mycli" / (
            f"{args.session}-runtime-cache-probe-report.json"
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"report={output_path}")
        print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
        return 0
    finally:
        ResponsesCapabilityProfile.for_base_url = original_profile_factory  # type: ignore[method-assign]
        if temporary_home is not None and not args.keep_home:
            shutil.rmtree(temporary_home, ignore_errors=True)


def _without_previous_response_id(
    profile: ResponsesCapabilityProfile,
) -> ResponsesCapabilityProfile:
    return ResponsesCapabilityProfile(
        supports_reasoning=profile.supports_reasoning,
        supports_reasoning_summaries=profile.supports_reasoning_summaries,
        supports_parallel_tool_calls=profile.supports_parallel_tool_calls,
        supports_previous_response_id=False,
        requires_assistant_output_text=profile.requires_assistant_output_text,
        disallows_empty_function_call_output=profile.disallows_empty_function_call_output,
        stream_max_retries=profile.stream_max_retries,
        supports_stream_fallback_to_create=profile.supports_stream_fallback_to_create,
    )


def _probe_from_response(
    index: int,
    prompt: str,
    response: TurnResponse,
) -> TurnProbe:
    turn_items = list(response.turn.items) if response.turn is not None else []
    usage = _last_usage(turn_items)
    return TurnProbe(
        index=index,
        prompt=prompt,
        assistant_preview=_preview(response.assistant_message),
        pending_decision=response.pending_decision is not None,
        activity_kinds=[event.kind for event in response.activity_events],
        turn_item_types=[item.type.value for item in turn_items],
        tool_calls=[
            item.tool_name or ""
            for item in turn_items
            if item.type.value == "tool_call" and item.tool_name
        ],
        tool_results=[
            item.tool_name or ""
            for item in turn_items
            if item.type.value == "tool_result" and item.tool_name
        ],
        usage=usage,
    )


def _last_usage(turn_items: list[Any]) -> ProviderUsage | None:
    for item in reversed(turn_items):
        if item.type.value != "model_usage":
            continue
        usage = item.metadata.get("provider_usage")
        if not isinstance(usage, dict):
            continue
        input_tokens = _usage_int(usage, "input_tokens") or _usage_int(usage, "prompt_tokens")
        output_tokens = _usage_int(usage, "output_tokens") or _usage_int(usage, "completion_tokens")
        total_tokens = _usage_int(usage, "total_tokens") or input_tokens + output_tokens
        cached_tokens = _cached_tokens(usage)
        return ProviderUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            total_tokens=total_tokens,
        )
    return None


def _usage_int(payload: dict[str, object], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _cached_tokens(payload: dict[str, object]) -> int:
    for direct_key in ("prompt_cache_hit_tokens", "cache_read_input_tokens", "cache_read_tokens"):
        direct = _usage_int(payload, direct_key)
        if direct:
            return direct
    for details_key in ("input_tokens_details", "prompt_tokens_details"):
        details = payload.get(details_key)
        if isinstance(details, dict):
            cached = _usage_int(details, "cached_tokens")
            if cached:
                return cached
    return 0


def _model_request_probes(*, home: Path, session_id: str) -> list[ModelRequestProbe]:
    events_path = home / ".mycli" / "logs" / "model-events.jsonl"
    probes: list[ModelRequestProbe] = []
    for event in _model_events(events_path):
        if event.get("session_id") != session_id:
            continue
        if event.get("event") not in {"model_stream_completed", "model_response_received"}:
            continue
        request_path = _event_path(event.get("request_path"))
        response_path = _event_path(event.get("response_path"))
        if request_path is None or response_path is None:
            continue
        request_payload = _read_json(request_path)
        response_payload = _read_json(response_path)
        body = _payload_body(request_payload)
        usage = _usage_from_response(response_payload)
        probes.append(
            ModelRequestProbe(
                index=len(probes) + 1,
                turn_id=str(event.get("turn_id") or ""),
                request_path=str(request_path),
                response_path=str(response_path),
                usage=usage,
                output_item_types=_response_output_item_types(response_payload),
                function_call_names=_response_function_call_names(response_payload),
                previous_response_id=_optional_str(body.get("previous_response_id")),
                input_item_count=_list_len(body.get("input")),
                tool_count=_list_len(body.get("tools")),
                prompt_cache_key_present=bool(body.get("prompt_cache_key")),
                post_tool_context_as_developer=_contains_post_tool_developer_context(
                    body.get("input")
                ),
                post_tool_context_as_tool_tag=_contains_tool_runtime_reminder(
                    request_payload
                ),
            )
        )
    return probes


def _model_events(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    events: list[dict[str, object]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return events


def _event_path(value: object) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    return path if path.exists() else None


def _payload_body(payload: object | None) -> dict[str, object]:
    if not isinstance(payload, dict):
        return {}
    body = payload.get("body")
    return body if isinstance(body, dict) else {}


def _usage_from_response(payload: object | None) -> ProviderUsage | None:
    if not isinstance(payload, dict):
        return None
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        response = payload.get("response")
        if isinstance(response, dict):
            usage = response.get("usage")
    if not isinstance(usage, dict):
        return None
    input_tokens = _usage_int(usage, "input_tokens") or _usage_int(usage, "prompt_tokens")
    output_tokens = _usage_int(usage, "output_tokens") or _usage_int(usage, "completion_tokens")
    total_tokens = _usage_int(usage, "total_tokens") or input_tokens + output_tokens
    return ProviderUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_tokens=_cached_tokens(usage),
        total_tokens=total_tokens,
    )


def _response_output_item_types(payload: object | None) -> list[str]:
    output_items = _response_output_items(payload)
    return [str(item.get("type")) for item in output_items if item.get("type")]


def _response_function_call_names(payload: object | None) -> list[str]:
    names: list[str] = []
    for item in _response_output_items(payload):
        if item.get("type") != "function_call":
            continue
        name = item.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def _response_output_items(payload: object | None) -> list[dict[str, object]]:
    if not isinstance(payload, dict):
        return []
    output = payload.get("output")
    if not isinstance(output, list):
        response = payload.get("response")
        if isinstance(response, dict):
            output = response.get("output")
    if not isinstance(output, list):
        return []
    return [item for item in output if isinstance(item, dict)]


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _list_len(value: object) -> int:
    return len(value) if isinstance(value, list) else 0


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _transport_probe(*, home: Path, session_id: str) -> TransportProbe:
    raw_request_paths = sorted(
        (home / ".mycli" / "logs" / "model-raw" / session_id).glob("*-request.json")
    )
    raw_previous_response_id_request_count = 0
    raw_prompt_cache_key_request_count = 0
    for request_path in raw_request_paths:
        body = _payload_body(_read_json(request_path))
        if body.get("previous_response_id"):
            raw_previous_response_id_request_count += 1
        if body.get("prompt_cache_key"):
            raw_prompt_cache_key_request_count += 1

    trace_events = _trace_events(home=home, session_id=session_id)
    trace_event_counts: dict[str, int] = {}
    previous_response_id_attempt_count = 0
    continuation_retry_count = 0
    for event in trace_events:
        kind = event.get("kind")
        if not isinstance(kind, str) or not kind:
            continue
        trace_event_counts[kind] = trace_event_counts.get(kind, 0) + 1
        payload = event.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        if kind == "responses_request" and payload.get("used_previous_response_id"):
            previous_response_id_attempt_count += 1
        if kind == "responses_continuation_retry":
            continuation_retry_count += 1

    return TransportProbe(
        raw_request_count=len(raw_request_paths),
        raw_previous_response_id_request_count=raw_previous_response_id_request_count,
        raw_prompt_cache_key_request_count=raw_prompt_cache_key_request_count,
        responses_request_event_count=trace_event_counts.get("responses_request", 0),
        previous_response_id_attempt_count=previous_response_id_attempt_count,
        continuation_retry_count=continuation_retry_count,
        trace_event_counts=trace_event_counts,
    )


def _trace_events(*, home: Path, session_id: str) -> list[dict[str, object]]:
    path = home / ".mycli" / "traces" / f"{session_id}-trace.jsonl"
    if not path.exists():
        return []
    events: list[dict[str, object]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return events


def _contains_tool_runtime_reminder(value: object) -> bool:
    if isinstance(value, str):
        return "<tool_runtime_reminder>" in value
    if isinstance(value, dict):
        return any(_contains_tool_runtime_reminder(item) for item in value.values())
    if isinstance(value, list | tuple):
        return any(_contains_tool_runtime_reminder(item) for item in value)
    return False


def _contains_post_tool_developer_context(value: object) -> bool:
    if not isinstance(value, list):
        return False
    for item in value:
        if not isinstance(item, dict):
            continue
        if item.get("role") != "developer":
            continue
        text = _content_text(item.get("content"))
        if "The previous tool call has completed." in text:
            return True
    return False


def _content_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return ""


def _summary(
    *,
    probes: list[TurnProbe],
    model_requests: list[ModelRequestProbe],
    transport_probe: TransportProbe,
) -> dict[str, object]:
    successful_usage = [probe.usage for probe in model_requests if probe.usage is not None]
    input_total = sum(usage.input_tokens for usage in successful_usage)
    cached_total = sum(usage.cached_tokens for usage in successful_usage)
    return {
        "turn_count": len(probes),
        "model_request_count": len(successful_usage),
        "tool_call_count": sum(len(probe.tool_calls) for probe in probes),
        "tool_result_count": sum(len(probe.tool_results) for probe in probes),
        "function_call_response_count": sum(
            1 for probe in model_requests if probe.function_call_names
        ),
        "post_tool_context_request_count": sum(
            1 for probe in model_requests if probe.post_tool_context_present
        ),
        "post_tool_context_developer_request_count": sum(
            1 for probe in model_requests if probe.post_tool_context_as_developer
        ),
        "post_tool_context_tool_tag_request_count": sum(
            1 for probe in model_requests if probe.post_tool_context_as_tool_tag
        ),
        "prompt_cache_key_request_count": sum(
            1 for probe in model_requests if probe.prompt_cache_key_present
        ),
        "raw_request_count": transport_probe.raw_request_count,
        "raw_previous_response_id_request_count": (
            transport_probe.raw_previous_response_id_request_count
        ),
        "previous_response_id_attempt_count": (
            transport_probe.previous_response_id_attempt_count
        ),
        "continuation_retry_count": transport_probe.continuation_retry_count,
        "input_tokens": input_total,
        "cached_tokens": cached_total,
        "cache_hit_rate": 0.0 if input_total <= 0 else cached_total / input_total,
    }


def _preview(value: str, limit: int = 180) -> str:
    text = " ".join(value.split())
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _render_turn_line(probe: TurnProbe) -> str:
    if probe.usage is None:
        cache = "cache=n/a"
    else:
        cache = (
            f"cache={probe.usage.cache_hit_rate:.1%} "
            f"cached={probe.usage.cached_tokens} input={probe.usage.input_tokens}"
        )
    tools = ",".join(probe.tool_calls) or "none"
    return f"turn{probe.index}: {cache} tools={tools}"


def _render_request_line(probe: ModelRequestProbe) -> str:
    if probe.usage is None:
        cache = "cache=n/a"
    else:
        cache = (
            f"cache={probe.usage.cache_hit_rate:.1%} "
            f"cached={probe.usage.cached_tokens} input={probe.usage.input_tokens}"
        )
    calls = ",".join(probe.function_call_names) or "none"
    context = "none"
    if probe.post_tool_context_as_developer:
        context = "developer"
    elif probe.post_tool_context_as_tool_tag:
        context = "tool_tag"
    return (
        f"request{probe.index}: {cache} calls={calls} "
        f"prev={'yes' if probe.previous_response_id else 'no'} "
        f"post_tool_context={context}"
    )


if __name__ == "__main__":
    raise SystemExit(main())
