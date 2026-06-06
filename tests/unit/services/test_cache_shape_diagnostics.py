from __future__ import annotations

from mycli.domain.runtime import (
    FragmentStability,
    ProviderCachePolicyCapability,
    ProviderMessageShape,
    ProviderProjectionLane,
    ProviderProjectionShape,
    ProviderRequestPolicyShape,
    RequestFragment,
    RequestFragmentKind,
    RequestShape,
)
from mycli.application.runtime.request import CacheShapeDiagnostics


def _shape(*, fragment_content: str, second_message: str = "same") -> RequestShape:
    return RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable system",
        tool_schema_hash="tool-schema",
        tool_order_hash="tool-order",
        fragments=(
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content=fragment_content,
                stability=FragmentStability.VOLATILE,
                metadata={
                    "cache_class": "ephemeral",
                    "section_hash": "intent-hash",
                },
            ),
        ),
        provider_messages=(
            ProviderMessageShape(role="system", content="stable system"),
            ProviderMessageShape(role="user", content=second_message),
        ),
        provider_projection=ProviderProjectionShape(
            lane=ProviderProjectionLane.CHAT_COMPLETIONS,
            message_count=2,
            runtime_item_count=0,
            cacheable_prefix_fragment_count=0,
            first_dynamic_fragment_index=None,
            first_ephemeral_fragment_index=0,
            cache_hint="stable_transcript_prefix",
        ),
    )


def test_diagnostic_without_previous_shape_has_no_first_diff() -> None:
    diagnostic = CacheShapeDiagnostics().build(
        current=_shape(fragment_content="first"),
        usage={
            "prompt_tokens": 100,
            "prompt_cache_hit_tokens": 80,
            "prompt_cache_miss_tokens": 20,
        },
    )

    payload = diagnostic.to_dict()

    assert payload["first_changed_fragment_id"] is None
    assert payload["first_changed_provider_message_index"] is None
    assert payload["prompt_tokens"] == 100
    assert payload["cache_hit_tokens"] == 80
    assert payload["cache_miss_tokens"] == 20
    assert payload["cache_hit_ratio"] == 0.8


def test_diagnostic_normalizes_nested_cached_token_usage() -> None:
    diagnostic = CacheShapeDiagnostics().build(
        current=_shape(fragment_content="first"),
        usage={
            "prompt_tokens": 100,
            "prompt_tokens_details": {"cached_tokens": 64},
        },
    )

    payload = diagnostic.to_dict()

    assert payload["prompt_tokens"] == 100
    assert payload["cache_hit_tokens"] == 64
    assert payload["cache_miss_tokens"] == 36
    assert payload["cache_hit_ratio"] == 0.64


def test_diagnostic_normalizes_anthropic_cached_token_usage() -> None:
    diagnostic = CacheShapeDiagnostics().build(
        current=_shape(fragment_content="first"),
        usage={
            "input_tokens": 100,
            "cache_read_input_tokens": 70,
            "cache_creation_input_tokens": 12,
        },
    )

    payload = diagnostic.to_dict()

    assert payload["prompt_tokens"] == 100
    assert payload["cache_hit_tokens"] == 70
    assert payload["cache_miss_tokens"] == 30
    assert payload["metadata"]["provider_cache_usage"] == {
        "cached_tokens": 70,
        "cache_write_tokens": 12,
        "telemetry_status": "present",
    }


def test_diagnostic_marks_missing_cache_usage_telemetry() -> None:
    payload = CacheShapeDiagnostics().build(
        current=_shape(fragment_content="first"),
        usage={"prompt_tokens": 100},
    ).to_dict()

    assert payload["metadata"]["provider_cache_usage"] == {
        "cached_tokens": 0,
        "cache_write_tokens": 0,
        "telemetry_status": "missing",
    }


def test_diagnostic_reports_cache_boundary_and_metadata_completeness() -> None:
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable system",
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
                id="stable:workspace_instructions",
                kind=RequestFragmentKind.STABLE,
                content="workspace rules",
                stability=FragmentStability.STABLE,
                metadata={
                    "cache_class": "static",
                    "section_hash": "workspace-hash",
                    "source": ".mycli.md",
                },
            ),
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content="current task",
                stability=FragmentStability.VOLATILE,
                metadata={
                    "cache_class": "ephemeral",
                    "section_hash": "intent-hash",
                },
            ),
        ),
    )

    payload = CacheShapeDiagnostics().build(current=shape).to_dict()

    assert payload["cache_boundary"] == {
        "fragment_ids": ("stable:system", "stable:workspace_instructions"),
        "hash": shape.cacheable_prefix_hash(),
        "estimated_chars": len("stable system") + len("workspace rules"),
        "estimated_tokens": 7,
    }
    assert payload["metadata"]["fragment_metadata_complete"] is True
    assert payload["metadata"]["missing_fragment_metadata"] == ()
    assert payload["metadata"]["section_boundaries"] == shape.section_boundaries()
    assert payload["metadata"]["provider_projection"] is None
    assert payload["metadata"]["compact_policy"] == {
        "engine": "canonical",
        "cheap_pruning_scope": "dynamic_replay",
        "stable_prefix_protected": True,
        "rehydration_cache_class": "dynamic",
        "provider_specific_compact": False,
    }


def test_diagnostic_reports_provider_request_policy_metadata() -> None:
    shape = RequestShape(
        provider="openai",
        protocol="responses",
        model="gpt-test",
        stable_system="stable system",
        fragments=(
            RequestFragment(
                id="stable:system",
                kind=RequestFragmentKind.STABLE,
                content="stable system",
                stability=FragmentStability.STABLE,
                metadata={"cache_class": "static"},
            ),
        ),
        provider_request_policy=ProviderRequestPolicyShape.for_request_shape(
            provider="openai",
            protocol="responses",
            model="gpt-test",
            system_hash="system-hash",
            tool_schema_hash="tool-schema",
            cacheable_prefix_hash="prefix-hash",
            lane=ProviderProjectionLane.RESPONSES,
        ),
    )

    payload = CacheShapeDiagnostics().build(
        current=shape,
        usage={"prompt_tokens_details": {"cached_tokens": 42}},
    ).to_dict()

    policy = payload["metadata"]["provider_request_policy"]
    assert isinstance(policy, dict)
    assert policy["wire_cache_hint_enabled"] is True
    assert policy["wire_hint_state"] == "enabled_and_emitted"
    assert policy["prompt_cache_key_hash"]
    assert policy["anthropic_cache_control_breakpoint_count"] == 0
    assert payload["metadata"]["provider_cached_tokens"] == 42


def test_diagnostic_reports_disabled_provider_request_policy_state() -> None:
    shape = RequestShape(
        provider="compatible",
        protocol="chat_completions",
        model="compatible-model",
        stable_system="stable system",
        fragments=(
            RequestFragment(
                id="stable:system",
                kind=RequestFragmentKind.STABLE,
                content="stable system",
                stability=FragmentStability.STABLE,
                metadata={"cache_class": "static"},
            ),
        ),
        provider_request_policy=ProviderRequestPolicyShape.for_request_shape(
            provider="compatible",
            protocol="chat_completions",
            model="compatible-model",
            system_hash="system-hash",
            tool_schema_hash="tool-schema",
            cacheable_prefix_hash="prefix-hash",
            lane=ProviderProjectionLane.CHAT_COMPLETIONS,
            capability=ProviderCachePolicyCapability(
                prompt_cache_key_enabled=False,
                cache_control_enabled=False,
            ),
        ),
    )

    payload = CacheShapeDiagnostics().build(current=shape).to_dict()

    policy = payload["metadata"]["provider_request_policy"]
    assert isinstance(policy, dict)
    assert policy["wire_cache_hint_enabled"] is False
    assert policy["wire_hint_state"] == "disabled_by_policy"


def test_diagnostic_reports_unsupported_provider_request_policy_state() -> None:
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-chat",
        stable_system="stable system",
        fragments=(
            RequestFragment(
                id="stable:system",
                kind=RequestFragmentKind.STABLE,
                content="stable system",
                stability=FragmentStability.STABLE,
                metadata={"cache_class": "static"},
            ),
        ),
        provider_request_policy=ProviderRequestPolicyShape.for_request_shape(
            provider="deepseek",
            protocol="chat_completions",
            model="deepseek-chat",
            system_hash="system-hash",
            tool_schema_hash="tool-schema",
            cacheable_prefix_hash="prefix-hash",
            lane=ProviderProjectionLane.CHAT_COMPLETIONS,
            capability=ProviderCachePolicyCapability(
                prompt_cache_key_enabled=False,
                cache_control_enabled=False,
                wire_hints_supported=False,
                provider_family="deepseek",
                cache_strategy="automatic_prefix_cache",
            ),
        ),
    )

    policy = CacheShapeDiagnostics().build(current=shape).to_dict()["metadata"][
        "provider_request_policy"
    ]

    assert isinstance(policy, dict)
    assert policy["wire_cache_hint_enabled"] is False
    assert policy["wire_hint_state"] == "unsupported"
    assert policy["provider_family"] == "deepseek"
    assert policy["cache_strategy"] == "automatic_prefix_cache"


def test_diagnostic_finds_first_changed_fragment() -> None:
    previous = _shape(fragment_content="first")
    current = _shape(fragment_content="second")

    diagnostic = CacheShapeDiagnostics().build(current=current, previous=previous)

    assert diagnostic.first_changed_fragment_id == "intent:current"
    assert diagnostic.first_changed_cache_class == "ephemeral"
    assert diagnostic.first_changed_provider_message_index is None


def test_diagnostic_finds_first_changed_provider_message_index() -> None:
    previous = _shape(fragment_content="same", second_message="before")
    current = _shape(fragment_content="same", second_message="after")

    diagnostic = CacheShapeDiagnostics().build(current=current, previous=previous)

    assert diagnostic.first_changed_fragment_id is None
    assert diagnostic.first_changed_provider_message_index == 1


def test_diagnostic_identifies_split_memory_fragment_change() -> None:
    previous = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable system",
        fragments=(
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content="inspect",
                stability=FragmentStability.VOLATILE,
            ),
            RequestFragment(
                id="retrieved_memory",
                kind=RequestFragmentKind.RETRIEVED_MEMORY,
                content="Memory: old",
                stability=FragmentStability.VOLATILE,
            ),
        ),
    )
    current = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable system",
        fragments=(
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content="inspect",
                stability=FragmentStability.VOLATILE,
            ),
            RequestFragment(
                id="retrieved_memory",
                kind=RequestFragmentKind.RETRIEVED_MEMORY,
                content="Memory: new",
                stability=FragmentStability.VOLATILE,
            ),
        ),
    )

    diagnostic = CacheShapeDiagnostics().build(current=current, previous=previous)

    assert diagnostic.first_changed_fragment_id == "retrieved_memory"
