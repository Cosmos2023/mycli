from __future__ import annotations

from dataclasses import dataclass
import re
import shlex

from mycli.cli.slash_command_result import (
    SlashCommandDisplay,
    SlashCommandDisplayKind,
    SlashCommandField,
    SlashCommandRow,
    SlashCommandSection,
    SlashCommandSeverity,
)

_MULTIWORD_KEYS = frozenset(
    {
        "command",
        "description",
        "message",
        "path",
        "pattern",
        "preview",
        "summary",
    }
)
_STATUS_FIELD_ORDER = (
    "session",
    "model",
    "provider",
    "directory",
    "mode",
    "sandbox",
    "permissions",
    "context",
    "pending",
    "suspended",
)
_STATUS_OMITTED_VALUES = frozenset({"", "no", "none", "unknown"})
_DIAGNOSTIC_SECTION_TITLES = {
    "current_context_window": "Current context window",
    "cumulative_usage": "Cumulative usage",
    "context_window": "Context composition",
    "compaction": "Compaction",
    "l4": "L4 state",
}


@dataclass(frozen=True, slots=True)
class _ParsedRow:
    label: str
    values: tuple[tuple[str, str], ...]
    detail: tuple[str, ...]

    def value_mapping(self) -> dict[str, str]:
        return dict(self.values)


def present_status(
    *,
    command: str,
    values: tuple[str, ...],
    directory: str | None,
) -> SlashCommandDisplay:
    parsed_values: dict[str, str] = {}
    for value in values:
        parsed_values.update(_tokenize_service_row(value).value_mapping())
    if directory:
        parsed_values["directory"] = directory
    fields = tuple(
        SlashCommandField(
            label=_humanize_key(key),
            value=parsed_values[key],
            tone=_tone_for_value(key, parsed_values[key]),
        )
        for key in _STATUS_FIELD_ORDER
        if key in parsed_values
        and not (
            key in {"pending", "suspended", "context"}
            and parsed_values[key].lower() in _STATUS_OMITTED_VALUES
        )
    )
    return SlashCommandDisplay(
        kind=SlashCommandDisplayKind.STATUS,
        command=command,
        title="mycli",
        fields=fields,
    )


def present_diagnostic(
    *,
    command: str,
    title: str,
    values: tuple[str, ...],
) -> SlashCommandDisplay:
    fields: list[SlashCommandField] = []
    sections: list[SlashCommandSection] = []
    for value in values:
        parsed = _tokenize_service_row(value)
        parsed_fields = tuple(
            SlashCommandField(
                label=_humanize_key(key),
                value=field_value,
                tone=_tone_for_value(key, field_value),
            )
            for key, field_value in parsed.values
        )
        section_title = _DIAGNOSTIC_SECTION_TITLES.get(parsed.label)
        if section_title:
            sections.append(
                SlashCommandSection(title=section_title, fields=parsed_fields)
            )
        elif parsed.label == "budget" or parsed.label == "result":
            fields.extend(parsed_fields)
        else:
            sections.append(
                SlashCommandSection(
                    title=_humanize_key(parsed.label),
                    fields=parsed_fields,
                    rows=(
                        SlashCommandRow(
                            key=f"{parsed.label}:detail",
                            label="Details",
                            detail=" ".join(parsed.detail),
                        ),
                    )
                    if parsed.detail
                    else (),
                )
            )
    return SlashCommandDisplay(
        kind=SlashCommandDisplayKind.DIAGNOSTIC,
        command=command,
        title=title,
        fields=tuple(fields),
        sections=tuple(sections),
    )


def present_list(
    *,
    command: str,
    title: str,
    values: tuple[str, ...],
    row_prefix: str,
) -> SlashCommandDisplay:
    rows: list[SlashCommandRow] = []
    for index, value in enumerate(values):
        parsed = _tokenize_service_row(value)
        row_values = parsed.values
        if parsed.label == "result" and row_values:
            label = _humanize_key(row_values[0][0])
        else:
            label = _humanize_key(parsed.label)
        rows.append(
            SlashCommandRow(
                key=f"{row_prefix}:{index}:{parsed.label}",
                label=label,
                values=tuple(field_value for _, field_value in row_values),
                status=_row_status(parsed),
                detail=" ".join(parsed.detail) or None,
            )
        )
    item_label = "item" if len(rows) == 1 else "items"
    return SlashCommandDisplay(
        kind=SlashCommandDisplayKind.LIST,
        command=command,
        title=title,
        summary=f"{len(rows)} {item_label}",
        rows=tuple(rows),
        total_rows=len(rows),
    )


def present_notice(
    *,
    command: str,
    title: str,
    summary: str,
    severity: SlashCommandSeverity = SlashCommandSeverity.SUCCESS,
) -> SlashCommandDisplay:
    return SlashCommandDisplay(
        kind=SlashCommandDisplayKind.NOTICE,
        command=command,
        title=title,
        severity=severity,
        summary=summary,
    )


def present_error(
    *,
    command: str,
    reason: str,
    usage: str | None,
    suggestions: tuple[str, ...] = (),
) -> SlashCommandDisplay:
    return SlashCommandDisplay(
        kind=SlashCommandDisplayKind.ERROR,
        command=command,
        title="Command error",
        severity=SlashCommandSeverity.ERROR,
        summary=reason,
        usage=usage,
        suggestions=suggestions,
    )


def present_preformatted(
    *,
    command: str,
    title: str,
    values: tuple[str, ...],
) -> SlashCommandDisplay:
    return SlashCommandDisplay.preformatted_result(
        command=command,
        title=title,
        text="\n".join(values),
    )


def _tokenize_service_row(value: str) -> _ParsedRow:
    try:
        tokens = shlex.split(value)
    except ValueError:
        tokens = value.split()
    if not tokens:
        return _ParsedRow(label="result", values=(), detail=())
    label = "result"
    start = 0
    if "=" not in tokens[0]:
        label = tokens[0]
        start = 1
    pairs: list[list[str]] = []
    detail: list[str] = []
    for token in tokens[start:]:
        if "=" in token:
            key, field_value = token.split("=", 1)
            if key:
                pairs.append([key, field_value])
                continue
        if pairs and pairs[-1][0] in _MULTIWORD_KEYS:
            pairs[-1][1] = " ".join(part for part in (pairs[-1][1], token) if part)
        else:
            detail.append(token)
    return _ParsedRow(
        label=label,
        values=tuple((key, field_value) for key, field_value in pairs),
        detail=tuple(detail),
    )


def _row_status(parsed: _ParsedRow) -> str | None:
    values = parsed.value_mapping()
    return values.get("status") or values.get("availability")


def _humanize_key(key: str) -> str:
    words = re.sub(r"[-_]+", " ", key).strip()
    return words[:1].upper() + words[1:] if words else "Result"


def _tone_for_value(key: str, value: str) -> str | None:
    if "cache_read" in key:
        return "success"
    if "duplicate" in key or "evictable" in key:
        return "warning"
    if "ratio" in key or "usage" in key or key == "context":
        match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)%", value.strip())
        if match:
            percent = float(match.group(1))
            if percent >= 90:
                return "error"
            if percent >= 70:
                return "warning"
            return "success"
    return None


__all__ = [
    "present_diagnostic",
    "present_error",
    "present_list",
    "present_notice",
    "present_preformatted",
    "present_status",
]
