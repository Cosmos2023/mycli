from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    FileRehydrationCandidate,
    InvokedSkillSnapshot,
    RehydrationBudget,
)
from mycli.services.context.compaction.rehydration import CompactionRehydrationService
from mycli.services.context.token_counter import TokenCounter


def _service(tmp_path: Path) -> CompactionRehydrationService:
    return CompactionRehydrationService(
        workspace_root=tmp_path,
        token_counter=TokenCounter(),
        file_budget=RehydrationBudget(max_total_tokens=30, max_item_tokens=20),
        skill_budget=RehydrationBudget(max_total_tokens=30, max_item_tokens=20),
        max_files=5,
        max_skills=5,
    )


def test_file_rehydration_rejects_workspace_escape(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside.py"
    outside.write_text("secret = True\n", encoding="utf-8")

    context = _service(tmp_path).build(
        file_candidates=(FileRehydrationCandidate(path=str(outside), tool_name="Read", sequence=1),),
        invoked_skills=(),
        tail_messages=(),
    )

    assert context.files == ()


def test_file_rehydration_sorts_edits_before_reads_and_deduplicates(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("a = 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("b = 2\n", encoding="utf-8")

    context = _service(tmp_path).build(
        file_candidates=(
            FileRehydrationCandidate(path="a.py", tool_name="Read", sequence=1),
            FileRehydrationCandidate(path="a.py", tool_name="Read", sequence=2),
            FileRehydrationCandidate(path="b.py", tool_name="Edit", sequence=1),
        ),
        invoked_skills=(),
        tail_messages=(),
    )

    assert [item.path for item in context.files] == ["b.py", "a.py"]


def test_file_rehydration_skips_tail_duplicate_content(tmp_path: Path) -> None:
    content = "def answer():\n    return 42\n"
    (tmp_path / "app.py").write_text(content, encoding="utf-8")

    context = _service(tmp_path).build(
        file_candidates=(FileRehydrationCandidate(path="app.py", tool_name="Read", sequence=1),),
        invoked_skills=(),
        tail_messages=(Message(role="tool", content=content),),
    )

    assert context.files == ()


def test_file_rehydration_truncates_by_budget(tmp_path: Path) -> None:
    (tmp_path / "large.py").write_text("x = 1\n" * 200, encoding="utf-8")

    context = _service(tmp_path).build(
        file_candidates=(FileRehydrationCandidate(path="large.py", tool_name="Read", sequence=1),),
        invoked_skills=(),
        tail_messages=(),
    )

    assert context.files
    assert context.files[0].truncated is True
    assert "[truncated]" in context.files[0].content


def test_invoked_skill_rehydration_reads_source_and_orders_by_recent(tmp_path: Path) -> None:
    skills = tmp_path / "skills"
    skills.mkdir()
    first = skills / "first.md"
    second = skills / "second.md"
    first.write_text("First body\n", encoding="utf-8")
    second.write_text("Second body\n", encoding="utf-8")

    context = _service(tmp_path).build(
        file_candidates=(),
        invoked_skills=(
            InvokedSkillSnapshot(
                name="first",
                description="First",
                source_path=str(first),
                body_digest=None,
                cached_body_excerpt=None,
                invoked_at=datetime(2026, 5, 26, tzinfo=UTC),
                last_turn_id="turn_1",
            ),
            InvokedSkillSnapshot(
                name="second",
                description="Second",
                source_path=str(second),
                body_digest=None,
                cached_body_excerpt=None,
                invoked_at=datetime(2026, 5, 27, tzinfo=UTC),
                last_turn_id="turn_2",
            ),
        ),
        tail_messages=(),
    )

    assert [item.name for item in context.invoked_skills] == ["second", "first"]
    assert context.invoked_skills[0].body == "Second body"


def test_invoked_skill_rehydration_uses_capped_excerpt_when_source_missing(tmp_path: Path) -> None:
    context = _service(tmp_path).build(
        file_candidates=(),
        invoked_skills=(
            InvokedSkillSnapshot(
                name="missing",
                description="Missing",
                source_path=str(tmp_path / "missing.md"),
                body_digest=None,
                cached_body_excerpt="Cached body",
                invoked_at=datetime(2026, 5, 27, tzinfo=UTC),
                last_turn_id="turn_1",
            ),
        ),
        tail_messages=(),
    )

    assert context.invoked_skills[0].body == "Cached body"
