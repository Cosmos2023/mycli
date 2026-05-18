from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from mycli.domain.conversation import Message
from mycli.services.context.compaction.pipeline import (
    LLMSummarization,
    effective_l4_trigger_ratio,
)


def test_effective_l4_trigger_ratio_uses_buffer_before_configured_ratio() -> None:
    ratio = effective_l4_trigger_ratio(
        configured_ratio=0.95,
        max_tokens=100_000,
        buffer_tokens=13_000,
    )

    assert ratio == 0.87


def test_effective_l4_trigger_ratio_keeps_lower_configured_ratio() -> None:
    ratio = effective_l4_trigger_ratio(
        configured_ratio=0.50,
        max_tokens=100_000,
        buffer_tokens=13_000,
    )

    assert ratio == 0.50


def test_effective_l4_trigger_ratio_scales_buffer_for_small_windows() -> None:
    ratio = effective_l4_trigger_ratio(
        configured_ratio=0.95,
        max_tokens=10_000,
        buffer_tokens=13_000,
    )

    assert ratio == 0.80


class TestL4Summarizer:
    def test_uses_client_when_provided(self) -> None:
        mock_client = MagicMock()
        mock_client.complete.return_value = "## Summary\n\n1. Refactor auth\n..."

        summarizer = LLMSummarization(
            trigger_ratio=0.1,
            summarizer_client=mock_client,
            summarizer_model_name="test-lite",
        )

        msgs = [
            Message(role="user", content="Refactor auth module"),
            Message(role="assistant", content="Reading auth.py"),
        ]

        result = summarizer._call_summarizer(msgs)

        assert mock_client.complete.called
        call_args = mock_client.complete.call_args.kwargs
        prompt = call_args["messages"][0]["content"]
        assert "1. Primary Request" in prompt
        assert "Refactor auth module" in prompt
        assert call_args["model"] == "test-lite"
        assert call_args["max_tokens"] == 600
        assert result == "## Summary\n\n1. Refactor auth\n..."

    def test_client_model_falls_back_to_main_model_name(self) -> None:
        mock_client = MagicMock()
        mock_client.complete.return_value = "summary"
        summarizer = LLMSummarization(
            trigger_ratio=0.1,
            model_name="main-model",
            summarizer_client=mock_client,
            summarizer_model_name=None,
        )

        result = summarizer._call_summarizer(
            [Message(role="user", content="summarize me")]
        )

        call_args = mock_client.complete.call_args.kwargs
        assert call_args["model"] == "main-model"
        assert result == "summary"

    def test_sends_full_message_content_to_client(self) -> None:
        mock_client = MagicMock()
        mock_client.complete.return_value = "summary"
        summarizer = LLMSummarization(
            trigger_ratio=0.1,
            summarizer_client=mock_client,
        )
        long_content = "start " + ("x" * 700) + " END_MARKER"

        summarizer._call_summarizer([Message(role="tool", content=long_content)])

        call_args = mock_client.complete.call_args.kwargs
        prompt = call_args["messages"][0]["content"]
        assert long_content in prompt
        assert "END_MARKER" in prompt

    def test_falls_back_to_stub_when_no_client(self) -> None:
        summarizer = LLMSummarization(trigger_ratio=0.1, summarizer_client=None)

        msgs = [
            Message(role="user", content="test"),
            Message(role="assistant", content="response"),
        ]

        result = summarizer._call_summarizer(msgs)

        assert "Conversation summary:" in result
        assert "user" in result

    def test_failure_propagates_to_circuit_breaker(self) -> None:
        mock_client = MagicMock()
        mock_client.complete.side_effect = Exception("API error")

        summarizer = LLMSummarization(
            trigger_ratio=0.1,
            summarizer_client=mock_client,
        )

        msgs = [Message(role="user", content="test")]

        with pytest.raises(Exception, match="API error"):
            summarizer._call_summarizer(msgs)

    def test_empty_messages_placeholder(self) -> None:
        summarizer = LLMSummarization(trigger_ratio=0.9)

        assert summarizer._call_summarizer([]) == "Conversation summary unavailable."


def test_summary_prompt_forbids_tools_and_non_text_outputs() -> None:
    mock_client = MagicMock()
    mock_client.complete.return_value = "summary"
    summarizer = LLMSummarization(
        trigger_ratio=0.1,
        summarizer_client=mock_client,
    )

    summarizer._call_summarizer([Message(role="user", content="summarize safely")])

    prompt = mock_client.complete.call_args.kwargs["messages"][0]["content"]
    assert "CRITICAL: Respond with TEXT ONLY." in prompt
    assert "Do NOT call tools." in prompt
    assert "Do NOT output JSON, XML, or code fences." in prompt
    assert "Do NOT continue the task." in prompt
