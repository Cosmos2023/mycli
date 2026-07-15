from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
from typing import Literal, TypeAlias


ToolImageDetail = Literal["auto", "low", "high", "original"]


class ToolOutputBudgetClass(str, Enum):
    DEFAULT = "default"
    READ = "read"
    READ_RANGE = "read_range"
    SHELL = "shell"
    INSTRUCTION = "instruction"


@dataclass(frozen=True, slots=True)
class ToolTextContent:
    text: str


@dataclass(frozen=True, slots=True)
class ToolImageContent:
    image_url: str
    detail: ToolImageDetail | None = None

    def __post_init__(self) -> None:
        if not self.image_url.strip():
            raise ValueError("tool image content requires image_url")


@dataclass(frozen=True, slots=True)
class ToolJsonContent:
    value: object


ToolOutputContent: TypeAlias = ToolTextContent | ToolImageContent | ToolJsonContent


@dataclass(frozen=True, slots=True)
class ToolOutputTruncation:
    original_chars: int
    retained_chars: int
    omitted_chars: int
    policy: Literal["head_tail"] = "head_tail"

    def __post_init__(self) -> None:
        values = (self.original_chars, self.retained_chars, self.omitted_chars)
        if any(value < 0 for value in values):
            raise ValueError("tool output truncation counts must be non-negative")


@dataclass(frozen=True, slots=True)
class ToolModelOutput:
    content: tuple[ToolOutputContent, ...]
    success: bool | None = None
    contains_external_context: bool = False
    budget_class: ToolOutputBudgetClass = ToolOutputBudgetClass.DEFAULT
    truncation: ToolOutputTruncation | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "content", tuple(self.content))

    @classmethod
    def from_text(
        cls,
        text: str,
        *,
        success: bool | None = None,
        contains_external_context: bool = False,
        budget_class: ToolOutputBudgetClass = ToolOutputBudgetClass.DEFAULT,
    ) -> ToolModelOutput:
        return cls(
            content=(ToolTextContent(text=text),),
            success=success,
            contains_external_context=contains_external_context,
            budget_class=budget_class,
        )

    @classmethod
    def from_json(
        cls,
        value: object,
        *,
        success: bool | None = None,
        contains_external_context: bool = False,
        budget_class: ToolOutputBudgetClass = ToolOutputBudgetClass.DEFAULT,
    ) -> ToolModelOutput:
        return cls(
            content=(ToolJsonContent(value=value),),
            success=success,
            contains_external_context=contains_external_context,
            budget_class=budget_class,
        )

    def text_content(self) -> str:
        return "\n".join(_content_item_text(item) for item in self.content)


def _content_item_text(item: ToolOutputContent) -> str:
    if isinstance(item, ToolTextContent):
        return item.text
    if isinstance(item, ToolImageContent):
        return f"[image: {item.image_url}]"
    return json.dumps(
        item.value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


__all__ = [
    "ToolImageContent",
    "ToolImageDetail",
    "ToolJsonContent",
    "ToolModelOutput",
    "ToolOutputBudgetClass",
    "ToolOutputContent",
    "ToolOutputTruncation",
    "ToolTextContent",
]
