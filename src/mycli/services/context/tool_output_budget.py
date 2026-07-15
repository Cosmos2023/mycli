from __future__ import annotations

from dataclasses import replace
import json

from mycli.domain.tooling.output import (
    ToolImageContent,
    ToolJsonContent,
    ToolModelOutput,
    ToolOutputContent,
    ToolOutputTruncation,
    ToolTextContent,
)


class ToolOutputBudgeter:
    def apply(self, output: ToolModelOutput, *, max_chars: int) -> ToolModelOutput:
        if max_chars < 0:
            raise ValueError("tool output max_chars must be non-negative")

        text = _combined_text(output.content)
        if len(text) <= max_chars:
            return output

        bounded, retained_chars = _head_tail(text, max_chars=max_chars)
        images = tuple(item for item in output.content if isinstance(item, ToolImageContent))
        content: tuple[ToolOutputContent, ...] = (
            ToolTextContent(text=bounded),
            *images,
        )
        omitted_chars = max(0, len(text) - retained_chars)
        return replace(
            output,
            content=content,
            truncation=ToolOutputTruncation(
                original_chars=len(text),
                retained_chars=retained_chars,
                omitted_chars=omitted_chars,
            ),
        )


def _combined_text(content: tuple[ToolOutputContent, ...]) -> str:
    parts: list[str] = []
    for item in content:
        if isinstance(item, ToolTextContent):
            parts.append(item.text)
        elif isinstance(item, ToolJsonContent):
            parts.append(
                json.dumps(
                    item.value,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
    return "\n".join(parts)


def _head_tail(text: str, *, max_chars: int) -> tuple[str, int]:
    if max_chars == 0:
        return "", 0
    if max_chars >= len(text):
        return text, len(text)

    omitted_chars = len(text)
    for _ in range(4):
        marker = f"\n... [{omitted_chars} chars omitted] ...\n"
        content_budget = max(0, max_chars - len(marker))
        head_chars = (content_budget + 1) // 2
        tail_chars = content_budget - head_chars
        retained_chars = head_chars + tail_chars
        next_omitted = len(text) - retained_chars
        if next_omitted == omitted_chars:
            break
        omitted_chars = next_omitted

    marker = f"\n... [{omitted_chars} chars omitted] ...\n"
    if len(marker) >= max_chars:
        return marker[:max_chars], 0
    content_budget = max_chars - len(marker)
    head_chars = (content_budget + 1) // 2
    tail_chars = content_budget - head_chars
    tail = text[-tail_chars:] if tail_chars else ""
    return f"{text[:head_chars]}{marker}{tail}", head_chars + tail_chars


__all__ = ["ToolOutputBudgeter"]
