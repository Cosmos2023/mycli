from __future__ import annotations

from dataclasses import dataclass, replace

from mycli.domain.runtime import (
    TurnContext,
    TurnContextSection,
    TurnContextSectionType,
)
from mycli.services.context.token_counter import TokenCounter


_PRESERVED_SECTION_TYPES = {
    TurnContextSectionType.BASE_INSTRUCTIONS,
    TurnContextSectionType.TOOL_EXPOSURE,
    TurnContextSectionType.USER_REQUEST,
}

_TRIM_ORDER = {
    TurnContextSectionType.MEMORY: 10,
    TurnContextSectionType.WORKSPACE_INSTRUCTIONS: 20,
    TurnContextSectionType.SKILL_CATALOG: 25,
    TurnContextSectionType.CONVERSATION_CONTEXT: 30,
    TurnContextSectionType.COMPACTION_REHYDRATION: 35,
    TurnContextSectionType.ENVIRONMENT_CONTEXT: 40,
    TurnContextSectionType.PLAN: 45,
    TurnContextSectionType.HOOK_CONTEXT: 80,
    TurnContextSectionType.RUNTIME_REMINDERS: 90,
}

_MIN_SECTION_CHARS = {
    TurnContextSectionType.HOOK_CONTEXT: 240,
    TurnContextSectionType.RUNTIME_REMINDERS: 240,
    TurnContextSectionType.WORKSPACE_INSTRUCTIONS: 320,
    TurnContextSectionType.CONVERSATION_CONTEXT: 320,
    TurnContextSectionType.COMPACTION_REHYDRATION: 320,
    TurnContextSectionType.MEMORY: 240,
    TurnContextSectionType.PLAN: 240,
    TurnContextSectionType.ENVIRONMENT_CONTEXT: 160,
    TurnContextSectionType.SKILL_CATALOG: 240,
}

_TRIM_MARKER = "\n\n[context section trimmed: {reason}; {omitted_chars} chars omitted]"


@dataclass(slots=True, frozen=True)
class SectionBudgetTrim:
    section_type: str
    reason: str
    original_chars: int
    trimmed_chars: int
    original_tokens: int
    trimmed_tokens: int

    def to_dict(self) -> dict[str, object]:
        return {
            "section_type": self.section_type,
            "reason": self.reason,
            "original_chars": self.original_chars,
            "trimmed_chars": self.trimmed_chars,
            "original_tokens": self.original_tokens,
            "trimmed_tokens": self.trimmed_tokens,
        }


@dataclass(slots=True, frozen=True)
class SectionBudgetDiagnostic:
    target_tokens: int
    before_tokens: int
    after_tokens: int
    remaining_tokens: int
    trimmed_sections: tuple[SectionBudgetTrim, ...]

    @property
    def trimmed_section_count(self) -> int:
        return len(self.trimmed_sections)

    @property
    def estimated_saved_tokens(self) -> int:
        return max(0, self.before_tokens - self.after_tokens)

    def to_dict(self) -> dict[str, object]:
        return {
            "target_tokens": self.target_tokens,
            "before_tokens": self.before_tokens,
            "after_tokens": self.after_tokens,
            "remaining_tokens": self.remaining_tokens,
            "trimmed_section_count": self.trimmed_section_count,
            "estimated_saved_tokens": self.estimated_saved_tokens,
            "trimmed_sections": [
                trimmed.to_dict() for trimmed in self.trimmed_sections
            ],
        }


class TurnContextBudgeter:
    def __init__(self, token_counter: TokenCounter | None = None) -> None:
        self._token_counter = token_counter or TokenCounter()

    def apply(
        self,
        *,
        turn_context: TurnContext,
        max_tokens: int,
    ) -> tuple[TurnContext, SectionBudgetDiagnostic]:
        target_tokens = max(1, max_tokens)
        before_tokens = self._estimate_turn_context_tokens(turn_context)
        if before_tokens <= target_tokens:
            return (
                turn_context,
                SectionBudgetDiagnostic(
                    target_tokens=target_tokens,
                    before_tokens=before_tokens,
                    after_tokens=before_tokens,
                    remaining_tokens=max(0, target_tokens - before_tokens),
                    trimmed_sections=(),
                ),
            )

        sections = list(turn_context.sections)
        trims: list[SectionBudgetTrim] = []
        current_tokens = before_tokens
        for index in self._candidate_indexes(sections):
            if current_tokens <= target_tokens:
                break
            section = sections[index]
            original_tokens = self._estimate_section_tokens(section)
            replacement = self._trim_section(
                section=section,
                target_tokens=target_tokens,
                current_tokens=current_tokens,
            )
            if replacement.content == section.content:
                continue
            trimmed_tokens = self._estimate_section_tokens(replacement)
            current_tokens = max(0, current_tokens - original_tokens + trimmed_tokens)
            sections[index] = replacement
            trims.append(
                SectionBudgetTrim(
                    section_type=section.type.value,
                    reason=str(replacement.metadata.get("budget_reason") or "over_budget"),
                    original_chars=len(section.content),
                    trimmed_chars=len(replacement.content),
                    original_tokens=original_tokens,
                    trimmed_tokens=trimmed_tokens,
                )
            )

        after = TurnContext(user_message=turn_context.user_message, sections=tuple(sections))
        after_tokens = self._estimate_turn_context_tokens(after)
        return (
            after,
            SectionBudgetDiagnostic(
                target_tokens=target_tokens,
                before_tokens=before_tokens,
                after_tokens=after_tokens,
                remaining_tokens=max(0, target_tokens - after_tokens),
                trimmed_sections=tuple(trims),
            ),
        )

    def _candidate_indexes(self, sections: list[TurnContextSection]) -> tuple[int, ...]:
        candidates = [
            (index, _TRIM_ORDER.get(section.type, 50))
            for index, section in enumerate(sections)
            if section.enabled and section.type not in _PRESERVED_SECTION_TYPES
        ]
        return tuple(index for index, _order in sorted(candidates, key=lambda item: item[1]))

    def _trim_section(
        self,
        *,
        section: TurnContextSection,
        target_tokens: int,
        current_tokens: int,
    ) -> TurnContextSection:
        overflow_tokens = max(1, current_tokens - target_tokens)
        original_chars = len(section.content)
        if original_chars <= 0:
            return section
        estimated_chars_to_remove = min(
            original_chars,
            max(overflow_tokens * 4, original_chars // 2),
        )
        min_chars = _MIN_SECTION_CHARS.get(section.type, 160)
        keep_chars = max(min_chars, original_chars - estimated_chars_to_remove)
        if keep_chars >= original_chars:
            return section
        trimmed = _trim_middle(section.content, keep_chars)
        reason = _reason_for_section(section.type)
        metadata = dict(section.metadata)
        metadata.update(
            {
                "trimmed": True,
                "original_chars": original_chars,
                "trimmed_chars": len(trimmed),
                "budget_reason": reason,
            }
        )
        return replace(section, content=trimmed, metadata=metadata)

    def _estimate_turn_context_tokens(self, turn_context: TurnContext) -> int:
        return sum(
            self._estimate_section_tokens(section)
            for section in turn_context.enabled_sections()
        )

    def _estimate_section_tokens(self, section: TurnContextSection) -> int:
        if not section.enabled:
            return 0
        return self._token_counter.count(section.content)


def _reason_for_section(section_type: TurnContextSectionType) -> str:
    if section_type is TurnContextSectionType.MEMORY:
        return "memory_over_budget"
    if section_type is TurnContextSectionType.WORKSPACE_INSTRUCTIONS:
        return "workspace_context_over_budget"
    if section_type is TurnContextSectionType.CONVERSATION_CONTEXT:
        return "conversation_context_over_budget"
    if section_type is TurnContextSectionType.COMPACTION_REHYDRATION:
        return "compaction_rehydration_over_budget"
    if section_type is TurnContextSectionType.RUNTIME_REMINDERS:
        return "runtime_reminders_bounded"
    return "context_section_over_budget"


def _trim_middle(content: str, keep_chars: int) -> str:
    if keep_chars <= 0:
        return ""
    if len(content) <= keep_chars:
        return content
    marker = _TRIM_MARKER.format(
        reason="over_budget",
        omitted_chars=max(0, len(content) - keep_chars),
    )
    if keep_chars <= len(marker) + 20:
        return content[:keep_chars].rstrip()
    head_chars = max(1, (keep_chars - len(marker)) // 2)
    tail_chars = max(1, keep_chars - len(marker) - head_chars)
    return f"{content[:head_chars].rstrip()}{marker}{content[-tail_chars:].lstrip()}"


__all__ = [
    "SectionBudgetDiagnostic",
    "SectionBudgetTrim",
    "TurnContextBudgeter",
]
