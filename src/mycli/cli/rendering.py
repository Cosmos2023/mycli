from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from mycli.domain.runtime import (
    DecisionAction,
    PendingDecision,
    RuntimeStreamEvent,
    TurnItem,
    TurnItemType,
    TurnRecord,
)

if TYPE_CHECKING:
    from rich.status import Status
    from rich.syntax import Syntax
    from rich.text import Text


@dataclass(slots=True)
class StreamingRenderState:
    """Small stdlib streaming surface used when rich is unavailable."""

    _chunks: list[str] = field(default_factory=list)
    active_tool: str | None = None

    def append_chunk(self, chunk: str) -> str | None:
        if not chunk:
            return None
        self._chunks.append(chunk)
        return f"[stream] {''.join(self._chunks)}"

    def start_tool(self, tool_name: str, message: str = "") -> str:
        self.active_tool = tool_name
        suffix = f": {message}" if message else ""
        return f"[tool] running {tool_name}{suffix}"

    def finish_tool(self, tool_name: str, message: str = "") -> str:
        if self.active_tool == tool_name:
            self.active_tool = None
        suffix = f": {message}" if message else ""
        return f"[tool] done {tool_name}{suffix}"

    @property
    def text(self) -> str:
        return "".join(self._chunks)


def render_pending_decision(decision: PendingDecision) -> list[str]:
    option_labels = {
        DecisionAction.APPROVE_ONCE: "[1] 仅本次允许",
        DecisionAction.REJECT: "[2] 拒绝",
        DecisionAction.ALLOW_SESSION: "[3] 本次会话内始终允许同类命令",
    }
    rendered = [
        "[decision] 发现需要确认的操作：",
        f"[decision] Tool: {decision.tool_call.name}",
        f"[decision] Preview: {decision.preview}",
        f"[decision] Reason: {decision.reason}",
    ]
    rendered.extend(option_labels[action] for action in decision.options)
    return rendered


def render_activity_lines(response: object) -> list[str]:
    raw_turn = getattr(response, "turn", None)
    if isinstance(raw_turn, TurnRecord):
        turn_lines = _render_turn_activity_lines(raw_turn)
        if turn_lines:
            return turn_lines

    raw_events = getattr(response, "activity_events", ())
    if not isinstance(raw_events, tuple):
        return []
    lines: list[str] = []
    for event in raw_events:
        message = getattr(event, "message", None)
        if isinstance(message, str) and message:
            rendered = _render_activity_event_message(event)
            lines.append(f"[activity] {rendered}")
    return lines


def render_progress_lines(response: object) -> list[str]:
    raw_updates = getattr(response, "progress_updates", ())
    if not isinstance(raw_updates, tuple):
        return []
    has_structured_activity = bool(render_activity_lines(response)) and isinstance(
        getattr(response, "turn", None),
        TurnRecord,
    )
    lines: list[str] = []
    for update in raw_updates:
        if not isinstance(update, str) or not update:
            continue
        if has_structured_activity and not update.startswith("[decision]"):
            continue
        lines.append(f"[progress] {update}")
    return lines


def _render_turn_activity_lines(turn: TurnRecord) -> list[str]:
    lines: list[str] = []
    reasoning_label: str | None = None
    reasoning_fragments: list[str] = []
    for item in turn.items:
        if item.type == TurnItemType.REASONING:
            if _is_provider_reasoning_item(item):
                _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
                reasoning_label = None
                reasoning_fragments = []
                _append_provider_reasoning_activity_line(lines, item)
                continue
            label, body = _split_reasoning_item(item.text)
            activity_kind = item.metadata.get("activity_kind")
            if activity_kind == "planning":
                label = "Planning"
            if label is None or not body:
                continue
            if reasoning_fragments and reasoning_label != label:
                _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
                reasoning_fragments = []
            reasoning_label = label
            reasoning_fragments.append(body)
            continue

        if item.type not in {
            TurnItemType.TOOL_EXPOSURE,
            TurnItemType.TOOL_CALL,
            TurnItemType.TOOL_RESULT,
            TurnItemType.APPROVAL_REQUEST,
            TurnItemType.APPROVAL_RESOLUTION,
            TurnItemType.WARNING,
        }:
            continue
        _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
        reasoning_label = None
        reasoning_fragments = []
        rendered_item = _render_turn_item_activity_message(item)
        if rendered_item:
            _append_unique_activity_line(lines, f"[activity] {rendered_item}")

    _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
    return lines


def _is_provider_reasoning_item(item: TurnItem) -> bool:
    return item.metadata.get("source") == "provider_reasoning_content"


def _append_provider_reasoning_activity_line(
    lines: list[str],
    item: TurnItem,
) -> None:
    body = _reasoning_body(item.text)
    if not body:
        return
    _append_unique_activity_line(lines, f"[activity] Thinking: {body}")


def _flush_reasoning_activity(
    lines: list[str],
    label: str | None,
    fragments: list[str],
) -> None:
    if label is None or not fragments:
        return
    merged = _join_reasoning_fragments(fragments)
    if not merged:
        return
    if _is_noisy_reasoning_activity(label, merged):
        return
    semantic = _semanticize_reasoning_activity(label, merged)
    if semantic is not None:
        _append_unique_activity_line(lines, f"[activity] {semantic}")
        return
    summarized = _summarize_reasoning_text(merged)
    if not summarized:
        return
    _append_unique_activity_line(lines, f"[activity] {label}: {summarized}")


def _render_activity_event_message(event: object) -> str:
    message = getattr(event, "message", "")
    message = message if isinstance(message, str) else ""
    kind = getattr(event, "kind", None)
    if _has_display_prefix(message):
        return message
    if kind in {"thinking", "planning"}:
        semantic = _semanticize_reasoning_activity(
            "Planning" if kind == "planning" else "Thinking",
            message,
        )
        if semantic is not None:
            return semantic
        return f"{'Planning' if kind == 'planning' else 'Thinking'}: {message}"
    if kind == "tool_exposure":
        return f"Tool exposure: tools={message or 'none'}"
    if kind == "tool_lifecycle":
        return f"Tool: {message}"
    if kind == "tool_started":
        return _render_tool_activity_message(
            tool_name=getattr(event, "tool_name", None),
            text=message,
            finished=False,
        )
    if kind == "tool_finished":
        return _render_tool_activity_message(
            tool_name=getattr(event, "tool_name", None),
            text=message,
            finished=True,
        )
    return message


def _render_turn_item_activity_message(item: TurnItem) -> str | None:
    if item.text and _has_display_prefix(item.text):
        return item.text
    if item.type == TurnItemType.TOOL_EXPOSURE:
        if item.tool_name:
            return f"Tool: {item.text or item.tool_name}"
        tool_names = item.metadata.get("tool_names")
        if isinstance(tool_names, list):
            rendered_names = ", ".join(str(name) for name in tool_names) or "none"
        else:
            rendered_names = item.text or "none"
        return f"Tool exposure: tools={rendered_names}"
    if item.type == TurnItemType.TOOL_CALL:
        return _render_tool_activity_message(
            tool_name=item.tool_name,
            text=item.text or item.tool_name or "tool",
            finished=False,
        )
    if item.type == TurnItemType.TOOL_RESULT:
        return _render_tool_activity_message(
            tool_name=item.tool_name,
            text=item.text or item.tool_name or "tool",
            finished=True,
        )
    return item.text


def _render_tool_activity_message(
    *,
    tool_name: object,
    text: str,
    finished: bool,
) -> str:
    name = tool_name if isinstance(tool_name, str) else ""
    if _has_display_prefix(text):
        return text
    if not finished:
        if name == "list_directory":
            return f"Listing: {text}"
        if name in {"read_file", "read_file_range"}:
            return f"Reading: {text}"
        if name == "search_text":
            return f"Searching: {text}"
        if name in {"edit_file", "replace_in_file"}:
            return f"Editing: {text}"
        if name == "append_file":
            return f"Appending: {text}"
        if name == "update_plan":
            return f"Planning: {text}"
        if name.startswith("git_"):
            return f"Git: {text}"
        if name == "run_shell":
            return f"Shell: {text}"
        return f"Tool: {text}"
    if name == "search_text":
        return f"Done searching: {text}"
    if name in {"read_file", "read_file_range"}:
        return f"Done reading: {text}"
    if name in {"edit_file", "replace_in_file"}:
        return f"Done editing: {text}"
    if name == "append_file":
        return f"Done appending: {text}"
    if name == "update_plan":
        return f"Done planning: {text}"
    if name.startswith("git_"):
        return f"Done git: {text}"
    if name == "run_shell":
        return f"Done shell: {text}"
    return f"Done: {text}"


def _has_display_prefix(text: str) -> bool:
    return text.startswith(
        (
            "Thinking:",
            "Planning:",
            "Tool exposure:",
            "Tool:",
            "Listing:",
            "Reading:",
            "Searching:",
            "Editing:",
            "Appending:",
            "Git:",
            "Shell:",
            "Done:",
            "Done ",
        )
    )


def _append_unique_activity_line(lines: list[str], line: str) -> None:
    if line in lines:
        return
    if line.startswith("[activity] 正在查看 ") and any(
        existing in {
            "[activity] 正在检查仓库结构",
            "[activity] 正在定位入口与主要模块",
            "[activity] 正在读取源码确认架构事实",
            "[activity] 已从确认的证据收口回答",
        }
        for existing in lines
    ):
        return
    lines.append(line)


def _split_reasoning_item(text: str | None) -> tuple[str | None, str]:
    if not isinstance(text, str):
        return None, ""
    stripped = text.strip()
    if not stripped:
        return None, ""
    for prefix in ("Thinking:", "Planning:"):
        if stripped.startswith(prefix):
            return prefix[:-1], stripped[len(prefix) :].strip()
    return "Thinking", stripped


def _reasoning_body(text: str | None) -> str:
    _, body = _split_reasoning_item(text)
    return body


def _join_reasoning_fragments(fragments: list[str]) -> str:
    merged = ""
    for fragment in fragments:
        piece = _normalize_whitespace(fragment)
        if not piece:
            continue
        if not merged:
            merged = piece
            continue
        if piece[0] in ",.!?;:)]}%":
            merged += piece
            continue
        if _is_cjk_character(merged[-1]) and _is_cjk_character(piece[0]):
            merged += piece
            continue
        merged += f" {piece}"
    return merged


def _summarize_reasoning_text(text: str, max_length: int = 140) -> str:
    normalized = _normalize_whitespace(text)
    if len(normalized) <= max_length:
        return normalized
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?。！？])\s+", normalized)
        if sentence.strip()
    ]
    candidate = ""
    for sentence in sentences:
        proposed = sentence if not candidate else f"{candidate} {sentence}"
        if len(proposed) > max_length:
            break
        candidate = proposed
        if len(candidate) >= 48:
            break
    if candidate:
        return candidate
    return f"{normalized[: max_length - 1].rstrip()}…"


def _semanticize_reasoning_activity(label: str | None, text: str) -> str | None:
    normalized = _normalize_whitespace(text)
    if not normalized:
        return None
    if normalized.startswith("已从确认的证据收口回答"):
        return "已从确认的证据收口回答"
    if normalized in {
        "正在检查仓库结构",
        "正在定位入口与主要模块",
        "正在读取源码确认架构事实",
        "已从确认的证据收口回答",
    }:
        return normalized
    lowered = normalized.lower()
    lowered = lowered.removeprefix("thinking: ").removeprefix("planning: ")

    if any(
        phrase in lowered
        for phrase in (
            "the user wants",
            "user wants me to",
            "user asked",
            "the user needs",
            "task is to",
        )
    ):
        return "正在理解任务目标"

    if label == "Planning" and "summar" in lowered:
        return "正在整理结论"

    if any(
        phrase in lowered
        for phrase in (
            "i have enough information",
            "output the summary",
            "summary now",
            "construct the response",
            "provide a brief summary",
            "provide a short summary",
            "organize the answer",
        )
    ):
        return "正在整理结论"

    targets = _extract_reasoning_targets(normalized)
    if targets and any(
        phrase in lowered
        for phrase in (
            "look at",
            "check",
            "inspect",
            "explore",
            "read",
            "list",
            "view",
        )
    ):
        rendered_targets = "、".join(f"`{target}`" for target in targets)
        return f"正在查看 {rendered_targets}"

    if any(
        phrase in lowered
        for phrase in (
            "workspace structure",
            "repository structure",
            "directory structure",
            "main structure",
            "project structure",
            "architecture pattern",
        )
    ):
        return "正在分析仓库结构"

    return None


def _is_noisy_reasoning_activity(label: str | None, text: str) -> bool:
    normalized = _normalize_whitespace(text)
    if not normalized:
        return True
    lowered = normalized.lower()

    prompt_echo_markers = (
        "available tools",
        "current plan",
        "runtime reminders",
        "conversation summary",
        "recent conversation",
        "current user request",
        "do not emit json",
        "input_text",
        "tool_call",
        "tool_result",
        "plan: none",
    )
    if any(marker in lowered for marker in prompt_echo_markers):
        return True

    if label == "Planning" and any(
        marker in lowered
        for marker in (
            "update_plan",
            "/plans/",
            "_text",
        )
    ):
        return True

    stripped = normalized.strip()
    if len(stripped) <= 24 and any(char in stripped for char in ("`", "_", "/", '"')):
        alpha_count = sum(char.isalpha() for char in stripped)
        if alpha_count <= max(8, len(stripped) // 2):
            return True

    return False


def _extract_reasoning_targets(text: str) -> list[str]:
    targets: list[str] = []
    checks = (
        (r"\bpy\s*project\.toml\b|\bpyproject\.toml\b", "pyproject.toml"),
        (r"\breadme(?:\.md)?\b", "README.md"),
        (r"\bsrc/mycli\b", "src/mycli/"),
        (r"`?\bsrc/`?|\bsrc(?: directory| tree| structure)\b", "src/"),
    )
    for pattern, target in checks:
        if re.search(pattern, text, flags=re.IGNORECASE) and target not in targets:
            targets.append(target)
    return targets


def _normalize_whitespace(text: str) -> str:
    return " ".join(text.split())


def _is_cjk_character(value: str) -> bool:
    codepoint = ord(value)
    return (
        0x4E00 <= codepoint <= 0x9FFF
        or 0x3400 <= codepoint <= 0x4DBF
        or 0x3040 <= codepoint <= 0x30FF
        or 0xAC00 <= codepoint <= 0xD7AF
    )


def render_error_lines(response: object) -> list[str]:
    raw_details = getattr(response, "error_details", ())
    if not isinstance(raw_details, tuple):
        return []
    lines: list[str] = []
    for detail in raw_details:
        if isinstance(detail, str) and detail:
            lines.append(f"[error] {detail}")
    return lines


def render_stream_lines(response: object) -> list[str]:
    assistant_message = getattr(response, "assistant_message", None)
    if isinstance(assistant_message, str) and assistant_message:
        return []
    raw_chunks = getattr(response, "streamed_chunks", ())
    if not isinstance(raw_chunks, tuple):
        return []
    lines: list[str] = []
    for chunk in raw_chunks:
        if isinstance(chunk, str) and chunk:
            lines.append(f"[stream] {chunk}")
    return lines


def render_runtime_stream_event(event: RuntimeStreamEvent) -> list[str]:
    if event.kind == "text_delta":
        return [f"[stream] {event.text}"] if event.text else []
    if event.kind == "reasoning":
        return [f"[activity] Thinking: {event.text}"] if event.text else []
    if event.kind == "tool_call":
        return [f"[activity] Tool: {event.tool_name}"] if event.tool_name else []
    if event.kind == "completed":
        return []
    return []


def render_streaming_state_lines(response: object) -> list[str]:
    raw_chunks = getattr(response, "streamed_chunks", ())
    if not isinstance(raw_chunks, tuple):
        return []
    state = StreamingRenderState()
    lines: list[str] = []
    for chunk in raw_chunks:
        if not isinstance(chunk, str):
            continue
        rendered = state.append_chunk(chunk)
        if rendered is not None:
            lines.append(rendered)
    return lines


def render_streaming_live_output(response: object) -> list["Text"]:
    return _render_rich_streaming_output(response)


def render_tool_status(tool_name: str, message: str = "") -> "Status":
    from rich.status import Status

    rendered_message = f"{tool_name}: {message}" if message else tool_name
    return Status(rendered_message)


def render_diff_view(diff: str) -> "Syntax":
    from rich.syntax import Syntax

    return Syntax(diff, "diff", line_numbers=True)


def _render_rich_streaming_output(response: object) -> list["Text"]:
    from rich.live import Live
    from rich.text import Text

    raw_chunks = getattr(response, "streamed_chunks", ())
    if not isinstance(raw_chunks, tuple):
        return []
    output: list[Text] = []
    state = StreamingRenderState()
    for chunk in raw_chunks:
        if not isinstance(chunk, str):
            continue
        state.append_chunk(chunk)
        with Live(Text(state.text), refresh_per_second=12, transient=True) as live:
            live.update(Text(state.text))
        output.append(Text(state.text))
    return output


def render_diff_lines(diff: str, *, max_lines: int = 80) -> list[str]:
    if not diff:
        return []
    rendered: list[str] = []
    for number, line in enumerate(diff.splitlines(), start=1):
        if len(rendered) >= max_lines:
            rendered.append(f"... truncated after {max_lines} lines")
            break
        rendered.append(f"{number:>4} {_diff_prefix(line)}{line}")
    return rendered


def _diff_prefix(line: str) -> str:
    if line.startswith("+") and not line.startswith("+++"):
        return "[+]"
    if line.startswith("-") and not line.startswith("---"):
        return "[-]"
    if line.startswith("@@"):
        return "[@]"
    return "   "
