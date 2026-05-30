from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.tooling.calls import ToolCall


@dataclass(slots=True, frozen=True)
class PendingClarification:
    request_id: str
    tool_call: ToolCall
    question: str
    options: tuple[dict[str, object], ...] = ()
    header: str = ""
    multi_select: bool = False

    def __post_init__(self) -> None:
        if not self.request_id.strip():
            raise ValueError("PendingClarification requires a request_id.")
        if not self.question.strip():
            raise ValueError("PendingClarification requires a question.")
