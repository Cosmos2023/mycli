from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True, frozen=True)
class SkillMetadata:
    name: str
    description: str
    trigger_hints: tuple[str, ...]
    source_path: str
    source_kind: str = "unknown"
    availability: str = "available"
    env_dependencies: tuple[str, ...] = field(default_factory=tuple)
    workspace_dependencies: tuple[str, ...] = field(default_factory=tuple)
    guardrails: tuple[str, ...] = field(default_factory=tuple)


@dataclass(slots=True, frozen=True)
class SkillDefinition:
    name: str
    description: str
    trigger_hints: tuple[str, ...]
    body: str
    source_path: str
    source_kind: str = "unknown"
    env_dependencies: tuple[str, ...] = field(default_factory=tuple)
    workspace_dependencies: tuple[str, ...] = field(default_factory=tuple)
    guardrails: tuple[str, ...] = field(default_factory=tuple)
