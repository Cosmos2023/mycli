from __future__ import annotations

from mycli.domain.tooling.calls import ToolResult
from mycli.domain.tooling.output import ToolModelOutput, ToolOutputBudgetClass
from mycli.services.context.tool_output_projector import ToolModelOutputProjector


def test_projector_prefers_typed_output_over_legacy_payload() -> None:
    result = ToolResult(
        success=True,
        summary="legacy summary",
        raw_payload={"content": "legacy body"},
        model_output=ToolModelOutput.from_text("typed body", success=True),
    )

    projection = ToolModelOutputProjector().project("Anything", result)

    assert projection.text_content() == "typed body"


def test_projector_uses_stable_legacy_fallback() -> None:
    result = ToolResult(success=False, summary="Failed", error="bad input")

    projection = ToolModelOutputProjector().project("UnknownTool", result)

    assert projection.success is False
    assert projection.text_content() == "UnknownTool failed\nError: bad input"


def test_projector_applies_budget_class_limit() -> None:
    result = ToolResult(
        success=True,
        summary="done",
        model_output=ToolModelOutput.from_text(
            "HEAD" + "x" * 3000 + "TAIL",
            success=True,
            budget_class=ToolOutputBudgetClass.SHELL,
        ),
    )
    projector = ToolModelOutputProjector(shell_max_chars=200)

    projection = projector.project("Shell", result)

    assert len(projection.text_content()) <= 200
    assert "HEAD" in projection.text_content()
    assert "TAIL" in projection.text_content()
    assert projection.truncation is not None


def test_projector_infers_success_when_typed_output_omits_it() -> None:
    result = ToolResult(
        success=False,
        summary="failed",
        model_output=ToolModelOutput.from_text("details"),
    )

    projection = ToolModelOutputProjector().project("Anything", result)

    assert projection.success is False
