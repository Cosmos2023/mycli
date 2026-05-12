from __future__ import annotations

from pathlib import Path

MAX_LINE_CHARS = 2000
DEFAULT_LIMIT = 2000
FULL_READ_CHAR_LIMIT = 15_000
HEAD_TAIL_CHAR_LIMIT = 60_000
HEAD_CHARS = 8_000
TAIL_CHARS = 4_000


def read_text(file_path: str, offset: int = 1, limit: int = DEFAULT_LIMIT) -> dict[str, object]:
    path = Path(file_path)
    if not path.exists():
        return {"error": f"[File not found: {file_path}]"}
    if path.is_dir():
        return {"error": f"[Path is a directory: {file_path}. Use LS to browse.]"}

    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        return {"error": f"[Cannot decode file as UTF-8: {file_path}: {exc}]"}

    total_chars = len(content)
    if total_chars > HEAD_TAIL_CHAR_LIMIT:
        return {
            "error": (
                f"[File too large ({total_chars} chars). "
                "Use offset/limit to read specific sections.]"
            )
        }

    original_total_lines = len(content.splitlines())
    view_content = content
    char_truncated = False
    if total_chars > FULL_READ_CHAR_LIMIT:
        omitted = total_chars - HEAD_CHARS - TAIL_CHARS
        view_content = (
            f"{content[:HEAD_CHARS]}\n"
            f"... [chars omitted] ... ({omitted} chars)\n"
            f"{content[-TAIL_CHARS:]}"
        )
        char_truncated = True

    lines = view_content.splitlines()
    total_lines = len(lines)
    start = max(0, offset - 1)
    end = min(start + limit, total_lines)
    shown = lines[start:end]
    line_truncated = offset == 1 and end < original_total_lines

    result_lines: list[str] = []
    for index, line in enumerate(shown):
        line_num = start + index + 1
        text = line.rstrip("\r")
        if len(text) > MAX_LINE_CHARS:
            text = text[:MAX_LINE_CHARS] + " [... truncated]"
        result_lines.append(f"{line_num:6d}\t{text}")

    output = "\n".join(result_lines)
    if output:
        output += "\n"
    if line_truncated:
        output += f"... (output truncated, showing {min(limit, original_total_lines)} of {original_total_lines} lines)\n"

    return {
        "content": output,
        "total_chars": total_chars,
        "total_lines": original_total_lines,
        "shown_lines": min(limit, max(original_total_lines - start, 0)),
        "truncated": char_truncated or line_truncated,
    }
