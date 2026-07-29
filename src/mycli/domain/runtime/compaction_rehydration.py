from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


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

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "description": self.description,
            "source_path": self.source_path,
            "body_digest": self.body_digest,
            "cached_body_excerpt": self.cached_body_excerpt,
            "invoked_at": self.invoked_at.isoformat(),
            "last_turn_id": self.last_turn_id,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "InvokedSkillSnapshot":
        return cls(
            name=str(payload["name"]),
            description=str(payload.get("description", "")),
            source_path=(
                payload["source_path"]
                if isinstance(payload.get("source_path"), str)
                else None
            ),
            body_digest=(
                payload["body_digest"]
                if isinstance(payload.get("body_digest"), str)
                else None
            ),
            cached_body_excerpt=(
                payload["cached_body_excerpt"]
                if isinstance(payload.get("cached_body_excerpt"), str)
                else None
            ),
            invoked_at=datetime.fromisoformat(str(payload["invoked_at"])),
            last_turn_id=str(payload["last_turn_id"]),
        )


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
