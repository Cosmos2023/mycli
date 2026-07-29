import csv
from datetime import UTC, datetime
import hashlib
import io
import os
from pathlib import Path
from typing import Any


SMALL_FILE_ROW_LIMIT = 50
HEAD_PREVIEW_ROWS = 20
TAIL_PREVIEW_ROWS = 10


def read_file(
    file_path: str,
    offset: int = 1,
    limit: int = HEAD_PREVIEW_ROWS,
    pages: str | None = None,
) -> dict[str, Any]:
    del pages
    path = Path(file_path)
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","

    with path.open("rb") as raw:
        raw_content = raw.read()
        stat = os.fstat(raw.fileno())
    text = raw_content.decode("utf-8")

    with io.StringIO(text, newline="") as f:
        reader = csv.reader(f, delimiter=delimiter)
        rows = list(reader)

    if not rows:
        return {
            "error": "[Empty file]",
            "rows": 0,
            "columns": 0,
            **_snapshot_metadata(raw_content, stat),
        }

    headers = rows[0]
    data = rows[1:]
    total_rows = len(data)
    columns = len(headers)
    total_lines = len(rows)
    requested_start = max(1, offset)
    requested_limit = max(0, limit)
    numeric_summary = _numeric_summary(headers, data)

    if requested_start > 1:
        start_index = min(requested_start - 1, total_lines)
        end_index = min(start_index + requested_limit, total_lines)
        selected_rows = rows[start_index:end_index]
        content = _format_content(
            rows=selected_rows,
            delimiter=delimiter,
            columns=headers,
        )
        shown_lines = len(selected_rows)
        return {
            "headers": headers,
            "preview": [_row_to_dict(headers, row) for row in selected_rows],
            "rows": total_rows,
            "columns": columns,
            "content": content,
            "numeric_summary": numeric_summary,
            "total_lines": total_lines,
            "shown_lines": shown_lines,
            "data_offset": requested_start,
            "data_limit": requested_limit,
            "truncated": shown_lines < total_lines,
            **_snapshot_metadata(raw_content, stat),
        }

    if total_rows <= SMALL_FILE_ROW_LIMIT:
        selected_rows = rows
        return {
            "headers": headers,
            "preview": [_row_to_dict(headers, row) for row in data],
            "rows": total_rows,
            "columns": columns,
            "content": _format_content(
                rows=selected_rows,
                delimiter=delimiter,
                profile=_format_numeric_profile(numeric_summary),
            ),
            "numeric_summary": numeric_summary,
            "total_lines": total_lines,
            "shown_lines": len(selected_rows),
            "truncated": False,
            **_snapshot_metadata(raw_content, stat),
        }

    selected_rows = rows[: HEAD_PREVIEW_ROWS + 1]
    return {
        "headers": headers,
        "preview": [_row_to_dict(headers, row) for row in data[:HEAD_PREVIEW_ROWS]],
        "tail_preview": [
            _row_to_dict(headers, row) for row in data[-TAIL_PREVIEW_ROWS:]
        ],
        "rows": total_rows,
        "columns": columns,
        "content": _format_content(
            rows=selected_rows,
            delimiter=delimiter,
            profile=_format_numeric_profile(numeric_summary),
        ),
        "numeric_summary": numeric_summary,
        "total_lines": total_lines,
        "shown_lines": len(selected_rows),
        "truncated": True,
        "summary": (
            f"[Total: {total_rows} rows x {columns} columns. "
            f"Showing first {HEAD_PREVIEW_ROWS} + last {TAIL_PREVIEW_ROWS} rows.]"
        ),
        **_snapshot_metadata(raw_content, stat),
    }

def _row_to_dict(headers: list[str], row: list[str]) -> dict[str, str]:
    return dict(zip(headers, row, strict=False))


def _format_content(
    *,
    rows: list[list[str]],
    delimiter: str,
    columns: list[str] | None = None,
    profile: str = "",
) -> str:
    lines: list[str] = []
    if columns is not None:
        lines.append(f"Columns: {_serialize_row(columns, delimiter)}")
    for row in rows:
        lines.append(_serialize_row(row, delimiter))
    if profile:
        lines.append(profile)
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def _serialize_row(row: list[str], delimiter: str) -> str:
    output = io.StringIO()
    writer = csv.writer(output, delimiter=delimiter, lineterminator="")
    writer.writerow(row)
    return output.getvalue()


def _snapshot_metadata(
    raw_content: bytes,
    stat: os.stat_result,
) -> dict[str, object]:
    return {
        "mtime_ns": stat.st_mtime_ns,
        "size": len(raw_content),
        "sha256": hashlib.sha256(raw_content).hexdigest(),
        "captured_at": datetime.now(UTC).isoformat(),
    }


def _numeric_summary(
    headers: list[str],
    data: list[list[str]],
) -> dict[str, dict[str, object]]:
    summaries: dict[str, dict[str, object]] = {}
    for column_index, header in enumerate(headers):
        values: list[tuple[int, float, list[str]]] = []
        for row_index, row in enumerate(data, start=2):
            if column_index >= len(row):
                continue
            parsed = _parse_number(row[column_index])
            if parsed is None:
                continue
            values.append((row_index, parsed, row))
        if not values:
            continue
        numbers = [value for _line, value, _row in values]
        min_line, min_value, min_row = min(values, key=lambda item: item[1])
        max_line, max_value, max_row = max(values, key=lambda item: item[1])
        total = sum(numbers)
        summaries[header] = {
            "count": len(values),
            "sum": _json_number(total),
            "average": _json_number(total / len(values)),
            "min": _json_number(min_value),
            "min_line": min_line,
            "min_context": _row_context(headers, min_row),
            "max": _json_number(max_value),
            "max_line": max_line,
            "max_context": _row_context(headers, max_row),
        }
    return summaries


def _parse_number(value: str) -> float | None:
    normalized = value.strip().replace(",", "")
    if not normalized:
        return None
    try:
        return float(normalized)
    except ValueError:
        return None


def _json_number(value: float) -> int | float:
    if value.is_integer():
        return int(value)
    return round(value, 4)


def _row_context(headers: list[str], row: list[str]) -> str:
    context_parts: list[str] = []
    for header, value in zip(headers, row, strict=False):
        if _parse_number(value) is None and value.strip():
            context_parts.append(f"{header}={value}")
        if len(context_parts) >= 2:
            break
    return ", ".join(context_parts)


def _format_numeric_profile(
    numeric_summary: dict[str, dict[str, object]],
) -> str:
    if not numeric_summary:
        return ""
    lines = ["Data profile:"]
    for header, summary in numeric_summary.items():
        parts = [
            f"{header}:",
            f"sum={summary['sum']}",
            f"avg={summary['average']}",
            f"min={summary['min']}",
            f"line={summary['min_line']}",
        ]
        min_context = summary.get("min_context")
        if isinstance(min_context, str) and min_context:
            parts.append(f"({min_context})")
        parts.extend(
            [
                f"max={summary['max']}",
                f"line={summary['max_line']}",
            ]
        )
        max_context = summary.get("max_context")
        if isinstance(max_context, str) and max_context:
            parts.append(f"({max_context})")
        lines.append("- " + " ".join(parts))
    return "\n".join(lines)
