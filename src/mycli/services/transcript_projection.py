from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from mycli.domain.conversation import Message
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.tool_display import ToolDisplayEnvelope

SHELL_TRANSCRIPT_MAX_CHARS = 8_000

_LEGACY_TURN_ABORTED_MARKER = (
    "<turn_aborted>\n"
    "The user interrupted the previous turn on purpose. Any running tools or "
    "commands may have partially executed.\n"
    "</turn_aborted>"
)

_SHELL_TOOL_NAMES = frozenset({"bash", "bashoutput", "run_shell", "shell"})
_VISIBLE_HISTORY_TYPES = frozenset(
    {
        HistoryItemType.USER_MESSAGE,
        HistoryItemType.ASSISTANT_MESSAGE,
        HistoryItemType.REASONING,
        HistoryItemType.TOOL_CALL,
        HistoryItemType.TOOL_RESULT,
        HistoryItemType.APPROVAL_REQUEST,
        HistoryItemType.APPROVAL_RESOLUTION,
        HistoryItemType.CLARIFICATION_RESPONSE,
        HistoryItemType.WARNING,
        HistoryItemType.COMPACTION,
        HistoryItemType.FILE_CHANGE,
        HistoryItemType.PLAN_UPDATE,
    }
)
_TUI_METADATA_KEYS = frozenset(
    {
        "path",
        "command",
        "command_preview",
        "query",
        "skill_name",
        "context",
        "content_preview",
        "content_line_count",
        "content_truncated",
        "diff",
        "diff_truncated",
        "output_preview",
        "error",
        "duration_ms",
        "duration_s",
        "status",
        "success",
        "mutating",
        "file_changes",
        "hidden_line_count",
        "summary_truncated",
        "error_truncated",
        "truncated",
        "omitted_chars",
        "process_state",
        "terminal_state",
        "exit_code",
        "shell_id",
        "shell_kind",
        "shell_edition",
        "background",
        "output_chars",
        "omitted_output_chars",
        "cleanup_result",
        "started_at",
        "completed_at",
    }
)
_BOUNDED_METADATA_TEXT_KEYS = frozenset(
    {"content_preview", "diff", "output_preview", "error"}
)


@dataclass(frozen=True, slots=True)
class TranscriptSnapshotItem:
    id: str
    type: str
    text: str = ""
    created_at: str | None = None
    tool_name: str | None = None
    call_id: str | None = None
    command: str | None = None
    status: str | None = None
    output: str | None = None
    exit_code: int | None = None
    duration_ms: int | None = None
    truncated: bool = False
    omitted_chars: int = 0
    metadata: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {"id": self.id, "type": self.type}
        optional: dict[str, object | None] = {
            "text": self.text,
            "created_at": self.created_at,
            "tool_name": self.tool_name,
            "call_id": self.call_id,
            "command": self.command,
            "status": self.status,
            "output": self.output,
            "exit_code": self.exit_code,
            "duration_ms": self.duration_ms,
            "truncated": self.truncated or None,
            "omitted_chars": self.omitted_chars or None,
            "metadata": self.metadata or None,
        }
        payload.update(
            {
                key: value
                for key, value in optional.items()
                if value is not None and value != ""
            }
        )
        return payload


def project_history_items_for_snapshot(
    items: tuple[HistoryItem, ...],
) -> tuple[TranscriptSnapshotItem, ...]:
    projected: list[TranscriptSnapshotItem] = []
    tool_indexes: dict[str, int] = {}
    for item in items:
        if item.type not in _VISIBLE_HISTORY_TYPES:
            continue
        if (
            item.type is HistoryItemType.USER_MESSAGE
            and _is_internal_turn_aborted_marker(item.metadata)
        ):
            continue
        if item.type is HistoryItemType.PLAN_UPDATE:
            projected.append(_plan_update_snapshot_item(item))
            continue
        if item.type is HistoryItemType.TOOL_CALL:
            snapshot_item = _tool_call_snapshot_item(item)
            projected.append(snapshot_item)
            if item.call_id:
                tool_indexes[item.call_id] = len(projected) - 1
            continue
        if item.type is HistoryItemType.TOOL_RESULT:
            snapshot_item = _tool_result_snapshot_item(item)
            existing_index = tool_indexes.get(item.call_id or "")
            if existing_index is None:
                projected.append(snapshot_item)
                if item.call_id:
                    tool_indexes[item.call_id] = len(projected) - 1
                continue
            existing = projected[existing_index]
            merged_metadata = {**existing.metadata, **snapshot_item.metadata}
            merged_display = _merge_tool_display(
                existing.metadata.get("display"),
                snapshot_item.metadata.get("display"),
            )
            if merged_display is not None:
                merged_metadata["display"] = merged_display
            projected[existing_index] = replace(
                existing,
                tool_name=existing.tool_name or snapshot_item.tool_name,
                call_id=existing.call_id or snapshot_item.call_id,
                status="completed",
                output=snapshot_item.output,
                exit_code=snapshot_item.exit_code,
                duration_ms=snapshot_item.duration_ms,
                truncated=snapshot_item.truncated,
                omitted_chars=snapshot_item.omitted_chars,
                metadata=merged_metadata,
            )
            continue
        projected.append(_history_snapshot_item(item))
    return tuple(projected)


def project_messages_for_snapshot(
    messages: list[Message],
) -> tuple[TranscriptSnapshotItem, ...]:
    projected: list[TranscriptSnapshotItem] = []
    for index, message in enumerate(messages, start=1):
        item_id = f"message-{index}"
        if message.role == "user":
            if _is_internal_turn_aborted_marker(message.metadata):
                continue
            projected.append(
                TranscriptSnapshotItem(id=item_id, type="user_message", text=message.content)
            )
        elif message.role == "assistant" and message.content:
            projected.append(
                TranscriptSnapshotItem(
                    id=item_id,
                    type="assistant_message",
                    text=message.content,
                )
            )
        elif message.role == "tool" and message.content:
            output, omitted = _bounded_head_tail(message.content, SHELL_TRANSCRIPT_MAX_CHARS)
            projected.append(
                TranscriptSnapshotItem(
                    id=item_id,
                    type="tool",
                    call_id=message.tool_call_id,
                    status="completed",
                    output=output,
                    truncated=omitted > 0,
                    omitted_chars=omitted,
                )
            )
    return tuple(projected)


def _is_internal_turn_aborted_marker(metadata: dict[str, object]) -> bool:
    return metadata.get("event_kind") == "turn_aborted_marker"


def project_history_items_for_tui(
    items: tuple[HistoryItem, ...],
) -> tuple[dict[str, object], ...]:
    projected: list[dict[str, object]] = []
    for item in project_history_items_for_snapshot(items):
        projected.extend(snapshot_item_to_tui_items(item.to_dict()))
    return tuple(projected)


def project_history_item_for_tui(item: HistoryItem) -> dict[str, object] | None:
    if item.type is HistoryItemType.COMMAND_RESULT:
        return None
    if item.type is HistoryItemType.PLAN_UPDATE:
        projected = snapshot_item_to_tui_items(
            _plan_update_snapshot_item(item).to_dict()
        )
        return projected[0]
    item_type = {
        HistoryItemType.USER_MESSAGE: "user",
        HistoryItemType.ASSISTANT_MESSAGE: "assistant_final",
        HistoryItemType.REASONING: "reasoning",
        HistoryItemType.TOOL_CALL: "tool_summary",
        HistoryItemType.TOOL_RESULT: "tool_detail",
        HistoryItemType.APPROVAL_REQUEST: "approval",
        HistoryItemType.APPROVAL_RESOLUTION: "system_notice",
        HistoryItemType.CLARIFICATION_RESPONSE: "user",
        HistoryItemType.WARNING: "warning",
        HistoryItemType.COMPACTION: "system_notice",
        HistoryItemType.FILE_CHANGE: "system_notice",
    }.get(item.type, "system_notice")
    metadata = _visible_tui_metadata(item.metadata)
    if item.tool_name:
        metadata["tool_name"] = item.tool_name
    if item.call_id:
        metadata["call_id"] = item.call_id
    created_at = _optional_str(item.metadata.get("created_at")) or ""
    return {
        "id": item.id,
        "type": item_type,
        "text": item.text or "",
        "created_at": created_at,
        "folded": item_type == "tool_detail",
        "metadata": metadata,
    }


def snapshot_item_to_tui_items(
    payload: dict[str, object],
) -> tuple[dict[str, object], ...]:
    item_id = _optional_str(payload.get("id"))
    item_type = _optional_str(payload.get("type"))
    if item_id is None or item_type is None:
        return ()
    text = _optional_str(payload.get("text")) or ""
    created_at = _optional_str(payload.get("created_at")) or ""
    if item_type == "user_message" and text == _LEGACY_TURN_ABORTED_MARKER:
        return ()
    if item_type == "command_result":
        return ()
    if item_type in {"command", "tool"}:
        metadata = _snapshot_tool_metadata(payload)
        summary = {
            "id": item_id,
            "type": "tool_summary",
            "text": text or _optional_str(payload.get("tool_name")) or "Tool",
            "created_at": created_at,
            "folded": False,
            "metadata": metadata,
        }
        return (summary,)
    tui_type = {
        "user_message": "user",
        "clarification_response": "user",
        "assistant_message": "assistant_final",
        "reasoning_summary": "reasoning",
        "warning": "warning",
        "error": "warning",
        "file_change": "system_notice",
        "plan": "system_notice",
        "status": "system_notice",
        "web_search": "tool_summary",
        "image": "tool_summary",
        "subagent": "subagent",
        "plan_update": "plan_update",
    }.get(item_type)
    if tui_type is None:
        return ()
    raw_metadata = payload.get("metadata")
    return (
        {
            "id": item_id,
            "type": tui_type,
            "text": text,
            "created_at": created_at,
            "folded": False,
            "metadata": dict(raw_metadata) if isinstance(raw_metadata, dict) else {},
        },
    )


def _history_snapshot_item(item: HistoryItem) -> TranscriptSnapshotItem:
    snapshot_type = {
        HistoryItemType.USER_MESSAGE: "user_message",
        HistoryItemType.ASSISTANT_MESSAGE: "assistant_message",
        HistoryItemType.REASONING: "reasoning_summary",
        HistoryItemType.APPROVAL_REQUEST: "warning",
        HistoryItemType.APPROVAL_RESOLUTION: "status",
        HistoryItemType.CLARIFICATION_RESPONSE: "clarification_response",
        HistoryItemType.WARNING: "warning",
        HistoryItemType.COMPACTION: "status",
        HistoryItemType.FILE_CHANGE: "file_change",
    }[item.type]
    return TranscriptSnapshotItem(
        id=item.id,
        type=snapshot_type,
        text=item.text or "",
        created_at=_optional_str(item.metadata.get("created_at")),
        metadata=_visible_snapshot_metadata(item.metadata),
    )


def _plan_update_snapshot_item(item: HistoryItem) -> TranscriptSnapshotItem:
    return TranscriptSnapshotItem(
        id=item.id,
        type="plan_update",
        text=item.text or "Updated Plan",
        created_at=_optional_str(item.metadata.get("created_at")),
        metadata=_visible_plan_update_metadata(item.metadata),
    )


def _visible_plan_update_metadata(metadata: dict[str, Any]) -> dict[str, object]:
    items: list[dict[str, object]] = []
    raw_items = metadata.get("items")
    if isinstance(raw_items, list):
        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                continue
            item_id = _optional_str(raw_item.get("id"))
            text = _optional_str(raw_item.get("text"))
            if item_id is None or text is None:
                continue
            raw_status = _optional_str(raw_item.get("status"))
            status = (
                raw_status
                if raw_status in {"pending", "in_progress", "completed"}
                else "pending"
            )
            projected_item: dict[str, object] = {
                "id": item_id,
                "text": text,
                "status": status,
            }
            evidence = raw_item.get("evidence")
            if isinstance(evidence, list):
                visible_evidence = [
                    entry
                    for entry in evidence
                    if isinstance(entry, str) and entry
                ]
                if visible_evidence:
                    projected_item["evidence"] = visible_evidence
            items.append(projected_item)
    completed = _optional_int(metadata.get("completed"))
    total = _optional_int(metadata.get("total"))
    return {
        "source": _optional_str(metadata.get("source")) or "Plan",
        "completed": completed if completed is not None else 0,
        "total": total if total is not None else len(items),
        "items": items,
    }


def _tool_call_snapshot_item(item: HistoryItem) -> TranscriptSnapshotItem:
    tool_name = item.tool_name or "Tool"
    command = _tool_command(item.metadata)
    metadata = _visible_tui_metadata(item.metadata)
    _remove_snapshot_tool_duplicates(metadata)
    return TranscriptSnapshotItem(
        id=item.id,
        type="command" if tool_name.lower() in _SHELL_TOOL_NAMES else "tool",
        text=item.text or "",
        created_at=_optional_str(item.metadata.get("created_at")),
        tool_name=tool_name,
        call_id=item.call_id,
        command=command,
        status=_optional_str(item.metadata.get("status")) or "running",
        metadata=metadata,
    )


def _tool_result_snapshot_item(item: HistoryItem) -> TranscriptSnapshotItem:
    tool_name = item.tool_name or "Tool"
    metadata = _visible_tui_metadata(item.metadata)
    if "display" in metadata:
        metadata.pop("output_preview", None)
        raw_output = ""
    else:
        raw_output = (
            _optional_str(metadata.pop("output_preview", None))
            if tool_name.lower() in _SHELL_TOOL_NAMES
            else None
        ) or item.text or ""
    max_chars = SHELL_TRANSCRIPT_MAX_CHARS if tool_name.lower() in _SHELL_TOOL_NAMES else 8_000
    output, omitted = _bounded_head_tail(raw_output, max_chars)
    _remove_snapshot_tool_duplicates(metadata)
    return TranscriptSnapshotItem(
        id=item.id,
        type="command" if tool_name.lower() in _SHELL_TOOL_NAMES else "tool",
        created_at=_optional_str(item.metadata.get("created_at")),
        tool_name=tool_name,
        call_id=item.call_id,
        command=_tool_command(item.metadata),
        status="completed",
        output=output,
        exit_code=_optional_int(item.metadata.get("exit_code")),
        duration_ms=_optional_int(item.metadata.get("duration_ms")),
        truncated=omitted > 0,
        omitted_chars=omitted,
        metadata=metadata,
    )


def _visible_snapshot_metadata(metadata: dict[str, Any]) -> dict[str, object]:
    return {
        key: metadata[key]
        for key in ("path", "status", "success", "changes")
        if key in metadata and metadata[key] not in (None, "", [], {})
    }


def _visible_tui_metadata(metadata: dict[str, Any]) -> dict[str, object]:
    visible: dict[str, object] = {}
    display = ToolDisplayEnvelope.from_mapping(metadata.get("display"))
    if display is not None:
        visible["display"] = display.to_dict()
    for key in _TUI_METADATA_KEYS:
        value = metadata.get(key)
        if value in (None, "", [], {}):
            continue
        _set_visible_metadata_value(visible, key, value)
    raw_payload = metadata.get("raw_payload")
    if isinstance(raw_payload, dict):
        for key in (
            "path",
            "command",
            "command_preview",
            "query",
            "skill_name",
            "context",
            "diff",
            "exit_code",
            "process_state",
            "terminal_state",
            "shell_id",
            "shell_kind",
            "shell_edition",
            "background",
            "output_chars",
            "omitted_output_chars",
            "cleanup_result",
        ):
            value = raw_payload.get(key)
            if key not in visible and value not in (None, "", [], {}):
                _set_visible_metadata_value(visible, key, value)
        raw_output = _combined_shell_output(raw_payload)
        if "output_preview" not in visible and raw_output:
            _set_visible_metadata_value(visible, "output_preview", raw_output)
    arguments = metadata.get("arguments")
    if isinstance(arguments, dict):
        for source_key, target_key in (
            ("file_path", "path"),
            ("path", "path"),
            ("command", "command"),
            ("query", "query"),
            ("skill_name", "skill_name"),
            ("context", "context"),
        ):
            value = arguments.get(source_key)
            if target_key not in visible and isinstance(value, str) and value:
                visible[target_key] = value
        content = arguments.get("content")
        if "content_preview" not in visible and isinstance(content, str) and content:
            _set_visible_metadata_value(visible, "content_preview", content)
            visible["content_line_count"] = _line_count(content)
    summary = metadata.get("summary")
    if "output_preview" not in visible and isinstance(summary, str) and summary:
        _set_visible_metadata_value(visible, "output_preview", summary)
    return visible


def _merge_tool_display(
    start: object,
    finish: object,
) -> dict[str, object] | None:
    start_display = ToolDisplayEnvelope.from_mapping(start)
    finish_display = ToolDisplayEnvelope.from_mapping(finish)
    if start_display is None:
        return None if finish_display is None else finish_display.to_dict()
    if finish_display is None:
        return start_display.to_dict()
    payload = finish_display.to_dict()
    if not finish_display.target and start_display.target:
        payload["target"] = start_display.target
    return payload


def _snapshot_tool_metadata(payload: dict[str, object]) -> dict[str, object]:
    raw_metadata = payload.get("metadata")
    metadata = (
        _visible_tui_metadata(dict(raw_metadata))
        if isinstance(raw_metadata, dict)
        else {}
    )
    for key in (
        "tool_name",
        "call_id",
        "command",
        "exit_code",
        "duration_ms",
        "truncated",
        "omitted_chars",
    ):
        value = payload.get(key)
        if value not in (None, ""):
            metadata[key] = value
    status = _optional_str(payload.get("status"))
    if status is not None:
        metadata["status"] = "done" if status == "completed" else status
        if status == "completed" and "success" not in metadata:
            metadata["success"] = True
    output = _optional_str(payload.get("output"))
    if output:
        metadata["output_preview"] = output
    return metadata


def _set_visible_metadata_value(
    visible: dict[str, object],
    key: str,
    value: object,
) -> None:
    if key not in _BOUNDED_METADATA_TEXT_KEYS or not isinstance(value, str):
        visible[key] = value
        return
    bounded, omitted = _bounded_head_tail(value, SHELL_TRANSCRIPT_MAX_CHARS)
    visible[key] = bounded
    if omitted <= 0:
        return
    if key == "diff":
        visible["diff_truncated"] = True
    elif key == "content_preview":
        visible["content_truncated"] = True
    else:
        visible["truncated"] = True
        visible["omitted_chars"] = omitted


def _combined_shell_output(payload: dict[str, Any]) -> str:
    stdout = payload.get("stdout")
    stderr = payload.get("stderr")
    chunks = [value for value in (stdout, stderr) if isinstance(value, str) and value]
    return "\n".join(chunks)


def _remove_snapshot_tool_duplicates(metadata: dict[str, object]) -> None:
    for key in (
        "command",
        "output_preview",
        "status",
        "exit_code",
        "duration_ms",
        "truncated",
        "omitted_chars",
    ):
        metadata.pop(key, None)


def _line_count(value: str) -> int:
    stripped = value.rstrip("\n")
    return len(stripped.splitlines()) if stripped else 0


def _tool_command(metadata: dict[str, Any]) -> str | None:
    command = metadata.get("command")
    if isinstance(command, str) and command:
        return command
    arguments = metadata.get("arguments")
    if not isinstance(arguments, dict):
        return None
    command = arguments.get("command")
    if isinstance(command, str) and command:
        return command
    args = arguments.get("args")
    if isinstance(args, list) and all(isinstance(value, str) for value in args):
        return " ".join(args)
    return None


def _bounded_head_tail(value: str, max_chars: int) -> tuple[str, int]:
    if len(value) <= max_chars:
        return value, 0
    marker = "\n... output omitted ...\n"
    retained = max(0, max_chars - len(marker))
    head_chars = retained // 2
    tail_chars = retained - head_chars
    omitted = len(value) - head_chars - tail_chars
    tail = value[-tail_chars:] if tail_chars else ""
    return f"{value[:head_chars]}{marker}{tail}", omitted


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


__all__ = [
    "SHELL_TRANSCRIPT_MAX_CHARS",
    "TranscriptSnapshotItem",
    "project_history_item_for_tui",
    "project_history_items_for_tui",
    "project_history_items_for_snapshot",
    "project_messages_for_snapshot",
    "snapshot_item_to_tui_items",
]
