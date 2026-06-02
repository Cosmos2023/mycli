from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

_MAX_SAFE_HOOK_MESSAGE_CHARS = 160


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


class HookExecutionStatus(StrEnum):
    OK = "ok"
    ERROR = "error"


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


@dataclass(slots=True, frozen=True)
class HookExecutionSummary:
    hook_point: HookPoint
    hook_name: str
    status: HookExecutionStatus
    action: HookAction | None = None
    message: str = ""

    def safe_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "hook_point": self.hook_point.value,
            "hook_name": self.hook_name,
            "status": self.status.value,
        }
        if self.action is not None:
            payload["action"] = self.action.value
        if self.message:
            payload["message"] = _safe_message(self.message)
        return payload


@dataclass(slots=True, frozen=True)
class HookRegistrationSnapshot:
    hook_point: HookPoint
    hook_name: str
    enabled: bool
    call_count: int = 0
    error_count: int = 0
    deny_count: int = 0
    modify_count: int = 0
    last_status: HookExecutionStatus | None = None
    last_action: HookAction | None = None
    last_message: str = ""

    def safe_line(self) -> str:
        status = self.last_status.value if self.last_status is not None else "never"
        action = self.last_action.value if self.last_action is not None else "none"
        line = (
            f"{self.hook_point.value} {self.hook_name} "
            f"enabled={str(self.enabled).lower()} calls={self.call_count} "
            f"errors={self.error_count} denies={self.deny_count} "
            f"modifies={self.modify_count} last_status={status} "
            f"last_action={action}"
        )
        if self.last_message:
            line = f"{line} last_message={_safe_message(self.last_message)}"
        return line


def _safe_message(message: str) -> str:
    normalized = " ".join(message.split())
    lowered = normalized.lower()
    if any(part in lowered for part in ("api_key", "apikey", "token", "secret", "password", "bearer ")):
        return "redacted"
    return normalized[:_MAX_SAFE_HOOK_MESSAGE_CHARS]
