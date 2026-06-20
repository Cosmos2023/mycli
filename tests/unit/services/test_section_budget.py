from __future__ import annotations

from mycli.domain.runtime import (
    TurnContext,
    TurnContextCacheClass,
    TurnContextSection,
    TurnContextSectionType,
)
from mycli.services.context.section_budget import TurnContextBudgeter


def _section(
    section_type: TurnContextSectionType,
    content: str,
    *,
    cache_class: TurnContextCacheClass = TurnContextCacheClass.DYNAMIC,
) -> TurnContextSection:
    return TurnContextSection(
        type=section_type,
        title=section_type.value,
        content=content,
        enabled=True,
        source=section_type.value,
        cache_class=cache_class,
    )


def test_budgeter_trims_lower_priority_sections_and_preserves_user_request() -> None:
    turn_context = TurnContext(
        user_message="current task",
        sections=(
            _section(
                TurnContextSectionType.BASE_INSTRUCTIONS,
                "follow rules",
                cache_class=TurnContextCacheClass.STATIC,
            ),
            _section(
                TurnContextSectionType.MEMORY,
                "memory " * 800,
            ),
            _section(
                TurnContextSectionType.WORKSPACE_INSTRUCTIONS,
                "workspace " * 600,
                cache_class=TurnContextCacheClass.STATIC,
            ),
            _section(
                TurnContextSectionType.TOOL_EXPOSURE,
                "Available tools: Read, Edit",
                cache_class=TurnContextCacheClass.STATIC,
            ),
            _section(
                TurnContextSectionType.USER_REQUEST,
                "current task",
                cache_class=TurnContextCacheClass.EPHEMERAL,
            ),
        ),
    )

    trimmed, diagnostic = TurnContextBudgeter().apply(
        turn_context=turn_context,
        max_tokens=500,
    )
    sections = {section.type: section for section in trimmed.sections}

    assert diagnostic.before_tokens > diagnostic.after_tokens
    assert diagnostic.trimmed_section_count >= 1
    assert sections[TurnContextSectionType.USER_REQUEST].content == "current task"
    assert sections[TurnContextSectionType.TOOL_EXPOSURE].content == (
        "Available tools: Read, Edit"
    )
    assert sections[TurnContextSectionType.MEMORY].metadata["trimmed"] is True
    assert sections[TurnContextSectionType.MEMORY].metadata["budget_reason"] == (
        "memory_over_budget"
    )
    assert "context section trimmed" in sections[TurnContextSectionType.MEMORY].content


def test_budgeter_reports_no_trim_when_context_is_under_budget() -> None:
    turn_context = TurnContext(
        user_message="hello",
        sections=(
            _section(TurnContextSectionType.BASE_INSTRUCTIONS, "rules"),
            _section(TurnContextSectionType.USER_REQUEST, "hello"),
        ),
    )

    trimmed, diagnostic = TurnContextBudgeter().apply(
        turn_context=turn_context,
        max_tokens=10_000,
    )

    assert trimmed == turn_context
    assert diagnostic.trimmed_section_count == 0
    assert diagnostic.estimated_saved_tokens == 0
