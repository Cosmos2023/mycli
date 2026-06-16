from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class MemoryKind(StrEnum):
    PREFERENCE = "preference"
    PROJECT_NOTE = "project_note"
    SESSION_SUMMARY = "session_summary"
    USER = "user"
    FEEDBACK = "feedback"
    PROJECT = "project"
    REFERENCE = "reference"


@dataclass(slots=True, frozen=True)
class MemoryRecord:
    kind: MemoryKind
    key: str
    value: str
    tags: tuple[str, ...] = field(default_factory=tuple)
