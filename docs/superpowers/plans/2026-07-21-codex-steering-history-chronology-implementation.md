# Codex Steering History Chronology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist completed assistant/tool items before committing same-turn steering input so live history and `/resume` reproduce Codex ordering.

**Architecture:** `RuntimeEventLedger` gains an incremental commit operation for completed `TurnItem` objects. `TurnExecutor` invokes it before every active-turn mailbox drain and before terminal leftover commits; successful items receive `history_committed`, so finalization only appends genuinely uncommitted history items.

**Tech Stack:** Python 3.13, frozen dataclasses, SQLite-backed `SessionService`, pytest.

---

## File Structure

- Modify `src/mycli/application/runtime/ledger/runtime_event_ledger.py`: incrementally persist completed turn items and mark successful commits.
- Modify `src/mycli/application/runtime/agent_runtime.py`: expose the ledger operation through the existing runtime facade.
- Modify `src/mycli/application/runtime/turn_executor.py`: establish the persistence barrier before steering commits.
- Modify `tests/unit/application/runtime/test_runtime_event_ledger.py`: verify stable IDs and finalizer-safe idempotency.
- Modify `tests/unit/application/test_agent_runtime.py`: verify live, durable, resume, and failure ordering.

No Node TUI production files change. The TUI already projects completed events and replays canonical transcript order; backend sequence numbers are the remaining defect.

### Task 1: Incremental Completed-Item Persistence

**Files:**
- Modify: `tests/unit/application/runtime/test_runtime_event_ledger.py`
- Modify: `src/mycli/application/runtime/ledger/runtime_event_ledger.py`

- [ ] **Step 1: Write the failing ledger test**

Add this recorder and test:

```python
class _RecordingSessionService(_NoopSessionService):
    def __init__(self) -> None:
        self.appended: list[HistoryItem] = []

    def append_history_items(
        self,
        session_id: str,
        items: tuple[HistoryItem, ...],
    ) -> None:
        assert session_id == "demo"
        self.appended.extend(items)


def test_runtime_event_ledger_incrementally_commits_completed_items_once() -> None:
    service = _RecordingSessionService()
    ledger = RuntimeEventLedger(
        session_id="demo",
        session_service=service,
        trace_service=_NoopTraceService(),  # type: ignore[arg-type]
        continuation_state_provider=lambda: None,
    )
    turn_items = [
        TurnItem(
            type=TurnItemType.USER_MESSAGE,
            text="start",
            metadata={"history_committed": True},
        ),
        TurnItem(type=TurnItemType.ASSISTANT_MESSAGE, text="first answer"),
    ]

    committed = ledger.persist_completed_turn_items(
        turn_id="turn-1",
        turn_items=turn_items,
    )

    assert [item.id for item in committed] == ["turn-1:item:2"]
    assert [item.text for item in service.appended] == ["first answer"]
    assert turn_items[1].metadata["history_committed"] is True
    assert ledger.persist_completed_turn_items(
        turn_id="turn-1",
        turn_items=turn_items,
    ) == ()
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn-1",
        status=TurnStatus.COMPLETED,
        started_at="2026-07-21T00:00:00Z",
        items=tuple(turn_items),
    )
    assert ledger.history_items_from_turn(turn) == ()
```

- [ ] **Step 2: Verify the test fails for the missing API**

```bash
uv run pytest -q tests/unit/application/runtime/test_runtime_event_ledger.py::test_runtime_event_ledger_incrementally_commits_completed_items_once
```

Expected: FAIL with `AttributeError` for `persist_completed_turn_items`.

- [ ] **Step 3: Implement the ledger operation**

Import `replace` from `dataclasses`, then add:

```python
def persist_completed_turn_items(
    self,
    *,
    turn_id: str,
    turn_items: list[TurnItem],
) -> tuple[HistoryItem, ...]:
    pending: list[tuple[int, HistoryItem]] = []
    for index, item in enumerate(turn_items, start=1):
        if item.metadata.get("history_committed") is True:
            continue
        history_item_type = self._history_type_for_turn_item(item)
        if history_item_type is None:
            continue
        pending.append(
            (
                index - 1,
                HistoryItem(
                    id=f"{turn_id}:item:{index}",
                    thread_id=self._session_id,
                    turn_id=turn_id,
                    type=history_item_type,
                    text=item.text,
                    tool_name=item.tool_name,
                    call_id=item.call_id,
                    metadata=dict(item.metadata),
                ),
            )
        )
    if not pending:
        return ()

    committed = tuple(history_item for _item_index, history_item in pending)
    self._session_service.append_history_items(self._session_id, committed)
    for item_index, _history_item in pending:
        item = turn_items[item_index]
        turn_items[item_index] = replace(
            item,
            metadata={**item.metadata, "history_committed": True},
        )
    return committed
```

Apply markers only after durable append succeeds. A failed write remains eligible for retry or finalization.

- [ ] **Step 4: Run the ledger suite**

```bash
uv run pytest -q tests/unit/application/runtime/test_runtime_event_ledger.py
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/ledger/runtime_event_ledger.py tests/unit/application/runtime/test_runtime_event_ledger.py
git commit -m "feat: persist completed turn items incrementally"
```

### Task 2: Persistence Barrier Before Steering

**Files:**
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`

- [ ] **Step 1: Add failing canonical-order coverage**

Extend `test_accepted_steer_continues_same_server_turn`:

```python
    history = runtime._session_service.load_history_items(runtime._config.session_id)
    visible = [
        (item.type, item.text)
        for item in history
        if item.type in {
            HistoryItemType.USER_MESSAGE,
            HistoryItemType.ASSISTANT_MESSAGE,
        }
    ]
    assert visible == [
        (HistoryItemType.USER_MESSAGE, "start"),
        (HistoryItemType.ASSISTANT_MESSAGE, "first answer"),
        (HistoryItemType.USER_MESSAGE, "inspect output"),
        (HistoryItemType.ASSISTANT_MESSAGE, "steer answer"),
    ]
    resumed = runtime._session_service.load_conversation(runtime._config.session_id)
    resumed_visible = [
        (message.role, message.content)
        for message in resumed.messages
        if message.role in {"user", "assistant"}
    ]
    assert resumed_visible[-4:] == [
        ("user", "start"),
        ("assistant", "first answer"),
        ("user", "inspect output"),
        ("assistant", "steer answer"),
    ]
```

Extend `test_terminal_race_commits_leftover_steer_without_another_model_request`:

```python
    visible = [
        (item.type, item.text)
        for item in history
        if item.type in {
            HistoryItemType.USER_MESSAGE,
            HistoryItemType.ASSISTANT_MESSAGE,
        }
    ]
    assert visible == [
        (HistoryItemType.USER_MESSAGE, "start"),
        (HistoryItemType.ASSISTANT_MESSAGE, "first"),
        (HistoryItemType.USER_MESSAGE, "late steer"),
    ]
```

- [ ] **Step 2: Add failing persistence-error coverage**

```python
def test_assistant_history_failure_does_not_commit_pending_steer(
    tmp_path: Path,
) -> None:
    adapter = TerminalQueueingAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    def accept_steer_before_response_returns() -> None:
        assert runtime.steer_active_turn(
            UserMessageInput(
                client_user_message_id="client-steer",
                text="inspect output",
                source="steer",
                target_turn_id="turn-fixed",
            )
        ) is MailboxAcceptance.ACCEPTED

    adapter.before_return = accept_steer_before_response_returns
    append_history_items = runtime._session_service.append_history_items

    def fail_assistant_commit(
        session_id: str,
        items: tuple[HistoryItem, ...],
    ) -> None:
        if any(item.type is HistoryItemType.ASSISTANT_MESSAGE for item in items):
            raise OSError("disk full")
        append_history_items(session_id, items)

    runtime._session_service.append_history_items = fail_assistant_commit

    with pytest.raises(OSError, match="disk full"):
        runtime.handle_user_turn(
            "start",
            turn_id="turn-fixed",
            client_user_message_id="client-start",
        )

    history = runtime._session_service.load_history_items(runtime._config.session_id)
    assert [
        item.text for item in history if item.type is HistoryItemType.USER_MESSAGE
    ] == ["start"]
    assert adapter.call_count == 1
    assert runtime.active_turn_mailbox_id() is None
```

- [ ] **Step 3: Verify current chronology fails**

```bash
uv run pytest -q \
  tests/unit/application/test_agent_runtime.py::test_accepted_steer_continues_same_server_turn \
  tests/unit/application/test_agent_runtime.py::test_terminal_race_commits_leftover_steer_without_another_model_request \
  tests/unit/application/test_agent_runtime.py::test_assistant_history_failure_does_not_commit_pending_steer
```

Expected: FAIL because steering currently receives a lower durable sequence number than the preceding assistant item.

- [ ] **Step 4: Add the `AgentRuntime` facade**

Add `HistoryItem` to the runtime domain imports if needed and add beside `_persist_turn_record`:

```python
def _persist_completed_turn_items(
    self,
    *,
    turn_id: str,
    turn_items: list[TurnItem],
) -> tuple[HistoryItem, ...]:
    return self._event_ledger.persist_completed_turn_items(
        turn_id=turn_id,
        turn_items=turn_items,
    )
```

- [ ] **Step 5: Flush before every mailbox drain**

At the top of `_run_turn_loop`, directly before `_drain_active_turn_input`, add:

```python
runtime._persist_completed_turn_items(
    turn_id=turn_id,
    turn_items=turn_items,
)
```

- [ ] **Step 6: Flush before terminal leftovers**

At the start of `_commit_leftovers_before_finalize`, before the mailbox-ID early return, add:

```python
runtime._persist_completed_turn_items(
    turn_id=turn_id,
    turn_items=turn_items,
)
```

Keeping this before the early return also marks completed items when the turn has no active mailbox.

- [ ] **Step 7: Run focused chronology tests**

Run the command from Step 3 again.

Expected: all three tests PASS; the failure case makes one provider call and commits no steering user message.

- [ ] **Step 8: Run adjacent lifecycle tests**

```bash
uv run pytest -q \
  tests/unit/application/runtime/test_user_message_lifecycle.py \
  tests/unit/application/runtime/test_runtime_event_ledger.py \
  tests/unit/application/test_agent_runtime.py -k "steer or steering or terminal_race or history_failure"
```

Expected: all selected tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py tests/unit/application/test_agent_runtime.py
git commit -m "fix: preserve steering history chronology"
```

### Task 3: Regression Verification

**Files:**
- Verify only; no production changes expected.

- [ ] **Step 1: Run the complete Python unit suite**

```bash
uv run pytest -q tests/unit
```

Expected: all tests PASS.

- [ ] **Step 2: Run repository static checks**

```bash
uv run ruff check .
uv run mypy src/mycli
```

Expected: both commands exit 0.

- [ ] **Step 3: Run Node TUI regression and typecheck**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: TUI tests PASS and TypeScript reports no errors.

- [ ] **Step 4: Inspect task-owned changes**

```bash
git status --short
git log --oneline -5
```

Expected: two focused implementation commits; pre-existing `.codex/config.toml`, shell-plan, training artifact, data, and demo-script changes remain untouched.
