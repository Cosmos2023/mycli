from __future__ import annotations

from dataclasses import dataclass
from typing import Any


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
