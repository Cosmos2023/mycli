from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class HookPoint(StrEnum):
    PRE_TOOL_USE = "pre_tool_use"
    POST_TOOL_USE = "post_tool_use"
    PRE_COMPACT = "pre_compact"
    SESSION_START = "session_start"
    SESSION_END = "session_end"


class HookAction(StrEnum):
    ALLOW = "allow"
    DENY = "deny"
    MODIFY = "modify"


@dataclass(slots=True, frozen=True)
class HookResult:
    action: HookAction
    message: str = ""
    modified_args: dict[str, Any] | None = None


@dataclass(slots=True, frozen=True)
class HookContext:
    hook_point: HookPoint
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    session_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
