from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

DISPLAY_VERSION = 1
MAX_TEXT_CHARS = 8_000
MAX_VALUE_CHARS = 2_048
MAX_ROWS = 100
MAX_SECTIONS = 16


class SlashCommandDisplayKind(StrEnum):
    STATUS = "status"
    DIAGNOSTIC = "diagnostic"
    LIST = "list"
    NOTICE = "notice"
    ERROR = "error"
    PREFORMATTED = "preformatted"


class SlashCommandSeverity(StrEnum):
    INFO = "info"
    SUCCESS = "success"
    WARNING = "warning"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class SlashCommandField:
    label: str
    value: str
    tone: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "label", _required_text(self.label, "field label"))
        object.__setattr__(self, "value", _bounded_text(self.value))
        object.__setattr__(self, "tone", _optional_text(self.tone))

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {"label": self.label, "value": self.value}
        if self.tone:
            payload["tone"] = self.tone
        return payload

    @classmethod
    def from_payload(cls, payload: object) -> SlashCommandField:
        record = _mapping(payload, "field")
        return cls(
            label=_required_payload_text(record, "label"),
            value=_payload_text(record, "value"),
            tone=_optional_payload_text(record, "tone"),
        )


@dataclass(frozen=True, slots=True)
class SlashCommandRow:
    key: str
    label: str
    values: tuple[str, ...] = ()
    status: str | None = None
    detail: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "key", _required_text(self.key, "row key"))
        object.__setattr__(self, "label", _required_text(self.label, "row label"))
        object.__setattr__(
            self,
            "values",
            tuple(_bounded_text(value) for value in self.values),
        )
        object.__setattr__(self, "status", _optional_text(self.status))
        object.__setattr__(self, "detail", _optional_text(self.detail))

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {"key": self.key, "label": self.label}
        if self.values:
            payload["values"] = list(self.values)
        if self.status:
            payload["status"] = self.status
        if self.detail:
            payload["detail"] = self.detail
        return payload

    @classmethod
    def from_payload(cls, payload: object) -> SlashCommandRow:
        record = _mapping(payload, "row")
        raw_values = record.get("values", ())
        if not isinstance(raw_values, (list, tuple)) or not all(
            isinstance(value, str) for value in raw_values
        ):
            raise ValueError("row values must be strings")
        return cls(
            key=_required_payload_text(record, "key"),
            label=_required_payload_text(record, "label"),
            values=tuple(raw_values),
            status=_optional_payload_text(record, "status"),
            detail=_optional_payload_text(record, "detail"),
        )


@dataclass(frozen=True, slots=True)
class SlashCommandSection:
    title: str
    fields: tuple[SlashCommandField, ...] = ()
    rows: tuple[SlashCommandRow, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "title", _required_text(self.title, "section title"))
        object.__setattr__(self, "fields", tuple(self.fields))
        object.__setattr__(self, "rows", tuple(self.rows[:MAX_ROWS]))

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {"title": self.title}
        if self.fields:
            payload["fields"] = [field.to_payload() for field in self.fields]
        if self.rows:
            payload["rows"] = [row.to_payload() for row in self.rows]
        return payload

    @classmethod
    def from_payload(cls, payload: object) -> SlashCommandSection:
        record = _mapping(payload, "section")
        raw_fields = _payload_sequence(record, "fields")
        raw_rows = _payload_sequence(record, "rows")
        return cls(
            title=_required_payload_text(record, "title"),
            fields=tuple(SlashCommandField.from_payload(item) for item in raw_fields),
            rows=tuple(SlashCommandRow.from_payload(item) for item in raw_rows),
        )


@dataclass(frozen=True, slots=True)
class SlashCommandDisplay:
    kind: SlashCommandDisplayKind
    command: str
    title: str
    severity: SlashCommandSeverity = SlashCommandSeverity.INFO
    summary: str | None = None
    fields: tuple[SlashCommandField, ...] = ()
    rows: tuple[SlashCommandRow, ...] = ()
    sections: tuple[SlashCommandSection, ...] = ()
    usage: str | None = None
    suggestions: tuple[str, ...] = ()
    preformatted: str | None = None
    total_rows: int | None = None
    omitted_rows: int = 0
    omitted_chars: int = 0
    version: int = DISPLAY_VERSION

    def __post_init__(self) -> None:
        if self.version != DISPLAY_VERSION:
            raise ValueError(f"unsupported slash command display version: {self.version}")
        if self.kind is SlashCommandDisplayKind.ERROR and self.severity is SlashCommandSeverity.SUCCESS:
            raise ValueError("error displays cannot use success severity")
        object.__setattr__(self, "command", _required_text(self.command, "command"))
        object.__setattr__(self, "title", _required_text(self.title, "title"))
        object.__setattr__(self, "summary", _optional_text(self.summary))
        object.__setattr__(self, "usage", _optional_text(self.usage))
        object.__setattr__(
            self,
            "suggestions",
            tuple(_bounded_text(value) for value in self.suggestions[:3] if value.strip()),
        )
        object.__setattr__(self, "fields", tuple(self.fields))
        raw_rows = tuple(self.rows)
        bounded_rows = raw_rows[:MAX_ROWS]
        explicit_total = self.total_rows if self.total_rows is not None else len(raw_rows)
        total_rows = max(explicit_total, len(raw_rows), len(bounded_rows))
        omitted_rows = max(self.omitted_rows, total_rows - len(bounded_rows))
        object.__setattr__(self, "rows", bounded_rows)
        object.__setattr__(
            self,
            "total_rows",
            total_rows if omitted_rows > 0 or self.total_rows is not None else None,
        )
        object.__setattr__(self, "omitted_rows", omitted_rows)
        object.__setattr__(self, "sections", tuple(self.sections[:MAX_SECTIONS]))
        bounded_preformatted, computed_omitted = _bounded_head_tail(self.preformatted)
        object.__setattr__(self, "preformatted", bounded_preformatted)
        object.__setattr__(self, "omitted_chars", max(self.omitted_chars, computed_omitted))

    @classmethod
    def preformatted_result(
        cls,
        *,
        command: str,
        title: str,
        text: str,
        severity: SlashCommandSeverity = SlashCommandSeverity.INFO,
    ) -> SlashCommandDisplay:
        return cls(
            kind=SlashCommandDisplayKind.PREFORMATTED,
            command=command,
            title=title,
            severity=severity,
            preformatted=text,
        )

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "version": self.version,
            "kind": self.kind.value,
            "command": self.command,
            "title": self.title,
            "severity": self.severity.value,
        }
        optional: tuple[tuple[str, object | None], ...] = (
            ("summary", self.summary),
            ("fields", [field.to_payload() for field in self.fields] or None),
            ("rows", [row.to_payload() for row in self.rows] or None),
            ("sections", [section.to_payload() for section in self.sections] or None),
            ("usage", self.usage),
            ("suggestions", list(self.suggestions) or None),
            ("preformatted", self.preformatted),
            ("total_rows", self.total_rows),
            ("omitted_rows", self.omitted_rows or None),
            ("omitted_chars", self.omitted_chars or None),
        )
        payload.update({key: value for key, value in optional if value is not None})
        return payload

    @classmethod
    def from_payload(cls, payload: object) -> SlashCommandDisplay:
        record = _mapping(payload, "display")
        version = record.get("version")
        if not isinstance(version, int) or isinstance(version, bool):
            raise ValueError("display version must be an integer")
        try:
            kind = SlashCommandDisplayKind(_required_payload_text(record, "kind"))
            severity = SlashCommandSeverity(
                _required_payload_text(record, "severity")
            )
        except ValueError as exc:
            raise ValueError("display kind or severity is invalid") from exc
        total_rows = _optional_payload_int(record, "total_rows")
        return cls(
            kind=kind,
            command=_required_payload_text(record, "command"),
            title=_required_payload_text(record, "title"),
            severity=severity,
            summary=_optional_payload_text(record, "summary"),
            fields=tuple(
                SlashCommandField.from_payload(item)
                for item in _payload_sequence(record, "fields")
            ),
            rows=tuple(
                SlashCommandRow.from_payload(item)
                for item in _payload_sequence(record, "rows")
            ),
            sections=tuple(
                SlashCommandSection.from_payload(item)
                for item in _payload_sequence(record, "sections")
            ),
            usage=_optional_payload_text(record, "usage"),
            suggestions=tuple(
                _payload_string_sequence(record, "suggestions")
            ),
            preformatted=_optional_payload_text(record, "preformatted"),
            total_rows=total_rows,
            omitted_rows=_optional_payload_int(record, "omitted_rows") or 0,
            omitted_chars=_optional_payload_int(record, "omitted_chars") or 0,
            version=version,
        )


def render_slash_command_text(display: SlashCommandDisplay) -> tuple[str, ...]:
    if display.kind is SlashCommandDisplayKind.PREFORMATTED:
        return tuple((display.preformatted or display.title).splitlines())
    if display.kind is SlashCommandDisplayKind.NOTICE:
        return (display.summary or display.title,)
    if display.kind is SlashCommandDisplayKind.ERROR:
        lines = [f"Error: {display.summary or display.title}"]
        if display.usage:
            usage = display.usage.removeprefix("Usage: ")
            lines.append(f"Usage: {usage}")
        if display.suggestions:
            lines.append(f"Did you mean: {', '.join(display.suggestions)}")
        return tuple(lines)

    title = display.title
    if display.summary:
        title = f"{title} - {display.summary}"
    lines = [title]
    lines.extend(_render_fields(display.fields))
    if display.kind is SlashCommandDisplayKind.LIST:
        lines.extend(_render_rows(display.rows))
        if display.omitted_rows:
            lines.append(f"... {display.omitted_rows} more")
        return tuple(lines)
    for section in display.sections:
        lines.append(section.title)
        lines.extend(_render_fields(section.fields))
        lines.extend(_render_rows(section.rows))
    return tuple(lines)


def _render_fields(fields: tuple[SlashCommandField, ...]) -> list[str]:
    return [f"{field.label}: {field.value}" for field in fields]


def _render_rows(rows: tuple[SlashCommandRow, ...]) -> list[str]:
    rendered: list[str] = []
    for row in rows:
        values = (row.label, *row.values)
        line = "  ".join(value for value in values if value)
        if row.detail:
            line = f"{line}  {row.detail}"
        rendered.append(line)
    return rendered


def _bounded_text(value: str, limit: int = MAX_VALUE_CHARS) -> str:
    return value if len(value) <= limit else value[:limit]


def _required_text(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return _bounded_text(value.strip())


def _optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("optional display text must be a string")
    normalized = value.strip()
    return _bounded_text(normalized) if normalized else None


def _bounded_head_tail(value: str | None) -> tuple[str | None, int]:
    if value is None or len(value) <= MAX_TEXT_CHARS:
        return value, 0
    marker = ""
    while True:
        keep = max(0, MAX_TEXT_CHARS - len(marker))
        omitted = len(value) - keep
        next_marker = f"\n... {omitted} chars omitted ...\n"
        if next_marker == marker:
            break
        marker = next_marker
    keep = MAX_TEXT_CHARS - len(marker)
    head = keep // 2
    tail = keep - head
    bounded = value[:head] + marker + (value[-tail:] if tail else "")
    return bounded, len(value) - head - tail


def _mapping(value: object, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _payload_text(record: Mapping[str, Any], key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value


def _required_payload_text(record: Mapping[str, Any], key: str) -> str:
    value = _payload_text(record, key)
    if not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value


def _optional_payload_text(record: Mapping[str, Any], key: str) -> str | None:
    value = record.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value


def _payload_sequence(record: Mapping[str, Any], key: str) -> tuple[object, ...]:
    value = record.get(key, ())
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{key} must be an array")
    return tuple(value)


def _payload_string_sequence(record: Mapping[str, Any], key: str) -> tuple[str, ...]:
    value = _payload_sequence(record, key)
    strings: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError(f"{key} must contain strings")
        strings.append(item)
    return tuple(strings)


def _optional_payload_int(record: Mapping[str, Any], key: str) -> int | None:
    value = record.get(key)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


__all__ = [
    "DISPLAY_VERSION",
    "MAX_ROWS",
    "MAX_SECTIONS",
    "MAX_TEXT_CHARS",
    "SlashCommandDisplay",
    "SlashCommandDisplayKind",
    "SlashCommandField",
    "SlashCommandRow",
    "SlashCommandSection",
    "SlashCommandSeverity",
    "render_slash_command_text",
]
