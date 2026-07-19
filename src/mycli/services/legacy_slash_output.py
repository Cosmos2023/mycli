from __future__ import annotations

import re
import shlex

from mycli.cli.slash_command_presenters import (
    present_diagnostic,
    present_list,
    present_notice,
    present_preformatted,
    present_status,
)
from mycli.cli.slash_command_result import (
    SlashCommandDisplay,
    SlashCommandSeverity,
)

LEGACY_TAGS = frozenset(
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
_DEFAULT_COMMANDS = {
    "status": "/status",
    "usage": "/usage",
    "context": "/context",
    "stats": "/stats",
    "tool": "/tools",
    "skill": "/skills",
    "agent": "/agents",
    "permission": "/permissions",
    "change": "/changes",
    "memory": "/memory",
    "mode": "/mode",
    "sandbox": "/sandbox",
    "undo": "/undo",
    "bash": "/ps",
}
_DIAGNOSTIC_TITLES = {
    "usage": "Usage",
    "context": "Context",
    "stats": "Statistics",
}
_LIST_TITLES = {
    "tool": "Tools",
    "skill": "Skills",
    "agent": "Agents",
    "permission": "Permissions",
    "change": "Changes",
    "memory": "Memory",
}
_NOTICE_TITLES = {
    "mode": "Mode",
    "sandbox": "Sandbox",
    "undo": "Undo complete",
}


def legacy_slash_display(
    *,
    command: str,
    lines: tuple[str, ...],
) -> SlashCommandDisplay | None:
    if not lines:
        return None
    parsed: list[tuple[str, str]] = []
    for line in lines:
        match = _TAGGED_LINE.fullmatch(line)
        if match is None:
            return None
        tag, body = match.groups()
        if tag not in LEGACY_TAGS:
            return None
        try:
            shlex.split(body)
        except ValueError:
            return None
        parsed.append((tag, body.strip()))
    tags = {tag for tag, _ in parsed}
    if len(tags) != 1:
        return None
    tag = parsed[0][0]
    values = tuple(body for _, body in parsed)
    resolved_command = command.strip() or _DEFAULT_COMMANDS[tag]
    if tag == "status":
        return present_status(
            command=resolved_command,
            values=values,
            directory=None,
        )
    if tag in _DIAGNOSTIC_TITLES:
        return present_diagnostic(
            command=resolved_command,
            title=_DIAGNOSTIC_TITLES[tag],
            values=values,
        )
    if tag in _LIST_TITLES:
        return present_list(
            command=resolved_command,
            title=_LIST_TITLES[tag],
            values=values,
            row_prefix=tag,
        )
    if tag in _NOTICE_TITLES:
        return present_notice(
            command=resolved_command,
            title=_NOTICE_TITLES[tag],
            summary="\n".join(values),
            severity=(
                SlashCommandSeverity.SUCCESS
                if tag == "undo"
                else SlashCommandSeverity.INFO
            ),
        )
    return present_preformatted(
        command=resolved_command,
        title="Background terminals",
        values=values,
    )


__all__ = ["LEGACY_TAGS", "legacy_slash_display"]
