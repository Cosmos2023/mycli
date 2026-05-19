from __future__ import annotations

from pathlib import Path

from mycli.services.context.token_counter import TokenCounter

MAX_LINE_CHARS = 2000
DEFAULT_LIMIT = 2000
MAX_READ_TOKENS = 25_000
_TOKEN_COUNTER = TokenCounter()


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

    total_tokens = _TOKEN_COUNTER.count(content)
    if total_tokens > MAX_READ_TOKENS:
        return {
            "error": (
                f"[File too large ({total_tokens} tokens). "
                "Use offset/limit to read specific sections.]"
            )
        }

    total_chars = len(content)
    stat = path.stat()
    original_total_lines = len(content.splitlines())
    view_content = content

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
        "mtime_ns": stat.st_mtime_ns,
        "size": stat.st_size,
        "total_chars": total_chars,
        "total_tokens": total_tokens,
        "total_lines": original_total_lines,
        "shown_lines": min(limit, max(original_total_lines - start, 0)),
        "truncated": line_truncated,
    }
