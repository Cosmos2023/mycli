# P7 Compaction Rehydration V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace L4 file rehydration through `runtime_reminders` with a first-class post-compaction rehydration channel that restores recent file snapshots and invoked skill bodies without harming DeepSeek cache prefix reuse.

**Architecture:** Add typed compaction rehydration domain objects, a focused post-compaction rehydration service, and a dedicated context/request fragment kind. Keep compaction and rehydration adjacent in the turn lifecycle, but keep responsibilities separate: L4 summarizes conversation history; rehydration restores bounded external state after compacted replay and before the current user request.

**Tech Stack:** Python 3.13, existing dataclasses/domain runtime model, SQLite-backed `SessionService` state rows, pytest, ruff, mypy.

**Spec:** `docs/superpowers/specs/2026-05-27-p7-compaction-rehydration-v2.md`

---

## File Structure

- `src/mycli/domain/runtime/compaction_rehydration.py`: new typed data model for `RehydrationBudget`, `RehydratedFile`, `RehydratedSkill`, `CompactionRehydrationContext`, `InvokedSkillSnapshot`, and `FileRehydrationCandidate`.
- `src/mycli/domain/runtime/__init__.py`: export new compaction rehydration types; add `AgentConfig` budget defaults.
- `src/mycli/domain/runtime/turn_context.py`: add `TurnContextSectionType.COMPACTION_REHYDRATION`.
- `src/mycli/domain/runtime/instruction_contract.py`: add `InstructionFragmentKind.COMPACTION_REHYDRATION`.
- `src/mycli/services/context/compaction/rehydration.py`: new post-compaction rehydration service with file filtering, ordering, budget truncation, invoked skill body loading, and rendering.
- `src/mycli/services/context/compaction/__init__.py`: export rehydration service/types if current package exports are used.
- `src/mycli/state/session_service.py`: persist and load invoked skill snapshots in session state.
- `src/mycli/application/runtime/tools/tool_execution_service.py`: record successful `Skill` tool calls through an injected callback.
- `src/mycli/application/runtime/agent_runtime.py`: wire invoked skill recording, create rehydration service, replace `_build_l4_rehydration_reminders()` usage with `_build_compaction_rehydration_context()`.
- `src/mycli/application/runtime/context/runtime_context_builder.py`: pass `compaction_rehydration` into `ExecutionContext`.
- `src/mycli/services/context/turn_context_assembler.py`: render dedicated compaction rehydration section.
- `src/mycli/services/context/instruction_contract_assembler.py`: convert section to dedicated fragment.
- `src/mycli/application/runtime/request/request_shape_builder.py`: make `compaction_rehydration` model-visible and order Chat Completions as `system -> stable contextual sections -> compacted replay summary + tail messages -> compaction_rehydration -> current user request`.
- `tests/unit/domain/test_runtime.py`: config/default/domain model tests.
- `tests/unit/services/context/compaction/test_rehydration.py`: file and skill rehydration service tests.
- `tests/unit/services/test_session_service.py`: invoked skill snapshot persistence tests.
- `tests/unit/application/test_tool_execution_service.py`: `Skill` success recording tests.
- `tests/unit/services/test_turn_context_assembler.py`: dedicated section rendering tests.
- `tests/unit/services/test_instruction_contract_assembler.py`: dedicated fragment tests.
- `tests/unit/services/test_request_shape_builder.py`: Chat/Responses ordering and visibility tests.
- `tests/unit/application/test_turn_recovery_and_budget.py` and `tests/unit/test_l4_rehydration.py`: update old runtime reminder assertions.
- `docs/superpowers/reports/2026-05-27-p7-compaction-rehydration-v2-smoke.md`: final smoke/verification evidence.

---

### Task 1: Domain Types And Config Defaults

**Files:**
- Create: `src/mycli/domain/runtime/compaction_rehydration.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/domain/runtime/turn_context.py`
- Modify: `src/mycli/domain/runtime/instruction_contract.py`
- Test: `tests/unit/domain/test_runtime.py`

- [ ] **Step 1: Write failing domain/config tests**

Append to `tests/unit/domain/test_runtime.py`:

```python
from datetime import UTC, datetime

from mycli.domain.runtime import (
    AgentConfig,
    CompactionRehydrationContext,
    FileRehydrationCandidate,
    FragmentStability,
    InstructionFragmentKind,
    InvokedSkillSnapshot,
    RehydratedFile,
    RehydratedSkill,
    RehydrationBudget,
    TurnContextSectionType,
)


def test_agent_config_has_compaction_rehydration_defaults(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)

    assert config.compaction_rehydration_file_max_total_tokens == 50_000
    assert config.compaction_rehydration_file_max_item_tokens == 5_000
    assert config.compaction_rehydration_skill_max_total_tokens == 25_000
    assert config.compaction_rehydration_skill_max_item_tokens == 5_000
    assert config.compaction_rehydration_max_files == 5
    assert config.compaction_rehydration_max_skills == 5


def test_compaction_rehydration_types_are_exported() -> None:
    invoked = InvokedSkillSnapshot(
        name="code-review",
        description="Review code",
        source_path="/skills/code-review/SKILL.md",
        body_digest="abc123",
        cached_body_excerpt=None,
        invoked_at=datetime(2026, 5, 27, tzinfo=UTC),
        last_turn_id="turn_1",
    )
    context = CompactionRehydrationContext(
        files=(
            RehydratedFile(
                path="src/app.py",
                content="print('ok')",
                token_count=3,
                truncated=False,
            ),
        ),
        invoked_skills=(
            RehydratedSkill(
                name=invoked.name,
                description=invoked.description,
                source_path=invoked.source_path,
                body="Use focused review.",
                token_count=4,
                truncated=False,
            ),
        ),
    )

    assert context.files[0].path == "src/app.py"
    assert context.invoked_skills[0].name == "code-review"
    assert RehydrationBudget(max_total_tokens=10, max_item_tokens=5).max_item_tokens == 5
    assert FileRehydrationCandidate(path="src/app.py", tool_name="Edit", sequence=1).kind == "edit"
    assert TurnContextSectionType.COMPACTION_REHYDRATION == "compaction_rehydration"
    assert InstructionFragmentKind.COMPACTION_REHYDRATION == "compaction_rehydration"
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_agent_config_has_compaction_rehydration_defaults tests/unit/domain/test_runtime.py::test_compaction_rehydration_types_are_exported -q
```

Expected: FAIL because the new types, enum values, and config fields do not exist.

- [ ] **Step 3: Add domain model**

Create `src/mycli/domain/runtime/compaction_rehydration.py`:

```python
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
        return "edit" if self.tool_name in {"Edit", "Write", "edit_file", "write_file"} else "read"


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
```

- [ ] **Step 4: Export types and add defaults**

Modify `src/mycli/domain/runtime/__init__.py`:

```python
from mycli.domain.runtime.compaction_rehydration import (
    CompactionRehydrationContext as CompactionRehydrationContext,
    FileRehydrationCandidate as FileRehydrationCandidate,
    InvokedSkillSnapshot as InvokedSkillSnapshot,
    RehydratedFile as RehydratedFile,
    RehydratedSkill as RehydratedSkill,
    RehydrationBudget as RehydrationBudget,
)
```

Add fields to `AgentConfig`:

```python
    compaction_rehydration_file_max_total_tokens: int = 50_000
    compaction_rehydration_file_max_item_tokens: int = 5_000
    compaction_rehydration_skill_max_total_tokens: int = 25_000
    compaction_rehydration_skill_max_item_tokens: int = 5_000
    compaction_rehydration_max_files: int = 5
    compaction_rehydration_max_skills: int = 5
```

Add the new names to `__all__`.

Modify `src/mycli/domain/runtime/turn_context.py`:

```python
    COMPACTION_REHYDRATION = "compaction_rehydration"
```

Modify `src/mycli/domain/runtime/instruction_contract.py`:

```python
    COMPACTION_REHYDRATION = "compaction_rehydration"
```

- [ ] **Step 5: Run tests**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_agent_config_has_compaction_rehydration_defaults tests/unit/domain/test_runtime.py::test_compaction_rehydration_types_are_exported -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/runtime tests/unit/domain/test_runtime.py
git commit -m "Define compaction rehydration domain types"
```

---

### Task 2: Rehydration Service For Files And Skills

**Files:**
- Create: `src/mycli/services/context/compaction/rehydration.py`
- Modify: `src/mycli/services/context/compaction/__init__.py`
- Test: `tests/unit/services/context/compaction/test_rehydration.py`

- [ ] **Step 1: Write failing rehydration service tests**

Create `tests/unit/services/context/compaction/test_rehydration.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/services/context/compaction/test_rehydration.py -q
```

Expected: FAIL because `CompactionRehydrationService` does not exist.

- [ ] **Step 3: Implement rehydration service**

Create `src/mycli/services/context/compaction/rehydration.py`:

```python
from __future__ import annotations

from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    CompactionRehydrationContext,
    FileRehydrationCandidate,
    InvokedSkillSnapshot,
    RehydratedFile,
    RehydratedSkill,
    RehydrationBudget,
)
from mycli.services.context.token_counter import TokenCounter


_STATE_FILE_PREFIXES = (
    ".mycli/",
    ".omx/",
    "docs/superpowers/plans/",
)


class CompactionRehydrationService:
    def __init__(
        self,
        *,
        workspace_root: Path,
        token_counter: TokenCounter,
        file_budget: RehydrationBudget,
        skill_budget: RehydrationBudget,
        max_files: int,
        max_skills: int,
    ) -> None:
        self._workspace_root = workspace_root.resolve()
        self._token_counter = token_counter
        self._file_budget = file_budget
        self._skill_budget = skill_budget
        self._max_files = max(0, max_files)
        self._max_skills = max(0, max_skills)

    def build(
        self,
        *,
        file_candidates: tuple[FileRehydrationCandidate, ...],
        invoked_skills: tuple[InvokedSkillSnapshot, ...],
        tail_messages: tuple[Message, ...],
    ) -> CompactionRehydrationContext:
        return CompactionRehydrationContext(
            files=self._build_files(file_candidates, tail_messages),
            invoked_skills=self._build_skills(invoked_skills),
        )

    def render(self, context: CompactionRehydrationContext) -> str:
        parts: list[str] = []
        if context.invoked_skills:
            parts.append(self._render_skills(context.invoked_skills))
        if context.files:
            parts.append(self._render_files(context.files))
        return "\n\n".join(parts)

    def _build_files(
        self,
        candidates: tuple[FileRehydrationCandidate, ...],
        tail_messages: tuple[Message, ...],
    ) -> tuple[RehydratedFile, ...]:
        tail_text = "\n".join(message.content for message in tail_messages if message.content)
        remaining_total = self._file_budget.max_total_tokens
        result: list[RehydratedFile] = []
        seen: set[str] = set()
        for candidate in self._ordered_candidates(candidates):
            if len(result) >= self._max_files or remaining_total <= 0:
                break
            resolved = self._resolve_workspace_file(candidate.path)
            if resolved is None:
                continue
            relative = str(resolved.relative_to(self._workspace_root))
            if relative in seen or self._is_state_file(relative):
                continue
            seen.add(relative)
            try:
                content = resolved.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if not content or content in tail_text:
                continue
            truncated_content, token_count, truncated = self._truncate(
                content=content,
                max_item_tokens=min(self._file_budget.max_item_tokens, remaining_total),
            )
            if not truncated_content:
                continue
            remaining_total -= token_count
            suffix = "\n[truncated]" if truncated else ""
            result.append(
                RehydratedFile(
                    path=relative,
                    content=f"{truncated_content}{suffix}",
                    token_count=token_count,
                    truncated=truncated,
                )
            )
        return tuple(result)

    def _build_skills(
        self,
        snapshots: tuple[InvokedSkillSnapshot, ...],
    ) -> tuple[RehydratedSkill, ...]:
        remaining_total = self._skill_budget.max_total_tokens
        result: list[RehydratedSkill] = []
        seen: set[str] = set()
        for snapshot in sorted(snapshots, key=lambda item: item.invoked_at, reverse=True):
            if len(result) >= self._max_skills or remaining_total <= 0:
                break
            if snapshot.name in seen:
                continue
            seen.add(snapshot.name)
            body = self._skill_body(snapshot)
            if not body:
                continue
            truncated_body, token_count, truncated = self._truncate(
                content=body,
                max_item_tokens=min(self._skill_budget.max_item_tokens, remaining_total),
            )
            if not truncated_body:
                continue
            remaining_total -= token_count
            suffix = "\n[truncated]" if truncated else ""
            result.append(
                RehydratedSkill(
                    name=snapshot.name,
                    description=snapshot.description,
                    source_path=snapshot.source_path,
                    body=f"{truncated_body}{suffix}",
                    token_count=token_count,
                    truncated=truncated,
                )
            )
        return tuple(result)

    def _ordered_candidates(
        self,
        candidates: tuple[FileRehydrationCandidate, ...],
    ) -> tuple[FileRehydrationCandidate, ...]:
        return tuple(
            sorted(
                candidates,
                key=lambda item: (0 if item.kind == "edit" else 1, -item.sequence),
            )
        )

    def _resolve_workspace_file(self, raw_path: str) -> Path | None:
        if not raw_path.strip():
            return None
        candidate = Path(raw_path)
        path = candidate if candidate.is_absolute() else self._workspace_root / candidate
        try:
            resolved = path.resolve()
            resolved.relative_to(self._workspace_root)
        except (OSError, ValueError):
            return None
        return resolved if resolved.is_file() else None

    def _is_state_file(self, relative_path: str) -> bool:
        normalized = relative_path.replace("\\", "/")
        return any(normalized.startswith(prefix) for prefix in _STATE_FILE_PREFIXES)

    def _skill_body(self, snapshot: InvokedSkillSnapshot) -> str:
        if snapshot.source_path:
            try:
                path = Path(snapshot.source_path)
                if path.is_file():
                    return path.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                pass
        return (snapshot.cached_body_excerpt or "").strip()

    def _truncate(self, *, content: str, max_item_tokens: int) -> tuple[str, int, bool]:
        if max_item_tokens <= 0:
            return "", 0, False
        token_count = self._token_counter.count(content)
        truncated = False
        while token_count > max_item_tokens and content:
            truncated = True
            content = content[: max(1, int(len(content) * 0.8))]
            token_count = self._token_counter.count(content)
        return content.rstrip(), token_count, truncated

    def _render_skills(self, skills: tuple[RehydratedSkill, ...]) -> str:
        blocks = [
            "[Invoked skills after compaction]",
            "Continue to follow these skill instructions.",
        ]
        for skill in skills:
            blocks.append(f"## {skill.name}\n{skill.body}")
        return "\n\n".join(blocks)

    def _render_files(self, files: tuple[RehydratedFile, ...]) -> str:
        blocks = [
            "[Compaction file rehydration]",
            "Recent file snapshots are current disk content. Re-read files if exact content matters.",
        ]
        for item in files:
            blocks.append(f"### {item.path}\n```text\n{item.content}\n```")
        return "\n\n".join(blocks)
```

Update `src/mycli/services/context/compaction/__init__.py` only if it already exports package classes. Export `CompactionRehydrationService` beside other compaction services.

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/unit/services/context/compaction/test_rehydration.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/services/context/compaction tests/unit/services/context/compaction/test_rehydration.py
git commit -m "Add post-compaction rehydration service"
```

---

### Task 3: Invoked Skill Snapshot Persistence

**Files:**
- Modify: `src/mycli/state/session_service.py`
- Modify: `src/mycli/domain/runtime/session_history.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Test: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write failing persistence tests**

Append to `tests/unit/services/test_session_service.py`:

```python
from datetime import UTC, datetime

from mycli.domain.runtime import InvokedSkillSnapshot


def test_session_service_round_trips_invoked_skill_snapshots(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    snapshot = InvokedSkillSnapshot(
        name="code-review",
        description="Review code",
        source_path=str(tmp_path / "skills" / "code-review" / "SKILL.md"),
        body_digest="sha256:abc",
        cached_body_excerpt="Review only changed code.",
        invoked_at=datetime(2026, 5, 27, 8, 0, tzinfo=UTC),
        last_turn_id="turn_1",
    )

    service.record_invoked_skill_snapshot("demo", snapshot)
    loaded = service.load_invoked_skill_snapshots("demo")

    assert loaded == (snapshot,)
    runtime_snapshot = service.load_runtime_snapshot("demo")
    assert runtime_snapshot is not None
    assert runtime_snapshot.invoked_skills == (snapshot,)


def test_session_service_replaces_invoked_skill_by_name_with_latest(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    first = InvokedSkillSnapshot(
        name="code-review",
        description="Old",
        source_path=None,
        body_digest="old",
        cached_body_excerpt="Old body",
        invoked_at=datetime(2026, 5, 27, 8, 0, tzinfo=UTC),
        last_turn_id="turn_1",
    )
    second = InvokedSkillSnapshot(
        name="code-review",
        description="New",
        source_path=None,
        body_digest="new",
        cached_body_excerpt="New body",
        invoked_at=datetime(2026, 5, 27, 9, 0, tzinfo=UTC),
        last_turn_id="turn_2",
    )

    service.record_invoked_skill_snapshot("demo", first)
    service.record_invoked_skill_snapshot("demo", second)

    assert service.load_invoked_skill_snapshots("demo") == (second,)
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_session_service.py::test_session_service_round_trips_invoked_skill_snapshots tests/unit/services/test_session_service.py::test_session_service_replaces_invoked_skill_by_name_with_latest -q
```

Expected: FAIL because `SessionService` has no invoked skill persistence API and `SessionRuntimeSnapshot` has no `invoked_skills` field.

- [ ] **Step 3: Add serialization helpers and snapshot field**

Modify `src/mycli/domain/runtime/compaction_rehydration.py`:

```python
from datetime import datetime
from typing import Any


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
            source_path=payload["source_path"] if isinstance(payload.get("source_path"), str) else None,
            body_digest=payload["body_digest"] if isinstance(payload.get("body_digest"), str) else None,
            cached_body_excerpt=payload["cached_body_excerpt"] if isinstance(payload.get("cached_body_excerpt"), str) else None,
            invoked_at=datetime.fromisoformat(str(payload["invoked_at"])),
            last_turn_id=str(payload["last_turn_id"]),
        )
```

Modify `src/mycli/domain/runtime/session_history.py`:

```python
from mycli.domain.runtime.compaction_rehydration import InvokedSkillSnapshot


@dataclass(slots=True, frozen=True)
class SessionRuntimeSnapshot:
    session_id: str
    thread_id: str
    history_items: tuple[HistoryItem, ...] = ()
    context_baseline: ContextBaseline | None = None
    turn_rollouts: tuple[TurnRollout, ...] = ()
    continuation_state: dict[str, Any] = field(default_factory=dict)
    invoked_skills: tuple[InvokedSkillSnapshot, ...] = ()
```

- [ ] **Step 4: Add SessionService API**

Modify `src/mycli/state/session_service.py`:

```python
from mycli.domain.runtime import InvokedSkillSnapshot


class SessionService:
    _KEY_INVOKED_SKILLS = "invoked_skills"

    def record_invoked_skill_snapshot(
        self,
        session_id: str,
        snapshot: InvokedSkillSnapshot,
    ) -> None:
        existing = {
            item.name: item
            for item in self.load_invoked_skill_snapshots(session_id)
        }
        existing[snapshot.name] = snapshot
        ordered = sorted(existing.values(), key=lambda item: item.invoked_at.isoformat())
        self._save_state(
            session_id=session_id,
            thread_id=session_id,
            state_key=self._KEY_INVOKED_SKILLS,
            payload=[item.to_dict() for item in ordered],
        )

    def load_invoked_skill_snapshots(
        self,
        session_id: str,
    ) -> tuple[InvokedSkillSnapshot, ...]:
        payload = self._load_state_list(session_id, self._KEY_INVOKED_SKILLS)
        return tuple(
            InvokedSkillSnapshot.from_dict(item)
            for item in payload
            if isinstance(item, dict)
        )
```

Update `load_runtime_snapshot()` to load and return `invoked_skills`. Include `not invoked_skills` in the empty snapshot guard:

```python
        invoked_skills = self.load_invoked_skill_snapshots(session_id)
        if (
            not history_items
            and context_baseline is None
            and not turn_rollouts
            and continuation_state is None
            and not invoked_skills
        ):
            return None
```

Pass `invoked_skills=invoked_skills` into `SessionRuntimeSnapshot`.

- [ ] **Step 5: Run tests**

Run:

```bash
uv run pytest tests/unit/services/test_session_service.py::test_session_service_round_trips_invoked_skill_snapshots tests/unit/services/test_session_service.py::test_session_service_replaces_invoked_skill_by_name_with_latest -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/runtime src/mycli/state/session_service.py tests/unit/services/test_session_service.py
git commit -m "Persist invoked skill snapshots"
```

---

### Task 4: Dedicated Context And Request Shape

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/application/runtime/context/runtime_context_builder.py`
- Modify: `src/mycli/services/context/turn_context_assembler.py`
- Modify: `src/mycli/services/context/instruction_contract_assembler.py`
- Modify: `src/mycli/application/runtime/request/request_shape_builder.py`
- Test: `tests/unit/services/test_turn_context_assembler.py`
- Test: `tests/unit/services/test_instruction_contract_assembler.py`
- Test: `tests/unit/services/test_request_shape_builder.py`

- [ ] **Step 1: Write failing context assembly tests**

Append to `tests/unit/services/test_turn_context_assembler.py`:

```python
from mycli.domain.runtime import (
    CompactionRehydrationContext,
    PlanItem,
    PlanState,
    PlanStatus,
    RehydratedFile,
)


def test_turn_context_assembler_renders_compaction_rehydration_section() -> None:
    context = ExecutionContext(
        config=AgentConfig(workspace_root=Path("/tmp/workspace")),
        compaction_rehydration=CompactionRehydrationContext(
            files=(
                RehydratedFile(
                    path="src/app.py",
                    content="def answer():\n    return 42",
                    token_count=6,
                    truncated=False,
                ),
            )
        ),
    )

    turn_context = TurnContextAssembler().assemble(user_message="continue", context=context)
    section = next(
        item
        for item in turn_context.sections
        if item.type is TurnContextSectionType.COMPACTION_REHYDRATION
    )

    assert section.enabled is True
    assert "[Compaction file rehydration]" in section.content
    assert "src/app.py" in section.content
```

Append to `tests/unit/services/test_instruction_contract_assembler.py`:

```python
from mycli.domain.runtime import CompactionRehydrationContext, RehydratedFile


def test_instruction_contract_assembler_emits_compaction_rehydration_fragment() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            compaction_rehydration=CompactionRehydrationContext(
                files=(
                    RehydratedFile(
                        path="src/app.py",
                        content="print('ok')",
                        token_count=3,
                        truncated=False,
                    ),
                )
            ),
        ),
    )

    contract = InstructionContractAssembler().assemble(
        turn_context=turn_context,
        base_instructions="Base",
        conversation_messages=(),
    )

    fragment = next(
        item
        for item in contract.contextual_user_sections
        if item.kind == "compaction_rehydration"
    )
    assert fragment.include_in_memory is False
    assert "[Compaction file rehydration]" in fragment.content


def test_instruction_contract_keeps_plan_separate_from_compaction_rehydration() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            plan_state=PlanState(
                items=(
                    PlanItem(
                        id="plan_1",
                        content="Finish the implementation",
                        status=PlanStatus.IN_PROGRESS,
                    ),
                )
            ),
            compaction_rehydration=CompactionRehydrationContext(
                files=(
                    RehydratedFile(
                        path="src/app.py",
                        content="print('ok')",
                        token_count=3,
                        truncated=False,
                    ),
                )
            ),
        ),
    )

    contract = InstructionContractAssembler().assemble(
        turn_context=turn_context,
        base_instructions="Base",
        conversation_messages=(),
    )

    plan_fragment = next(item for item in contract.contextual_user_sections if item.kind == "plan")
    rehydration_fragment = next(
        item
        for item in contract.contextual_user_sections
        if item.kind == "compaction_rehydration"
    )

    assert "Finish the implementation" in plan_fragment.content
    assert "Finish the implementation" not in rehydration_fragment.content
    assert "src/app.py" in rehydration_fragment.content
```

- [ ] **Step 2: Write failing request ordering tests**

Append to `tests/unit/services/test_request_shape_builder.py`:

```python
def test_request_shape_builder_places_chat_rehydration_after_replay_before_current_user(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(
            workspace_root=tmp_path,
            provider="deepseek",
            protocol="chat_completions",
            model="deepseek-v4-flash",
        ),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                ),
                InstructionFragment(
                    kind="compaction_rehydration",
                    title="Compaction rehydration",
                    content="[Compaction file rehydration]\n### src/app.py",
                ),
            ),
            conversation_messages=(
                Message(role="assistant", content="Compacted summary"),
                Message(role="assistant", content="Tail answer"),
            ),
            current_user_request="continue now",
        ),
        tools=(_tool("Skill"),),
    )

    contents = [message.content for message in shape.provider_messages]
    joined = "\n".join(contents)

    assert joined.index("Available skills") < joined.index("Compacted summary")
    assert joined.index("Compacted summary") < joined.index("[Compaction file rehydration]")
    assert joined.index("[Compaction file rehydration]") < joined.index("continue now")


def test_request_shape_builder_includes_compaction_rehydration_in_responses_delta(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path, protocol=ProtocolId.RESPONSES),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="compaction_rehydration",
                    title="Compaction rehydration",
                    content="[Invoked skills after compaction]\n## code-review",
                ),
            ),
            current_user_request="continue",
        ),
        tools=(_tool("Skill"),),
    )

    assert any(
        "[Invoked skills after compaction]" in message.content
        for message in shape.provider_messages
        if message.role == "user"
    )
    assert any(
        fragment.id == "volatile:compaction_rehydration"
        and fragment.metadata["instruction_fragment_kind"] == "compaction_rehydration"
        for fragment in shape.fragments
    )
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_turn_context_assembler.py::test_turn_context_assembler_renders_compaction_rehydration_section tests/unit/services/test_instruction_contract_assembler.py::test_instruction_contract_assembler_emits_compaction_rehydration_fragment tests/unit/services/test_instruction_contract_assembler.py::test_instruction_contract_keeps_plan_separate_from_compaction_rehydration tests/unit/services/test_request_shape_builder.py::test_request_shape_builder_places_chat_rehydration_after_replay_before_current_user tests/unit/services/test_request_shape_builder.py::test_request_shape_builder_includes_compaction_rehydration_in_responses_delta -q
```

Expected: FAIL because `ExecutionContext` lacks `compaction_rehydration`, assemblers do not render it, and request shape builder does not recognize the fragment.

- [ ] **Step 4: Add context field and assembly**

Modify `ExecutionContext` in `src/mycli/domain/runtime/__init__.py`:

```python
    compaction_rehydration: CompactionRehydrationContext = field(
        default_factory=CompactionRehydrationContext
    )
```

Modify `RuntimeContextBuilder.build_context()` and `assemble_turn_context()` to accept:

```python
        compaction_rehydration: CompactionRehydrationContext | None = None,
```

Pass this into `ExecutionContext`:

```python
            compaction_rehydration=compaction_rehydration or CompactionRehydrationContext(),
```

Modify `TurnContextAssembler.assemble()`:

```python
        compaction_rehydration_content = self._render_compaction_rehydration(context)
```

Insert this section after `CONVERSATION_CONTEXT` and before `MEMORY`:

```python
            TurnContextSection(
                type=TurnContextSectionType.COMPACTION_REHYDRATION,
                title="Compaction rehydration",
                content=compaction_rehydration_content,
                enabled=bool(compaction_rehydration_content),
                source="compaction",
            ),
```

Add helper:

```python
    def _render_compaction_rehydration(self, context: ExecutionContext) -> str:
        files = context.compaction_rehydration.files
        skills = context.compaction_rehydration.invoked_skills
        parts: list[str] = []
        if skills:
            parts.append("[Invoked skills after compaction]")
            parts.append("Continue to follow these skill instructions.")
            for skill in skills:
                parts.append(f"## {skill.name}\n{skill.body}")
        if files:
            parts.append("[Compaction file rehydration]")
            parts.append(
                "Recent file snapshots are current disk content. Re-read files if exact content matters."
            )
            for item in files:
                parts.append(f"### {item.path}\n```text\n{item.content}\n```")
        return "\n\n".join(parts)
```

Modify `InstructionContractAssembler.assemble()`:

```python
            if section.type is TurnContextSectionType.COMPACTION_REHYDRATION:
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.COMPACTION_REHYDRATION,
                        include_in_memory=False,
                        prefix="这是压缩后的复水上下文。它补充当前文件快照和已调用 skill 指令，不是用户的新请求。",
                    )
                )
                continue
```

- [ ] **Step 5: Update request shape builder visibility and ordering**

Modify `_transcript_contextual_section_is_model_visible()` and `_responses_contextual_section_is_model_visible()` to include:

```python
            "compaction_rehydration",
```

Modify `_transcript_provider_messages()` so `skill_catalog` stays before replay and `compaction_rehydration` moves after replay:

```python
        stable_context = self._render_transcript_delta_context(
            contract,
            include_kinds={"skill_catalog"},
        )
        rehydration_context = self._render_transcript_delta_context(
            contract,
            include_kinds={"compaction_rehydration"},
        )
```

Update `_render_transcript_delta_context()` signature:

```python
    def _render_transcript_delta_context(
        self,
        contract: InstructionContract,
        *,
        include_kinds: set[str] | None = None,
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in contract.contextual_user_sections
            if self._transcript_contextual_section_is_model_visible(section)
            and (include_kinds is None or str(section.kind) in include_kinds)
        )
```

Then assemble:

```python
        if stable_context:
            messages.append(ProviderMessageShape(role="user", content=stable_context))
        for message in self._chat_completions_replay_messages(contract):
            ...
        if rehydration_context:
            messages.append(ProviderMessageShape(role="user", content=rehydration_context))
        if contract.current_user_request and not self._replay_contains_current_user_request(contract):
            messages.append(ProviderMessageShape(role="user", content=contract.current_user_request))
```

Apply the same order to `_transcript_provider_runtime_items()`.

- [ ] **Step 6: Run tests**

Run:

```bash
uv run pytest tests/unit/services/test_turn_context_assembler.py::test_turn_context_assembler_renders_compaction_rehydration_section tests/unit/services/test_instruction_contract_assembler.py::test_instruction_contract_assembler_emits_compaction_rehydration_fragment tests/unit/services/test_instruction_contract_assembler.py::test_instruction_contract_keeps_plan_separate_from_compaction_rehydration tests/unit/services/test_request_shape_builder.py::test_request_shape_builder_places_chat_rehydration_after_replay_before_current_user tests/unit/services/test_request_shape_builder.py::test_request_shape_builder_includes_compaction_rehydration_in_responses_delta -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/domain/runtime src/mycli/application/runtime/context src/mycli/services/context src/mycli/application/runtime/request tests/unit/services
git commit -m "Route compaction rehydration through request context"
```

---

### Task 5: Record Successful Skill Invocations

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Test: `tests/unit/application/test_tool_execution_service.py`

- [ ] **Step 1: Write failing skill recording test**

Append to `tests/unit/application/test_tool_execution_service.py`:

```python
from mycli.domain.runtime import InvokedSkillSnapshot


def test_tool_execution_service_records_successful_skill_invocation(tmp_path: Path) -> None:
    recorded: list[InvokedSkillSnapshot] = []
    hook_manager = HookManager()
    skill_tool = FakeSkillTool()
    registry = ToolRegistry.from_tools([skill_tool])
    service, _ = _service(
        tmp_path,
        hook_manager=hook_manager,
        registry=registry,
        record_invoked_skill=lambda snapshot: recorded.append(snapshot),
    )
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Skill"),
                source=ToolRouteSource.REGISTRY,
                spec=skill_tool.spec,
            ),
        )
    )
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="Skill",
            arguments={"skill_name": "code-review"},
            reason="Need code review instructions",
            call_id="call_skill",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert len(recorded) == 1
    assert recorded[0].name == "code-review"
    assert recorded[0].description == "Review code"
    assert recorded[0].source_path is not None
    assert recorded[0].cached_body_excerpt == "Find correctness bugs first."
    assert recorded[0].last_turn_id == "turn_1"
```

Modify the existing `_service()` helper signature in `tests/unit/application/test_tool_execution_service.py`:

```python
def _service(
    tmp_path: Path,
    *,
    hook_manager: HookManager,
    registry: ToolRegistry | None = None,
    file_history: FileHistoryService | None = None,
    record_invoked_skill: Callable[[InvokedSkillSnapshot], None] | None = None,
) -> tuple[ToolExecutionService, FakeTool]:
```

Add imports:

```python
from typing import Callable
from mycli.domain.runtime import InvokedSkillSnapshot
```

Pass the callback into `ToolExecutionService(...)` in that helper:

```python
        record_invoked_skill=record_invoked_skill,
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/application/test_tool_execution_service.py::test_tool_execution_service_records_successful_skill_invocation -q
```

Expected: FAIL because `ToolExecutionService` has no `record_invoked_skill` callback.

- [ ] **Step 3: Add callback and snapshot creation**

Modify `ToolExecutionService.__init__()`:

```python
        record_invoked_skill: Callable[[InvokedSkillSnapshot], None] | None = None,
```

Store it:

```python
        self._record_invoked_skill = record_invoked_skill
```

Add imports:

```python
from datetime import UTC, datetime
import hashlib

from mycli.domain.runtime import InvokedSkillSnapshot
```

After `result = ...` is available in the existing single-tool execution path, add a call before `_record_tool_message()`:

```python
        self._record_skill_invocation(
            tool_name=normalized_call.name,
            result=result,
            turn_id=turn_id,
        )
```

Add helper:

```python
    def _record_skill_invocation(
        self,
        *,
        tool_name: str,
        result: ToolResult,
        turn_id: str,
    ) -> None:
        if self._record_invoked_skill is None:
            return
        if tool_name != "Skill" or not result.success:
            return
        skill_name = result.raw_payload.get("skill_name")
        content = result.raw_payload.get("content")
        if not isinstance(skill_name, str) or not skill_name.strip():
            return
        body = content.strip() if isinstance(content, str) else ""
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest() if body else None
        self._record_invoked_skill(
            InvokedSkillSnapshot(
                name=skill_name.strip(),
                description=str(result.raw_payload.get("description") or ""),
                source_path=(
                    str(result.raw_payload["source_path"])
                    if isinstance(result.raw_payload.get("source_path"), str)
                    else None
                ),
                body_digest=digest,
                cached_body_excerpt=body[:20_000] if body else None,
                invoked_at=datetime.now(UTC),
                last_turn_id=turn_id,
            )
        )
```

Wire the callback in `AgentRuntime.__init__()`:

```python
            record_invoked_skill=lambda snapshot: self._session_service.record_invoked_skill_snapshot(
                self._config.session_id,
                snapshot,
            ),
```

- [ ] **Step 4: Run test**

Run:

```bash
uv run pytest tests/unit/application/test_tool_execution_service.py::test_tool_execution_service_records_successful_skill_invocation -q
```

Expected: PASS.

- [ ] **Step 5: Run existing tool execution tests**

Run:

```bash
uv run pytest tests/unit/application/test_tool_execution_service.py tests/unit/application/test_parallel_tool_execution.py tests/unit/test_tool_append_seal.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/runtime/tools/tool_execution_service.py src/mycli/application/runtime/agent_runtime.py tests/unit/application/test_tool_execution_service.py
git commit -m "Record invoked skill snapshots"
```

---

### Task 6: Build Rehydration After L4 Compaction

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/runtime/context/runtime_context_builder.py`
- Test: `tests/unit/test_l4_rehydration.py`
- Test: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Write failing runtime rehydration tests**

Replace `test_runtime_builds_recent_file_rehydration_block` in `tests/unit/test_l4_rehydration.py` with:

```python
def test_runtime_builds_compaction_rehydration_context_from_recent_files(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    target = tmp_path / "src" / "app.py"
    target.write_text("def answer():\n    return 42\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=object(),
    )
    runtime.rebind_session(AgentConfig(workspace_root=tmp_path))

    context = runtime._build_compaction_rehydration_context(
        cost_metrics={"recent_files": ["src/app.py"]},
        conversation_tail=(),
    )

    assert context.files[0].path == "src/app.py"
    assert "def answer()" in context.files[0].content
```

Add:

```python
def test_runtime_compaction_rehydration_includes_invoked_skills(tmp_path: Path) -> None:
    skill_file = tmp_path / "skill.md"
    skill_file.write_text("Follow the skill body.\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=object(),
    )
    runtime.rebind_session(AgentConfig(workspace_root=tmp_path, session_id="demo"))
    runtime._session_service.record_invoked_skill_snapshot(
        "demo",
        InvokedSkillSnapshot(
            name="demo-skill",
            description="Demo skill",
            source_path=str(skill_file),
            body_digest=None,
            cached_body_excerpt=None,
            invoked_at=datetime(2026, 5, 27, tzinfo=UTC),
            last_turn_id="turn_1",
        ),
    )

    context = runtime._build_compaction_rehydration_context(
        cost_metrics={"recent_files": []},
        conversation_tail=(),
    )

    assert context.invoked_skills[0].name == "demo-skill"
    assert "Follow the skill body" in context.invoked_skills[0].body
```

Add imports:

```python
from datetime import UTC, datetime
from mycli.domain.runtime import InvokedSkillSnapshot
```

Update old reminder tests in `tests/unit/application/test_turn_recovery_and_budget.py` so they expect no model-visible `[Compaction rehydration]` in `runtime_reminders`; keep `_apply_l4_recent_file_hints()` tests only for the short hint if the helper remains.

- [ ] **Step 2: Run failing tests**

Run:

```bash
uv run pytest tests/unit/test_l4_rehydration.py::test_runtime_builds_compaction_rehydration_context_from_recent_files tests/unit/test_l4_rehydration.py::test_runtime_compaction_rehydration_includes_invoked_skills -q
```

Expected: FAIL because `_build_compaction_rehydration_context()` does not exist.

- [ ] **Step 3: Add runtime builder method**

Modify `AgentRuntime.__init__()` to keep a rehydration service factory or method. Add method:

```python
    def _build_compaction_rehydration_context(
        self,
        *,
        cost_metrics: dict[str, int | float | str | list[str]] | None,
        conversation_tail: tuple[Message, ...],
    ) -> CompactionRehydrationContext:
        raw_files = [] if cost_metrics is None else cost_metrics.get("recent_files")
        candidates = self._file_rehydration_candidates(raw_files)
        service = CompactionRehydrationService(
            workspace_root=self._config.workspace_root,
            token_counter=self._token_counter,
            file_budget=RehydrationBudget(
                max_total_tokens=self._config.compaction_rehydration_file_max_total_tokens,
                max_item_tokens=self._config.compaction_rehydration_file_max_item_tokens,
            ),
            skill_budget=RehydrationBudget(
                max_total_tokens=self._config.compaction_rehydration_skill_max_total_tokens,
                max_item_tokens=self._config.compaction_rehydration_skill_max_item_tokens,
            ),
            max_files=self._config.compaction_rehydration_max_files,
            max_skills=self._config.compaction_rehydration_max_skills,
        )
        return service.build(
            file_candidates=candidates,
            invoked_skills=self._session_service.load_invoked_skill_snapshots(
                self._config.session_id
            ),
            tail_messages=conversation_tail,
        )

    def _file_rehydration_candidates(
        self,
        raw_files: object,
    ) -> tuple[FileRehydrationCandidate, ...]:
        if not isinstance(raw_files, list):
            return ()
        candidates: list[FileRehydrationCandidate] = []
        for index, raw_path in enumerate(raw_files):
            if isinstance(raw_path, str) and raw_path.strip():
                candidates.append(
                    FileRehydrationCandidate(
                        path=raw_path.strip(),
                        tool_name="Read",
                        sequence=index,
                    )
                )
        return tuple(candidates)
```

Keep `_build_l4_rehydration_reminders()` temporarily if old code still calls it. It will be removed or reduced after `turn_executor.py` is migrated.

- [ ] **Step 4: Pass compaction rehydration through turn executor**

In `TurnExecutor.execute_user_turn()`, add local variable near `runtime_reminders`:

```python
        compaction_rehydration = CompactionRehydrationContext()
```

After L4 compaction applies, replace:

```python
*runtime._build_l4_rehydration_reminders(...)
```

with:

```python
compaction_rehydration = runtime._build_compaction_rehydration_context(
    cost_metrics=runtime._compaction_pipeline.llm_summarization.last_cost_metrics,
    conversation_tail=tuple(conversation_for_model.messages),
)
```

Pass `compaction_rehydration=compaction_rehydration` into every `_assemble_turn_context(...)` call that follows compaction.

Update `AgentRuntime._assemble_turn_context()` and `RuntimeContextBuilder.assemble_turn_context()` signatures to accept and pass `compaction_rehydration`.

- [ ] **Step 5: Run tests**

Run:

```bash
uv run pytest tests/unit/test_l4_rehydration.py tests/unit/application/test_turn_recovery_and_budget.py -q
```

Expected: PASS after updating old reminder assertions.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/runtime tests/unit/test_l4_rehydration.py tests/unit/application/test_turn_recovery_and_budget.py
git commit -m "Build rehydration context after L4 compaction"
```

---

### Task 7: Remove Model-Visible L4 Runtime Reminder Path

**Files:**
- Modify: `src/mycli/services/context/turn_context_assembler.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `tests/unit/services/test_turn_context_assembler.py`
- Modify: `tests/unit/services/test_request_shape_builder.py`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Write failing regression tests**

Append to `tests/unit/services/test_turn_context_assembler.py`:

```python
def test_turn_context_assembler_does_not_render_compaction_rehydration_from_runtime_reminders() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            runtime_reminders=(
                "[Compaction rehydration]\n### src/app.py\n```text\nold path\n```",
            ),
        ),
    )

    runtime_section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.RUNTIME_REMINDERS
    )

    assert runtime_section.enabled is False
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_turn_context_assembler.py::test_turn_context_assembler_does_not_render_compaction_rehydration_from_runtime_reminders -q
```

Expected: FAIL because `_render_runtime_reminders()` currently keeps `[Compaction rehydration]`.

- [ ] **Step 3: Remove old filtering exception**

Modify `_render_runtime_reminders()` in `src/mycli/services/context/turn_context_assembler.py`:

```python
    def _render_runtime_reminders(self, context: ExecutionContext) -> str:
        reminders = tuple(
            item
            for item in context.runtime_reminders
            if item.strip() and not item.startswith("[Compaction rehydration]")
        )
        if not reminders:
            return ""
        return "\n".join(("Runtime reminders:", *[f"- {item}" for item in reminders]))
```

This keeps `BudgetNudge` reminders model-visible if they still exist, while permanently excluding L4 files and invoked skills from the runtime reminder channel.

- [ ] **Step 4: Remove `_build_l4_rehydration_reminders()` call sites**

Search:

```bash
rg -n "_build_l4_rehydration_reminders|\\[Compaction rehydration\\]" src tests
```

Expected remaining references after implementation:

```text
tests or migration notes only for old marker rejection
```

Delete `_build_l4_rehydration_reminders()` from `AgentRuntime` after replacing all production call sites. Move existing path safety assertions to `CompactionRehydrationService` tests in `tests/unit/services/context/compaction/test_rehydration.py`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
uv run pytest tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_request_shape_builder.py tests/unit/test_l4_rehydration.py tests/unit/services/context/compaction/test_rehydration.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mycli tests/unit
git commit -m "Stop routing L4 rehydration through runtime reminders"
```

---

### Task 8: End-To-End Verification And Smoke Report

**Files:**
- Create: `docs/superpowers/reports/2026-05-27-p7-compaction-rehydration-v2-smoke.md`
- Modify only if needed: tests touched by failures from this task.

- [ ] **Step 1: Run request/context focused suite**

Run:

```bash
uv run pytest tests/unit/services/context/compaction/test_rehydration.py tests/unit/test_l4_rehydration.py tests/unit/services/test_request_shape_builder.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py tests/unit/services/test_session_service.py tests/unit/application/test_tool_execution_service.py -q
```

Expected: PASS.

- [ ] **Step 2: Run static checks**

Run:

```bash
uv run ruff check src tests
```

Expected: PASS.

Run:

```bash
uv run mypy src/mycli
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
uv run pytest -q
```

Expected: PASS.

- [ ] **Step 4: Write smoke report**

Create `docs/superpowers/reports/2026-05-27-p7-compaction-rehydration-v2-smoke.md`:

```markdown
# P7 Compaction Rehydration V2 Smoke

## Scope

- Dedicated `compaction_rehydration` context replaces L4 file snapshots through `runtime_reminders`.
- Invoked skill snapshots persist and restore after L4.
- Chat Completions ordering preserves DeepSeek cache prefix through compacted replay.

## Verification

| Command | Result |
| --- | --- |
| `uv run pytest tests/unit/services/context/compaction/test_rehydration.py tests/unit/test_l4_rehydration.py tests/unit/services/test_request_shape_builder.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py tests/unit/services/test_session_service.py tests/unit/application/test_tool_execution_service.py -q` | PASS |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS |

## Notes

- Existing sessions without invoked skill snapshots resume normally and simply do not restore skill bodies until a skill is invoked again.
- `runtime_reminders` no longer carries `[Compaction rehydration]` file snapshots.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/reports/2026-05-27-p7-compaction-rehydration-v2-smoke.md
git commit -m "Record P7 rehydration smoke evidence"
```

---

## Self-Review Checklist

- Spec coverage:
  - Dedicated `compaction_rehydration`: Task 1, Task 4, Task 6.
  - File filtering/order/budget: Task 2.
  - Invoked skill persistence/restoration: Task 3, Task 5, Task 6.
  - Skill catalog stays metadata-only: Task 4 request shape tests keep catalog separate from rehydration.
- Plan independence: Task 4 adds a dedicated instruction-contract test proving plan content stays outside compaction rehydration.
  - Chat ordering for DeepSeek cache prefix: Task 4.
  - Remove old `runtime_reminders` path: Task 7.
  - Verification/smoke: Task 8.
- No placeholders: all tasks have exact files, commands, expected results, and concrete snippets.
- Type consistency:
  - `CompactionRehydrationContext` is the type used by `ExecutionContext`, `RuntimeContextBuilder`, `TurnContextAssembler`, and runtime L4 integration.
  - `InvokedSkillSnapshot` persists through `SessionService` and is consumed by `CompactionRehydrationService`.
  - Request fragment kind string is consistently `compaction_rehydration`.
