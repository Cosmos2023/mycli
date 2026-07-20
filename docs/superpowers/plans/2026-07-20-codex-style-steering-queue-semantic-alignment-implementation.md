# Codex-Style Steering Queue Semantic Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's process-local two-list queue with a persisted, session-scoped, revisioned queue state machine that matches Codex pending-steer, rejected-steer, and follow-up semantics from backend through TUI.

**Architecture:** Add immutable queue records in the domain layer and a `SessionQueueCoordinator` in the application runtime as the sole mutation owner. Persist snapshots through `SessionService`, target steering at a server-generated turn ID, acknowledge delivery only after history contains the queue ID, and project revisioned snapshots through the gateway into a non-authoritative Node TUI.

**Tech Stack:** Python 3.13, dataclasses, threading locks, SQLite session state, pytest, JSON-RPC gateway contracts, TypeScript 5.9, Node.js test runner, custom Node terminal UI.

**Design:** `docs/superpowers/specs/2026-07-20-codex-style-steering-queue-semantic-alignment-design.md`

---

## File Map

**Create**

- `src/mycli/application/runtime/session_queue.py`: atomic session queue state machine, persistence coordination, limits, revisions, and compatibility projection.
- `tests/unit/domain/runtime/test_message_queue.py`: queue record and snapshot serialization/validation tests.
- `tests/unit/application/runtime/test_session_queue.py`: coordinator transitions, ordering, idempotency, persistence failure, and recovery tests.

**Modify**

- `src/mycli/domain/runtime/message_queue.py`: new record, snapshot, disposition, limit, and serialization types while retaining the legacy DTO.
- `src/mycli/domain/runtime/__init__.py`: export queue domain types.
- `src/mycli/state/session_service.py`: save/load/delete canonical queue state.
- `src/mycli/domain/runtime/session_history.py`: include queue snapshot in runtime restore data.
- `src/mycli/application/runtime/agent_runtime.py`: replace raw list ownership with the coordinator and keep compatibility APIs.
- `src/mycli/application/runtime/turn_executor.py`: accept server turn IDs, commit pending steers durably, and schedule rejected-before-follow-up.
- `src/mycli/application/turn_service.py`: expose structured queue operations and forward server turn IDs.
- `src/mycli/cli/node_tui/gateway.py`: mint server turn IDs, validate expected turns, return dispositions, and emit revisioned snapshots.
- `src/mycli/domain/runtime/gateway_contract.py`: describe new queue request/response/event fields and errors.
- `tui/mycli-shell/src/gateway.ts`: remove durable local queue fallback and submit against active server turn IDs.
- `tui/mycli-shell/src/adapters/runtime-state.ts`: parse revisioned three-class snapshots and ignore stale revisions.
- `tui/mycli-shell/src/model.ts`: add rejected-steer previews and attachment metadata.
- `tui/mycli-shell/src/components/pending-input-preview.ts`: render three sections, dynamic hints, attachments, and bounded overflow.
- `tui/mycli-shell/src/shell-runtime.ts`: feed keybindings/height budget to pending preview and refresh only when its signature changes.
- Existing Python and TypeScript tests listed in each task below.

## Compatibility Rules

- Keep `QueuedTurnInput`, `queue_steering_message()`, `queue_follow_up_message()`, `queued_messages()`, and `queued_input_items()` until Task 10.
- Legacy `steering` projects pending steers. Legacy `follow_up` projects rejected steers followed by ordinary follow-ups so old clients do not lose messages.
- New code consumes `QueueSnapshot`; compatibility projections never become a second source of truth.
- Do not stage or alter unrelated worktree files listed by `git status`.

---

### Task 1: Add Queue Domain Records And Serialization

**Files:**
- Modify: `src/mycli/domain/runtime/message_queue.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Create: `tests/unit/domain/runtime/test_message_queue.py`

- [ ] **Step 1: Write failing record and snapshot round-trip tests**

```python
from datetime import UTC, datetime

import pytest

from mycli.domain.runtime import (
    QueueCapacity,
    QueueDisposition,
    QueueSnapshot,
    QueuedInputRecord,
)


def test_queue_snapshot_round_trip_preserves_three_classes() -> None:
    now = datetime(2026, 7, 20, tzinfo=UTC)
    pending = QueuedInputRecord.create(
        queue_id="queue-1",
        session_id="session-1",
        client_turn_id="client-1",
        target_turn_id="turn-1",
        kind="pending_steer",
        text="inspect output",
        image_paths=("/tmp/a.png",),
        source="user",
        now=now,
    )
    rejected = pending.transition(kind="rejected_steer", state="queued", now=now)
    follow_up = QueuedInputRecord.create(
        queue_id="queue-2",
        session_id="session-1",
        client_turn_id="client-2",
        target_turn_id=None,
        kind="follow_up",
        text="summarize",
        now=now,
    )
    snapshot = QueueSnapshot(
        session_id="session-1",
        revision=3,
        pending_steers=(pending,),
        rejected_steers=(rejected,),
        follow_ups=(follow_up,),
    )

    assert QueueSnapshot.from_dict(snapshot.to_dict()) == snapshot
    assert QueueDisposition.ACCEPTED_FOR_TURN.value == "accepted_for_turn"


def test_queue_record_rejects_invalid_target_and_capacity_defaults_are_fixed() -> None:
    with pytest.raises(ValueError, match="target_turn_id"):
        QueuedInputRecord.create(
            queue_id="queue-1",
            session_id="session-1",
            client_turn_id="client-1",
            target_turn_id=None,
            kind="pending_steer",
            text="inspect",
        )

    assert QueueCapacity().max_records == 128
    assert QueueCapacity().max_text_bytes == 64 * 1024
    assert QueueCapacity().max_total_text_bytes == 512 * 1024
    assert QueueCapacity().max_attachments == 16


def test_queue_snapshot_restore_quarantines_only_invalid_records() -> None:
    valid = QueuedInputRecord.create(
        queue_id="queue-good",
        session_id="session-1",
        client_turn_id="client-good",
        target_turn_id=None,
        kind="follow_up",
        text="good",
        now=datetime(2026, 7, 20, tzinfo=UTC),
    )
    payload = QueueSnapshot(
        session_id="session-1",
        revision=2,
        follow_ups=(valid,),
    ).to_dict()
    payload["follow_ups"].append({"queue_id": "queue-bad"})

    snapshot, issues = QueueSnapshot.restore(payload)

    assert [item.queue_id for item in snapshot.follow_ups] == ["queue-good"]
    assert issues == ("follow_ups[1]: missing session_id",)
```

- [ ] **Step 2: Run the tests and verify the missing imports fail**

Run:

```bash
uv run pytest tests/unit/domain/runtime/test_message_queue.py -q
```

Expected: collection fails because `QueuedInputRecord` and `QueueSnapshot` do not exist.

- [ ] **Step 3: Add immutable domain types without changing the legacy DTO**

Add these public types to `message_queue.py`:

```python
QueueItemKind = Literal["pending_steer", "rejected_steer", "follow_up"]
QueueDeliveryState = Literal["queued", "accepted", "committed"]


class QueueDisposition(StrEnum):
    ACCEPTED_FOR_TURN = "accepted_for_turn"
    DEFERRED_TO_END_OF_TURN = "deferred_to_end_of_turn"
    QUEUED_FOLLOW_UP = "queued_follow_up"
    DUPLICATE = "duplicate"


@dataclass(slots=True, frozen=True)
class QueueCapacity:
    max_records: int = 128
    max_text_bytes: int = 64 * 1024
    max_total_text_bytes: int = 512 * 1024
    max_attachments: int = 16


@dataclass(slots=True, frozen=True)
class QueuedInputRecord:
    queue_id: str
    session_id: str
    client_turn_id: str
    target_turn_id: str | None
    kind: QueueItemKind
    state: QueueDeliveryState
    text: str
    image_paths: tuple[str, ...]
    source: str
    created_at: str
    updated_at: str


@dataclass(slots=True, frozen=True)
class QueueSnapshot:
    session_id: str
    revision: int = 0
    pending_steers: tuple[QueuedInputRecord, ...] = ()
    rejected_steers: tuple[QueuedInputRecord, ...] = ()
    follow_ups: tuple[QueuedInputRecord, ...] = ()

    def active_records(self) -> tuple[QueuedInputRecord, ...]:
        return (*self.pending_steers, *self.rejected_steers, *self.follow_ups)
```

Add these methods with the following exact behavior:

- `QueuedInputRecord.create()`: strip all IDs and text, reject an empty value,
  deduplicate non-empty image paths in insertion order, require a target only for
  `pending_steer`, assign state `accepted` for pending steers and `queued` for the
  other kinds, and serialize `now or datetime.now(UTC)` with `isoformat()` into
  both timestamps.
- `transition()`: return `dataclasses.replace(self, kind=kind or self.kind,
  state=state or self.state, updated_at=(now or datetime.now(UTC)).isoformat())`
  and re-run the pending-target invariant.
- `to_dict()`: emit every dataclass field, converting `image_paths` to a list.
- `from_dict()`: require every scalar field to have its declared JSON type,
  parse kind/state through their literals, accept only a list of non-empty image
  strings, then call the dataclass constructor so invariants run once.
- `QueueSnapshot.to_dict()`: emit `session_id`, `revision`, and the three arrays
  using each record's `to_dict()`.
- `QueueSnapshot.from_dict()`: require a non-negative integer revision, parse
  each array independently, require every record session to equal snapshot
  session, and preserve array order.
- `QueueSnapshot.restore()`: require valid top-level session/revision fields,
  parse records one by one with `QueuedInputRecord.from_dict()`, retain valid
  records, and return `(snapshot, tuple(issues))` where each issue is
  `"<array>[<index>]: <ValueError message>"`.

Export every new type from `domain/runtime/__init__.py`.

- [ ] **Step 4: Run domain tests**

Run: `uv run pytest tests/unit/domain/runtime/test_message_queue.py -q`

Expected: all tests pass.

- [ ] **Step 5: Commit the domain model**

```bash
git add src/mycli/domain/runtime/message_queue.py src/mycli/domain/runtime/__init__.py tests/unit/domain/runtime/test_message_queue.py
git commit -m "feat: define revisioned steering queue records"
```

---

### Task 2: Persist Queue Snapshots In Session State

**Files:**
- Modify: `src/mycli/state/session_service.py`
- Modify: `src/mycli/domain/runtime/session_history.py`
- Test: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write failing save/load/delete and runtime snapshot tests**

```python
def test_session_service_persists_queue_snapshot(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path)
    snapshot = QueueSnapshot(
        session_id="demo",
        revision=1,
        follow_ups=(queued_record(kind="follow_up", queue_id="queue-1"),),
    )

    service.save_queue_snapshot("demo", snapshot)

    assert service.load_queue_snapshot("demo") == snapshot
    assert service.load_runtime_snapshot("demo").queue_snapshot == snapshot
    service.clear_queue_snapshot("demo")
    assert service.load_queue_snapshot("demo") == QueueSnapshot(session_id="demo")


def test_session_service_records_queue_restore_issues(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path)
    service._save_state(
        session_id="demo",
        thread_id="demo",
        state_key=service._KEY_INPUT_QUEUE,
        payload={
            "session_id": "demo",
            "revision": 1,
            "pending_steers": [],
            "rejected_steers": [],
            "follow_ups": [{"queue_id": "broken"}],
        },
    )

    assert service.load_queue_snapshot("demo").active_records() == ()
    events_path = MycliStorageLayout.from_home_dir(tmp_path).session_events_path("demo")
    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
    assert any(event["type"] == "queue.restore_issue" for event in events)


def queued_record(*, kind: QueueItemKind, queue_id: str) -> QueuedInputRecord:
    return QueuedInputRecord.create(
        queue_id=queue_id,
        session_id="demo",
        client_turn_id=f"client-{queue_id}",
        target_turn_id="turn-1" if kind == "pending_steer" else None,
        kind=kind,
        text=queue_id,
        now=datetime(2026, 7, 20, tzinfo=UTC),
    )
```

- [ ] **Step 2: Run the test and verify the methods are missing**

Run:

```bash
uv run pytest tests/unit/services/test_session_service.py -q -k queue_snapshot
```

Expected: fail with missing `save_queue_snapshot`.

- [ ] **Step 3: Implement the dedicated session state key**

Add `_KEY_INPUT_QUEUE = "input_queue"` and these exact methods:

```python
def save_queue_snapshot(self, session_id: str, snapshot: QueueSnapshot) -> None:
    if snapshot.session_id != session_id:
        raise ValueError("queue snapshot session does not match state session")
    self._save_state(
        session_id=session_id,
        thread_id=session_id,
        state_key=self._KEY_INPUT_QUEUE,
        payload=snapshot.to_dict(),
    )

def load_queue_snapshot(self, session_id: str) -> QueueSnapshot:
    payload = self._load_state_object(session_id, self._KEY_INPUT_QUEUE)
    if payload is None:
        return QueueSnapshot(session_id=session_id)
    snapshot, issues = QueueSnapshot.restore(payload)
    for issue in issues:
        logger.warning("queue restore issue session_id=%s: %s", session_id, issue)
        self._snapshot_service.append_event(
            session_id=session_id,
            event_type="queue.restore_issue",
            payload={"issue": issue},
        )
    return snapshot

def clear_queue_snapshot(self, session_id: str) -> None:
    self._store.delete_state(session_id, self._KEY_INPUT_QUEUE)
```

Add `queue_snapshot: QueueSnapshot | None = None` to `SessionRuntimeSnapshot`, load it in `load_runtime_snapshot()`, and include it in the empty-snapshot decision.

- [ ] **Step 4: Run persistence tests**

Run: `uv run pytest tests/unit/services/test_session_service.py -q -k 'queue_snapshot or runtime_snapshot'`

Expected: all selected tests pass.

- [ ] **Step 5: Commit persistence support**

```bash
git add src/mycli/state/session_service.py src/mycli/domain/runtime/session_history.py tests/unit/services/test_session_service.py
git commit -m "feat: persist session steering queues"
```

---

### Task 3: Implement The Session Queue Coordinator

**Files:**
- Create: `src/mycli/application/runtime/session_queue.py`
- Create: `tests/unit/application/runtime/test_session_queue.py`

- [ ] **Step 1: Write failing transition, ordering, idempotency, limit, and recovery tests**

```python
def test_coordinator_accepts_rejects_and_prioritizes_steers(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path)
    queue = SessionQueueCoordinator(session_id="demo", session_service=service)

    accepted = queue.enqueue_steer(
        text="inspect",
        client_turn_id="client-1",
        expected_turn_id="turn-1",
        active_turn_id="turn-1",
        steerable=True,
    )
    rejected = queue.enqueue_steer(
        text="retry",
        client_turn_id="client-2",
        expected_turn_id="turn-old",
        active_turn_id="turn-1",
        steerable=True,
    )
    queue.enqueue_follow_up(text="later", client_turn_id="client-3")

    assert accepted.disposition is QueueDisposition.ACCEPTED_FOR_TURN
    assert rejected.disposition is QueueDisposition.DEFERRED_TO_END_OF_TURN
    assert queue.next_end_of_turn().text == "retry"
    queue.mark_started(rejected.record.queue_id)
    assert queue.next_end_of_turn().text == "later"


def test_coordinator_deduplicates_and_rejects_conflicting_client_ids(tmp_path: Path) -> None:
    queue = coordinator(tmp_path)
    first = queue.enqueue_follow_up(text="same", client_turn_id="client-1")
    duplicate = queue.enqueue_follow_up(text="same", client_turn_id="client-1")
    assert duplicate.disposition is QueueDisposition.DUPLICATE
    assert duplicate.record.queue_id == first.record.queue_id
    with pytest.raises(QueueConflictError):
        queue.enqueue_follow_up(text="different", client_turn_id="client-1")


def test_coordinator_recovers_history_committed_queue_ids(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path)
    queue = SessionQueueCoordinator(session_id="demo", session_service=service)
    queued = queue.enqueue_steer(
        text="inspect", client_turn_id="client-1",
        expected_turn_id="turn-1", active_turn_id="turn-1", steerable=True,
    ).record
    restored = SessionQueueCoordinator.restore(
        session_id="demo",
        session_service=service,
        committed_queue_ids={queued.queue_id},
        active_turn_id=None,
    )
    assert restored.snapshot().active_records() == ()


@pytest.mark.parametrize(
    ("capacity", "text", "images"),
    [
        (QueueCapacity(max_records=0), "x", ()),
        (QueueCapacity(max_text_bytes=0), "x", ()),
        (QueueCapacity(max_total_text_bytes=0), "x", ()),
        (QueueCapacity(max_attachments=0), "x", ("/tmp/a.png",)),
    ],
)
def test_coordinator_enforces_each_capacity_limit(
    tmp_path: Path,
    capacity: QueueCapacity,
    text: str,
    images: tuple[str, ...],
) -> None:
    queue = coordinator(tmp_path, capacity=capacity)
    with pytest.raises(QueueCapacityError):
        queue.enqueue_follow_up(
            text=text,
            image_paths=images,
            client_turn_id="client-capacity",
        )


def test_failed_persistence_does_not_publish_candidate_state(tmp_path: Path) -> None:
    queue = coordinator(tmp_path)
    queue._session_service.save_queue_snapshot = Mock(side_effect=OSError("disk full"))
    with pytest.raises(OSError, match="disk full"):
        queue.enqueue_follow_up(text="later", client_turn_id="client-1")
    assert queue.snapshot().active_records() == ()


def test_task_notification_capacity_replaces_oldest_internal_record(tmp_path: Path) -> None:
    queue = coordinator(tmp_path, capacity=QueueCapacity(max_records=1))
    queue.enqueue_steer(
        text="old notification",
        client_turn_id="task-old",
        expected_turn_id="turn-1",
        active_turn_id="turn-1",
        steerable=True,
        source="task_notification",
    )
    queue.enqueue_steer(
        text="new notification",
        client_turn_id="task-new",
        expected_turn_id="turn-1",
        active_turn_id="turn-1",
        steerable=True,
        source="task_notification",
    )
    assert [item.text for item in queue.snapshot().pending_steers] == ["new notification"]


def coordinator(
    tmp_path: Path,
    *,
    capacity: QueueCapacity = QueueCapacity(),
) -> SessionQueueCoordinator:
    return SessionQueueCoordinator(
        session_id="demo",
        session_service=SessionService(home_dir=tmp_path),
        capacity=capacity,
    )
```

- [ ] **Step 2: Run coordinator tests and verify import failure**

Run: `uv run pytest tests/unit/application/runtime/test_session_queue.py -q`

Expected: collection fails because `SessionQueueCoordinator` is missing.

- [ ] **Step 3: Implement one-lock, persist-before-publish mutations**

Define:

```python
@dataclass(slots=True, frozen=True)
class QueueMutationResult:
    disposition: QueueDisposition
    record: QueuedInputRecord
    snapshot: QueueSnapshot


class QueueConflictError(ValueError):
    pass


class QueueCapacityError(ValueError):
    pass
```

Implement `SessionQueueCoordinator` with these exact operations:

- Constructor loads `SessionService.load_queue_snapshot(session_id)`, owns one
  `threading.Lock`, defaults IDs to `queue_{uuid4().hex}`, and defaults time to
  `datetime.now(UTC)`.
- `enqueue_steer(...)` first looks up `(session_id, client_turn_id)`. Identical
  text/images/target returns `DUPLICATE`; different content raises
  `QueueConflictError`. Matching active/expected IDs plus `steerable=True`
  appends `pending_steer`; every other case appends `rejected_steer`.
- `enqueue_follow_up(...)` uses the same idempotency rule and appends a follow-up.
- `claim_pending_steers(turn_id)` returns matching pending records without
  mutating the snapshot.
- `commit(queue_ids)` removes exactly those IDs from pending steers and rejects
  IDs that are unknown or in another class.
- `reject_pending_for_turn(turn_id)` moves matching records to the rejected tail
  while preserving order.
- `next_end_of_turn()` returns rejected index zero before follow-up index zero
  without mutating state.
- `mark_started(queue_id)` removes only the current `next_end_of_turn()` record;
  any other ID raises `QueueConflictError`.
- `pop_last_follow_up()` removes only the final ordinary follow-up.
- `restore(...)` removes records whose IDs occur in committed history and moves
  pending records whose target differs from `active_turn_id` into rejected.
- Every successful mutation builds revision `current + 1`, validates record,
  UTF-8 byte, aggregate byte, and attachment limits, persists the candidate,
  then swaps `_snapshot`. A failed validation or save leaves `_snapshot`
  unchanged. `snapshot()` returns the immutable current value.
- When a `task_notification` candidate exceeds capacity, remove the oldest
  active task-notification record and validate once more. If no internal record
  can be replaced, raise `QueueCapacityError` and emit a queue-capacity
  diagnostic through the injected diagnostic callback.
- `subscribe(listener)` returns an unsubscribe callback. Successful mutations
  copy listeners under the queue lock and invoke them with the persisted snapshot
  after releasing the lock. Listener exceptions are suppressed and never roll
  back persisted state.

- [ ] **Step 4: Run coordinator and persistence tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/test_session_queue.py tests/unit/services/test_session_service.py -q -k 'queue or runtime_snapshot'
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the coordinator**

```bash
git add src/mycli/application/runtime/session_queue.py tests/unit/application/runtime/test_session_queue.py
git commit -m "feat: coordinate persisted steering queue transitions"
```

---

### Task 4: Migrate AgentRuntime Behind Compatibility APIs

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Test: `tests/unit/application/test_agent_runtime.py`
- Test: `tests/integration/test_turn_service.py`

- [ ] **Step 1: Write failing compatibility and session rebind tests**

```python
def test_agent_runtime_queue_snapshot_is_session_scoped(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=FollowUpCaptureAdapter(),
    )
    runtime.rebind_session(replace(runtime._config, session_id="first"))
    runtime.queue_follow_up_message("first message", client_turn_id="client-1")
    runtime.rebind_session(replace(runtime._config, session_id="second"))
    assert runtime.queue_snapshot().session_id == "second"
    assert runtime.queued_messages() == ((), ())
    runtime.rebind_session(replace(runtime._config, session_id="first"))
    assert runtime.queued_messages() == ((), ("first message",))


def test_legacy_projection_keeps_rejected_before_follow_up(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=FollowUpCaptureAdapter(),
    )
    runtime.queue_steering_message(
        "rejected", client_turn_id="client-1",
        expected_turn_id="stale", active_turn_id="current", steerable=True,
    )
    runtime.queue_follow_up_message("later", client_turn_id="client-2")
    assert runtime.queued_messages() == ((), ("rejected", "later"))
```

- [ ] **Step 2: Run selected tests and verify they fail against raw lists**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py -q -k 'queue_snapshot_is_session_scoped or legacy_projection_keeps_rejected'
```

Expected: fail because structured snapshot/rebind behavior is missing.

- [ ] **Step 3: Replace `_steering_messages` and `_follow_up_messages` ownership**

Construct `SessionQueueCoordinator.restore()` in `AgentRuntime.__init__()` using queue IDs found in `HistoryItem.metadata["queue_id"]`. Add `queue_snapshot()`, structured enqueue methods, commit/reject methods, and end-of-turn pop methods. Implement existing methods as projections/delegates; do not maintain mirror lists.

In `rebind_session()`, restore the destination coordinator before exposing the new config. In `TurnService`, add structured delegates and preserve legacy signatures for callers that do not pass the new keywords.

Use these exact structured `TurnService` method names and signatures throughout
the gateway and tests:

```python
def queue_steering_input(
    self,
    message: str,
    *,
    image_paths: tuple[str, ...] = (),
    client_turn_id: str,
    expected_turn_id: str,
    active_turn_id: str | None,
    steerable: bool,
) -> QueueMutationResult:
    return self._runtime.queue_steering_input(
        message,
        image_paths=image_paths,
        client_turn_id=client_turn_id,
        expected_turn_id=expected_turn_id,
        active_turn_id=active_turn_id,
        steerable=steerable,
    )

def queue_follow_up_input(
    self,
    message: str,
    *,
    image_paths: tuple[str, ...] = (),
    client_turn_id: str,
    source: str = "user",
) -> QueueMutationResult:
    return self._runtime.queue_follow_up_input(
        message,
        image_paths=image_paths,
        client_turn_id=client_turn_id,
        source=source,
    )

def queue_snapshot(self) -> QueueSnapshot:
    return self._runtime.queue_snapshot()

def next_queued_turn(self) -> QueuedInputRecord | None:
    return self._runtime.next_queued_turn()

def mark_queued_turn_started(self, queue_id: str) -> QueueSnapshot:
    return self._runtime.mark_queued_turn_started(queue_id)

def subscribe_queue(
    self,
    listener: Callable[[QueueSnapshot], None],
) -> Callable[[], None]:
    return self._runtime.subscribe_queue(listener)

def queue_drain_blocked(self) -> bool:
    pending_decision = self._session_service.load_pending_decision(
        self._config.session_id,
    )
    suspended = self._session_service.load_suspended_turn(self._config.session_id)
    return pending_decision is not None or (
        isinstance(suspended, SuspendedTurn)
        and suspended.pending_clarification is not None
    )
```

Cover `queue_drain_blocked()` in `test_turn_service.py` with one pending approval,
one suspended clarification, and a clear state. The expected results are `True`,
`True`, and `False`, respectively.

- [ ] **Step 4: Run queue-facing runtime tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py -q -k 'steering or follow_up or queued or queue_snapshot'
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit runtime ownership migration**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py
git commit -m "refactor: make session coordinator own queued input"
```

---

### Task 5: Commit Steering At Model Boundaries And Drain End-Of-Turn Priority

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Test: `tests/unit/application/test_agent_runtime.py`
- Test: `tests/integration/test_turn_service.py`

- [ ] **Step 1: Write failing durable commit and priority tests**

```python
def test_pending_steer_is_removed_only_after_history_commit(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=FollowUpCaptureAdapter(),
    )
    runtime.queue_steering_message(
        "inspect", client_turn_id="client-steer",
        expected_turn_id="turn-fixed", active_turn_id="turn-fixed", steerable=True,
    )
    runtime._session_service.append_history_items = Mock(side_effect=OSError("disk full"))

    with pytest.raises(OSError, match="disk full"):
        TurnExecutor(runtime).execute_user_turn("start", turn_id="turn-fixed")

    assert [item.text for item in runtime.queue_snapshot().pending_steers] == ["inspect"]


class TerminalQueueingAdapter:
    def __init__(self) -> None:
        self.before_return: Callable[[], None] | None = None
        self.call_count = 0

    def next_turn(self, *, items: list[RuntimeItem], tools: object) -> ModelTurnResult:
        del items, tools
        self.call_count += 1
        callback = self.before_return
        self.before_return = None
        if callback is not None:
            callback()
        return ModelTurnResult(
            items=(RuntimeItem(
                role="assistant",
                blocks=(RuntimeBlock(type="text", text="first"),),
            ),),
            done=True,
        )


def test_terminal_turn_reclassifies_pending_and_leaves_next_input_for_host(tmp_path: Path) -> None:
    adapter = TerminalQueueingAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    def queue_during_in_flight_response() -> None:
        runtime.queue_steering_message(
            "retry first", client_turn_id="client-rejected",
            expected_turn_id="turn-fixed", active_turn_id="turn-fixed", steerable=True,
        )

    adapter.before_return = queue_during_in_flight_response
    runtime.queue_follow_up_message("ordinary later", client_turn_id="client-follow")

    TurnExecutor(runtime).execute_user_turn("start", turn_id="turn-fixed")

    snapshot = runtime.queue_snapshot()
    assert adapter.call_count == 1
    assert [item.text for item in snapshot.rejected_steers] == ["retry first"]
    assert [item.text for item in snapshot.follow_ups] == ["ordinary later"]
    assert runtime.next_queued_turn().text == "retry first"
```

- [ ] **Step 2: Run selected tests and verify current pop-before-persist behavior fails**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py -q -k 'removed_only_after_history_commit or terminal_turn_reclassifies_pending'`

Expected: both tests fail.

- [ ] **Step 3: Add caller-supplied turn IDs and queue commit metadata**

Change `execute_user_turn()` to:

```python
def execute_user_turn(self, user_message: str, *, image_paths: tuple[str, ...] = (),
                      stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
                      interrupt_token: RuntimeInterruptToken | None = None,
                      turn_id: str | None = None) -> TurnResponse:
    resolved_turn_id = turn_id or f"turn_{uuid4().hex}"
```

Add `turn_id` to `TurnService.handle_user_turn()` and to
`_call_handle_user_turn()`. Forward it only when the runtime callable accepts the
keyword, using the same compatibility check already used for image and interrupt
arguments:

```python
def _call_handle_user_turn(
    handle_user_turn: Callable[..., object],
    user_message: str,
    *,
    image_paths: tuple[str, ...] = (),
    stream_sink: Callable[[RuntimeStreamEvent], None] | None,
    interrupt_token: RuntimeInterruptToken | None,
    turn_id: str | None,
) -> object:
    kwargs: dict[str, object] = {}
    if image_paths and _callable_accepts_keyword(handle_user_turn, "image_paths"):
        kwargs["image_paths"] = image_paths
    if stream_sink is not None:
        kwargs["stream_sink"] = stream_sink
    if interrupt_token is not None and _callable_accepts_keyword(
        handle_user_turn, "interrupt_token",
    ):
        kwargs["interrupt_token"] = interrupt_token
    if turn_id is not None and _callable_accepts_keyword(handle_user_turn, "turn_id"):
        kwargs["turn_id"] = turn_id
    return handle_user_turn(user_message, **kwargs)
```

The public method has `turn_id: str | None = None` as its final argument and
passes it to the helper. Add an integration assertion that a fixed
`turn-server-fixed` value reaches `TurnExecutor` unchanged while a legacy fake
without a `turn_id` keyword still runs.

Replace destructive steering pop with `claim_pending_steers(turn_id)`. Add each record to conversation and `TurnItem.metadata` with `queue_id`, `client_turn_id`, `queue_kind`, and source. Persist appended history before calling `commit_queue_items(queue_ids)`. On any terminal response, call `reject_pending_for_turn(turn_id)`. Remove the existing in-loop `pop_next_follow_up_message()` continuation: a terminal assistant answer returns immediately, leaving rejected/follow-up scheduling to the runtime host. Expose non-mutating `next_queued_turn()` and `mark_queued_turn_started(queue_id)` delegates on `AgentRuntime` and `TurnService`.

- [ ] **Step 4: Run runtime tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py -q -k 'steering or follow_up or queue or interrupted or server_turn_id'
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit runtime delivery semantics**

```bash
git add src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py
git commit -m "feat: acknowledge steering after durable history commit"
```

---

### Task 6: Add Server Turn Identity And Revisioned Gateway Contracts

**Files:**
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/domain/runtime/gateway_contract.py`
- Test: `tests/unit/cli/node_tui/test_gateway.py`
- Test: `tests/unit/domain/runtime/test_gateway_contract.py`

- [ ] **Step 1: Write failing gateway identity and disposition tests**

```python
class QueueSchedulingTurnService(FakeTurnService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.started = Event()
        self.second_started = Event()
        self.release = Event()
        self.blocker_checked = Event()
        self.queue_blocked = False
        self.user_messages: list[str] = []
        self.server_turn_ids: list[str] = []
        self._queue = SessionQueueCoordinator(
            session_id="demo",
            session_service=SessionService(home_dir=workspace_root / "home"),
        )

    def handle_user_turn(
        self,
        message: str,
        stream_sink: StreamSink | None = None,
        *,
        turn_id: str | None = None,
    ) -> TurnResponse:
        del stream_sink
        if turn_id is None:
            raise AssertionError("gateway did not pass a server turn id")
        self.user_messages.append(message)
        self.server_turn_ids.append(turn_id)
        if len(self.user_messages) == 1:
            self.started.set()
            if not self.release.wait(timeout=2.0):
                raise AssertionError("first turn was not released")
        else:
            self.second_started.set()
        return TurnResponse(assistant_message=f"response {len(self.user_messages)}")

    def queue_steering_input(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str,
        expected_turn_id: str,
        active_turn_id: str | None,
        steerable: bool,
    ) -> QueueMutationResult:
        return self._queue.enqueue_steer(
            text=message,
            image_paths=image_paths,
            client_turn_id=client_turn_id,
            expected_turn_id=expected_turn_id,
            active_turn_id=active_turn_id,
            steerable=steerable,
        )

    def queue_follow_up_input(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str,
        source: str = "user",
    ) -> QueueMutationResult:
        return self._queue.enqueue_follow_up(
            text=message,
            image_paths=image_paths,
            client_turn_id=client_turn_id,
            source=source,
        )

    def queue_snapshot(self) -> QueueSnapshot:
        return self._queue.snapshot()

    def next_queued_turn(self) -> QueuedInputRecord | None:
        return self._queue.next_end_of_turn()

    def mark_queued_turn_started(self, queue_id: str) -> QueueSnapshot:
        return self._queue.mark_started(queue_id)

    def subscribe_queue(
        self,
        listener: Callable[[QueueSnapshot], None],
    ) -> Callable[[], None]:
        return self._queue.subscribe(listener)

    def queue_drain_blocked(self) -> bool:
        self.blocker_checked.set()
        return self.queue_blocked


def test_gateway_exposes_server_turn_id_and_rejects_stale_steer(tmp_path: Path) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    gateway = NodeTuiGateway(service=service)
    try:
        started = gateway.handle_request(RpcRequest(
            id="submit", method="turn.submit",
            params={"message": "start", "client_turn_id": "client-start"},
        ))
        assert service.started.wait(timeout=2.0)
        turn_id = str(started.result["turn_id"])

        response = gateway.handle_request(RpcRequest(
            id="steer", method="turn.steer",
            params={
                "message": "inspect",
                "client_turn_id": "client-steer",
                "expected_turn_id": f"{turn_id}-stale",
            },
        ))

        assert started.result == {
            "accepted": True,
            "client_turn_id": "client-start",
            "turn_id": turn_id,
        }
        assert response.result["disposition"] == "deferred_to_end_of_turn"
        assert response.result["queue_items"]["rejected_steers"][0]["message"] == "inspect"
    finally:
        service.release.set()
        gateway.wait_for_current_turn(timeout=2.0)
        gateway.close()


def test_gateway_starts_rejected_steer_as_a_new_server_turn(tmp_path: Path) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(service=service, emit=lambda method, params: events.append((method, params)))
    try:
        first = gateway.handle_request(RpcRequest(
            id="submit", method="turn.submit",
            params={"message": "start", "client_turn_id": "client-start"},
        ))
        assert service.started.wait(timeout=2.0)
        gateway.handle_request(RpcRequest(
            id="steer", method="turn.steer",
            params={
                "message": "retry",
                "client_turn_id": "client-steer",
                "expected_turn_id": f"{first.result['turn_id']}-stale",
            },
        ))
        service.release.set()
        assert service.second_started.wait(timeout=2.0)
        gateway.wait_for_current_turn(timeout=2.0)

        started_ids = [
            params["turn_id"] for method, params in events
            if method == "turn.started"
        ]
        assert len(started_ids) == 2
        assert started_ids[0] != started_ids[1]
        assert service.server_turn_ids == started_ids
        assert service.user_messages == ["start", "retry"]
    finally:
        service.release.set()
        gateway.close()


def test_gateway_retains_queue_while_interaction_is_pending(tmp_path: Path) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    service.queue_blocked = True
    gateway = NodeTuiGateway(service=service)
    try:
        gateway.handle_request(RpcRequest(
            id="submit", method="turn.submit",
            params={"message": "start", "client_turn_id": "client-start"},
        ))
        assert service.started.wait(timeout=2.0)
        queued = gateway.handle_request(RpcRequest(
            id="follow", method="turn.follow_up",
            params={"message": "later", "client_turn_id": "client-follow"},
        ))
        service.release.set()
        gateway.wait_for_current_turn(timeout=2.0)
        assert service.blocker_checked.wait(timeout=2.0)

        assert service.user_messages == ["start"]
        assert queued.result["queue_items"]["follow_ups"][0]["message"] == "later"
        assert [item.text for item in service.queue_snapshot().follow_ups] == ["later"]
    finally:
        service.release.set()
        gateway.close()


class StartFailingThread(Thread):
    def start(self) -> None:
        raise RuntimeError("worker start failed")


class FailSecondThreadFactory:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, **kwargs: Any) -> Thread:
        self.calls += 1
        thread_type = Thread if self.calls == 1 else StartFailingThread
        return thread_type(**kwargs)


def test_gateway_keeps_record_when_next_worker_cannot_start(tmp_path: Path) -> None:
    service = QueueSchedulingTurnService(tmp_path)
    failure_seen = Event()

    def emit(method: str, params: dict[str, object]) -> None:
        if method == "gateway.error" and params.get("code") == "queue_worker_start_failed":
            failure_seen.set()

    gateway = NodeTuiGateway(
        service=service,
        emit=emit,
        turn_thread_factory=FailSecondThreadFactory(),
    )
    try:
        first = gateway.handle_request(RpcRequest(
            id="submit", method="turn.submit",
            params={"message": "start", "client_turn_id": "client-start"},
        ))
        assert service.started.wait(timeout=2.0)
        gateway.handle_request(RpcRequest(
            id="steer", method="turn.steer",
            params={
                "message": "retry",
                "client_turn_id": "client-steer",
                "expected_turn_id": f"{first.result['turn_id']}-stale",
            },
        ))
        service.release.set()
        assert failure_seen.wait(timeout=2.0)

        assert service.user_messages == ["start"]
        assert [item.text for item in service.queue_snapshot().rejected_steers] == ["retry"]
    finally:
        service.release.set()
        gateway.close()
```

Add contract assertions requiring `turn_id`, `expected_turn_id`, `queue_revision`, `queue_items`, and dispositions, plus `stale_turn` and `queue_conflict` error codes.

- [ ] **Step 2: Run tests and verify fields are missing**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py -q -k 'server_turn_id or stale_steer or queue'
```

Expected: fail because `turn_id` and structured queue fields are absent.

- [ ] **Step 3: Mint the server turn ID before the worker starts**

In `_handle_turn_submit()`, generate `turn_id = f"turn_{uuid4().hex}"`, store it as `_current_turn_id`, pass it into `_run_turn_worker`, and return it beside `client_turn_id`. Emit it in `turn.started`, `turn.completed`, `turn.interrupted`, `turn.failed`, and status payloads.

Require `expected_turn_id` in `turn.steer`. Under `_turn_lock`, snapshot `_current_turn_id` and `_turn_running`, then call the structured coordinator API with that identity. Serialize mutation disposition and the complete revisioned snapshot. Update gateway schemas and typed protocol tests.

Add an injectable `turn_thread_factory` constructor argument defaulting to
`Thread` for foreground and queued-turn workers, then add one daemon
queue-scheduler thread and one `threading.Event` to the gateway. The scheduler
thread itself continues to use `Thread` directly, so worker-failure tests can fail
the second turn start without disabling the scheduler.
The coordinator subscription callback only calls `event.set()` and never
acquires `_turn_lock`. `_schedule_next_queued_turn()` wakes on that event,
acquires `_turn_lock`, returns when a turn/approval/clarification is active,
reads `service.next_queued_turn()`, mints a new server/client turn identity, and
installs the worker state. It starts the worker, then calls
`service.mark_queued_turn_started(queue_id)` and emits the updated snapshot. If
`Thread.start()` raises, reset installed worker state and leave the record
queued. Worker terminal cleanup sets the scheduler event again. The documented
lock order is `_turn_lock` then coordinator lock; coordinator listeners run only
after its lock is released. This makes idle background task notifications start
through the same rejected-steer priority path.

Extend `close()` to unsubscribe from queue updates, set a scheduler-stop event,
wake the scheduler, and join it with a bounded timeout. The scheduler checks
`service.queue_drain_blocked()` before selecting an item. Approval and
clarification response workers set the scheduler event after successfully clearing
their pending interaction.

- [ ] **Step 4: Run gateway unit tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit server identity and contracts**

```bash
git add src/mycli/application/turn_service.py src/mycli/cli/node_tui/gateway.py src/mycli/domain/runtime/gateway_contract.py tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py
git commit -m "feat: target steering at server turn ids"
```

---

### Task 7: Cover Gateway Retry, Resume, And Real Client Behavior

**Files:**
- Modify: `tests/integration/test_node_tui_gateway.py`
- Modify: `tui/mycli-shell/test/support/scripted-client.ts`

- [ ] **Step 1: Add failing integration scenarios**

Add scripted actions that:

```json
{"type":"turn.submit","message":"start","client_turn_id":"client-start"}
{"type":"turn.steer","message":"inspect","client_turn_id":"client-steer","use_active_turn_id":true}
{"type":"turn.steer","message":"inspect","client_turn_id":"client-steer","use_active_turn_id":true}
{"type":"session.resume","session_id":"other"}
```

Assert the first steer is accepted, the retry returns `duplicate`, exactly one queue record exists, and resumed status contains only `other` session records. Add a restart test that constructs a new runtime against the same `home_dir` and verifies pending state normalization.

- [ ] **Step 2: Run integration tests and verify retry/resume assertions fail**

Run: `uv run pytest tests/integration/test_node_tui_gateway.py -q -k 'queue_retry or queue_resume or queue_restart'`

Expected: selected tests fail until all snapshots are session-scoped and idempotent.

- [ ] **Step 3: Unify gateway serialization and resume rebinding**

Ensure `_status_payload()`, bootstrap, direct mutation responses, and `turn.queue.updated` all call one `_queue_payload(snapshot)` serializer. During `session.resume`, emit `session.changed` first, then destination `status.changed`; no source-session queue update may follow the switch. Update the scripted client to retain the latest `turn_id` from submit/started events and use it for steering.

- [ ] **Step 4: Run Python gateway integration tests**

Run: `uv run pytest tests/integration/test_node_tui_gateway.py -q`

Expected: all tests pass.

- [ ] **Step 5: Commit integration behavior**

```bash
git add tests/integration/test_node_tui_gateway.py tui/mycli-shell/test/support/scripted-client.ts src/mycli/cli/node_tui/gateway.py
git commit -m "test: cover steering retries and session resume"
```

---

### Task 8: Make The Node Gateway A Revisioned Backend Projection

**Files:**
- Modify: `tui/mycli-shell/src/gateway.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing stale-revision and lost-response tests**

```typescript
test("runtime adapter ignores stale queue revisions", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "turn.queue.updated", {
		queue_revision: 4,
		queue_items: { pending_steers: [{ message: "new" }], rejected_steers: [], follow_ups: [] },
	});
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		queue_revision: 3,
		queue_items: { pending_steers: [{ message: "old" }], rejected_steers: [], follow_ups: [] },
	});
	assert.deepEqual(state.queuedPendingSteers.map((item) => item.message), ["new"]);
});

test("session changes reset queue revision and hide internal notifications", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "turn.queue.updated", {
		queue_revision: 9,
		queue_items: { pending_steers: [{ message: "old", source: "user" }], rejected_steers: [], follow_ups: [] },
	});
	state = reduceRuntimeEvent(state, "session.changed", { session_id: "session-2" });
	state = reduceRuntimeEvent(state, "status.changed", {
		session_id: "session-2",
		queue_revision: 1,
		queue_items: {
			pending_steers: [
				{ message: "internal", source: "task_notification" },
				{ message: "visible", source: "user" },
			],
			rejected_steers: [],
			follow_ups: [],
		},
	});

	assert.equal(state.queueRevision, 1);
	assert.deepEqual(state.queuedPendingSteers.map((item) => item.message), ["visible"]);
});
```

Add a gateway source assertion proving `queueSteeringTurn()` does not push to a local durable array in `catch`, and that it sends `expected_turn_id: runtimeState.activeTurnId`.

- [ ] **Step 2: Run Node tests and verify missing state fails**

Run:

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='stale queue revisions|steering request uses active server turn'
```

Expected: fail because revision and active server turn state are absent.

- [ ] **Step 3: Replace local queue arrays with structured runtime state**

Change runtime state to include:

```typescript
queueRevision: number;
activeTurnId: string | null;
queuedPendingSteers: RuntimeQueuedInputPreview[];
queuedRejectedSteers: RuntimeQueuedInputPreview[];
queuedFollowUpInputs: RuntimeQueuedInputPreview[];
```

Parse `queue_items` first and use legacy fields only when structured fields are absent. Ignore any queue payload with a lower revision. Filter records with `source === "task_notification"` from presentation arrays while retaining them in backend state. Set `activeTurnId` from `turn.started`, clear it only when the matching terminal event arrives, and clear all queue state and revision immediately on `session.changed` until destination status arrives.

Delete `queuedSteeringTurns`, `queuedFollowUpTurns`, local fallback enqueue, and `drainQueuedTurns()`. Backend terminal-turn scheduling now owns queue drain. On ambiguous RPC failure, display the gateway error and wait for the next backend status snapshot.

- [ ] **Step 4: Run state and gateway tests plus typecheck**

Run:

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all Node tests and typecheck pass.

- [ ] **Step 5: Commit backend-projection migration**

```bash
git add tui/mycli-shell/src/gateway.ts tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/test
git commit -m "refactor: project backend steering queue revisions"
```

---

### Task 9: Render Complete Codex-Style Queue Semantics

**Files:**
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/components/pending-input-preview.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`

- [ ] **Step 1: Write failing three-section, attachment, dynamic hint, and height tests**

```typescript
test("pending preview renders three queue classes within its height budget", () => {
	const preview = new PendingInputPreviewComponent({
		pendingSteers: [{ text: "pending", hasImages: true }],
		rejectedSteers: [{ text: "rejected", hasImages: false }],
		followUps: Array.from({ length: 8 }, (_, index) => ({ text: `later ${index}`, hasImages: false })),
	}, { interruptHint: "f12", editHint: "shift+left", maxHeight: 12 });
	const output = stripAnsi(preview.render(52).join("\n"));

	assert.match(output, /Messages to be submitted after next tool call/);
	assert.match(output, /attachment/);
	assert.match(output, /Messages to be submitted at end of turn/);
	assert.match(output, /Queued follow-up inputs/);
	assert.match(output, /f12 to interrupt/);
	assert.match(output, /shift\+left edit last queued message/);
	assert.match(output, /\.\.\. \+\d+ more/);
	assert.ok(preview.render(52).length <= 12);
});

test("pending preview bounds CJK and multiline input by visual width", () => {
	const width = 24;
	const preview = new PendingInputPreviewComponent({
		pendingSteers: [{ text: "检查最新命令输出\n然后继续处理这个很长的任务", hasImages: false }],
		rejectedSteers: [],
		followUps: [],
	}, { interruptHint: "esc", editHint: "alt+up", maxHeight: 8 });

	for (const line of preview.render(width)) {
		assert.ok(visibleWidth(line) <= width, `line too wide: ${stripAnsi(line)}`);
	}
	assert.ok(preview.render(width).length <= 8);
});
```

Add a runtime transition test for pending -> rejected -> absent and retain the existing streaming test that unchanged pending chrome is not rebuilt.

- [ ] **Step 2: Run the focused tests and verify the third section/options are missing**

Run:

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='three queue classes|pending.*rejected|height budget'
```

Expected: fail against the current two-section constructor.

- [ ] **Step 3: Extend the presentation model and bounded component**

Define:

```typescript
export type MycliShellPendingInput = {
	pendingSteers: MycliShellQueuedInputPreview[];
	rejectedSteers: MycliShellQueuedInputPreview[];
	followUps: MycliShellQueuedInputPreview[];
};
```

Render pending, rejected, and follow-up sections in that order. Append an attachment marker when `hasImages` is true and no `[image #N]` placeholder is present. Resolve interrupt/edit hints from the installed keybinding map. Compute `maxHeight` from terminal rows while reserving at least one transcript row plus editor/status/footer chrome. Truncate complete items from the bottom and append `... +N more`; never split an ANSI or wide-character cell.

- [ ] **Step 4: Run all TUI tests and typecheck**

Run:

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 5: Commit full queue presentation**

```bash
git add tui/mycli-shell/src/model.ts tui/mycli-shell/src/components/pending-input-preview.ts tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/test/shell-app.test.ts tui/mycli-shell/test/runtime-state.test.ts
git commit -m "feat: render complete Codex steering queue states"
```

---

### Task 10: Remove Obsolete Ownership And Run Full Verification

**Files:**
- Modify: `src/mycli/domain/runtime/message_queue.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Test: all queue-related Python and Node tests

- [ ] **Step 1: Add a source guard against duplicate queue ownership**

Add a test that reads production sources and asserts these obsolete names are absent outside compatibility method declarations:

```python
def test_queue_state_has_one_backend_owner() -> None:
    runtime_source = Path("src/mycli/application/runtime/agent_runtime.py").read_text()
    gateway_source = Path("tui/mycli-shell/src/gateway.ts").read_text()
    assert "_steering_messages" not in runtime_source
    assert "_follow_up_messages" not in runtime_source
    assert "queuedSteeringTurns" not in gateway_source
    assert "queuedFollowUpTurns" not in gateway_source
```

- [ ] **Step 2: Run the guard and remove remaining mirrors**

Run: `uv run pytest tests/unit/application/runtime/test_session_queue.py -q -k one_backend_owner`

Expected before cleanup: fail if any raw owner remains. Remove remaining storage and direct mutation code while retaining compatibility projection functions.

- [ ] **Step 3: Run focused Python verification**

```bash
uv run pytest \
  tests/unit/domain/runtime/test_message_queue.py \
  tests/unit/domain/runtime/test_gateway_contract.py \
  tests/unit/application/runtime/test_session_queue.py \
  tests/unit/services/test_session_service.py \
  tests/unit/application/test_agent_runtime.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/integration/test_turn_service.py \
  tests/integration/test_node_tui_gateway.py -q
```

Expected: all focused tests pass.

- [ ] **Step 4: Run static checks and full suites**

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: every command exits zero with no failures.

- [ ] **Step 5: Inspect repository diff and queue schema compatibility**

```bash
git diff --check
git status --short
rg -n "steering_items|follow_up_items|queue_items|queue_revision" \
  src/mycli tui/mycli-shell/src
```

Expected: no whitespace errors; only intended files remain modified; legacy fields are emitted only by compatibility serializers while new clients consume `queue_items` and `queue_revision`.

- [ ] **Step 6: Commit cleanup and verification**

```bash
git add src/mycli tui/mycli-shell/src tests tui/mycli-shell/test
git commit -m "refactor: retire legacy steering queue ownership"
```

---

## Execution Notes

- Before Task 1, preserve the already completed uncommitted dynamic pending-preview refresh fix in `tui/mycli-shell/src/shell-runtime.ts` and `tui/mycli-shell/test/shell-app.test.ts`; commit it separately or carry it forward without reverting it.
- Keep task commits narrowly scoped. Do not stage `.codex/config.toml`, model artifacts, training data, demo scripts, or unrelated shell-runtime plan edits.
- At every queue mutation boundary, persist before emitting a snapshot.
- Never remove a pending steer merely because it was claimed for a model request; remove it only after history with the same `queue_id` is durable.
- Never compare queue revisions across sessions. Reset revision state on `session.changed`.
