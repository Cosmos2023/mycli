from __future__ import annotations

from mycli.domain.runtime import (
    FragmentStability,
    ProviderMessageShape,
    ProviderProjectionLane,
    ProviderProjectionShape,
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
