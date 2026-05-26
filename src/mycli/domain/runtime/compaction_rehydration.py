from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(slots=True, frozen=True)
class RehydrationBudget:
    max_total_tokens: int
    max_item_tokens: int


@dataclass(slots=True, frozen=True)
class FileRehydrationCandidate:
    path: str
    tool_name: str
    sequence: int

    @property
    def kind(self) -> str:
        if self.tool_name in {"Edit", "Write", "edit_file", "write_file"}:
            return "edit"
        return "read"


@dataclass(slots=True, frozen=True)
class RehydratedFile:
    path: str
    content: str
    token_count: int
    truncated: bool


@dataclass(slots=True, frozen=True)
class InvokedSkillSnapshot:
    name: str
    description: str
    source_path: str | None
    body_digest: str | None
    cached_body_excerpt: str | None
    invoked_at: datetime
    last_turn_id: str


@dataclass(slots=True, frozen=True)
class RehydratedSkill:
    name: str
    description: str
    source_path: str | None
    body: str
    token_count: int
    truncated: bool


@dataclass(slots=True, frozen=True)
class CompactionRehydrationContext:
    files: tuple[RehydratedFile, ...] = ()
    invoked_skills: tuple[RehydratedSkill, ...] = ()

    def is_empty(self) -> bool:
        return not self.files and not self.invoked_skills
