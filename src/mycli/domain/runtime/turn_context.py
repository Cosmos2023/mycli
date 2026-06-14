from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from mycli.domain.runtime.canonical_timeline import (
    CanonicalTimelineDurability,
    CanonicalTimelineScope,
)


class TurnContextSectionType(StrEnum):
    BASE_INSTRUCTIONS = "base_instructions"
    COLLABORATION_MODE = "collaboration_mode"
    WORKSPACE_INSTRUCTIONS = "workspace_instructions"
    ENVIRONMENT_CONTEXT = "environment_context"
    CONVERSATION_CONTEXT = "conversation_context"
    MEMORY = "memory"
    PLAN = "plan"
    COMPACTION_REHYDRATION = "compaction_rehydration"
    RUNTIME_REMINDERS = "runtime_reminders"
    SKILL_CATALOG = "skill_catalog"
    TOOL_EXPOSURE = "tool_exposure"
    USER_REQUEST = "user_request"


class TurnContextCacheClass(StrEnum):
    STATIC = "static"
    DYNAMIC = "dynamic"
    EPHEMERAL = "ephemeral"


@dataclass(slots=True, frozen=True)
class TurnContextSection:
    type: TurnContextSectionType
    title: str
    content: str
    enabled: bool = True
    source: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    cache_class: TurnContextCacheClass = TurnContextCacheClass.DYNAMIC
    durability: CanonicalTimelineDurability = CanonicalTimelineDurability.PERSISTENT
    scope: CanonicalTimelineScope = CanonicalTimelineScope.TURN


@dataclass(slots=True, frozen=True)
class TurnContext:
    user_message: str
    sections: tuple[TurnContextSection, ...]

    def enabled_sections(self) -> tuple[TurnContextSection, ...]:
        return tuple(section for section in self.sections if section.enabled)

    def debug_summary(self) -> dict[str, object]:
        enabled_sections = [section.type.value for section in self.sections if section.enabled]
        disabled_sections = [section.type.value for section in self.sections if not section.enabled]
        return {
            "user_message": self.user_message,
            "section_order": [section.type.value for section in self.sections],
            "enabled_sections": enabled_sections,
            "disabled_sections": disabled_sections,
            "cache_classes": {
                section.type.value: section.cache_class.value for section in self.sections
            },
            "durability": {
                section.type.value: section.durability.value for section in self.sections
            },
            "scopes": {
                section.type.value: section.scope.value for section in self.sections
            },
        }
