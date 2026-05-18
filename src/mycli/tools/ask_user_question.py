from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


@dataclass
class AskUserQuestion:
    question: str
    options: list[dict[str, Any]]
    header: str = ""
    multi_select: bool = False

    def __post_init__(self) -> None:
        if len(self.options) < 2 or len(self.options) > 4:
            raise ValueError("2-4 options required")

        self.options = [
            *self.options,
            {"label": "Other", "description": "Custom answer"},
        ]


def ask_user_question(
    question: str,
    options: list[dict[str, Any]],
    header: str | None = None,
    multi_select: bool = False,
) -> dict[str, Any]:
    question_request = AskUserQuestion(
        question=question,
        options=options,
        header=header or "",
        multi_select=multi_select,
    )
    return {
        "question": question_request.question,
        "options": question_request.options,
        "header": question_request.header,
        "multi_select": question_request.multi_select,
        "status": "awaiting_user_response",
    }


class AskUserQuestionTool:
    name = "AskUserQuestion"
    spec = ToolSpec(
        name="AskUserQuestion",
        description="Ask the user a structured question with 2-4 options plus implicit Other.",
        parameters=(
            ToolParameter(name="question", type="string", required=True),
            ToolParameter(name="options", type="array", required=True),
            ToolParameter(name="header", type="string", required=False),
            ToolParameter(name="multi_select", type="boolean", required=False),
        ),
        risk_level="low",
    )

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        try:
            options = arguments.get("options")
            if not isinstance(options, list):
                raise ValueError("AskUserQuestion requires options.")
            payload = ask_user_question(
                question=str(arguments.get("question") or ""),
                options=[dict(item) for item in options if isinstance(item, dict)],
                header=arguments.get("header") if isinstance(arguments.get("header"), str) else None,
                multi_select=bool(arguments.get("multi_select", False)),
            )
        except ValueError as exc:
            return ToolResult(
                success=False,
                summary="Failed to ask user question",
                error=str(exc),
            )
        return ToolResult(
            success=True,
            summary="Awaiting user response",
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
