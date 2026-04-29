from __future__ import annotations

from mycli.domain.runtime import (
    FragmentStability,
    ProviderMessageShape,
    RequestFragment,
    RequestFragmentKind,
    RequestShape,
)
from mycli.services.cache_shape_diagnostics import CacheShapeDiagnostics


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
            ),
        ),
        provider_messages=(
            ProviderMessageShape(role="system", content="stable system"),
            ProviderMessageShape(role="user", content=second_message),
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


def test_diagnostic_finds_first_changed_fragment() -> None:
    previous = _shape(fragment_content="first")
    current = _shape(fragment_content="second")

    diagnostic = CacheShapeDiagnostics().build(current=current, previous=previous)

    assert diagnostic.first_changed_fragment_id == "intent:current"
    assert diagnostic.first_changed_provider_message_index is None


def test_diagnostic_finds_first_changed_provider_message_index() -> None:
    previous = _shape(fragment_content="same", second_message="before")
    current = _shape(fragment_content="same", second_message="after")

    diagnostic = CacheShapeDiagnostics().build(current=current, previous=previous)

    assert diagnostic.first_changed_fragment_id is None
    assert diagnostic.first_changed_provider_message_index == 1
