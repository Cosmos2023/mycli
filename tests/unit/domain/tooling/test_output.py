from __future__ import annotations

import pytest

from mycli.domain.tooling.calls import ToolResult
from mycli.domain.tooling.output import (
    ToolImageContent,
    ToolJsonContent,
    ToolModelOutput,
    ToolOutputBudgetClass,
    ToolTextContent,
)


def test_tool_model_output_preserves_multiline_text_and_success() -> None:
    text = "one\n```python\nx = 1\n```"

    output = ToolModelOutput.from_text(text, success=True)

    assert output.content == (ToolTextContent(text=text),)
    assert output.success is True
    assert output.budget_class is ToolOutputBudgetClass.DEFAULT


def test_tool_model_output_supports_mixed_content() -> None:
    output = ToolModelOutput(
        content=(
            ToolTextContent(text="result"),
            ToolJsonContent(value={"count": 2}),
            ToolImageContent(image_url="data:image/png;base64,abc", detail="high"),
        ),
        success=True,
        contains_external_context=True,
        budget_class=ToolOutputBudgetClass.SHELL,
    )

    assert output.text_content() == "result\n{\"count\":2}\n[image: data:image/png;base64,abc]"
    assert output.contains_external_context is True
    assert output.budget_class is ToolOutputBudgetClass.SHELL


def test_tool_image_content_rejects_empty_url() -> None:
    with pytest.raises(ValueError, match="image_url"):
        ToolImageContent(image_url="")


def test_tool_result_accepts_optional_typed_model_output() -> None:
    output = ToolModelOutput.from_text("ok", success=True)

    result = ToolResult(success=True, summary="done", model_output=output)

    assert result.model_output is output


def test_legacy_tool_result_constructor_remains_compatible() -> None:
    result = ToolResult(success=True, summary="done", raw_payload={"content": "legacy"})

    assert result.model_output is None
