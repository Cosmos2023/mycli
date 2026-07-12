# Session Transcript Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full runtime-message copy in `session.json` with a sparse schema-v2 snapshot containing all TUI-visible transcript history while keeping SQLite as the only canonical model-context source.

**Architecture:** Add a focused transcript projection service that converts structured `HistoryItem` records into sanitized, bounded snapshot items and existing TUI wire items. `SessionSnapshotService` writes and reads schema-v2 snapshots atomically, while `SessionService` supplies SQLite history, lazily imports schema-v1 message snapshots when canonical rows are absent, and rebuilds missing or corrupt snapshots without using schema-v2 transcript data as model context.

**Tech Stack:** Python 3.13, standard-library `dataclasses`, `json`, `os`, `sqlite3`, `pathlib`, pytest, uv, ruff, mypy.

---

## File Map

- Create `src/mycli/services/transcript_projection.py`: typed transcript snapshot items, visibility filtering, metadata allowlisting, tool lifecycle coalescing, and UTF-8-safe head-tail truncation.
- Create `tests/unit/services/test_transcript_projection.py`: focused projection, privacy, deduplication, and truncation tests.
- Modify `src/mycli/services/session_snapshot.py`: schema-v2 writer/reader, compact sparse JSON, atomic fsync/replace, legacy message extraction, and transcript fallback loading.
- Create `tests/unit/services/test_session_snapshot.py`: focused snapshot schema, corruption, sparse encoding, and size-regression tests.
- Modify `src/mycli/state/session_service.py`: pass structured history into snapshots, lazily import schema-v1 messages, rebuild invalid snapshots, and expose snapshot transcript fallback.
- Modify `src/mycli/services/session_service.py`: preserve lineage before the single snapshot write and import legacy state before resume resolution.
- Modify `tests/unit/services/test_session_service.py`: service integration, migration, canonical-source, repair, and single-write tests.
- Modify `src/mycli/cli/node_tui/gateway.py`: use shared TUI projection and fall back to a read-only snapshot transcript on SQLite read failure.
- Modify `tests/unit/cli/node_tui/test_gateway.py`: normal projection parity and degraded snapshot transcript tests.

## Task 1: Add The Shared Transcript Projection Boundary

**Files:**
- Create: `src/mycli/services/transcript_projection.py`
- Create: `tests/unit/services/test_transcript_projection.py`

- [ ] **Step 1: Write failing tests for visibility, tool coalescing, and bounded output**

```python
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.transcript_projection import (
    SHELL_TRANSCRIPT_MAX_CHARS,
    project_history_items_for_snapshot,
    project_history_item_for_tui,
)


def test_snapshot_projection_keeps_only_tui_visible_history() -> None:
    items = (
        HistoryItem(
            id="user-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect the repo",
            metadata={"created_at": "2026-07-12T10:00:00Z", "provider_blob": "secret"},
        ),
        HistoryItem(
            id="baseline-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
            text="private environment context",
            metadata={"provider_blob": "secret"},
        ),
    )

    projected = project_history_items_for_snapshot(items)

    assert [item.type for item in projected] == ["user_message"]
    assert projected[0].to_dict() == {
        "id": "user-1",
        "type": "user_message",
        "text": "inspect the repo",
        "created_at": "2026-07-12T10:00:00Z",
    }
    assert "provider_blob" not in str(projected)


def test_snapshot_projection_coalesces_tool_call_and_result() -> None:
    items = (
        HistoryItem(
            id="tool-call-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_CALL,
            text="Running tests",
            tool_name="Bash",
            call_id="call-1",
            metadata={"arguments": {"command": "pytest -q"}},
        ),
        HistoryItem(
            id="tool-result-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_RESULT,
            text="128 passed",
            tool_name="Bash",
            call_id="call-1",
            metadata={
                "exit_code": 0,
                "duration_ms": 4210,
                "provider_id": "tool-private-1",
                "transcript_content": "model-only duplicate",
            },
        ),
    )

    projected = project_history_items_for_snapshot(items)

    assert len(projected) == 1
    assert projected[0].to_dict() == {
        "id": "tool-call-1",
        "type": "command",
        "text": "Running tests",
        "tool_name": "Bash",
        "call_id": "call-1",
        "command": "pytest -q",
        "status": "completed",
        "output": "128 passed",
        "exit_code": 0,
        "duration_ms": 4210,
    }


def test_shell_snapshot_output_uses_head_tail_limit() -> None:
    content = "a" * SHELL_TRANSCRIPT_MAX_CHARS + "middle" + "z" * 32
    projected = project_history_items_for_snapshot(
        (
            HistoryItem(
                id="tool-result-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.TOOL_RESULT,
                text=content,
                tool_name="run_shell",
                call_id="call-1",
            ),
        )
    )

    payload = projected[0].to_dict()
    assert len(str(payload["output"])) <= SHELL_TRANSCRIPT_MAX_CHARS
    assert payload["truncated"] is True
    assert payload["omitted_chars"] > 0
    assert str(payload["output"]).startswith("a")
    assert str(payload["output"]).endswith("z" * 32)


def test_tui_projection_preserves_existing_wire_shape_without_private_metadata() -> None:
    item = HistoryItem(
        id="hist-tool",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.TOOL_CALL,
        text="Read pyproject.toml",
        tool_name="Read",
        call_id="call-read-1",
        metadata={"created_at": "2026-07-12T10:00:00Z", "provider_id": "private"},
    )

    assert project_history_item_for_tui(item) == {
        "id": "hist-tool",
        "type": "tool_summary",
        "text": "Read pyproject.toml",
        "created_at": "2026-07-12T10:00:00Z",
        "folded": False,
        "metadata": {"tool_name": "Read", "call_id": "call-read-1"},
    }
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/services/test_transcript_projection.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mycli.services.transcript_projection'`.

- [ ] **Step 3: Implement the typed projector and sparse serializer**

Create `TranscriptSnapshotItem` with explicit visible fields and a sparse `to_dict()`:

```python
SHELL_TRANSCRIPT_MAX_CHARS = 8_000
_SHELL_TOOL_NAMES = frozenset({"bash", "bashoutput", "run_shell", "shell"})
_VISIBLE_HISTORY_TYPES = frozenset(
    {
        HistoryItemType.USER_MESSAGE,
        HistoryItemType.ASSISTANT_MESSAGE,
        HistoryItemType.REASONING,
        HistoryItemType.TOOL_CALL,
        HistoryItemType.TOOL_RESULT,
        HistoryItemType.APPROVAL_REQUEST,
        HistoryItemType.APPROVAL_RESOLUTION,
        HistoryItemType.WARNING,
        HistoryItemType.COMPACTION,
        HistoryItemType.FILE_CHANGE,
    }
)


@dataclass(frozen=True, slots=True)
class TranscriptSnapshotItem:
    id: str
    type: str
    text: str = ""
    created_at: str | None = None
    tool_name: str | None = None
    call_id: str | None = None
    command: str | None = None
    status: str | None = None
    output: str | None = None
    exit_code: int | None = None
    duration_ms: int | None = None
    truncated: bool = False
    omitted_chars: int = 0
    metadata: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {"id": self.id, "type": self.type}
        optional = {
            "text": self.text,
            "created_at": self.created_at,
            "tool_name": self.tool_name,
            "call_id": self.call_id,
            "command": self.command,
            "status": self.status,
            "output": self.output,
            "exit_code": self.exit_code,
            "duration_ms": self.duration_ms,
            "truncated": self.truncated or None,
            "omitted_chars": self.omitted_chars or None,
            "metadata": self.metadata or None,
        }
        payload.update({key: value for key, value in optional.items() if value is not None and value != ""})
        return payload
```

Implement four public functions: `project_history_items_for_snapshot()`, `project_messages_for_snapshot()`, `project_history_item_for_tui()`, and `snapshot_item_to_tui_items()`.

`project_history_items_for_snapshot()` must iterate in history order, skip non-visible history types, and keep a `call_id -> projected index` map. A `TOOL_CALL` creates a command/tool item; a matching `TOOL_RESULT` replaces that item with `status="completed"`, bounded visible output, exit code, and duration. A result without a preceding call creates one standalone completed item. Duplicate results update the existing item instead of appending.

`project_messages_for_snapshot()` is the history-empty compatibility path. It creates only user, Assistant, and tool-result transcript items from `Message.role`, `Message.content`, and `Message.tool_call_id`; it never copies `Message.metadata`, runtime blocks, response IDs, or tool argument structures.

`project_history_item_for_tui()` preserves the current gateway wire keys (`id`, `type`, `text`, `created_at`, `folded`, and `metadata`) but replaces arbitrary metadata copying with a visible allowlist. Flatten these display fields from nested metadata before discarding `raw_payload` and `arguments`: `path`, `command`, `query`, `context`, `content_preview`, `content_line_count`, `diff_preview`, `output_preview`, `error`, `duration_ms`, `status`, `success`, `mutating`, `hidden_line_count`, `truncated`, `omitted_chars`, `process_state`, `terminal_state`, `exit_code`, `started_at`, and `completed_at`. Always add `tool_name` and `call_id` from typed `HistoryItem` fields. Never retain `transcript_content`, `provider_id`, `args_preview`, `summary`, `raw_payload`, or `arguments` themselves.

`snapshot_item_to_tui_items()` validates `id`, `type`, and string fields before conversion. User, Assistant, reasoning, warning, status, and file-change items produce one TUI item. Command/tool items produce a `tool_summary` item and, when `output` is non-empty, one folded `tool_detail` item. Invalid items return an empty tuple so one malformed entry cannot break the snapshot.

Implement head-tail truncation without slicing encoded bytes:

```python
def _bounded_head_tail(value: str, max_chars: int) -> tuple[str, int]:
    if len(value) <= max_chars:
        return value, 0
    marker = "\n... output omitted ...\n"
    retained = max_chars - len(marker)
    head_chars = retained // 2
    tail_chars = retained - head_chars
    omitted = len(value) - head_chars - tail_chars
    return f"{value[:head_chars]}{marker}{value[-tail_chars:]}", omitted
```

- [ ] **Step 4: Run focused tests and static checks**

```bash
uv run pytest tests/unit/services/test_transcript_projection.py -q
uv run ruff check src/mycli/services/transcript_projection.py \
  tests/unit/services/test_transcript_projection.py
uv run mypy src/mycli/services/transcript_projection.py
```

Expected: all tests pass, ruff reports no errors, and mypy reports success.

- [ ] **Step 5: Commit the projector**

```bash
git add src/mycli/services/transcript_projection.py \
  tests/unit/services/test_transcript_projection.py
git commit -m "Add visible transcript projection"
```

## Task 2: Write Sparse Schema-V2 Session Snapshots

**Files:**
- Modify: `src/mycli/services/session_snapshot.py:1-253`
- Create: `tests/unit/services/test_session_snapshot.py`

- [ ] **Step 1: Write failing schema-v2 and atomic-read tests**

```python
import json
from pathlib import Path

import pytest

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.session_snapshot import SessionSnapshotContext, SessionSnapshotService


def test_snapshot_writes_sparse_v2_transcript_without_runtime_messages(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    conversation = Conversation(
        session_id="demo",
        messages=[Message(role="user", content="inspect repo")],
    )
    history = (
        HistoryItem(
            id="user-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect repo",
        ),
    )

    service.write_conversation_snapshot(
        conversation=conversation,
        history_items=history,
        context=SessionSnapshotContext(workspace_root=tmp_path),
    )

    payload = json.loads(service.snapshot_path("demo").read_text(encoding="utf-8"))
    assert payload["schema_version"] == 2
    assert "messages" not in payload
    assert payload["transcript"] == [
        {"id": "user-1", "type": "user_message", "text": "inspect repo"}
    ]
    assert "provider" not in payload
    assert "subagents" not in payload


def test_snapshot_preserves_created_at_across_rewrites(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    conversation = Conversation(session_id="demo", messages=[Message(role="user", content="one")])
    context = SessionSnapshotContext(workspace_root=tmp_path)

    service.write_conversation_snapshot(conversation=conversation, history_items=(), context=context)
    first = service.read_snapshot("demo")
    service.write_conversation_snapshot(conversation=conversation, history_items=(), context=context)
    second = service.read_snapshot("demo")

    assert first is not None
    assert second is not None
    assert second["created_at"] == first["created_at"]


def test_empty_snapshot_keeps_required_transcript_array(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    service.write_conversation_snapshot(
        conversation=Conversation(session_id="empty"),
        history_items=(),
        context=SessionSnapshotContext(workspace_root=tmp_path),
    )

    payload = service.read_snapshot("empty")
    assert payload is not None
    assert payload["transcript"] == []


def test_snapshot_reader_rejects_corrupt_json_without_deleting_it(tmp_path: Path) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    path = service.snapshot_path("demo")
    path.parent.mkdir(parents=True)
    path.write_text('{"schema_version":', encoding="utf-8")

    assert service.read_snapshot("demo") is None
    assert path.read_text(encoding="utf-8") == '{"schema_version":'


def test_atomic_replace_failure_preserves_previous_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = SessionSnapshotService(home_dir=tmp_path)
    context = SessionSnapshotContext(workspace_root=tmp_path)
    service.write_conversation_snapshot(
        conversation=Conversation(
            session_id="demo",
            messages=[Message(role="user", content="before")],
        ),
        history_items=(),
        context=context,
    )
    path = service.snapshot_path("demo")
    previous = path.read_text(encoding="utf-8")
    original_replace = Path.replace

    def fail_temporary_replace(source: Path, target: Path) -> Path:
        if source.name.startswith(".session.json."):
            raise OSError("rename failed")
        return original_replace(source, target)

    monkeypatch.setattr(Path, "replace", fail_temporary_replace)

    with pytest.raises(OSError, match="rename failed"):
        service.write_conversation_snapshot(
            conversation=Conversation(
                session_id="demo",
                messages=[Message(role="user", content="after")],
            ),
            history_items=(),
            context=context,
        )

    assert path.read_text(encoding="utf-8") == previous
    assert list(path.parent.glob(".session.json.*.tmp")) == []
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/services/test_session_snapshot.py -q
```

Expected: FAIL because `history_items`, `snapshot_path()`, and `read_snapshot()` do not exist and the writer still emits schema v1.

- [ ] **Step 3: Implement schema-v2 payload construction and compact atomic writes**

Change the writer signature to:

```python
def write_conversation_snapshot(
    self,
    *,
    conversation: Conversation,
    history_items: tuple[HistoryItem, ...],
    context: SessionSnapshotContext,
) -> None:
```

Add public read helpers:

```python
def snapshot_path(self, session_id: str) -> Path:
    return self._layout.session_snapshot_path(session_id)


def read_snapshot(self, session_id: str) -> dict[str, object] | None:
    path = self.snapshot_path(session_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None
```

Build `transcript` from `project_history_items_for_snapshot(history_items)`. If history is empty, use `project_messages_for_snapshot(conversation.messages)` so direct conversation saves remain readable.

Replace indented JSON writes with compact atomic writes and an fsync barrier:

```python
encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
with temporary.open("w", encoding="utf-8") as handle:
    handle.write(encoded)
    handle.flush()
    os.fsync(handle.fileno())
temporary.replace(path)
```

Preserve an existing string `created_at`; always refresh `updated_at`. Recursively omit `None`, optional empty lists, empty dictionaries, and default false values from the top-level payload and transcript items. Keep the required top-level `transcript` key as `[]` for an empty session. Keep `links.events` and non-empty lineage/state/subagent metadata, but do not include canonical `messages`.

- [ ] **Step 4: Run focused tests and update the existing readable-snapshot assertion**

```bash
uv run pytest tests/unit/services/test_session_snapshot.py \
  tests/unit/services/test_session_service.py::test_session_service_writes_readable_session_snapshot -q
```

Expected: PASS after changing the existing assertion from `schema_version == 1` and `messages` to `schema_version == 2` and `transcript`.

- [ ] **Step 5: Run static checks and commit**

```bash
uv run ruff check src/mycli/services/session_snapshot.py \
  tests/unit/services/test_session_snapshot.py \
  tests/unit/services/test_session_service.py
uv run mypy src/mycli/services/session_snapshot.py
git add src/mycli/services/session_snapshot.py \
  tests/unit/services/test_session_snapshot.py \
  tests/unit/services/test_session_service.py
git commit -m "Write compact session transcript snapshots"
```

## Task 3: Feed Structured History Into One Snapshot Write

**Files:**
- Modify: `src/mycli/state/session_service.py:64-123,793-817`
- Modify: `src/mycli/services/session_service.py:9-35`
- Modify: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write failing integration tests for history projection and duplicate writes**

```python
def test_history_append_refreshes_snapshot_with_visible_transcript(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)
    service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="user-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.USER_MESSAGE,
                text="inspect repo",
            ),
            HistoryItem(
                id="private-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
                text="private context",
            ),
        ),
    )

    payload = json.loads(
        (home_dir / ".mycli" / "sessions" / "demo" / "session.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["transcript"] == [
        {"id": "user-1", "type": "user_message", "text": "inspect repo"}
    ]


def test_conversation_save_writes_snapshot_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    writes = 0
    original = service._snapshot_service.write_conversation_snapshot

    def recording_write(**kwargs: object) -> None:
        nonlocal writes
        writes += 1
        original(**kwargs)

    monkeypatch.setattr(service._snapshot_service, "write_conversation_snapshot", recording_write)
    service.save_conversation(
        Conversation(
            session_id="demo",
            parent_id="root",
            fork_point=1,
            messages=[Message(role="user", content="hello")],
        )
    )

    assert writes == 1


def test_snapshot_write_failure_does_not_rollback_sqlite_conversation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = SessionService(home_dir=tmp_path / "home")

    def fail_write(**_kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(service._snapshot_service, "write_conversation_snapshot", fail_write)
    service.save_conversation(
        Conversation(session_id="demo", messages=[Message(role="user", content="hello")])
    )

    stored = service._store.load_conversation("demo")
    assert stored is not None
    assert stored[0]["content"] == "hello"
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/services/test_session_service.py \
  -k "history_append_refreshes_snapshot_with_visible_transcript or conversation_save_writes_snapshot_once or snapshot_write_failure" -q
```

Expected: FAIL because `_write_snapshot()` does not pass history, snapshot failure propagates, and the compatibility `SessionService.save_conversation()` performs a second snapshot write.

- [ ] **Step 3: Pass history into the snapshot and remove the duplicate write**

Update `mycli.state.session_service.SessionService._write_snapshot()`:

```python
def _write_snapshot(self, conversation: Conversation) -> None:
    try:
        self._snapshot_service.write_conversation_snapshot(
            conversation=conversation,
            history_items=self.load_history_items(conversation.session_id),
            context=SessionSnapshotContext(
                workspace_root=self._workspace_root,
                plan_state=self.load_plan_state(conversation.session_id),
            ),
        )
    except OSError as exc:
        logger.warning(
            "failed to write session snapshot session_id=%s: %s",
            conversation.session_id,
            exc,
        )
```

Add `logger = logging.getLogger(__name__)` at module scope. Snapshot I/O failure is non-fatal after SQLite succeeds; the next stable save retries.

Reorder `mycli.services.session_service.SessionService.save_conversation()` so lineage is resolved and persisted before `super().save_conversation()`; remove the trailing `_write_snapshot()`:

```python
def save_conversation(self, conversation: Conversation) -> None:
    parent_id = conversation.parent_id
    fork_point = conversation.fork_point
    if parent_id is None and fork_point is None:
        metadata = self._load_conversation_tree_metadata(conversation.session_id)
        if metadata is not None:
            parent_id = _optional_str(metadata.get("parent_id"))
            fork_point = _optional_int(metadata.get("fork_point"))
    conversation.parent_id = parent_id
    conversation.fork_point = fork_point
    self._save_conversation_tree_metadata(
        conversation,
        parent_id=parent_id,
        fork_point=fork_point,
    )
    super().save_conversation(conversation)
```

- [ ] **Step 4: Run session-service tests and static checks**

```bash
uv run pytest tests/unit/services/test_session_service.py -q
uv run ruff check src/mycli/state/session_service.py \
  src/mycli/services/session_service.py \
  tests/unit/services/test_session_service.py
uv run mypy src/mycli/state/session_service.py src/mycli/services/session_service.py
```

Expected: all session-service tests pass and one logical save produces one snapshot write.

- [ ] **Step 5: Commit service integration**

```bash
git add src/mycli/state/session_service.py \
  src/mycli/services/session_service.py \
  tests/unit/services/test_session_service.py
git commit -m "Project session history into snapshots"
```

## Task 4: Add Lazy Schema-V1 Migration And Snapshot Repair

**Files:**
- Modify: `src/mycli/services/session_snapshot.py`
- Modify: `src/mycli/state/session_service.py:74-97,806-817`
- Modify: `src/mycli/services/session_service.py:28-47`
- Modify: `tests/unit/services/test_session_snapshot.py`
- Modify: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write failing migration and canonical-source tests**

```python
def test_load_conversation_imports_v1_messages_when_sqlite_is_empty(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    snapshot_path = home_dir / ".mycli" / "sessions" / "legacy" / "session.json"
    snapshot_path.parent.mkdir(parents=True)
    snapshot_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "session_id": "legacy",
                "messages": [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi"},
                ],
            }
        ),
        encoding="utf-8",
    )
    service = SessionService(home_dir=home_dir)

    conversation = service.load_conversation("legacy")

    assert [message.content for message in conversation.messages] == ["hello", "hi"]
    migrated = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert migrated["schema_version"] == 2
    assert "messages" not in migrated
    assert service._store.load_conversation("legacy") is not None


def test_v2_transcript_is_never_used_as_model_conversation(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    snapshot_path = home_dir / ".mycli" / "sessions" / "display-only" / "session.json"
    snapshot_path.parent.mkdir(parents=True)
    snapshot_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "session_id": "display-only",
                "transcript": [
                    {"id": "user-1", "type": "user_message", "text": "not canonical"}
                ],
            }
        ),
        encoding="utf-8",
    )
    service = SessionService(home_dir=home_dir)

    conversation = service.load_conversation("display-only")

    assert conversation.messages == []
    assert service._store.load_conversation("display-only") is None


def test_corrupt_snapshot_is_rebuilt_from_sqlite(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)
    service.save_conversation(
        Conversation(session_id="demo", messages=[Message(role="user", content="hello")])
    )
    snapshot_path = home_dir / ".mycli" / "sessions" / "demo" / "session.json"
    snapshot_path.write_text("{broken", encoding="utf-8")

    loaded = service.load_conversation("demo")

    assert loaded.messages[0].content == "hello"
    repaired = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert repaired["schema_version"] == 2


def test_unknown_session_load_does_not_create_empty_snapshot(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = SessionService(home_dir=home_dir)

    conversation = service.load_conversation("missing")

    assert conversation.messages == []
    assert not (
        home_dir / ".mycli" / "sessions" / "missing" / "session.json"
    ).exists()
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/services/test_session_service.py \
  -k "imports_v1_messages or v2_transcript_is_never_used or corrupt_snapshot_is_rebuilt or unknown_session_load" -q
```

Expected: FAIL because snapshots are write-only and `load_conversation()` does not import or repair them.

- [ ] **Step 3: Add legacy extraction and transcript read helpers**

In `SessionSnapshotService`, add:

```python
def legacy_messages(self, session_id: str) -> tuple[dict[str, object], ...]:
    payload = self.read_snapshot(session_id)
    if payload is None or payload.get("schema_version") != 1:
        return ()
    raw_messages = payload.get("messages")
    if not isinstance(raw_messages, list):
        return ()
    return tuple(dict(item) for item in raw_messages if isinstance(item, dict))


def snapshot_requires_rebuild(self, session_id: str) -> bool:
    payload = self.read_snapshot(session_id)
    return payload is None or payload.get("schema_version") != 2 or not isinstance(
        payload.get("transcript"), list
    )
```

Malformed transcript entries must be skipped individually by snapshot-to-TUI conversion; a syntactically invalid JSON document returns `None` and remains untouched until canonical rebuild succeeds.

- [ ] **Step 4: Import only v1 messages and rebuild invalid snapshots from canonical state**

Add an internal loader parameter so refresh paths avoid double writes:

```python
def load_conversation(
    self,
    session_id: str,
    *,
    repair_snapshot: bool = True,
) -> Conversation:
    payload = self._store.load_conversation(session_id)
    conversation = Conversation(session_id=session_id)
    has_canonical_state = False
    if payload is not None:
        has_canonical_state = True
        for item in payload:
            conversation.append(deserialize_message(item))
    else:
        history_messages = self._conversation_messages_from_history(session_id)
        if history_messages:
            has_canonical_state = True
            conversation.messages.extend(history_messages)
        else:
            legacy = self._snapshot_service.legacy_messages(session_id)
            for item in legacy:
                conversation.append(deserialize_message(item))
            if legacy:
                has_canonical_state = True
                self._store.replace_conversation(
                    session_id=session_id,
                    workspace_root=self._workspace_root,
                    thread_id=session_id,
                    messages=[serialize_message(message) for message in conversation.messages],
                )
    if (
        has_canonical_state
        and repair_snapshot
        and self._snapshot_service.snapshot_requires_rebuild(session_id)
    ):
        self._write_snapshot(conversation)
    return conversation
```

Update `_refresh_snapshot()` to call `self.load_conversation(session_id, repair_snapshot=False)`. Mirror the keyword parameter in `mycli.services.session_service.SessionService.load_conversation()` so lineage metadata is still applied.

Add `_import_legacy_snapshot_if_present(session_id) -> bool` to the state service. It reads only `legacy_messages()`, persists them with `replace_conversation()`, writes schema v2, and returns `True`; it returns `False` without writing anything for missing, corrupt, or schema-v2 snapshots. Call this helper before `resume_conversation()` invokes `resolve_resume_session_id()`. Never import schema-v2 transcript items into conversation messages, and never create an empty snapshot merely because an unknown session ID was requested.

- [ ] **Step 5: Run migration, resume, and repair tests**

```bash
uv run pytest tests/unit/services/test_session_snapshot.py \
  tests/unit/services/test_session_service.py -q
```

Expected: PASS, including existing lineage, fork, and history-rehydration tests.

- [ ] **Step 6: Run static checks and commit**

```bash
uv run ruff check src/mycli/services/session_snapshot.py \
  src/mycli/state/session_service.py \
  src/mycli/services/session_service.py \
  tests/unit/services/test_session_snapshot.py \
  tests/unit/services/test_session_service.py
uv run mypy src/mycli/services/session_snapshot.py \
  src/mycli/state/session_service.py \
  src/mycli/services/session_service.py
git add src/mycli/services/session_snapshot.py \
  src/mycli/state/session_service.py \
  src/mycli/services/session_service.py \
  tests/unit/services/test_session_snapshot.py \
  tests/unit/services/test_session_service.py
git commit -m "Migrate and repair session snapshots"
```

## Task 5: Share TUI Projection And Add Read-Only Snapshot Fallback

**Files:**
- Modify: `src/mycli/cli/node_tui/gateway.py:1-40,1181-1195,2185-2209`
- Modify: `src/mycli/state/session_service.py`
- Modify: `src/mycli/services/session_snapshot.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py:909-1006`
- Modify: `tests/unit/services/test_session_snapshot.py`

- [ ] **Step 1: Write failing gateway fallback tests**

```python
import sqlite3


def test_gateway_transcript_load_falls_back_to_snapshot_on_sqlite_error(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.snapshot_tui_items = (
        {
            "id": "user-1",
            "type": "user",
            "text": "visible history",
            "created_at": "",
            "folded": False,
            "metadata": {},
        },
    )
    service.fake_session_service.load_history_error = sqlite3.DatabaseError("database unavailable")
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req-1",
            method="transcript.load",
            params={"session_id": "demo", "before": None},
        )
    )

    assert response.result is not None
    assert response.result["read_only"] is True
    assert response.result["items"][0]["type"] == "warning"
    assert response.result["items"][1]["text"] == "visible history"


def test_gateway_normal_transcript_projection_drops_provider_metadata(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service.fake_session_service.history_items = (
        HistoryItem(
            id="hist-tool",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_CALL,
            text="Read pyproject.toml",
            tool_name="Read",
            call_id="call-1",
            metadata={"provider_id": "private", "created_at": "2026-07-12T10:00:00Z"},
        ),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(id="req-1", method="transcript.load", params={"session_id": "demo"})
    )

    assert response.result is not None
    assert response.result["items"][0]["metadata"] == {
        "tool_name": "Read",
        "call_id": "call-1",
    }
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py \
  -k "falls_back_to_snapshot or drops_provider_metadata" -q
```

Expected: FAIL because gateway projection copies arbitrary metadata and SQLite errors abort transcript loading.

Extend the existing `FakeSessionService` used by gateway tests with deterministic failure and fallback state:

```python
class FakeSessionService:
    def __init__(self) -> None:
        self.history_items: tuple[HistoryItem, ...] = ()
        self.load_history_error: Exception | None = None
        self.snapshot_tui_items: tuple[dict[str, object], ...] = ()

    def load_history_items(self, _session_id: str) -> tuple[HistoryItem, ...]:
        if self.load_history_error is not None:
            raise self.load_history_error
        return self.history_items

    def load_snapshot_tui_items(self, _session_id: str) -> tuple[dict[str, object], ...]:
        return self.snapshot_tui_items
```

- [ ] **Step 3: Expose validated snapshot transcript items**

Add to `SessionSnapshotService`:

```python
def load_tui_items(self, session_id: str) -> tuple[dict[str, object], ...]:
    payload = self.read_snapshot(session_id)
    if payload is None or payload.get("schema_version") != 2:
        return ()
    raw_items = payload.get("transcript")
    if not isinstance(raw_items, list):
        return ()
    projected: list[dict[str, object]] = []
    for raw_item in raw_items:
        if isinstance(raw_item, dict):
            projected.extend(snapshot_item_to_tui_items(raw_item))
    return tuple(projected)
```

Expose it from state `SessionService`:

```python
def load_snapshot_tui_items(self, session_id: str) -> tuple[dict[str, object], ...]:
    return self._snapshot_service.load_tui_items(session_id)
```

- [ ] **Step 4: Replace the gateway-local projector and add degraded fallback**

Import `sqlite3` and `project_history_item_for_tui`. Delete the private `_project_history_item()` implementation.

Use this flow in `_handle_transcript_load()`:

```python
try:
    history_items = list(self.service._session_service.load_history_items(session_id))
except (sqlite3.Error, OSError) as exc:
    fallback = list(self.service._session_service.load_snapshot_tui_items(session_id))
    if not fallback:
        raise
    warning = {
        "id": f"{session_id}:snapshot-read-only",
        "type": "warning",
        "text": f"SQLite history is unavailable; showing read-only session snapshot: {exc}",
        "created_at": "",
        "folded": False,
        "metadata": {"read_only": True},
    }
    return {
        "session_id": session_id,
        "items": [warning, *fallback],
        "next_before": None,
        "read_only": True,
    }
```

Keep the existing `before` and `limit` behavior for the normal SQLite path, using `project_history_item_for_tui()` for each selected item.

- [ ] **Step 5: Run gateway and snapshot tests**

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py \
  tests/unit/services/test_session_snapshot.py -q
```

Expected: PASS with unchanged normal transcript shape and a visible read-only warning on fallback.

- [ ] **Step 6: Run static checks and commit**

```bash
uv run ruff check src/mycli/cli/node_tui/gateway.py \
  src/mycli/state/session_service.py \
  src/mycli/services/session_snapshot.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/unit/services/test_session_snapshot.py
uv run mypy src/mycli/cli/node_tui/gateway.py \
  src/mycli/state/session_service.py \
  src/mycli/services/session_snapshot.py
git add src/mycli/cli/node_tui/gateway.py \
  src/mycli/state/session_service.py \
  src/mycli/services/session_snapshot.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/unit/services/test_session_snapshot.py
git commit -m "Add session snapshot transcript fallback"
```

## Task 6: Add Size Regression Coverage And Run Final Verification

**Files:**
- Modify: `tests/unit/services/test_session_snapshot.py`
- Verify: all files changed in Tasks 1-5

- [ ] **Step 1: Add a structural size-regression test**

```python
def test_v2_snapshot_omits_repeated_runtime_payloads(tmp_path: Path) -> None:
    private_blob = "provider-private-reasoning-" * 2_000
    repeated_tool_output = "same shell output\n" * 2_000
    conversation = Conversation(session_id="large")
    history = (
        HistoryItem(
            id="tool-call",
            thread_id="large",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_CALL,
            text="Run tests",
            tool_name="Bash",
            call_id="call-1",
            metadata={"arguments": {"command": "pytest -q"}, "provider_blob": private_blob},
        ),
        HistoryItem(
            id="tool-result",
            thread_id="large",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_RESULT,
            text=repeated_tool_output,
            tool_name="Bash",
            call_id="call-1",
            metadata={
                "transcript_content": repeated_tool_output,
                "summary": repeated_tool_output,
                "provider_blob": private_blob,
            },
        ),
    )
    service = SessionSnapshotService(home_dir=tmp_path)

    service.write_conversation_snapshot(
        conversation=conversation,
        history_items=history,
        context=SessionSnapshotContext(workspace_root=tmp_path),
    )

    persisted = service.snapshot_path("large").read_text(encoding="utf-8")
    payload = json.loads(persisted)
    assert "messages" not in payload
    assert "provider_blob" not in persisted
    assert "transcript_content" not in persisted
    assert '"summary"' not in persisted
    assert len(payload["transcript"]) == 1
    assert len(str(payload["transcript"][0]["output"])) <= 8_000
```

- [ ] **Step 2: Run the regression test**

```bash
uv run pytest tests/unit/services/test_session_snapshot.py::test_v2_snapshot_omits_repeated_runtime_payloads -q
```

Expected: PASS after Tasks 1-5. If it fails, fix only the projection or sparse serialization path that leaked the repeated payload.

- [ ] **Step 3: Run all focused Python tests**

```bash
uv run pytest tests/unit/services/test_transcript_projection.py \
  tests/unit/services/test_session_snapshot.py \
  tests/unit/services/test_session_service.py \
  tests/unit/cli/node_tui/test_gateway.py -q
```

Expected: PASS.

- [ ] **Step 4: Run lint and type checks for all changed modules**

```bash
uv run ruff check src/mycli/services/transcript_projection.py \
  src/mycli/services/session_snapshot.py \
  src/mycli/state/session_service.py \
  src/mycli/services/session_service.py \
  src/mycli/cli/node_tui/gateway.py \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/services/test_session_snapshot.py \
  tests/unit/services/test_session_service.py \
  tests/unit/cli/node_tui/test_gateway.py
uv run mypy src/mycli/services/transcript_projection.py \
  src/mycli/services/session_snapshot.py \
  src/mycli/state/session_service.py \
  src/mycli/services/session_service.py \
  src/mycli/cli/node_tui/gateway.py
```

Expected: no ruff errors and mypy success.

- [ ] **Step 5: Run the full test suite**

```bash
uv run pytest -q
```

Expected: PASS with no regressions in conversation resume, lineage, structured history, tool replay, or Node TUI gateway behavior.

- [ ] **Step 6: Commit final regression coverage**

```bash
git add tests/unit/services/test_session_snapshot.py
git commit -m "Cover compact session snapshot size"
```

## Completion Criteria

- `session.json` writes `schema_version: 2` and no top-level canonical `messages`.
- Every TUI-visible history item is represented; provider-only history types are excluded.
- Tool call/result pairs with the same call ID occupy one snapshot item.
- Shell output is hard-capped at 8,000 Unicode characters with head-tail omission metadata.
- SQLite remains the only schema-v2 model-context source.
- Schema-v1 messages migrate lazily only when SQLite canonical state is absent.
- Missing or corrupt snapshots rebuild from SQLite without losing canonical state.
- Normal TUI transcript loading preserves its wire shape and strips private metadata.
- SQLite read failure can show the validated snapshot transcript with an explicit read-only warning.
- One conversation save performs one snapshot write.
- Focused tests, full pytest, ruff, and mypy all pass.
