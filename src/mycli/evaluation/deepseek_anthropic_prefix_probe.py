from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from anthropic import Anthropic

from mycli.infrastructure.ssl import ensure_certifi_ca_bundle

DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_MAX_TOKENS = 256
DEFAULT_REQUESTS = 4
DEFAULT_PREFIX_REPEAT = 180
SUPPORTED_CACHE_CONTROL_MODES = ("none", "system_and_3")


@dataclass(slots=True, frozen=True)
class UsageSummary:
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    raw_keys: tuple[str, ...]

    @property
    def warm_cache_ratio(self) -> float:
        total = self.input_tokens + self.cache_read_tokens
        if total == 0:
            return 0.0
        return self.cache_read_tokens / total

    def to_dict(self) -> dict[str, object]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_creation_tokens": self.cache_creation_tokens,
            "warm_cache_ratio": round(self.warm_cache_ratio, 4),
            "raw_keys": self.raw_keys,
        }


@dataclass(slots=True, frozen=True)
class ProbeRequestSummary:
    index: int
    phase: str
    message_count: int
    assistant_content_block_types: tuple[str, ...]
    tool_use_count: int
    usage: UsageSummary

    def to_dict(self) -> dict[str, object]:
        return {
            "index": self.index,
            "phase": self.phase,
            "message_count": self.message_count,
            "assistant_content_block_types": self.assistant_content_block_types,
            "tool_use_count": self.tool_use_count,
            "usage": self.usage.to_dict(),
        }


def summarize_usage(usage: dict[str, object]) -> UsageSummary:
    return UsageSummary(
        input_tokens=_int_metric(usage, "input_tokens") or _int_metric(usage, "prompt_tokens"),
        output_tokens=_int_metric(usage, "output_tokens")
        or _int_metric(usage, "completion_tokens"),
        cache_read_tokens=_cache_read_tokens(usage),
        cache_creation_tokens=_cache_creation_tokens(usage),
        raw_keys=tuple(sorted(str(key) for key in usage)),
    )


def prefix_cache_observation(
    requests: tuple[ProbeRequestSummary, ...],
) -> dict[str, object]:
    if not requests:
        return {
            "status": "unknown",
            "reason": "no requests completed",
            "warm_cache_read_tokens": 0,
            "warm_cache_ratio": 0.0,
        }
    if all(
        request.usage.input_tokens == 0
        and request.usage.output_tokens == 0
        and request.usage.cache_read_tokens == 0
        and request.usage.cache_creation_tokens == 0
        for request in requests
    ):
        return {
            "status": "unknown",
            "reason": "provider response did not include token usage",
            "warm_cache_read_tokens": 0,
            "warm_cache_ratio": 0.0,
        }
    warm_requests = requests[1:] if len(requests) > 1 else requests
    warm_cache_read_tokens = sum(request.usage.cache_read_tokens for request in warm_requests)
    warm_input_tokens = sum(request.usage.input_tokens for request in warm_requests)
    denominator = warm_input_tokens + warm_cache_read_tokens
    warm_cache_ratio = 0.0 if denominator == 0 else warm_cache_read_tokens / denominator
    if warm_cache_read_tokens > 0:
        return {
            "status": "observed",
            "reason": "later requests reported cached input tokens",
            "warm_cache_read_tokens": warm_cache_read_tokens,
            "warm_cache_ratio": round(warm_cache_ratio, 4),
        }
    return {
        "status": "not_observed",
        "reason": "later requests completed but reported zero cached input tokens",
        "warm_cache_read_tokens": 0,
        "warm_cache_ratio": 0.0,
    }


def apply_system_and_three_cache_control(
    system: list[dict[str, object]],
    messages: list[dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    wire_system = copy.deepcopy(system)
    wire_messages = copy.deepcopy(messages)
    marked = 0
    if wire_system:
        last_system = wire_system[-1]
        if last_system.get("type") == "text":
            last_system["cache_control"] = {"type": "ephemeral"}
            marked += 1
    for message in reversed(wire_messages):
        if marked >= 4:
            break
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for block in reversed(content):
            if marked >= 4:
                break
            if isinstance(block, dict) and block.get("type") in {
                "text",
                "tool_use",
                "tool_result",
            }:
                block["cache_control"] = {"type": "ephemeral"}
                marked += 1
                break
    return wire_system, wire_messages


def build_probe_report(
    *,
    base_url: str,
    model: str,
    cache_control_mode: str,
    stable_prefix_text: str,
    tool_schema: dict[str, object],
    requests: tuple[ProbeRequestSummary, ...],
    tool_result_hashes: tuple[str, ...],
) -> dict[str, object]:
    return {
        "probe": "deepseek_anthropic_prefix_cache",
        "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "provider": {
            "base_url_host": _host_label(base_url),
            "model": model,
            "protocol": "anthropic_messages",
        },
        "cache_control_mode": cache_control_mode,
        "stable_prefix": {
            "chars": len(stable_prefix_text),
            "sha256": _stable_hash(stable_prefix_text),
        },
        "tool_schema": {
            "name": tool_schema.get("name"),
            "sha256": _stable_hash(_canonical_json(tool_schema)),
        },
        "requests": [request.to_dict() for request in requests],
        "tool_result_hashes": tool_result_hashes,
        "observation": prefix_cache_observation(requests),
    }


def run_probe(
    *,
    api_key: str,
    base_url: str,
    model: str,
    cache_control_mode: str,
    request_count: int,
    prefix_repeat: int,
    max_tokens: int,
    sleep_seconds: float,
) -> dict[str, object]:
    ensure_certifi_ca_bundle()
    stable_prefix = _stable_prefix(prefix_repeat)
    system: list[dict[str, object]] = [{"type": "text", "text": stable_prefix}]
    tool_schema = _tool_schema()
    client = Anthropic(
        api_key=api_key,
        base_url=base_url.rstrip("/"),
        timeout=60.0,
        max_retries=0,
    )
    messages: list[dict[str, object]] = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Use local_lookup for the alpha customer record, then answer "
                        "with exactly one short sentence."
                    ),
                }
            ],
        }
    ]
    request_summaries: list[ProbeRequestSummary] = []
    tool_result_hashes: list[str] = []
    for request_index in range(1, request_count + 1):
        wire_system, wire_messages = _wire_payload(
            system=system,
            messages=messages,
            cache_control_mode=cache_control_mode,
        )
        payload = _create_message(
            client=client,
            model=model,
            max_tokens=max_tokens,
            system=wire_system,
            messages=wire_messages,
            tools=[tool_schema],
        )
        content = _content_blocks(payload)
        tool_uses = [block for block in content if block.get("type") == "tool_use"]
        request_summaries.append(
            ProbeRequestSummary(
                index=request_index,
                phase=_phase_label(content),
                message_count=len(messages),
                assistant_content_block_types=tuple(
                    str(block.get("type")) for block in content
                ),
                tool_use_count=len(tool_uses),
                usage=summarize_usage(_usage_payload(payload)),
            )
        )
        messages.append({"role": "assistant", "content": content})
        if tool_uses:
            tool_result_blocks = [
                {
                    "type": "tool_result",
                    "tool_use_id": str(tool_use.get("id")),
                    "content": _tool_result_text(tool_use),
                }
                for tool_use in tool_uses
            ]
            tool_result_hashes.extend(
                _stable_hash(str(block["content"])) for block in tool_result_blocks
            )
            messages.append({"role": "user", "content": tool_result_blocks})
        elif request_index < request_count:
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"Follow-up {request_index}: keep using the same "
                                "stable context and answer in one short sentence."
                            ),
                        }
                    ],
                }
            )
        if sleep_seconds > 0 and request_index < request_count:
            time.sleep(sleep_seconds)
    return build_probe_report(
        base_url=base_url,
        model=model,
        cache_control_mode=cache_control_mode,
        stable_prefix_text=stable_prefix,
        tool_schema=tool_schema,
        requests=tuple(request_summaries),
        tool_result_hashes=tuple(tool_result_hashes),
    )


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    api_key = _api_key_from_env()
    report = run_probe(
        api_key=api_key,
        base_url=args.base_url,
        model=args.model,
        cache_control_mode=args.cache_control_mode,
        request_count=args.requests,
        prefix_repeat=args.prefix_repeat,
        max_tokens=args.max_tokens,
        sleep_seconds=args.sleep_seconds,
    )
    output_path = _write_report(report, args.output_dir)
    print(_render_summary(report, output_path))
    return 0


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Probe whether DeepSeek's Anthropic-compatible endpoint reports "
            "prefix-cache hits across multi-turn tool traffic."
        )
    )
    parser.add_argument("--base-url", default=os.environ.get("MYCLI_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--model", default=os.environ.get("MYCLI_MODEL", DEFAULT_MODEL))
    parser.add_argument(
        "--cache-control-mode",
        choices=SUPPORTED_CACHE_CONTROL_MODES,
        default=os.environ.get("PROBE_CACHE_CONTROL_MODE", "none"),
    )
    parser.add_argument("--requests", type=int, default=DEFAULT_REQUESTS)
    parser.add_argument("--prefix-repeat", type=int, default=DEFAULT_PREFIX_REPEAT)
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--sleep-seconds", type=float, default=0.0)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("evaluation/runs"),
    )
    return parser.parse_args(argv)


def _api_key_from_env() -> str:
    api_key = (
        os.environ.get("MYCLI_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
        or os.environ.get("ANTHROPIC_API_KEY")
    )
    if not api_key:
        raise SystemExit(
            "MYCLI_API_KEY, DEEPSEEK_API_KEY, or ANTHROPIC_API_KEY is required."
        )
    return api_key


def _write_report(report: dict[str, object], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = output_dir / f"deepseek-anthropic-prefix-probe-{timestamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _render_summary(report: dict[str, object], output_path: Path) -> str:
    observation = report.get("observation")
    observation_payload = observation if isinstance(observation, dict) else {}
    requests = report.get("requests")
    request_payloads = requests if isinstance(requests, list) else []
    lines = [
        "[probe] deepseek anthropic prefix cache",
        f"[probe] report: {output_path}",
        (
            "[probe] observation: "
            f"{observation_payload.get('status')} "
            f"warm_cache_read_tokens={observation_payload.get('warm_cache_read_tokens')} "
            f"warm_cache_ratio={observation_payload.get('warm_cache_ratio')}"
        ),
    ]
    for request in request_payloads:
        if not isinstance(request, dict):
            continue
        usage = request.get("usage")
        usage_payload = usage if isinstance(usage, dict) else {}
        lines.append(
            "[probe] request "
            f"{request.get('index')}: phase={request.get('phase')} "
            f"messages={request.get('message_count')} "
            f"tool_uses={request.get('tool_use_count')} "
            f"input={usage_payload.get('input_tokens')} "
            f"cache_read={usage_payload.get('cache_read_tokens')} "
            f"cache_create={usage_payload.get('cache_creation_tokens')}"
        )
    return "\n".join(lines)


def _wire_payload(
    *,
    system: list[dict[str, object]],
    messages: list[dict[str, object]],
    cache_control_mode: str,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    if cache_control_mode == "system_and_3":
        return apply_system_and_three_cache_control(system, messages)
    return copy.deepcopy(system), copy.deepcopy(messages)


def _create_message(
    *,
    client: Anthropic,
    model: str,
    max_tokens: int,
    system: list[dict[str, object]],
    messages: list[dict[str, object]],
    tools: list[dict[str, object]],
) -> dict[str, object]:
    response = cast(Any, client.messages).create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=messages,
        tools=tools,
        thinking={"type": "disabled"},
    )
    return _payload_to_dict(response)


def _payload_to_dict(payload: object) -> dict[str, object]:
    if isinstance(payload, dict):
        return dict(payload)
    for attr in ("to_dict", "model_dump", "dict"):
        serializer = getattr(payload, attr, None)
        if callable(serializer):
            serialized = serializer()
            if isinstance(serialized, dict):
                return dict(serialized)
    raise TypeError("Anthropic SDK response did not serialize to a dictionary.")


def _content_blocks(payload: dict[str, object]) -> list[dict[str, object]]:
    content = payload.get("content")
    if not isinstance(content, list):
        return []
    return [dict(block) for block in content if isinstance(block, dict)]


def _usage_payload(payload: dict[str, object]) -> dict[str, object]:
    usage = payload.get("usage")
    return dict(usage) if isinstance(usage, dict) else {}


def _phase_label(content: list[dict[str, object]]) -> str:
    if any(block.get("type") == "tool_use" for block in content):
        return "tool_use"
    return "text"


def _tool_result_text(tool_use: dict[str, object]) -> str:
    tool_input = tool_use.get("input")
    args = tool_input if isinstance(tool_input, dict) else {}
    lookup_key = str(args.get("query") or args.get("key") or "alpha")
    return (
        "local_lookup_result: customer=Alpha Co; renewal=2026-07-15; "
        f"lookup_key={lookup_key}; status=green; owner=team-cache-probe."
    )


def _tool_schema() -> dict[str, object]:
    return {
        "name": "local_lookup",
        "description": (
            "Return a stable local customer record. Use this when the user asks "
            "for alpha customer context."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Lookup key, for example alpha.",
                }
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    }


def _stable_prefix(repeat: int) -> str:
    static_lines = [
        "You are running a cache probe. Preserve this static instruction prefix.",
        "Never reveal secrets. Keep answers short. Prefer stable wording.",
        "The following static workspace facts are intentionally repetitive.",
    ]
    for index in range(repeat):
        static_lines.append(
            f"STATIC-CACHE-LINE-{index:04d}: alpha customer policy version 2026-06 stable."
        )
    return "\n".join(static_lines)


def _int_metric(payload: dict[str, object], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _cache_read_tokens(usage: dict[str, object]) -> int:
    for key in (
        "cache_read_input_tokens",
        "prompt_cache_hit_tokens",
        "cache_read_tokens",
    ):
        value = _int_metric(usage, key)
        if value:
            return value
    for details_key in ("input_tokens_details", "prompt_tokens_details"):
        details = usage.get(details_key)
        if isinstance(details, dict):
            value = _int_metric(details, "cached_tokens")
            if value:
                return value
    return 0


def _cache_creation_tokens(usage: dict[str, object]) -> int:
    for key in (
        "cache_creation_input_tokens",
        "prompt_cache_creation_tokens",
        "cache_write_tokens",
    ):
        value = _int_metric(usage, key)
        if value:
            return value
    return 0


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_json(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _host_label(base_url: str) -> str:
    without_scheme = base_url.split("://", 1)[-1]
    return without_scheme.split("/", 1)[0]


if __name__ == "__main__":
    raise SystemExit(main())
