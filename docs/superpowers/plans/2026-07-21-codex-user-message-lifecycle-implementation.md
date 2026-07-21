# Codex User Message Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's persisted backend user queue with Codex-style active-turn steering, backend UserMessage lifecycle events, and transient TUI-owned rejected/follow-up queues.

**Architecture:** Python owns only the active regular turn mailbox and commits every accepted user input through one durable lifecycle service. The Node TUI owns pending steer presentation, rejected steer retry, and Tab follow-up scheduling; committed `item.completed(UserMessage)` events are the only bridge from transient input into transcript state. A one-time read/ack handoff drains legacy persisted queue records without creating new ones.

**Tech Stack:** Python 3.13, dataclasses, thread-safe runtime state, JSON-RPC gateway, TypeScript, Node test runner, pytest, Ruff, mypy, TypeScript compiler.

---

## Execution Preconditions

The worktree already contains unrelated local files and uncommitted queue/transcript fixes. Do not stage `.codex/config.toml`, the existing unified-shell plan, `best_model.pt`, `data/`, or `train_demo.py`.

Before Task 1, preserve the already-tested fixes as separate commits or carry them forward without reverting them:

```text
src/mycli/application/runtime/turn_executor.py
src/mycli/cli/node_tui/gateway.py
src/mycli/services/transcript_projection.py
tests/unit/application/test_agent_runtime.py
tests/unit/cli/node_tui/test_gateway.py
tests/unit/services/test_transcript_projection.py
tui/mycli-shell/src/adapters/runtime-state.ts
tui/mycli-shell/test/runtime-state.test.ts
```

The implementation must satisfy
`docs/superpowers/specs/2026-07-21-codex-user-message-lifecycle-design.md`.
The 2026-07-20 backend-first queue spec is historical context, not the target behavior.

## File Ownership Map

- `src/mycli/domain/runtime/user_input.py`: immutable user-input identity and typed steering errors.
- `src/mycli/application/runtime/user_input_mailbox.py`: thread-safe active-turn mailbox only.
- `src/mycli/application/runtime/user_message_lifecycle.py`: atomic conversation/history/turn-item commit and lifecycle emission.
- `src/mycli/application/runtime/turn_executor.py`: safe-boundary mailbox drain and same-turn continuation.
- `src/mycli/application/runtime/agent_runtime.py`: owns mailbox/lifecycle services and internal notification inbox.
- `src/mycli/application/turn_service.py`: exposes active-turn steering without queue persistence.
- `src/mycli/cli/node_tui/protocol.py`: JSON-RPC structured error data.
- `src/mycli/cli/node_tui/gateway.py`: validates active turns, maps typed errors, forwards item lifecycle, and performs legacy handoff.
- `src/mycli/domain/runtime/gateway_contract.py`: public RPC/event schema.
- `tui/mycli-shell/src/adapters/runtime-state.ts`: committed transcript reduction plus transient local queue reducers.
- `tui/mycli-shell/src/gateway.ts`: steer retry, local follow-up scheduling, interrupt recovery, and migration ack.
- `tui/mycli-shell/src/shell-runtime.ts`: edit-last behavior remains a UI callback, not a backend RPC.
- `src/mycli/application/runtime/session_queue.py`: legacy read/ack migration only, then removable after the compatibility window.

### Task 1: Add User Input Identity And Active-Turn Mailbox

**Files:**
- Create: `src/mycli/domain/runtime/user_input.py`
- Create: `src/mycli/application/runtime/user_input_mailbox.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Test: `tests/unit/domain/runtime/test_user_input.py`
- Test: `tests/unit/application/runtime/test_user_input_mailbox.py`

- [ ] **Step 1: Write failing domain tests**

Add tests proving normalization, stable identity, duplicate acceptance, conflicting duplicate rejection, FIFO drain, mismatch errors, and closed/non-steerable behavior:

```python
def test_mailbox_accepts_duplicate_identity_once() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-1", steerable=True)
    item = UserMessageInput(
        client_user_message_id="client-1",
        text="inspect",
        image_paths=(),
        source="steer",
        target_turn_id="turn-1",
    )

    assert mailbox.accept("turn-1", item) is MailboxAcceptance.ACCEPTED
    assert mailbox.accept("turn-1", item) is MailboxAcceptance.DUPLICATE
    assert mailbox.drain("turn-1") == (item,)


def test_mailbox_reports_actual_turn_on_mismatch() -> None:
    mailbox = ActiveTurnMailbox()
    mailbox.begin("turn-actual", steerable=True)

    with pytest.raises(TurnIdMismatchError) as raised:
        mailbox.accept("turn-stale", user_input("client-1", "inspect", "turn-stale"))

    assert raised.value.actual_turn_id == "turn-actual"
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
uv run pytest tests/unit/domain/runtime/test_user_input.py tests/unit/application/runtime/test_user_input_mailbox.py -q
```

Expected: import failures because `user_input.py` and `user_input_mailbox.py` do not exist.

- [ ] **Step 3: Implement immutable input and typed errors**

Create `user_input.py` with this public shape:

```python
class MailboxAcceptance(StrEnum):
    ACCEPTED = "accepted"
    DUPLICATE = "duplicate"


@dataclass(frozen=True, slots=True)
class UserMessageInput:
    client_user_message_id: str
    text: str
    image_paths: tuple[str, ...] = ()
    source: Literal["submit", "steer"] = "submit"
    target_turn_id: str | None = None

    def __post_init__(self) -> None:
        message_id = self.client_user_message_id.strip()
        text = self.text.strip()
        if not message_id or not text:
            raise ValueError("user message id and text must be non-empty")
        if self.source == "steer" and not self.target_turn_id:
            raise ValueError("steer input requires target_turn_id")
        object.__setattr__(self, "client_user_message_id", message_id)
        object.__setattr__(self, "text", text)
        object.__setattr__(self, "image_paths", tuple(dict.fromkeys(self.image_paths)))


class NoActiveTurnError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class TurnIdMismatchError(RuntimeError):
    expected_turn_id: str
    actual_turn_id: str


@dataclass(frozen=True, slots=True)
class ActiveTurnNotSteerableError(RuntimeError):
    turn_id: str
    turn_kind: str


class UserMessageIdConflictError(RuntimeError):
    pass
```

- [ ] **Step 4: Implement the thread-safe mailbox**

Create `user_input_mailbox.py` with `begin()`, `accept()`, `has_pending()`, `drain()`, and `close_and_drain()`. All state transitions occur under one `threading.Lock`; `close_and_drain()` clears the active identity atomically so later steer requests receive `NoActiveTurnError`.

```python
class ActiveTurnMailbox:
    def __init__(self) -> None:
        self._lock = Lock()
        self._turn_id: str | None = None
        self._turn_kind = "regular"
        self._steerable = False
        self._pending: deque[UserMessageInput] = deque()
        self._accepted: dict[str, UserMessageInput] = {}

    def accept(self, expected_turn_id: str, item: UserMessageInput) -> MailboxAcceptance:
        with self._lock:
            if self._turn_id is None:
                raise NoActiveTurnError("no active turn to steer")
            if self._turn_id != expected_turn_id:
                raise TurnIdMismatchError(expected_turn_id, self._turn_id)
            if not self._steerable:
                raise ActiveTurnNotSteerableError(self._turn_id, self._turn_kind)
            existing = self._accepted.get(item.client_user_message_id)
            if existing is not None:
                if existing != item:
                    raise UserMessageIdConflictError(item.client_user_message_id)
                return MailboxAcceptance.DUPLICATE
            self._accepted[item.client_user_message_id] = item
            self._pending.append(item)
            return MailboxAcceptance.ACCEPTED
```

- [ ] **Step 5: Run focused tests and static checks**

```bash
uv run pytest tests/unit/domain/runtime/test_user_input.py tests/unit/application/runtime/test_user_input_mailbox.py -q
uv run ruff check src/mycli/domain/runtime/user_input.py src/mycli/application/runtime/user_input_mailbox.py tests/unit/domain/runtime/test_user_input.py tests/unit/application/runtime/test_user_input_mailbox.py
```

Expected: all focused tests pass and Ruff reports no errors.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/mycli/domain/runtime/user_input.py src/mycli/domain/runtime/__init__.py src/mycli/application/runtime/user_input_mailbox.py tests/unit/domain/runtime/test_user_input.py tests/unit/application/runtime/test_user_input_mailbox.py
git commit -m "feat: add active turn user input mailbox"
```

### Task 2: Centralize Durable UserMessage Commit And Lifecycle

**Files:**
- Create: `src/mycli/application/runtime/user_message_lifecycle.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/turn_service.py`
- Test: `tests/unit/application/runtime/test_user_message_lifecycle.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing lifecycle tests**

Test exact persistence and event order before integrating the turn loop:

```python
def test_commit_persists_before_user_item_lifecycle(tmp_path: Path) -> None:
    events: list[RuntimeStreamEvent] = []
    conversation = Conversation(session_id="demo")
    turn_items: list[TurnItem] = []
    lifecycle = lifecycle_for_tests(tmp_path)
    item = UserMessageInput("client-1", "inspect", source="submit")

    committed = lifecycle.commit(
        turn_id="turn-1",
        item=item,
        conversation=conversation,
        turn_items=turn_items,
        stream_sink=events.append,
    )

    assert committed.history_id == "turn-1:user:client-1"
    assert [event.kind for event in events] == ["item_started", "item_completed"]
    assert events[1].metadata["item"]["client_user_message_id"] == "client-1"
    assert load_history(tmp_path)[0].metadata["client_user_message_id"] == "client-1"
    assert turn_items[0].metadata["history_committed"] is True
```

Also test that retrying the same ID does not append a second history item or emit duplicate lifecycle events, while a conflicting payload raises `UserMessageIdConflictError`.

- [ ] **Step 2: Run tests and verify RED**

```bash
uv run pytest tests/unit/application/runtime/test_user_message_lifecycle.py -q
```

Expected: import failure for `UserMessageLifecycle`.

- [ ] **Step 3: Implement `UserMessageLifecycle.commit()`**

The class receives `session_id`, `SessionService`, and the existing turn-item append callback. It creates a stable history ID, writes metadata, rolls back the in-memory conversation append if persistence raises, and only then emits lifecycle events.

```python
@dataclass(frozen=True, slots=True)
class CommittedUserMessage:
    history_id: str
    client_user_message_id: str


def commit(
    self,
    *,
    turn_id: str,
    item: UserMessageInput,
    conversation: Conversation,
    turn_items: list[TurnItem],
    stream_sink: Callable[[RuntimeStreamEvent], None] | None,
) -> CommittedUserMessage:
    history_id = f"{turn_id}:user:{item.client_user_message_id}"
    metadata = {
        "client_user_message_id": item.client_user_message_id,
        "source": item.source,
    }
    existing = self._history_item(history_id)
    if existing is not None:
        self._assert_same_message(existing, item)
        return CommittedUserMessage(history_id, item.client_user_message_id)

    message = Message(
        role="user",
        content=item.text,
        blocks=self._user_blocks(item),
    )
    conversation.append(message)
    try:
        self._session_service.append_history_items(
            self._session_id,
            (HistoryItem(
                id=history_id,
                thread_id=self._session_id,
                turn_id=turn_id,
                type=HistoryItemType.USER_MESSAGE,
                text=item.text,
                metadata=metadata,
            ),),
        )
    except Exception:
        conversation.messages.pop()
        raise

    self._append_turn_item(
        turn_id=turn_id,
        turn_items=turn_items,
        item=TurnItem(
            type=TurnItemType.USER_MESSAGE,
            text=item.text,
            metadata={**metadata, "history_committed": True},
        ),
    )
    self._emit_user_item_lifecycle(turn_id, history_id, item, stream_sink)
    return CommittedUserMessage(history_id, item.client_user_message_id)
```

Implement `_history_item()` as an ID lookup over `SessionService.load_history_items()`, `_assert_same_message()` as exact text/source/image comparison, `_user_blocks()` with the existing text and `local_image_block()` builders, and `_emit_user_item_lifecycle()` as ordered `RuntimeStreamEvent(kind="item_started")` then `RuntimeStreamEvent(kind="item_completed")` calls carrying the same item payload.

- [ ] **Step 4: Thread `client_user_message_id` through normal turn submission**

Add the optional keyword to these calls and convert it to `UserMessageInput(source="submit")` before the first model request:

```text
NodeTuiGateway._run_turn_worker
TurnService.handle_user_turn
_call_handle_user_turn
AgentRuntime.handle_user_turn
TurnExecutor.execute_user_turn
```

Replace the initial conversation append plus raw turn item in `TurnExecutor` with a call to `runtime._user_message_lifecycle.commit` using the resolved turn ID, normalized `UserMessageInput`, active conversation, current turn-item list, and stream sink. Keep hook rejection before commit.

- [ ] **Step 5: Run focused application tests**

```bash
uv run pytest tests/unit/application/runtime/test_user_message_lifecycle.py tests/unit/application/test_agent_runtime.py -q
```

Expected: all tests pass; ordinary user history contains one stable lifecycle item.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/mycli/application/runtime/user_message_lifecycle.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/turn_service.py tests/unit/application/runtime/test_user_message_lifecycle.py tests/unit/application/test_agent_runtime.py
git commit -m "refactor: unify durable user message commit"
```

### Task 3: Consume Steering In The Same Server Turn

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/turn_service.py`
- Test: `tests/unit/application/test_agent_runtime.py`
- Test: `tests/unit/application/runtime/test_user_input_mailbox.py`

- [ ] **Step 1: Write failing same-turn tests**

Use a blocking adapter that accepts a steer during its first request and captures the second request:

```python
def test_accepted_steer_continues_same_server_turn(tmp_path: Path) -> None:
    adapter = BlockingThenCaptureAdapter()
    runtime = runtime_with(adapter, tmp_path)
    worker = start_turn(runtime, "start", turn_id="turn-fixed")
    assert adapter.first_request_started.wait(timeout=2)

    accepted = runtime.steer_active_turn(
        UserMessageInput(
            client_user_message_id="client-steer",
            text="inspect output",
            source="steer",
            target_turn_id="turn-fixed",
        )
    )
    adapter.release_first_request.set()
    worker.join(timeout=2)

    assert accepted is MailboxAcceptance.ACCEPTED
    assert adapter.request_count == 2
    assert adapter.second_request_user_messages[-1] == "inspect output"
```

Add a race test where input arrives after the model returns final output but before terminal finalization; it must be committed before `turn.completed`. Add a no-reply test proving leftover accepted input remains durable history.

- [ ] **Step 2: Run tests and verify RED**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py -q -k 'same_server_turn or leftover_accepted'
```

Expected: failure because steering still enters `SessionQueueCoordinator` and creates an end-of-turn record.

- [ ] **Step 3: Register and expose the active mailbox**

`AgentRuntime` owns one `ActiveTurnMailbox` and exposes:

```python
def begin_active_turn_mailbox(self, turn_id: str, *, steerable: bool, turn_kind: str) -> None:
    self._user_input_mailbox.begin(turn_id, steerable=steerable, turn_kind=turn_kind)

def steer_active_turn(self, item: UserMessageInput) -> MailboxAcceptance:
    assert item.target_turn_id is not None
    return self._user_input_mailbox.accept(item.target_turn_id, item)

def drain_active_turn_input(self, turn_id: str) -> tuple[UserMessageInput, ...]:
    return self._user_input_mailbox.drain(turn_id)

def close_active_turn_mailbox(self, turn_id: str) -> tuple[UserMessageInput, ...]:
    return self._user_input_mailbox.close_and_drain(turn_id)
```

`TurnExecutor.execute_user_turn()` uses an idempotent `begin_active_turn_mailbox()` fallback for non-gateway callers after hook validation and before initial commit. Task 4 registers the mailbox in the gateway before starting the worker, eliminating the submit/steer startup race.

- [ ] **Step 4: Replace queue drain with mailbox drain**

Rename `_drain_steering_messages()` to `_drain_active_turn_input()` and commit every drained item through `UserMessageLifecycle`. Remove the direct queue history append, `history_committed` special-case construction, `commit_queue_items()`, and `queued_message_committed` stream event from this path.

At every terminal response path, call one helper before the existing runtime finalizer:

```python
def _commit_leftovers_before_finalize(
    self,
    *,
    conversation: Conversation,
    turn_id: str,
    turn_items: list[TurnItem],
    stream_sink: Callable[[RuntimeStreamEvent], None] | None,
) -> None:
    leftovers = self._runtime.close_active_turn_mailbox(turn_id)
    self._commit_user_inputs(
        leftovers,
        conversation=conversation,
        turn_id=turn_id,
        turn_items=turn_items,
        stream_sink=stream_sink,
    )
```

Invoke this helper before all seven existing `runtime._finalize_response` calls in `turn_executor.py`. Before accepting a normal final answer, check mailbox activity once more; pending input causes another loop iteration with the same `turn_id`.

- [ ] **Step 5: Keep task notifications separate**

Do not route `TaskNotification.to_xml()` through `UserMessageInput`. Keep the existing notification queue temporarily and add an assertion that it emits no `item.completed(UserMessage)` event. Task 7 replaces its storage.

- [ ] **Step 6: Run runtime tests**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py tests/unit/application/test_turn_recovery_and_budget.py tests/unit/application/runtime/test_user_input_mailbox.py -q
```

Expected: same-turn, race, interruption, and leftover tests pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/turn_service.py tests/unit/application/test_agent_runtime.py tests/unit/application/runtime/test_user_input_mailbox.py
git commit -m "feat: consume steering in the active turn"
```

### Task 4: Add Typed Gateway Steering And Item Events

**Files:**
- Modify: `src/mycli/cli/node_tui/protocol.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/domain/runtime/gateway_contract.py`
- Modify: `tests/unit/cli/node_tui/test_protocol.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`
- Modify: `tests/unit/domain/runtime/test_gateway_contract.py`

- [ ] **Step 1: Write failing protocol and gateway tests**

Cover structured error data and exact item event order:

```python
def test_turn_steer_mismatch_returns_actual_turn_id(tmp_path: Path) -> None:
    gateway, service = running_gateway(tmp_path, turn_id="turn-actual")
    response = gateway.handle_request(RpcRequest(
        id="steer",
        method="turn.steer",
        params={
            "client_user_message_id": "client-1",
            "expected_turn_id": "turn-stale",
            "message": "inspect",
        },
    ))

    assert response.error == {
        "code": "turn_id_mismatch",
        "message": "expected active turn turn-stale but found turn-actual",
        "data": {"actual_turn_id": "turn-actual"},
    }
```

Also assert `item.started` occurs before `item.completed`, both precede the next model request event, and the generic `runtime.event` mirror carries the same payload.

- [ ] **Step 2: Run tests and verify RED**

```bash
uv run pytest tests/unit/cli/node_tui/test_protocol.py tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py -q -k 'steer or item_started or error_data'
```

Expected: failures because JSON-RPC errors have no `data` and item streams are not registered.

- [ ] **Step 3: Extend JSON-RPC errors with data**

Change `error_response()` and gateway helpers to accept an optional dictionary:

```python
def error_response(message_id, *, code: str, message: str, data: JsonObject | None = None):
    error: JsonObject = {"code": code, "message": message}
    if data:
        error["data"] = data
    return RpcResponse(id=message_id, error=error)
```

Add gateway codes `no_active_turn`, `turn_id_mismatch`, `active_turn_not_steerable`, `input_too_large`, and `message_id_conflict`.

- [ ] **Step 4: Replace `_handle_turn_steer()` queue mutation**

Construct `UserMessageInput(source="steer")`, call `service.steer_active_turn()`, and map typed exceptions to structured RPC errors. A duplicate is a successful response:

```python
{
    "accepted": True,
    "disposition": "duplicate",
    "client_user_message_id": item.client_user_message_id,
    "turn_id": expected_turn_id,
}
```

Do not create `rejected_steer` or emit `turn.queue.updated`.

In `_handle_turn_submit`, register the regular mailbox while holding the same turn lock and before `thread.start()`. If thread startup fails, close that mailbox before returning the error. Change the `turn.steer` dispatch branch to pass the full `RpcRequest` and return an `RpcResponse`, allowing typed errors with `data` rather than wrapping every result in `result_response()`.

- [ ] **Step 5: Map runtime item lifecycle events**

Map `RuntimeStreamEvent(kind="item_started" | "item_completed")` to direct `item.started` and `item.completed` gateway events. Add both event schemas with required `turn_id` and structured `item` fields.

- [ ] **Step 6: Run gateway and contract suites**

```bash
uv run pytest tests/unit/cli/node_tui/test_protocol.py tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py tests/integration/test_node_tui_gateway.py -q
```

Expected: all protocol, gateway, and integration tests pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/mycli/cli/node_tui/protocol.py src/mycli/cli/node_tui/gateway.py src/mycli/domain/runtime/gateway_contract.py tests/unit/cli/node_tui/test_protocol.py tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py tests/integration/test_node_tui_gateway.py
git commit -m "feat: expose Codex user item lifecycle"
```

### Task 5: Move Queue State Into The Node Reducer

**Files:**
- Modify: `tui/mycli-shell/src/adapters/gateway-client.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/test/gateway-events.test.ts`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Use identity rather than text matching:

```typescript
test("completed user item commits a pending steer exactly once", () => {
	let state = runtimeStateWithPendingSteer(initialRuntimeState(), {
		clientUserMessageId: "client-1",
		message: "inspect",
		attachments: [],
	});
	const payload = {
		turn_id: "turn-1",
		item: {
			id: "turn-1:user:client-1",
			type: "user_message",
			client_user_message_id: "client-1",
			content: "inspect",
			source: "steer",
		},
	};

	state = reduceRuntimeEvent(state, "item.completed", payload);
	state = reduceRuntimeEvent(state, "item.completed", payload);

	assert.equal(state.localPendingSteers.length, 0);
	assert.deepEqual(projectRuntimeState(state).messages.map((item) => item.text), ["inspect"]);
});
```

Add tests for completed events without local pending state, duplicate direct/mirror events, rejected-before-follow-up ordering, edit-last follow-up, session change clearing all transient queues, and task notification suppression.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/runtime-state.test.ts test/gateway-events.test.ts
```

Expected: TypeScript compile/test failure because local queue reducers and item events do not exist.

- [ ] **Step 3: Add local queue identity types**

Replace backend snapshot-owned queue fields with:

```typescript
export type RuntimeLocalUserInput = {
	clientUserMessageId: string;
	message: string;
	attachments: MycliShellLocalImageAttachment[];
};

localPendingSteers: RuntimeLocalUserInput[];
localRejectedSteers: RuntimeLocalUserInput[];
localFollowUps: RuntimeLocalUserInput[];
localSubmittingMessages: RuntimeLocalUserInput[];
```

Keep the projected `MycliShellPendingInput` shape unchanged so the existing component continues rendering the three sections.

- [ ] **Step 4: Add pure local queue reducers**

Export functions for add pending, reject pending, queue follow-up, pop last follow-up, restore pending after interrupt, and select the next rejected/follow-up input. Every function deduplicates by `clientUserMessageId` and preserves FIFO except edit-last.

- [ ] **Step 5: Reduce `item.completed(UserMessage)`**

On completed lifecycle, remove the matching pending steer or ordinary submitting message and append a `RuntimeTranscriptItem` using backend item ID. Ignore `item.started` for transcript insertion, but retain enough state for diagnostics. Delete the temporary `queued_message_committed` reducer after compatibility tests are migrated.

- [ ] **Step 6: Carry JSON-RPC error data in `GatewayRequestError`**

Add `readonly data: Record<string, unknown>` and parse `error.data` in `GatewayClient`, enabling mismatch retry in Task 6.

- [ ] **Step 7: Run Node tests and typecheck**

```bash
npm test
npm run typecheck
```

Run from `tui/mycli-shell`. Expected: all Node tests pass and `tsc --noEmit` exits zero.

- [ ] **Step 8: Commit Task 5**

```bash
git add tui/mycli-shell/src/adapters/gateway-client.ts tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/src/model.ts tui/mycli-shell/test/gateway-events.test.ts tui/mycli-shell/test/runtime-state.test.ts
git commit -m "refactor: project local Codex input queues"
```

### Task 6: Implement TUI Steer Retry, Follow-Up Scheduling, And Interrupt Recovery

**Files:**
- Modify: `tui/mycli-shell/src/gateway.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/test/shell-runtime.test.ts`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`
- Modify: `tui/mycli-shell/test/support/scripted-client.ts`

- [ ] **Step 1: Write failing behavior tests**

Cover the full client state machine:

```typescript
test("turn mismatch retries once and preserves message identity", async () => {
	const client = scriptedGateway()
		.reject("turn.steer", "turn_id_mismatch", { actual_turn_id: "turn-2" })
		.resolve("turn.steer", { accepted: true, disposition: "accepted" });

	await client.submitWhileRunning("inspect");

	assert.deepEqual(client.requests("turn.steer").map((request) => ({
		id: request.params.client_user_message_id,
		turn: request.params.expected_turn_id,
	})), [
		{ id: client.requests("turn.steer")[0]!.params.client_user_message_id, turn: "turn-1" },
		{ id: client.requests("turn.steer")[0]!.params.client_user_message_id, turn: "turn-2" },
	]);
});
```

Add tests for no-active/non-steerable rejection, rejected priority, Tab follow-up not issuing an RPC while running, one-at-a-time terminal dispatch, edit-last local restore, and interrupt resubmission without duplicate committed messages.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/shell-runtime.test.ts test/runtime-state.test.ts
```

Expected: failures because follow-up still calls `turn.follow_up` and mismatch errors are not retried.

- [ ] **Step 3: Make Enter steering optimistic only in pending preview**

Generate `clientUserMessageId` before RPC, add it to local pending state, and call `turn.steer`. Do not append a transcript user message. On `turn_id_mismatch`, retry once with `error.data.actual_turn_id`; on `no_active_turn` or `active_turn_not_steerable`, move the same item to local rejected state.

- [ ] **Step 4: Make ordinary submit wait for backend lifecycle**

Remove `runtimeStateWithUserMessage()` from `submitTurn()`. Pass `client_user_message_id` in `turn.submit`, retain a submitting identity until `item.completed`, and let the reducer append the committed transcript item. A rejected submit removes only the submitting state and renders the structured error.

- [ ] **Step 5: Keep Tab follow-up entirely local**

`submitFollowUp()` calls `runtimeStateWithLocalFollowUp()` and never sends `turn.follow_up`. `popLastQueuedFollowUp()` becomes a pure local state operation and returns text plus attachments to `shell-runtime.ts`.

- [ ] **Step 6: Dispatch one local input after terminal events**

After `turn.completed`, `turn.failed`, or `turn.interrupted`, mark local dispatch eligible but do not submit while the gateway worker still owns the active-turn lock. When the following `status.changed { turn_running: false }` arrives, schedule one microtask that selects rejected FIFO first, then follow-up FIFO, and calls normal `submitTurn()` with the existing client identity. Guard with `backendTurnBusy` and one `localDispatchScheduled` flag so direct and mirrored events cannot submit twice.

- [ ] **Step 7: Reconcile interruption**

When an interrupt completes, leave already committed messages alone. Move local pending items that did not receive completed lifecycle into rejected FIFO and submit them before ordinary follow-up. Preserve attachments and combine only when the existing UI explicitly requests merged resubmission.

- [ ] **Step 8: Remove backend queue calls from scripted client tests**

Update scripted actions so Tab and edit-last mutate local state. Retain `turn.steer` for Enter and add scripted structured errors with data.

- [ ] **Step 9: Run complete Node verification**

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all Node tests pass.

- [ ] **Step 10: Commit Task 6**

```bash
git add tui/mycli-shell/src/gateway.ts tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/test/shell-runtime.test.ts tui/mycli-shell/test/runtime-state.test.ts tui/mycli-shell/test/support/scripted-client.ts
git commit -m "feat: route Codex style transient input queues"
```

### Task 7: Migrate Legacy Queues And Separate Task Notifications

**Files:**
- Create: `src/mycli/application/runtime/runtime_notification_inbox.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/runtime/session_queue.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/domain/runtime/gateway_contract.py`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Test: `tests/unit/application/runtime/test_runtime_notification_inbox.py`
- Test: `tests/unit/cli/node_tui/test_gateway.py`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`

- [ ] **Step 1: Write failing migration and notification tests**

Python tests must prove:

```python
def test_legacy_queue_handoff_is_repeated_until_ack(tmp_path: Path) -> None:
    service = service_with_legacy_queue(tmp_path, rejected=("retry",), follow_up=("later",))
    gateway = NodeTuiGateway(service=service)

    first = gateway.bootstrap_payload()
    second = gateway.bootstrap_payload()
    assert first["legacy_user_queue_migration"] == second["legacy_user_queue_migration"]

    gateway.ack_legacy_queue_migration(first["legacy_user_queue_migration"]["token"])
    assert "legacy_user_queue_migration" not in gateway.bootstrap_payload()
```

Also prove task notifications reach the next model boundary but create no UserMessage history/lifecycle and no visible TUI queue item. Node tests prove queue IDs import once and ack only after local state accepts them.

- [ ] **Step 2: Run tests and verify RED**

```bash
uv run pytest tests/unit/application/runtime/test_runtime_notification_inbox.py tests/unit/cli/node_tui/test_gateway.py -q -k 'legacy_queue_handoff or task_notification_inbox'
cd tui/mycli-shell && node --import ./node_modules/tsx/dist/esm/index.mjs --test test/runtime-state.test.ts --test-name-pattern='legacy queue migration'
```

Expected: missing inbox and migration payload failures.

- [ ] **Step 3: Implement a non-user runtime notification inbox**

Create a lock-protected FIFO containing `TaskNotification` or serialized runtime notification records. `queue_task_notification()` writes this inbox. `TurnExecutor` drains it at the same safe boundary as user mailbox input, appends it only to model conversation with internal metadata, and emits no UserMessage item events.

- [ ] **Step 4: Expose read/ack legacy migration**

Keep `SessionQueueCoordinator` read-only for legacy state. Bootstrap returns:

```text
legacy_user_queue_migration {
  token
  records[] { queue_id, kind, text, local_images, client_user_message_id }
}
```

Filter records already represented by history `queue_id`. Add RPC `turn.queue.migration.ack`; matching ack clears exactly the exported legacy IDs. A stale token returns `queue_conflict` without clearing.

- [ ] **Step 5: Import migration records into TUI local state**

Map legacy pending/rejected steer to local rejected FIFO and follow-up to local follow-up FIFO. Use queue ID as the migration dedupe identity when no client user message ID exists. Send ack only after state update succeeds.

- [ ] **Step 6: Run migration, runtime, and Node suites**

```bash
uv run pytest tests/unit/application/runtime/test_runtime_notification_inbox.py tests/unit/application/test_agent_runtime.py tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py -q
cd tui/mycli-shell && npm test && npm run typecheck
```

Expected: all focused suites pass.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/mycli/application/runtime/runtime_notification_inbox.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/session_queue.py src/mycli/cli/node_tui/gateway.py src/mycli/domain/runtime/gateway_contract.py tui/mycli-shell/src/gateway.ts tui/mycli-shell/src/adapters/runtime-state.ts tests/unit/application/runtime/test_runtime_notification_inbox.py tests/unit/cli/node_tui/test_gateway.py tui/mycli-shell/test/runtime-state.test.ts
git commit -m "feat: migrate legacy queues to transient TUI state"
```

### Task 8: Retire Backend User Queue Scheduling And Compatibility Events

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/domain/runtime/gateway_contract.py`
- Modify: `src/mycli/domain/runtime/message_queue.py`
- Modify: `src/mycli/application/runtime/session_queue.py`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Modify: `tests/unit/application/runtime/test_session_queue.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`
- Modify: `tests/integration/test_node_tui_gateway.py`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`

- [ ] **Step 1: Add source-absence tests before deletion**

Add assertions that production gateway/TUI source no longer references:

```text
_queue_scheduler_loop
_schedule_next_queued_turn
turn.follow_up
turn.queue.pop
turn.queue.clear
turn.queue.updated
queued_message_committed
queue_follow_up_input
next_queued_turn
mark_queued_turn_started
```

Keep `turn.queue.migration.ack` and legacy migration readers until the compatibility window ends.

- [ ] **Step 2: Run absence tests and verify RED**

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q -k 'retired_user_queue'
cd tui/mycli-shell && node --import ./node_modules/tsx/dist/esm/index.mjs --test test/runtime-state.test.ts --test-name-pattern='retired backend queue'
```

Expected: failures listing existing scheduler and RPC symbols.

- [ ] **Step 3: Remove scheduler ownership**

Delete gateway queue listener/scheduler thread, queue status fields, and auto-start worker path. Remove user queue methods from `TurnService` and `AgentRuntime`. Retain only legacy migration read/ack adapters and the separate runtime notification inbox.

- [ ] **Step 4: Remove obsolete RPC and event contracts**

Delete `turn.follow_up`, `turn.queue.pop`, `turn.queue.clear`, and `turn.queue.updated` from supported methods/events and schemas. Delete `QueueDisposition` paths used only by new writes. Keep legacy data dataclasses only where migration parsing requires them.

- [ ] **Step 5: Remove Node compatibility reducers**

Delete backend queue revision fields, `applyQueuePayload()`, bootstrap/status queue projections, and `queued_message_committed`. Pending input projection must derive only from local transient arrays.

- [ ] **Step 6: Update or delete superseded tests**

Delete tests whose sole expectation is backend persisted queue scheduling. Preserve migration parsing/ack tests, active mailbox tests, local TUI queue tests, and transcript replay tests.

- [ ] **Step 7: Run cross-layer focused suites**

```bash
uv run pytest tests/unit/application tests/unit/cli/node_tui tests/unit/domain/runtime tests/integration/test_node_tui_gateway.py -q
cd tui/mycli-shell && npm test && npm run typecheck
```

Expected: all focused Python and Node suites pass.

- [ ] **Step 8: Commit Task 8**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py src/mycli/cli/node_tui/gateway.py src/mycli/domain/runtime/gateway_contract.py src/mycli/domain/runtime/message_queue.py src/mycli/application/runtime/session_queue.py tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/src/gateway.ts tests/unit/application/runtime/test_session_queue.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py tui/mycli-shell/test/runtime-state.test.ts
git commit -m "refactor: retire backend user queue scheduling"
```

### Task 9: Verify End-To-End Semantics And Update Documentation

**Files:**
- Modify: `tests/integration/test_node_tui_gateway.py`
- Modify: `tui/mycli-shell/test/gateway-replay.test.ts`
- Modify: `tui/mycli-shell/test/shell-runtime.test.ts`
- Modify: `docs/superpowers/specs/README.md`
- Modify: `docs/superpowers/specs/2026-07-20-codex-style-steering-queue-semantic-alignment-design.md`

- [ ] **Step 1: Add final scenario tests**

Cover these exact observable scenarios:

```text
111 running -> Enter qqq -> qqq commits in same turn -> continuation uses qqq
111 terminal race -> qqq rejected locally -> qqq starts one ordinary next turn
accepted qqq with no assistant reply -> qqq exists after resume
Tab follow-up -> no backend RPC while running -> one next turn after terminal
process restart -> unaccepted local queue absent
legacy persisted queue -> imported once -> acked -> absent on second bootstrap
interrupt -> committed inputs stay -> unconfirmed inputs resubmit once
DeepSeek multi-tool response -> mailbox inputs remain FIFO and commit at the next safe boundary
```

Assert live and replay transcript user item IDs, order, text, and attachments are equal.

- [ ] **Step 2: Mark the old spec as superseded**

Add a top-level notice to the 2026-07-20 design linking the 2026-07-21 design. Do not rewrite its historical content. Ensure the specs README lists the 2026-07-21 document first.

- [ ] **Step 3: Run full Python verification**

```bash
uv run pytest -q
uv run ruff check src tests
uv run mypy src
```

Expected: the full suite passes with only the repository's documented skips; Ruff and mypy exit zero.

- [ ] **Step 4: Run full Node verification**

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all Node tests pass and TypeScript reports no errors.

- [ ] **Step 5: Inspect protocol and persistence artifacts**

Run:

```bash
rg -n 'turn\.follow_up|turn\.queue\.updated|queued_message_committed|_schedule_next_queued_turn' src/mycli tui/mycli-shell/src
rg -n 'pending_steers|rejected_steers|follow_ups' src/mycli tui/mycli-shell/src
```

Expected: the first command has no production matches. The second command matches only TUI-local state, legacy migration readers, and runtime notification code explicitly allowed by the design.

- [ ] **Step 6: Review the final diff for unrelated files**

```bash
git status --short
git diff --check
git diff --stat
```

Expected: no whitespace errors; unrelated training artifacts and user-owned config/plan changes remain unstaged and unchanged.

- [ ] **Step 7: Commit Task 9**

```bash
git add tests/integration/test_node_tui_gateway.py tui/mycli-shell/test/gateway-replay.test.ts tui/mycli-shell/test/shell-runtime.test.ts docs/superpowers/specs/README.md docs/superpowers/specs/2026-07-20-codex-style-steering-queue-semantic-alignment-design.md
git commit -m "test: verify Codex user message lifecycle"
```

## Completion Gate

Do not declare the migration complete until all of the following are true:

- A running turn consumes accepted Enter steering without creating a second server turn.
- Every committed user message has one stable `client_user_message_id` across live events and replay.
- Pending/rejected/follow-up UI state is transient and absent after process restart.
- No production backend path persists or schedules user queue records.
- Legacy queue handoff is retry-safe and acknowledged before deletion.
- Internal task notifications and `<turn_aborted>` never render as visible user messages.
- Full Python, Node, Ruff, mypy, and TypeScript verification is fresh and green.
