import csv
from pathlib import Path
from typing import Any


SMALL_FILE_ROW_LIMIT = 50
HEAD_PREVIEW_ROWS = 20
TAIL_PREVIEW_ROWS = 10


def read_file(file_path: str, pages: str | None = None) -> dict[str, Any]:
    del pages
    path = Path(file_path)
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","

    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.reader(f, delimiter=delimiter)
        rows = list(reader)

    if not rows:
        return {"error": "[Empty file]", "rows": 0, "columns": 0}

    headers = rows[0]
    data = rows[1:]
    total_rows = len(data)
    columns = len(headers)

    if total_rows <= SMALL_FILE_ROW_LIMIT:
        return {
            "headers": headers,
            "preview": [_row_to_dict(headers, row) for row in data],
            "rows": total_rows,
            "columns": columns,
            "truncated": False,
        }

    return {
        "headers": headers,
        "preview": [_row_to_dict(headers, row) for row in data[:HEAD_PREVIEW_ROWS]],
        "tail_preview": [
            _row_to_dict(headers, row) for row in data[-TAIL_PREVIEW_ROWS:]
        ],
        "rows": total_rows,
        "columns": columns,
        "truncated": True,
        "summary": (
            f"[Total: {total_rows} rows x {columns} columns. "
            f"Showing first {HEAD_PREVIEW_ROWS} + last {TAIL_PREVIEW_ROWS} rows.]"
        ),
    }


def read_csv(file_path: str, pages: str | None = None) -> dict[str, Any]:
    return read_file(file_path, pages=pages)


def _row_to_dict(headers: list[str], row: list[str]) -> dict[str, str]:
    return dict(zip(headers, row, strict=False))
