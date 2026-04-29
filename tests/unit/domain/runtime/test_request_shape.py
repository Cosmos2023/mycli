from __future__ import annotations

import pytest

from mycli.domain.runtime.request_shape import (
    FragmentStability,
    ProviderMessageShape,
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
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content="fix cache",
                stability=FragmentStability.VOLATILE,
            ),
        ),
        provider_messages=(
            ProviderMessageShape(role="system", content="stable system"),
            ProviderMessageShape(role="user", content="fix cache"),
        ),
    )

    summary = shape.summary()

    assert summary["provider"] == "deepseek"
    assert summary["protocol"] == "chat_completions"
    assert summary["model"] == "deepseek-v4-flash"
    assert summary["system_hash"] == stable_hash("stable system")
    assert summary["tool_schema_hash"] == "tool-schema"
    assert summary["tool_order_hash"] == "tool-order"
    assert summary["fragment_hashes"] == {"intent:current": stable_hash("fix cache")}
    assert summary["provider_message_hashes"] == (
        stable_hash("system\nstable system"),
        stable_hash("user\nfix cache"),
    )


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
