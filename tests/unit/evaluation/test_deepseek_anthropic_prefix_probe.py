from __future__ import annotations

import json

from mycli.evaluation.deepseek_anthropic_prefix_probe import (
    ProbeRequestSummary,
    apply_system_and_three_cache_control,
    build_probe_report,
    prefix_cache_observation,
    summarize_usage,
)


def test_summarize_usage_normalizes_anthropic_cache_fields() -> None:
    summary = summarize_usage(
        {
            "input_tokens": 120,
            "output_tokens": 30,
            "cache_read_input_tokens": 80,
            "cache_creation_input_tokens": 40,
        }
    )

    assert summary.input_tokens == 120
    assert summary.output_tokens == 30
    assert summary.cache_read_tokens == 80
    assert summary.cache_creation_tokens == 40
    assert summary.warm_cache_ratio == 0.4


def test_prefix_cache_observation_requires_later_cached_tokens() -> None:
    requests = (
        ProbeRequestSummary(
            index=1,
            phase="first",
            message_count=1,
            assistant_content_block_types=("text",),
            tool_use_count=0,
            usage=summarize_usage({"input_tokens": 100}),
        ),
        ProbeRequestSummary(
            index=2,
            phase="second",
            message_count=3,
            assistant_content_block_types=("text",),
            tool_use_count=0,
            usage=summarize_usage({"input_tokens": 50, "cache_read_input_tokens": 150}),
        ),
    )

    observation = prefix_cache_observation(requests)

    assert observation["status"] == "observed"
    assert observation["warm_cache_read_tokens"] == 150
    assert observation["warm_cache_ratio"] == 0.75


def test_prefix_cache_observation_is_unknown_without_usage() -> None:
    requests = (
        ProbeRequestSummary(
            index=1,
            phase="first",
            message_count=1,
            assistant_content_block_types=("text",),
            tool_use_count=0,
            usage=summarize_usage({}),
        ),
    )

    assert prefix_cache_observation(requests)["status"] == "unknown"


def test_system_and_three_cache_control_is_wire_only_and_limited_to_four() -> None:
    system = [{"type": "text", "text": "stable system"}]
    messages = [
        {"role": "user", "content": [{"type": "text", "text": f"user {index}"}]}
        for index in range(5)
    ]

    wire_system, wire_messages = apply_system_and_three_cache_control(system, messages)

    assert "cache_control" not in system[0]
    assert all(
        "cache_control" not in block
        for message in messages
        for block in message["content"]
        if isinstance(block, dict)
    )
    serialized = json.dumps({"system": wire_system, "messages": wire_messages})
    assert serialized.count("cache_control") == 4
    assert wire_system[-1]["cache_control"] == {"type": "ephemeral"}


def test_probe_report_excludes_raw_prompt_and_tool_result_text() -> None:
    report = build_probe_report(
        base_url="https://api.deepseek.com/anthropic",
        model="deepseek-v4-flash",
        cache_control_mode="none",
        stable_prefix_text="RAW_STABLE_PREFIX_SHOULD_NOT_APPEAR",
        tool_schema={"name": "local_lookup", "description": "tool"},
        requests=(
            ProbeRequestSummary(
                index=1,
                phase="tool request",
                message_count=1,
                assistant_content_block_types=("tool_use",),
                tool_use_count=1,
                usage=summarize_usage({"input_tokens": 100}),
            ),
        ),
        tool_result_hashes=("hash-only",),
    )

    encoded = json.dumps(report, ensure_ascii=False)

    assert "RAW_STABLE_PREFIX_SHOULD_NOT_APPEAR" not in encoded
    assert "hash-only" in encoded
    assert report["stable_prefix"]["chars"] == len("RAW_STABLE_PREFIX_SHOULD_NOT_APPEAR")
