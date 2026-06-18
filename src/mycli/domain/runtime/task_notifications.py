from __future__ import annotations

from dataclasses import dataclass, field
from html import escape
from pathlib import Path


@dataclass(frozen=True, slots=True)
class TaskNotification:
    task_id: str
    status: str
    summary: str
    output_file: Path | None = None
    task_type: str | None = None
    result: str | None = None
    usage: str | None = None
    completed_at: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)

    def to_xml(self) -> str:
        lines = [
            "<task-notification>",
            f"<task-id>{escape(self.task_id)}</task-id>",
        ]
        if self.task_type:
            lines.append(f"<task-type>{escape(self.task_type)}</task-type>")
        if self.output_file is not None:
            lines.append(f"<output-file>{escape(str(self.output_file))}</output-file>")
        lines.append(f"<status>{escape(self.status)}</status>")
        if self.completed_at:
            lines.append(f"<completed-at>{escape(self.completed_at)}</completed-at>")
        lines.append(f"<summary>{escape(self.summary[:500])}</summary>")
        if self.result is not None:
            lines.append(f"<result>{escape(self.result)}</result>")
        if self.usage is not None:
            lines.append(f"<usage>{escape(self.usage)}</usage>")
        for key, value in sorted(self.metadata.items()):
            if value is None:
                continue
            tag = key.replace("_", "-")
            lines.append(f"<{tag}>{escape(str(value))}</{tag}>")
        lines.append("</task-notification>")
        return "\n".join(lines)


__all__ = ["TaskNotification"]
