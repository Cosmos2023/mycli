from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Mapping

from mycli.cli.rendering import RenderOptions, render_activity_lines
from mycli.domain.runtime import (
    RuntimeStreamEvent,
    TurnRecord,
    TurnResponse,
    ViewMode,
)


class TuiTranscriptKind(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    THINKING = "thinking"
    TOOL_SUMMARY = "tool_summary"
    DIFF = "diff"
    WARNING = "warning"
    ERROR = "error"
    APPROVAL = "approval"


@dataclass(slots=True, frozen=True)
class TuiTranscriptItem:
    kind: TuiTranscriptKind
    text: str
    metadata: Mapping[str, object] = field(default_factory=dict)


def items_from_response(
    response: TurnResponse,
    *,
    diff_max_lines: int = 80,
) -> tuple[TuiTranscriptItem, ...]:
    items: list[TuiTranscriptItem] = []
    if isinstance(response.turn, TurnRecord):
        items.extend(_items_from_turn(response.turn, diff_max_lines=diff_max_lines))
    else:
        for event in response.activity_events:
            if event.kind in {"thinking", "planning"} and event.message:
                items.append(
                    TuiTranscriptItem(
                        TuiTranscriptKind.THINKING,
                        _clean_activity(event.message),
                    )
                )
            elif event.kind.startswith("tool") and event.message:
                items.append(
                    TuiTranscriptItem(
                        TuiTranscriptKind.TOOL_SUMMARY,
                        _clean_activity(event.message),
                    )
                )
    for detail in response.error_details:
        items.append(TuiTranscriptItem(TuiTranscriptKind.ERROR, detail))
    if response.pending_decision is not None:
        items.append(
            TuiTranscriptItem(TuiTranscriptKind.APPROVAL, response.pending_decision.preview)
        )
    if response.assistant_message:
        items.append(TuiTranscriptItem(TuiTranscriptKind.ASSISTANT, response.assistant_message))
    return tuple(items)


def summarize_tool_activity(
    events: tuple[RuntimeStreamEvent, ...],
    *,
    max_items: int = 4,
) -> tuple[str, ...]:
    rendered: list[str] = []
    for event in events[:max_items]:
        name = event.tool_name or "tool"
        path = event.metadata.get("path") if isinstance(event.metadata, dict) else None
        target = f" {path}" if isinstance(path, str) and path else ""
        rendered.append(f"{name}{target}")
    omitted = len(events) - max_items
    if omitted > 0:
        rendered.append(f"... {omitted} more tool calls folded")
    return tuple(rendered)


def execution_status_label(*, phase: str, elapsed_seconds: float) -> str:
    label = {
        "thinking": "Thinking...",
        "reading": "Reading files...",
        "searching": "Searching...",
        "running_tests": "Running tests...",
        "running": "Running commands...",
        "editing": "Editing files...",
        "waiting_approval": "Waiting for approval...",
    }.get(phase, "Working...")
    return f"{label} ({int(elapsed_seconds)}s)"


def phase_for_tool(tool_name: str | None) -> str:
    return {
        "Read": "reading",
        "read_file": "reading",
        "WebFetch": "reading",
        "Grep": "searching",
        "Glob": "searching",
        "WebSearch": "searching",
        "Edit": "editing",
        "Write": "editing",
        "MultiEdit": "editing",
        "Bash": "running",
        "Lint": "running_tests",
        "Pytest": "running_tests",
    }.get(tool_name or "", "working")


def append_final_answer(
    *,
    existing_stream: str,
    final_answer: str,
) -> tuple[TuiTranscriptItem, ...]:
    answer = final_answer if final_answer != existing_stream else existing_stream
    return (TuiTranscriptItem(TuiTranscriptKind.ASSISTANT, answer),) if answer else ()


def _items_from_turn(
    turn: TurnRecord,
    *,
    diff_max_lines: int,
) -> tuple[TuiTranscriptItem, ...]:
    rendered = render_activity_lines(
        TurnResponse(assistant_message="", turn=turn),
        options=RenderOptions(view_mode=ViewMode.DEFAULT, diff_max_lines=diff_max_lines),
    )
    items: list[TuiTranscriptItem] = []
    for line in rendered:
        text = line.removeprefix("[activity] ").removeprefix("[diff] ")
        if line.startswith("[diff]"):
            items.append(TuiTranscriptItem(TuiTranscriptKind.DIFF, f"[diff] {text}"))
        elif "Thinking:" in line or "Planning:" in line:
            items.append(TuiTranscriptItem(TuiTranscriptKind.THINKING, _clean_activity(text)))
        else:
            items.append(
                TuiTranscriptItem(TuiTranscriptKind.TOOL_SUMMARY, _clean_activity(text))
            )
    return tuple(items)


def _clean_activity(text: str) -> str:
    return (
        text.removeprefix("[activity] ")
        .removeprefix("Thinking: ")
        .removeprefix("Planning: ")
        .strip()
    )
