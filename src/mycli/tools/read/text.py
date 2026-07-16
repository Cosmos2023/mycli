from __future__ import annotations

import codecs
from datetime import UTC, datetime
import hashlib
import os
from pathlib import Path

from mycli.services.context.token_counter import TokenCounter

MAX_LINE_CHARS = 2000
DEFAULT_LIMIT = 200
MAX_READ_TOKENS = 25_000
STREAM_CHUNK_BYTES = 512 * 1024
_TOKEN_COUNTER = TokenCounter()


def read_text(
    file_path: str,
    offset: int = 1,
    limit: int = DEFAULT_LIMIT,
    *,
    allow_large_window: bool = False,
) -> dict[str, object]:
    path = Path(file_path)
    if not path.exists():
        return {"error": f"[File not found: {file_path}]"}
    if path.is_dir():
        return {"error": f"[Path is a directory: {file_path}. Use LS to browse.]"}
    if allow_large_window:
        return _read_text_window(path, offset=offset, limit=limit)

    try:
        with path.open("rb") as handle:
            raw_content = handle.read()
            stat = os.fstat(handle.fileno())
        content = raw_content.decode("utf-8")
    except UnicodeDecodeError as exc:
        return {"error": f"[Cannot decode file as UTF-8: {file_path}: {exc}]"}

    total_tokens = _TOKEN_COUNTER.count(content)
    if total_tokens > MAX_READ_TOKENS and not allow_large_window:
        return {
            "error": (
                f"[File too large ({total_tokens} tokens). "
                "Use offset/limit to read specific sections.]"
            )
        }

    total_chars = len(content)
    original_total_lines = len(content.splitlines())
    view_content = content

    lines = view_content.splitlines()
    total_lines = len(lines)
    start = max(0, offset - 1)
    end = min(start + limit, total_lines)
    shown = lines[start:end]
    line_truncated = end < original_total_lines

    result_lines: list[str] = []
    for line in shown:
        text = line.rstrip("\r")
        if len(text) > MAX_LINE_CHARS:
            text = text[:MAX_LINE_CHARS] + " [... truncated]"
        result_lines.append(text)

    output = "\n".join(result_lines)
    if output:
        output += "\n"
    if line_truncated:
        next_offset = start + len(shown) + 1
        output += (
            f"... (output truncated, showing {min(limit, original_total_lines)} "
            f"of {original_total_lines} lines; use offset={next_offset} "
            "with limit to continue)\n"
        )

    return {
        "content": output,
        "mtime_ns": stat.st_mtime_ns,
        "size": len(raw_content),
        "sha256": hashlib.sha256(raw_content).hexdigest(),
        "captured_at": datetime.now(UTC).isoformat(),
        "total_chars": total_chars,
        "total_tokens": total_tokens,
        "total_lines": original_total_lines,
        "shown_lines": min(limit, max(original_total_lines - start, 0)),
        "truncated": line_truncated,
    }


def _read_text_window(path: Path, *, offset: int, limit: int) -> dict[str, object]:
    start = max(0, offset - 1)
    effective_limit = max(0, limit)
    end = start + effective_limit
    selected_lines: list[str] = []
    total_lines = 0
    total_chars = 0
    digest = hashlib.sha256()
    decoder = codecs.getincrementaldecoder("utf-8")()
    pending = ""

    try:
        with path.open("rb") as handle:
            stat = os.fstat(handle.fileno())
            while True:
                chunk = handle.read(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
                decoded = decoder.decode(chunk)
                total_chars += len(decoded)
                pieces = (pending + decoded).split("\n")
                pending = pieces.pop()
                for line in pieces:
                    if start <= total_lines < end:
                        selected_lines.append(line.rstrip("\r"))
                    total_lines += 1
            tail = decoder.decode(b"", final=True)
            total_chars += len(tail)
            if tail:
                pending += tail
            if pending:
                line = pending.rstrip("\r")
                if start <= total_lines < end:
                    selected_lines.append(line)
                total_lines += 1
    except UnicodeDecodeError as exc:
        return {"error": f"[Cannot decode file as UTF-8: {path}: {exc}]"}

    selected_content = "\n".join(selected_lines)
    output = _format_lines(selected_lines)
    line_truncated = end < total_lines
    if line_truncated:
        next_offset = start + len(selected_lines) + 1
        output += (
            f"... (output truncated, showing {min(effective_limit, total_lines)} "
            f"of {total_lines} lines; use offset={next_offset} "
            "with limit to continue)\n"
        )

    return {
        "content": output,
        "mtime_ns": stat.st_mtime_ns,
        "size": stat.st_size,
        "sha256": digest.hexdigest(),
        "captured_at": datetime.now(UTC).isoformat(),
        "total_chars": total_chars,
        "total_tokens": _TOKEN_COUNTER.count(selected_content),
        "total_lines": total_lines,
        "shown_lines": min(effective_limit, max(total_lines - start, 0)),
        "truncated": line_truncated,
    }


def _format_lines(lines: list[str]) -> str:
    result_lines: list[str] = []
    for line in lines:
        text = line.rstrip("\r")
        if len(text) > MAX_LINE_CHARS:
            text = text[:MAX_LINE_CHARS] + " [... truncated]"
        result_lines.append(text)

    output = "\n".join(result_lines)
    if output:
        output += "\n"
    return output
