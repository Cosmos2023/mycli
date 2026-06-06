from __future__ import annotations

import pytest

from mycli.domain.runtime.request_shape import (
    FragmentStability,
    ProviderCachePolicyCapability,
    ProviderMessageShape,
    ProviderProjectionLane,
    ProviderProjectionShape,
    ProviderRequestPolicyShape,
    ProviderRuntimeItemShape,
    RequestFragment,
    RequestFragmentKind,
    RequestShape,
    stable_hash,
)
from mycli.domain.runtime.blocks import RuntimeBlock


def test_stable_hash_is_deterministic() -> None:
    assert stable_hash("same text") == stable_hash("same text")
    assert stable_hash("same text") != stable_hash("different text")
    assert len(stable_hash("same text")) == 64


def test_request_fragment_rejects_blank_id() -> None:
    with pytest.raises(ValueError, match="fragment id cannot be blank"):
        RequestFragment(
            id=" ",
            kind=RequestFragmentKind.INTENT,
            content="hello",
            stability=FragmentStability.VOLATILE,
        )


def test_request_fragment_derives_hash_and_length() -> None:
    fragment = RequestFragment(
        id="intent:current",
        kind=RequestFragmentKind.INTENT,
        content="用户问题",
        stability=FragmentStability.VOLATILE,
        provider_visibility=("deepseek", "qwen"),
    )

    assert fragment.content_hash == stable_hash("用户问题")
    assert fragment.char_length == len("用户问题")
    assert fragment.provider_visibility == ("deepseek", "qwen")


def test_request_shape_summarizes_fragments_and_messages() -> None:
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable system",
        tool_schema_hash="tool-schema",
        tool_order_hash="tool-order",
        fragments=(
            RequestFragment(
                id="stable:system",
                kind=RequestFragmentKind.STABLE,
                content="stable system",
                stability=FragmentStability.STABLE,
                metadata={
                    "cache_class": "static",
                    "section_hash": "system-hash",
                    "source": "system_prompt",
                },
            ),
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content="fix cache",
                stability=FragmentStability.VOLATILE,
                metadata={
                    "cache_class": "ephemeral",
                    "section_hash": "intent-hash",
                    "source": "user_message",
                },
            ),
        ),
        provider_messages=(
            ProviderMessageShape(role="system", content="stable system"),
            ProviderMessageShape(role="user", content="fix cache"),
        ),
        provider_projection=ProviderProjectionShape(
            lane=ProviderProjectionLane.CHAT_COMPLETIONS,
            message_count=2,
            runtime_item_count=0,
            cacheable_prefix_fragment_count=1,
            first_dynamic_fragment_index=None,
            first_ephemeral_fragment_index=1,
            cache_hint="stable_transcript_prefix",
        ),
    )

    summary = shape.summary()

    assert summary["provider"] == "deepseek"
    assert summary["protocol"] == "chat_completions"
    assert summary["model"] == "deepseek-v4-flash"
    assert summary["system_hash"] == stable_hash("stable system")
    assert summary["tool_schema_hash"] == "tool-schema"
    assert summary["tool_order_hash"] == "tool-order"
    assert summary["fragment_hashes"] == {
        "stable:system": stable_hash("stable system"),
        "intent:current": stable_hash("fix cache"),
    }
    assert summary["section_boundaries"] == (
        {
            "fragment_id": "stable:system",
            "cache_class": "static",
            "stability": "stable",
            "kind": "stable",
            "source": "system_prompt",
            "length": len("stable system"),
            "cacheable_prefix": True,
        },
        {
            "fragment_id": "intent:current",
            "cache_class": "ephemeral",
            "stability": "volatile",
            "kind": "intent",
            "source": "user_message",
            "length": len("fix cache"),
            "cacheable_prefix": False,
        },
    )
    assert summary["provider_message_hashes"] == (
        stable_hash("system\nstable system"),
        stable_hash("user\nfix cache"),
    )
    assert summary["provider_projection"] == {
        "lane": "chat_completions",
        "message_count": 2,
        "runtime_item_count": 0,
        "cacheable_prefix_fragment_count": 1,
        "first_dynamic_fragment_index": None,
        "first_ephemeral_fragment_index": 1,
        "cache_hint": "stable_transcript_prefix",
        "wire_only_hints": (),
    }
    assert summary["compact_policy"] == {
        "engine": "canonical",
        "cheap_pruning_scope": "dynamic_replay",
        "stable_prefix_protected": True,
        "rehydration_cache_class": "dynamic",
        "provider_specific_compact": False,
    }


def test_provider_runtime_item_shape_hashes_structured_blocks() -> None:
    item = ProviderRuntimeItemShape(
        role="assistant",
        blocks=(
            RuntimeBlock(type="text", text="I will inspect."),
            RuntimeBlock(
                type="tool_call",
                tool_name="read_file",
                tool_arguments={"path": "README.md"},
                call_id="call_read_1",
            ),
        ),
    )

    assert item.content_hash == item.content_hash
    assert item.char_length > 0


def test_request_shape_summary_includes_provider_request_policy() -> None:
    shape = RequestShape(
        provider="openai",
        protocol="responses",
        model="gpt-test",
        stable_system="stable system",
        tool_schema_hash="tool-schema",
        fragments=(
            RequestFragment(
                id="stable:system",
                kind=RequestFragmentKind.STABLE,
                content="stable system",
                stability=FragmentStability.STABLE,
                metadata={"cache_class": "static"},
            ),
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content="do current work",
                stability=FragmentStability.VOLATILE,
                metadata={"cache_class": "ephemeral"},
            ),
        ),
        provider_request_policy=ProviderRequestPolicyShape.for_request_shape(
            provider="openai",
            protocol="responses",
            model="gpt-test",
            system_hash=stable_hash("stable system"),
            tool_schema_hash="tool-schema",
            cacheable_prefix_hash=stable_hash(stable_hash("stable system")),
            lane=ProviderProjectionLane.RESPONSES,
        ),
    )

    summary = shape.summary()
    policy = summary["provider_request_policy"]

    assert isinstance(policy, dict)
    assert policy["lane"] == "responses"
    assert policy["wire_only"] is True
    assert "prompt_cache_key" not in policy
    assert policy["prompt_cache_key_preview"].startswith("mycli:openai:responses:")
    assert policy["prompt_cache_key_hash"] == stable_hash(
        str(shape.provider_request_policy.prompt_cache_key)
    )
    assert policy["anthropic_cache_control_breakpoint_count"] == 0


def test_provider_request_policy_capability_can_disable_prompt_cache_key() -> None:
    policy = ProviderRequestPolicyShape.for_request_shape(
        provider="compatible",
        protocol="chat_completions",
        model="legacy-model",
        system_hash="system",
        tool_schema_hash="tools",
        cacheable_prefix_hash="stable-prefix",
        lane=ProviderProjectionLane.CHAT_COMPLETIONS,
        capability=ProviderCachePolicyCapability(prompt_cache_key_enabled=False),
    )

    assert policy.prompt_cache_key is None
    assert policy.prompt_cache_key_hash is None
    assert policy.wire_cache_hint_enabled is False
    assert policy.to_wire_dict()["prompt_cache_key"] is None


def test_provider_request_policy_capability_can_disable_anthropic_cache_control() -> None:
    policy = ProviderRequestPolicyShape.for_request_shape(
        provider="anthropic",
        protocol="anthropic_messages",
        model="claude-test",
        system_hash="system",
        tool_schema_hash="tools",
        cacheable_prefix_hash="stable-prefix",
        lane=ProviderProjectionLane.ANTHROPIC_MESSAGES,
        capability=ProviderCachePolicyCapability(cache_control_enabled=False),
    )

    assert policy.anthropic_cache_control_breakpoints == ()
    assert policy.wire_cache_hint_enabled is False
    assert "cache_control" not in policy.wire_only_hints
