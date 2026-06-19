from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field
from enum import StrEnum

from mycli.domain.tooling.calls import ToolCall


class ApprovalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


@dataclass(slots=True, frozen=True)
class PendingApproval:
    tool_call: ToolCall
    reason: str
    preview: str
    command_pattern: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
