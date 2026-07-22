from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePosixPath

from mycli.domain.tooling.calls import ToolCall, ToolResult


FILE_CHANGE_VERSION = 1
FILE_CHANGE_MAX_CHARS = 200_000
FILE_CHANGE_MAX_LINES = 5_000


class FileChangeKind(StrEnum):
    ADD = "add"
    UPDATE = "update"
    DELETE = "delete"
    RENAME = "rename"


_STATUS_KINDS = {
    "created": FileChangeKind.ADD,
    "added": FileChangeKind.ADD,
    "written": FileChangeKind.UPDATE,
    "overwritten": FileChangeKind.UPDATE,
    "edited": FileChangeKind.UPDATE,
    "patched": FileChangeKind.UPDATE,
    "deleted": FileChangeKind.DELETE,
    "renamed": FileChangeKind.RENAME,
}


@dataclass(frozen=True, slots=True)
class FileChangeDisplay:
    version: int
    kind: FileChangeKind
    path: str
    previous_path: str | None = None
    diff: str = ""
    added_lines: int = 0
    removed_lines: int = 0
    truncated: bool = False
    omitted_chars: int = 0
    language: str | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "version": self.version,
            "kind": self.kind.value,
            "path": self.path,
            "diff": self.diff,
            "added_lines": self.added_lines,
            "removed_lines": self.removed_lines,
        }
        if self.previous_path:
            payload["previous_path"] = self.previous_path
        if self.truncated:
            payload["truncated"] = True
            payload["omitted_chars"] = self.omitted_chars
        if self.language:
            payload["language"] = self.language
        return payload

    @classmethod
    def from_mapping(cls, value: object) -> FileChangeDisplay | None:
        if not isinstance(value, dict) or value.get("version") != FILE_CHANGE_VERSION:
            return None
        raw_kind = value.get("kind")
        raw_path = value.get("path")
        raw_diff = value.get("diff", "")
        if not isinstance(raw_kind, str) or not isinstance(raw_path, str):
            return None
        if not isinstance(raw_diff, str):
            return None
        try:
            kind = FileChangeKind(raw_kind)
        except ValueError:
            return None
        path = raw_path.strip()
        if not path:
            return None

        normalized_diff = _normalize_diff(raw_diff)
        bounded_diff, bounded_omitted = _bound_diff(normalized_diff)
        counted_added, counted_removed = _count_diff_lines(normalized_diff)
        added_lines = _optional_nonnegative_int(value.get("added_lines"))
        removed_lines = _optional_nonnegative_int(value.get("removed_lines"))
        previous_omitted = _optional_nonnegative_int(value.get("omitted_chars")) or 0
        was_truncated = value.get("truncated") is True
        return cls(
            version=FILE_CHANGE_VERSION,
            kind=kind,
            path=path,
            previous_path=_optional_text(value.get("previous_path")),
            diff=bounded_diff,
            added_lines=counted_added if added_lines is None else added_lines,
            removed_lines=counted_removed if removed_lines is None else removed_lines,
            truncated=was_truncated or bounded_omitted > 0,
            omitted_chars=previous_omitted + bounded_omitted,
            language=_optional_text(value.get("language")) or _language_for_path(path),
        )


def project_file_changes(
    call: ToolCall,
    result: ToolResult,
) -> tuple[FileChangeDisplay, ...]:
    if not result.success:
        return ()

    raw_changes = result.raw_payload.get("file_changes")
    if isinstance(raw_changes, list):
        parsed = tuple(
            change
            for raw_change in raw_changes
            if (change := FileChangeDisplay.from_mapping(raw_change)) is not None
        )
        if parsed:
            return parsed

    status = _optional_text(result.raw_payload.get("status"))
    if status is None or status.lower() == "unchanged":
        return ()
    kind = _STATUS_KINDS.get(status.lower())
    if kind is None:
        return ()
    path = _result_path(call, result.raw_payload)
    if path is None:
        return ()

    raw_diff = result.raw_payload.get("diff", "")
    if not isinstance(raw_diff, str):
        raw_diff = ""
    normalized_diff = _normalize_diff(raw_diff)
    added_lines, removed_lines = _count_diff_lines(normalized_diff)
    bounded_diff, omitted_chars = _bound_diff(normalized_diff)
    return (
        FileChangeDisplay(
            version=FILE_CHANGE_VERSION,
            kind=kind,
            path=path,
            previous_path=_optional_text(
                result.raw_payload.get("previous_path")
                or result.raw_payload.get("old_path")
            ),
            diff=bounded_diff,
            added_lines=added_lines,
            removed_lines=removed_lines,
            truncated=omitted_chars > 0,
            omitted_chars=omitted_chars,
            language=_language_for_path(path),
        ),
    )


def mutation_receipt(result: ToolResult) -> str:
    path = _optional_text(result.raw_payload.get("path"))
    if not result.success:
        if result.error:
            return f"Failed to update {path or 'file'}: {result.error}"
        return result.summary
    if result.raw_payload.get("status") == "unchanged":
        return f"No changes to {path or 'file'}"

    entries = _receipt_entries(result.raw_payload)
    if not entries and path:
        entries = (("M", path),)
    if not entries:
        return result.summary
    return "\n".join(
        (
            "Success. Updated the following files:",
            *(f"{status} {label}" for status, label in entries),
        )
    )


def _receipt_entries(payload: dict[str, object]) -> tuple[tuple[str, str], ...]:
    labels = {
        FileChangeKind.ADD: "A",
        FileChangeKind.UPDATE: "M",
        FileChangeKind.DELETE: "D",
        FileChangeKind.RENAME: "R",
    }
    entries: list[tuple[str, str]] = []
    raw_changes = payload.get("file_changes")
    if isinstance(raw_changes, list):
        for raw_change in raw_changes:
            change = FileChangeDisplay.from_mapping(raw_change)
            if change is None:
                continue
            label = (
                f"{change.previous_path} -> {change.path}"
                if change.kind is FileChangeKind.RENAME and change.previous_path
                else change.path
            )
            entries.append((labels[change.kind], label))
    if entries:
        return tuple(entries)

    path = _optional_text(payload.get("path"))
    status = _optional_text(payload.get("status"))
    kind = _STATUS_KINDS.get((status or "").lower())
    if kind is None or path is None:
        return ()
    return ((labels[kind], path),)


def _result_path(call: ToolCall, payload: dict[str, object]) -> str | None:
    for value in (
        payload.get("path"),
        payload.get("file"),
        call.arguments.get("file_path"),
        call.arguments.get("path"),
    ):
        path = _optional_text(value)
        if path:
            return path
    return None


def _normalize_diff(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _count_diff_lines(diff: str) -> tuple[int, int]:
    added = 0
    removed = 0
    for line in diff.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


def _bound_diff(diff: str) -> tuple[str, int]:
    lines = diff.splitlines(keepends=True)
    if len(diff) <= FILE_CHANGE_MAX_CHARS and len(lines) <= FILE_CHANGE_MAX_LINES:
        return diff, 0

    retained_limit = max(2, FILE_CHANGE_MAX_LINES - 1)
    head_count = min(len(lines), retained_limit // 2)
    tail_count = min(len(lines) - head_count, retained_limit - head_count)

    while head_count + tail_count > 2:
        candidate, omitted = _bounded_line_candidate(lines, head_count, tail_count)
        if len(candidate) <= FILE_CHANGE_MAX_CHARS:
            return candidate, omitted
        head_chars = sum(len(line) for line in lines[:head_count])
        tail_chars = sum(len(line) for line in lines[len(lines) - tail_count :])
        if head_chars >= tail_chars and head_count > 1:
            head_count -= 1
        elif tail_count > 1:
            tail_count -= 1
        else:
            break

    return _bound_diff_by_chars(diff)


def _bounded_line_candidate(
    lines: list[str],
    head_count: int,
    tail_count: int,
) -> tuple[str, int]:
    tail_start = len(lines) - tail_count
    omitted_lines = lines[head_count:tail_start]
    omitted_chars = sum(len(line) for line in omitted_lines)
    marker = (
        f"... {len(omitted_lines)} lines / {omitted_chars} chars omitted ...\n"
    )
    return "".join((*lines[:head_count], marker, *lines[tail_start:])), omitted_chars


def _bound_diff_by_chars(diff: str) -> tuple[str, int]:
    omitted = max(1, len(diff) - FILE_CHANGE_MAX_CHARS)
    while True:
        marker = f"\n... {omitted} chars omitted ...\n"
        retained = max(0, FILE_CHANGE_MAX_CHARS - len(marker))
        updated_omitted = len(diff) - retained
        if updated_omitted == omitted:
            break
        omitted = updated_omitted
    head_chars = retained // 2
    tail_chars = retained - head_chars
    tail = diff[-tail_chars:] if tail_chars else ""
    return f"{diff[:head_chars]}{marker}{tail}", omitted


def _language_for_path(path: str) -> str | None:
    normalized = path.replace("\\", "/")
    suffix = PurePosixPath(normalized).suffix.lstrip(".").lower()
    return suffix or None


def _optional_text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _optional_nonnegative_int(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


__all__ = [
    "FILE_CHANGE_MAX_CHARS",
    "FILE_CHANGE_MAX_LINES",
    "FILE_CHANGE_VERSION",
    "FileChangeDisplay",
    "FileChangeKind",
    "mutation_receipt",
    "project_file_changes",
]
