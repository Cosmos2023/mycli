from __future__ import annotations

import re
import shlex

_LEGACY_TAGS = frozenset(
    {
        "status",
        "usage",
        "context",
        "stats",
        "tool",
        "skill",
        "agent",
        "permission",
        "change",
        "memory",
        "mode",
        "sandbox",
        "undo",
        "bash",
    }
)

_TAGGED_LINE = re.compile(r"^\s*\[([a-z]+)\]\s*(.*)$")


def is_legacy_slash_output(lines: tuple[str, ...]) -> bool:
    if not lines:
        return False
    tags: set[str] = set()
    for line in lines:
        match = _TAGGED_LINE.fullmatch(line)
        if match is None:
            return False
        tag, body = match.groups()
        if tag not in _LEGACY_TAGS:
            return False
        try:
            shlex.split(body)
        except ValueError:
            return False
        tags.add(tag)
    return len(tags) == 1


__all__ = ["is_legacy_slash_output"]
