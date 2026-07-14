# Approval Resume History Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent approval continuation from persisting duplicate user messages and normalize legacy duplicates consistently for TUI, snapshots, and model replay.

**Architecture:** Add a pure history replay normalizer that receives approval continuation turn IDs derived from persisted turn rollouts, then expose normalized replay history through `SessionService`. Stop producing the synthetic user item for new approvals, and use the normalized service view at each replay boundary without mutating canonical SQLite audit data.

**Tech Stack:** Python 3.13, pytest, Ruff, Mypy, SQLite-backed session history, Node TUI JSON-RPC gateway.

---

## File Map

- Create `src/mycli/services/history_replay.py`: derive approval turns from rollouts and normalize legacy approval-continuation history.
- Create `tests/unit/services/test_history_replay.py`: semantic normalization and preservation cases.
- Modify `src/mycli/state/session_service.py`: expose normalized replay history and use it for runtime snapshots, conversation views, and readable snapshots.
- Modify `tests/unit/services/test_session_service.py`: verify rollout-backed replay normalization.
- Modify `src/mycli/application/runtime/turn_executor.py`: stop writing the suspended user message during approval continuation.
- Modify `tests/unit/application/test_agent_runtime.py`: prove approval continuation persists one original user message.
- Modify `src/mycli/cli/node_tui/gateway.py`: normalize complete history before transcript pagination and projection.
- Modify `tests/unit/cli/node_tui/test_gateway.py`: prove old sessions reload without duplicate users and keep stable pagination.

## Task 1: Add Semantic History Replay Normalization

**Files:**
- Create: `src/mycli/services/history_replay.py`
- Create: `tests/unit/services/test_history_replay.py`

- [ ] **Step 1: Write failing normalization tests**

Create tests with a history sequence containing an original user turn, an approval continuation turn ID supplied from rollout evidence, the old synthetic user item, a queued user item in that continuation, and an independent later turn with identical text. Also construct a `TurnRollout` containing a `turn_item` event whose payload type is `approval_resolution`, and assert its turn ID is discovered:

```python
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.history_replay import (
    approval_resume_turn_ids,
    normalize_history_for_replay,
)


def item(
    item_id: str,
    turn_id: str,
    item_type: HistoryItemType,
    *,
    text: str = "",
    queued: bool = False,
) -> HistoryItem:
    return HistoryItem(
        id=item_id,
        thread_id="demo",
        turn_id=turn_id,
        type=item_type,
        text=text,
        metadata={"queued": True} if queued else {},
    )


def test_normalizer_removes_only_legacy_approval_resume_user_item() -> None:
    history = (
        item("user-original", "turn-1", HistoryItemType.USER_MESSAGE, text="inspect cpu"),
        item("approval", "turn-2", HistoryItemType.APPROVAL_RESOLUTION),
        item("user-legacy", "turn-2", HistoryItemType.USER_MESSAGE, text="inspect cpu"),
        item("user-queued", "turn-2", HistoryItemType.USER_MESSAGE, text="also inspect disk", queued=True),
        item("user-repeat", "turn-3", HistoryItemType.USER_MESSAGE, text="inspect cpu"),
    )

    normalized = normalize_history_for_replay(
        history,
        approval_turn_ids=frozenset({"turn-2"}),
    )

    assert [entry.id for entry in normalized] == [
        "user-original",
        "approval",
        "user-queued",
        "user-repeat",
    ]


def test_normalizer_preserves_users_outside_approval_resume_turns() -> None:
    history = (item("user", "turn-1", HistoryItemType.USER_MESSAGE, text="inspect cpu"),)

    assert normalize_history_for_replay(history, approval_turn_ids=frozenset()) == history
```

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/services/test_history_replay.py -q
```

Expected: collection fails because `mycli.services.history_replay` does not exist.

- [ ] **Step 3: Implement the pure normalizer**

Create `src/mycli/services/history_replay.py`:

```python
from __future__ import annotations

from mycli.domain.runtime import HistoryItem, HistoryItemType


def normalize_history_for_replay(
    items: tuple[HistoryItem, ...],
    *,
    approval_turn_ids: frozenset[str],
) -> tuple[HistoryItem, ...]:
    normalized: list[HistoryItem] = []
    for item in items:
        if (
            item.type is HistoryItemType.USER_MESSAGE
            and item.turn_id in approval_turn_ids
            and item.metadata.get("queued") is not True
        ):
            continue
        normalized.append(item)
    return tuple(normalized)


def approval_resume_turn_ids(rollouts: tuple[TurnRollout, ...]) -> frozenset[str]:
    return frozenset(
        rollout.turn_id
        for rollout in rollouts
        if any(
            event.kind == "turn_item"
            and event.payload.get("type") == HistoryItemType.APPROVAL_RESOLUTION.value
            for event in rollout.events
        )
    )
```

- [ ] **Step 4: Run focused tests and static checks**

```bash
uv run pytest tests/unit/services/test_history_replay.py -q
uv run ruff check src/mycli/services/history_replay.py tests/unit/services/test_history_replay.py
uv run mypy src/mycli/services/history_replay.py
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/services/history_replay.py tests/unit/services/test_history_replay.py
git commit -m "Normalize legacy approval replay history"
```

## Task 2: Stop Persisting Duplicate Approval User Messages

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write a failing approval persistence test**

Extend the existing `PushThenDoneAdapter` approval test:

```python
def test_agent_runtime_approval_resume_does_not_repeat_user_history(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneAdapter(),
    )

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    runtime.resolve_pending_approval("1")

    user_items = [
        item
        for item in runtime._session_service.load_history_items(runtime._config.session_id)
        if item.type is HistoryItemType.USER_MESSAGE
    ]
    assert [item.text for item in user_items] == ["push the branch"]
```

- [ ] **Step 2: Run the test to verify RED**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_approval_resume_does_not_repeat_user_history -q
```

Expected: FAIL because the list contains `"push the branch"` twice.

- [ ] **Step 3: Remove the synthetic append**

Delete only this block from `TurnExecutor.resolve_pending_approval`:

```python
runtime._append_turn_item(
    turn_id=turn_id,
    turn_items=turn_items,
    item=TurnItem(type=TurnItemType.USER_MESSAGE, text=suspended.user_message),
)
```

Keep `suspended.user_message` for tool exposure, finalization, tracing, and the restored conversation.

- [ ] **Step 4: Run application tests**

```bash
uv run pytest \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_approval_resume_does_not_repeat_user_history \
  tests/unit/application/test_turn_executor.py \
  tests/integration/test_turn_service.py -q
uv run ruff check src/mycli/application/runtime/turn_executor.py tests/unit/application/test_agent_runtime.py
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/turn_executor.py tests/unit/application/test_agent_runtime.py
git commit -m "Avoid duplicate user history on approval resume"
```

## Task 3: Add The Normalized Session Replay View

**Files:**
- Modify: `src/mycli/state/session_service.py`
- Modify: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write failing replay service tests**

Persist a legacy history sequence and a rollout whose first event is an
approval resolution. Assert `load_replay_history_items` removes the synthetic
user item while `load_history_items` remains unchanged. Then assert runtime
snapshot history, reconstructed conversation messages, and a refreshed
`session.json` use the normalized sequence.

```python
history = (
    HistoryItem(
        id="user-original",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.USER_MESSAGE,
        text="inspect cpu",
    ),
    HistoryItem(
        id="approval",
        thread_id="demo",
        turn_id="turn-2",
        type=HistoryItemType.APPROVAL_RESOLUTION,
        text="[decision] 1",
    ),
    HistoryItem(
        id="user-legacy",
        thread_id="demo",
        turn_id="turn-2",
        type=HistoryItemType.USER_MESSAGE,
        text="inspect cpu",
    ),
)
```

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/services/test_session_service.py -k approval_replay -q
```

Expected: FAIL because `load_replay_history_items` does not exist.

- [ ] **Step 3: Implement and use the normalized service view**

Add this method to `SessionService`:

```python
def load_replay_history_items(self, session_id: str) -> tuple[HistoryItem, ...]:
    return normalize_history_for_replay(
        self.load_history_items(session_id),
        approval_turn_ids=approval_resume_turn_ids(self.load_turn_rollouts(session_id)),
    )
```

Use `load_replay_history_items` in `load_runtime_snapshot`,
`_conversation_messages_from_history`, and `_write_snapshot`. Keep mutation and
maintenance paths on raw `load_history_items`.

- [ ] **Step 4: Run focused tests and checks**

```bash
uv run pytest \
  tests/unit/services/test_session_service.py \
  tests/unit/services/test_context_manager.py \
  tests/unit/services/test_session_snapshot.py -q
uv run ruff check \
  src/mycli/state/session_service.py \
  tests/unit/services/test_session_service.py
uv run mypy src/mycli/state/session_service.py
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add \
  src/mycli/state/session_service.py \
  tests/unit/services/test_session_service.py
git commit -m "Normalize approval history at replay boundaries"
```

## Task 4: Normalize TUI Transcript Loading Before Pagination

**Files:**
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`

- [ ] **Step 1: Write a failing gateway regression test**

Populate `FakeSessionService.history_items` with an original user item, an approval resolution, the legacy duplicate user item, and an assistant item. Request `transcript.load` with `limit=2` and assert the response contains the approval resolution and assistant item, not the duplicate user item. Also request without a limit and assert exactly one user item remains.

```python
response = gateway.handle_request(
    RpcRequest(
        id="req_history",
        method="transcript.load",
        params={"session_id": "demo", "before": None},
    )
)
assert response.result is not None
assert [item["id"] for item in response.result["items"]] == [
    "user-original",
    "approval",
    "assistant",
]
```

- [ ] **Step 2: Run the test to verify RED**

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py -k 'approval_resume and transcript' -q
```

Expected: FAIL because `user-legacy` is returned.

- [ ] **Step 3: Normalize before pagination**

In `_handle_transcript_load`, normalize immediately after loading canonical history:

```python
items = list(
    self.service._session_service.load_replay_history_items(session_id)
)
```

Do this before applying `before` and `limit`. Keep the read-only snapshot fallback unchanged because snapshot generation is normalized in Task 3.

- [ ] **Step 4: Run gateway and TUI adapter tests**

```bash
uv run pytest \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/integration/test_node_tui_gateway.py -q
npm --prefix tui/mycli-shell test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/cli/node_tui/gateway.py tests/unit/cli/node_tui/test_gateway.py
git commit -m "Hide legacy approval duplicates from TUI history"
```

## Task 5: Verify The Reported Session Shape And Full Regression

**Files:**
- Modify only files required by verification failures.

- [ ] **Step 1: Verify the reported session through the normalizer**

Use the configured mycli services or a read-only diagnostic command to load history for `e45e1739-9cae-49f2-9f69-8f8aa16ce644`, apply `normalize_history_for_replay`, and confirm the visible user-message count for `看一下当前的cpu等使用情况` changes from four to one without writing the session database.

- [ ] **Step 2: Run all Python verification**

```bash
uv run pytest -q
uv run ruff check .
uv run mypy src/mycli
```

Expected: zero failures and zero static-check errors.

- [ ] **Step 3: Run all TUI verification**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all Node tests and TypeScript checks pass.

- [ ] **Step 4: Verify repository state**

```bash
git diff --check
git status --short
git log --oneline -8
```

Expected: only the unrelated `.codex/config.toml` remains modified and the fix is split into focused commits.

- [ ] **Step 5: Finish the branch**

Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Do not merge, push, delete, or clean the worktree without the user's selected finish option.
