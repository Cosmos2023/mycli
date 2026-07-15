from __future__ import annotations

from mycli.domain.tooling.output import (
    ToolImageContent,
    ToolModelOutput,
    ToolTextContent,
)
from mycli.services.context.tool_output_budget import ToolOutputBudgeter


def test_budgeter_retains_head_and_tail_with_explicit_marker() -> None:
    output = ToolModelOutput.from_text(
        "HEAD\n" + "x" * 200 + "\nTAIL",
        success=True,
    )

    projected = ToolOutputBudgeter().apply(output, max_chars=80)
    text = projected.text_content()

    assert "HEAD" in text
    assert "TAIL" in text
    assert "chars omitted" in text
    assert len(text) <= 80
    assert projected.truncation is not None
    assert projected.truncation.original_chars == 210
    assert projected.truncation.omitted_chars > 0


def test_budgeter_preserves_output_below_limit() -> None:
    output = ToolModelOutput.from_text("one\ntwo", success=True)

    projected = ToolOutputBudgeter().apply(output, max_chars=80)

    assert projected is output


def test_budgeter_preserves_images_when_text_is_truncated() -> None:
    image = ToolImageContent(image_url="data:image/png;base64,abc", detail="high")
    output = ToolModelOutput(
        content=(ToolTextContent(text="x" * 200), image),
        success=True,
    )

    projected = ToolOutputBudgeter().apply(output, max_chars=60)

    assert image in projected.content
    assert projected.content[-1] is image


def test_budgeter_handles_tiny_limit_without_overflow() -> None:
    output = ToolModelOutput.from_text("abcdefghij", success=True)

    projected = ToolOutputBudgeter().apply(output, max_chars=3)

    assert len(projected.text_content()) <= 3
    assert projected.truncation is not None
