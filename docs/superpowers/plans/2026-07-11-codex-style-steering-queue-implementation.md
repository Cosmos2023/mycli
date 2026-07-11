# Codex-Style Steering Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mycli preserve, edit, and render steering and follow-up queues with Codex-style semantics and message previews.

**Architecture:** Keep `AgentRuntime`'s existing steering and follow-up queues as the source of truth. Add one typed pop-last-follow-up operation through `TurnService` and the Node TUI gateway, project typed queue items into a dedicated TUI pending-input model, and render that model through a Codex-style preview component above the composer. Queue compatibility APIs remain available, while the TUI stops using clear-all for editing or interrupt.

**Tech Stack:** Python 3.13, dataclasses, JSON-RPC, pytest, TypeScript 5.9, Node test runner, custom retained-mode TUI components.

---

## File Map

- Modify `src/mycli/application/runtime/agent_runtime.py`: pop only the newest follow-up while preserving steering and earlier follow-ups.
- Modify `src/mycli/application/turn_service.py`: expose the typed pop operation to gateway callers.
- Modify `src/mycli/domain/runtime/gateway_contract.py`: advertise `turn.queue.pop` without removing `turn.queue.clear`.
- Modify `src/mycli/cli/node_tui/gateway.py`: implement `turn.queue.pop`, emit the repaired queue snapshot, and leave interrupt independent of queue mutation.
- Modify `tests/unit/application/test_agent_runtime.py`: cover LIFO editing, metadata preservation, and steering isolation.
- Modify `tests/integration/test_turn_service.py`: cover the service proxy.
- Modify `tests/unit/cli/node_tui/test_gateway.py`: cover the new RPC response and queue update event.
- Modify `tui/mycli-shell/src/model.ts`: add projected pending steering and follow-up preview types.
- Modify `tui/mycli-shell/src/adapters/runtime-state.ts`: retain typed visible queue items and project them into shell state.
- Create `tui/mycli-shell/src/components/pending-input-preview.ts`: render Codex-style queue sections with bounded visual lines.
- Modify `tui/mycli-shell/src/components/footer.ts`: remove duplicate queue counts.
- Modify `tui/mycli-shell/src/shell-runtime.ts`: mount the new pending-input component and update queue-edit wording.
- Modify `tui/mycli-shell/src/gateway.ts`: call `turn.queue.pop`, restore only the popped follow-up, and stop clearing queues before interrupt.
- Modify `tui/mycli-shell/src/index.ts`: export the new component and queue preview types.
- Modify `tui/mycli-shell/test/runtime-state.test.ts`: cover typed projection and hidden task notifications.
- Modify `tui/mycli-shell/test/shell-app.test.ts`: cover rendering, width limits, edit-last behavior, images, and interrupt preservation.
- Modify `tests/integration/test_node_tui_gateway.py`: verify queue pop and interrupt behavior through a real runtime/gateway boundary.

### Task 0: Verify The Existing Queue Baseline

**Files:**
- Verify only; no source changes.

- [ ] **Step 1: Run the focused Python queue baseline**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py \
  tests/integration/test_turn_service.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/integration/test_node_tui_gateway.py -q
```

Expected: PASS.

- [ ] **Step 2: Run the focused TypeScript queue baseline**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='queue|queued|steer|follow-up|interrupt'
npm --prefix tui/mycli-shell run typecheck
```

Expected: PASS.

- [ ] **Step 3: Confirm the worktree is clean**

```bash
git status --short
```

Expected: empty output.

### Task 1: Pop Only The Newest Follow-Up In `AgentRuntime`

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py:968-994`
- Modify: `src/mycli/application/turn_service.py:270-290`
- Test: `tests/unit/application/test_agent_runtime.py`
- Test: `tests/integration/test_turn_service.py`

- [ ] **Step 1: Write the failing runtime tests**

Add to `tests/unit/application/test_agent_runtime.py`:

```python
def test_agent_runtime_pops_latest_follow_up_without_touching_steering(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=SteeringNotificationCaptureAdapter(),
    )
    runtime.queue_steering_message("inspect current output")
    runtime.queue_follow_up_message("first follow-up")
    runtime.queue_follow_up_message(
        "second [image #1]",
        image_paths=("/tmp/second.png",),
        client_turn_id="follow-up-2",
    )

    popped = runtime.pop_last_follow_up_input()

    assert popped is not None
    assert popped.kind == "follow_up"
    assert popped.text == "second [image #1]"
    assert popped.image_paths == ("/tmp/second.png",)
    assert popped.client_turn_id == "follow-up-2"
    assert runtime.queued_messages() == (
        ("inspect current output",),
        ("first follow-up",),
    )


def test_agent_runtime_pop_latest_follow_up_is_idempotent_when_empty(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=SteeringNotificationCaptureAdapter(),
    )
    runtime.queue_steering_message("keep steering")

    assert runtime.pop_last_follow_up_input() is None
    assert runtime.queued_messages() == (("keep steering",), ())
```

- [ ] **Step 2: Write the failing `TurnService` proxy test**

Add to `tests/integration/test_turn_service.py`:

```python
def test_turn_service_pops_only_latest_follow_up(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=FakeModel(),
        tool_registry=FakeToolRegistry(),
    )
    service.queue_steering_message("keep steering")
    service.queue_follow_up_message("first")
    service.queue_follow_up_message("second")

    popped = service.pop_last_follow_up_input()

    assert popped is not None
    assert popped.text == "second"
    assert service.queued_messages() == (("keep steering",), ("first",))
```

- [ ] **Step 3: Run the tests to verify RED**

```bash
uv run pytest \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_pops_latest_follow_up_without_touching_steering \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_pop_latest_follow_up_is_idempotent_when_empty \
  tests/integration/test_turn_service.py::test_turn_service_pops_only_latest_follow_up -q
```

Expected: FAIL because `pop_last_follow_up_input()` does not exist.

- [ ] **Step 4: Implement the runtime operation**

Add beside `pop_next_follow_up_message()` in `AgentRuntime`:

```python
def pop_last_follow_up_input(self) -> QueuedTurnInput | None:
    with self._message_queue_lock:
        if not self._follow_up_messages:
            return None
        return self._follow_up_messages.pop()
```

This deliberately uses `pop()` rather than `pop(0)`: normal delivery remains FIFO, while edit-last is LIFO.

- [ ] **Step 5: Implement the service proxy**

Import `QueuedTurnInput` from `mycli.domain.runtime` if it is not already available, then add:

```python
def pop_last_follow_up_input(self) -> QueuedTurnInput | None:
    pop = getattr(self._runtime, "pop_last_follow_up_input", None)
    if not callable(pop):
        return None
    return cast(QueuedTurnInput | None, pop())
```

- [ ] **Step 6: Verify and commit**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py \
  tests/integration/test_turn_service.py -q
uv run ruff check src/mycli/application/runtime/agent_runtime.py \
  src/mycli/application/turn_service.py \
  tests/unit/application/test_agent_runtime.py \
  tests/integration/test_turn_service.py
uv run mypy src/mycli/application/runtime/agent_runtime.py \
  src/mycli/application/turn_service.py
git add src/mycli/application/runtime/agent_runtime.py \
  src/mycli/application/turn_service.py \
  tests/unit/application/test_agent_runtime.py \
  tests/integration/test_turn_service.py
git commit -m "Add edit-last follow-up queue operation"
```

Expected: tests, Ruff, and mypy pass.

### Task 2: Expose `turn.queue.pop` Through The Gateway

**Files:**
- Modify: `src/mycli/domain/runtime/gateway_contract.py:6-34`
- Modify: `src/mycli/cli/node_tui/gateway.py:150-190,290-310,616-655`
- Test: `tests/unit/cli/node_tui/test_gateway.py`

- [ ] **Step 1: Write the failing gateway test**

Import `QueuedTurnInput` from `mycli.domain.runtime`, then add this focused fake beside `FakeTurnService`:

```python
class QueuePopTurnService(FakeTurnService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.steering_inputs: list[QueuedTurnInput] = []
        self.follow_up_inputs: list[QueuedTurnInput] = []

    def queue_steering_message(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str | None = None,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        self.steering_inputs.append(
            QueuedTurnInput(
                kind="steering",
                text=message,
                image_paths=image_paths,
                client_turn_id=client_turn_id,
            )
        )
        return self.queued_messages()

    def queue_follow_up_message(
        self,
        message: str,
        *,
        image_paths: tuple[str, ...] = (),
        client_turn_id: str | None = None,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        self.follow_up_inputs.append(
            QueuedTurnInput(
                kind="follow_up",
                text=message,
                image_paths=image_paths,
                client_turn_id=client_turn_id,
            )
        )
        return self.queued_messages()

    def queued_messages(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return (
            tuple(item.text for item in self.steering_inputs),
            tuple(item.text for item in self.follow_up_inputs),
        )

    def queued_input_items(
        self,
    ) -> tuple[tuple[QueuedTurnInput, ...], tuple[QueuedTurnInput, ...]]:
        return tuple(self.steering_inputs), tuple(self.follow_up_inputs)

    def pop_last_follow_up_input(self) -> QueuedTurnInput | None:
        if not self.follow_up_inputs:
            return None
        return self.follow_up_inputs.pop()
```

Add the RPC test:

```python
def test_gateway_queue_pop_returns_latest_follow_up_and_remaining_snapshot(
    tmp_path: Path,
) -> None:
    service = QueuePopTurnService(tmp_path)
    service.queue_steering_message(
        "keep steering [image #1]",
        image_paths=("/tmp/steer.png",),
    )
    service.queue_follow_up_message("first")
    service.queue_follow_up_message(
        "second [image #1]",
        image_paths=("/tmp/second.png",),
        client_turn_id="follow-up-2",
    )
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(
        service=service,
        emit=lambda method, params: events.append((method, params)),
    )

    response = gateway.handle_request(
        RpcRequest(id="pop-1", method="turn.queue.pop", params={})
    )

    assert response.result is not None
    assert response.result["item"] == {
        "kind": "follow_up",
        "message": "second [image #1]",
        "text": "second [image #1]",
        "source": "user",
        "local_images": [
            {"path": "/tmp/second.png", "placeholder": "[image #1]"}
        ],
        "client_turn_id": "follow-up-2",
    }
    assert response.result["steering"] == ["keep steering [image #1]"]
    assert response.result["follow_up"] == ["first"]
    assert response.result["has_pending_input"] is True
    assert any(
        method == "turn.queue.updated"
        and params["steering"] == ["keep steering [image #1]"]
        and params["follow_up"] == ["first"]
        for method, params in events
    )

    empty = gateway.handle_request(
        RpcRequest(id="pop-2", method="turn.queue.pop", params={})
    )
    assert empty.result is not None
    assert empty.result["item"] is not None
    assert empty.result["item"]["message"] == "first"

    empty = gateway.handle_request(
        RpcRequest(id="pop-3", method="turn.queue.pop", params={})
    )
    assert empty.result is not None
    assert empty.result["item"] is None
    assert empty.result["steering"] == ["keep steering [image #1]"]
    assert empty.result["follow_up"] == []

    status = gateway._status_payload()
    assert status["queued_steering_items"] == [
        {
            "kind": "steering",
            "message": "keep steering [image #1]",
            "text": "keep steering [image #1]",
            "source": "user",
            "local_images": [
                {"path": "/tmp/steer.png", "placeholder": "[image #1]"}
            ],
        }
    ]
    assert status["queued_follow_up_items"] == []
```

- [ ] **Step 2: Verify RED**

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py \
  -k 'queue_pop' -q
```

Expected: FAIL with method-not-found or unsupported RPC assertions.

- [ ] **Step 3: Advertise the RPC method**

Add `"turn.queue.pop"` to `SUPPORTED_GATEWAY_RPC_METHODS` in `gateway_contract.py`. Keep `"turn.queue.clear"` unchanged.

- [ ] **Step 4: Extend the gateway service protocol**

Add beside `clear_queued_input_items()`:

```python
def pop_last_follow_up_input(self) -> object | None: ...
```

- [ ] **Step 5: Route and implement the request**

Add to `handle_request()` before `turn.queue.clear`:

```python
if request.method == "turn.queue.pop":
    return result_response(request.id, self._handle_turn_queue_pop())
```

Add:

```python
def _handle_turn_queue_pop(self) -> dict[str, object]:
    pop = getattr(self.service, "pop_last_follow_up_input", None)
    item = pop() if callable(pop) else None
    payload = self._queue_payload()
    serialized = _queued_items_payload((item,)) if item is not None else []
    payload["item"] = serialized[0] if serialized else None
    self._emit_queue_update(payload)
    return payload
```

The queue snapshot must be read after the pop so the response and emitted event agree.

In `_status_payload()`, retain the legacy `queued_steering` and `queued_follow_up`
fields and add typed bootstrap fields from `queue_payload`:

```python
if "steering_items" in queue_payload or "follow_up_items" in queue_payload:
    payload["queued_steering_items"] = queue_payload.get("steering_items", [])
    payload["queued_follow_up_items"] = queue_payload.get("follow_up_items", [])
```

This keeps image metadata and client turn IDs available after bootstrap or a full
status refresh instead of only after `turn.queue.updated`.

- [ ] **Step 6: Verify and commit**

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py -q
uv run ruff check src/mycli/domain/runtime/gateway_contract.py \
  src/mycli/cli/node_tui/gateway.py \
  tests/unit/cli/node_tui/test_gateway.py
uv run mypy src/mycli/domain/runtime/gateway_contract.py \
  src/mycli/cli/node_tui/gateway.py
git add src/mycli/domain/runtime/gateway_contract.py \
  src/mycli/cli/node_tui/gateway.py \
  tests/unit/cli/node_tui/test_gateway.py
git commit -m "Expose follow-up queue pop through gateway"
```

### Task 3: Project Typed Queue Messages Into TUI State

**Files:**
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`

- [ ] **Step 1: Write failing projection tests**

Add to `runtime-state.test.ts`:

```typescript
test("runtime adapter projects Codex-style pending steering and follow-ups", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		steering_items: [
			{ message: "inspect current output", local_images: [{ path: "/tmp/a.png" }] },
		],
		follow_up_items: [{ message: "summarize afterward" }],
		steering: ["inspect current output"],
		follow_up: ["summarize afterward"],
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.pendingInput, {
		steering: [{ text: "inspect current output", hasImages: true }],
		followUps: [{ text: "summarize afterward", hasImages: false }],
	});
});
```

Add a second test where steering contains only `<task-notification>...</task-notification>` and follow-up is empty. Assert `shell.pendingInput === undefined`, visible queue counts are zero, and `hasPendingInput` is false in projected presentation state.

- [ ] **Step 2: Verify RED**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='Codex-style pending steering|task notification.*pending'
```

Expected: FAIL because `pendingInput` and typed preview items do not exist.

- [ ] **Step 3: Add the public TUI model**

Add to `model.ts`:

```typescript
export type MycliShellQueuedInputPreview = {
	text: string;
	hasImages: boolean;
};

export type MycliShellPendingInput = {
	steering: MycliShellQueuedInputPreview[];
	followUps: MycliShellQueuedInputPreview[];
};
```

Add to `MycliShellState`:

```typescript
pendingInput?: MycliShellPendingInput;
```

Keep legacy footer queue fields for compatibility during this task; Task 4 removes their visual use.

- [ ] **Step 4: Add typed runtime preview items**

In `runtime-state.ts`, add:

```typescript
export type RuntimeQueuedInputPreview = {
	message: string;
	hasImages: boolean;
};
```

Change `queuedSteeringInputs` and `queuedFollowUpInputs` to `RuntimeQueuedInputPreview[]`. Add these parsers:

```typescript
function queuedInputPreviews(items: unknown, fallback: unknown): RuntimeQueuedInputPreview[] {
	const raw = Array.isArray(items) && items.length > 0 ? items : stringArrayValue(fallback);
	return raw
		.map((item): RuntimeQueuedInputPreview | null => {
			if (typeof item === "string") {
				return item.trim() ? { message: item.trim(), hasImages: false } : null;
			}
			const record = recordValue(item);
			const message = stringValue(record.message) ?? stringValue(record.text);
			if (!message?.trim()) return null;
			return {
				message: message.trim(),
				hasImages: Array.isArray(record.local_images) && record.local_images.length > 0,
			};
		})
		.filter((item): item is RuntimeQueuedInputPreview => item !== null)
		.filter((item) => !isInternalTaskNotification(item.message));
}
```

In `status.changed`, parse the typed bootstrap fields first:

```typescript
const queuedSteering = queuedInputPreviews(
	params.queued_steering_items,
	params.queued_steering,
);
const queuedFollowUp = queuedInputPreviews(
	params.queued_follow_up_items,
	params.queued_follow_up,
);
```

In `turn.queue.updated`, use `queuedInputPreviews(params.steering_items,
params.steering)` and `queuedInputPreviews(params.follow_up_items,
params.follow_up)`. Change `runtimeStateWithMessageQueues()` to accept
`RuntimeQueuedInputPreview[]`, filter internal task notifications by `message`,
and derive `queuedInputs` from `item.message` for compatibility.

- [ ] **Step 5: Project the pending input model**

In `projectRuntimeState()`:

```typescript
const steering = state.queuedSteeringInputs.map((item) => ({
	text: item.message,
	hasImages: item.hasImages,
}));
const followUps = state.queuedFollowUpInputs.map((item) => ({
	text: item.message,
	hasImages: item.hasImages,
}));
```

Return:

```typescript
pendingInput:
	steering.length > 0 || followUps.length > 0
		? { steering, followUps }
		: undefined,
```

Derive visible counts and `hasPendingInput` from these filtered arrays, not from the raw backend activity flag.

- [ ] **Step 6: Preserve local image previews in `gateway.ts`**

Replace count-only `queueMessages()` calls used by `syncQueuedInputs()` with:

```typescript
function queuePreviews(items: QueuedTurnInput[]): RuntimeQueuedInputPreview[] {
	return items.map((item) => ({
		message: item.message,
		hasImages: Boolean(item.attachments?.localImages?.length),
	}));
}
```

Import `RuntimeQueuedInputPreview` and pass the preview arrays to `runtimeStateWithMessageQueues()` so local fallback state matches gateway event state.

- [ ] **Step 7: Verify and commit**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='queue|queued|steer|follow-up|task notification'
npm --prefix tui/mycli-shell run typecheck
git add tui/mycli-shell/src/model.ts \
  tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/src/gateway.ts \
  tui/mycli-shell/test/runtime-state.test.ts
git commit -m "Project typed queue previews into TUI state"
```

### Task 4: Render The Codex-Style Pending Input Preview

**Files:**
- Create: `tui/mycli-shell/src/components/pending-input-preview.ts`
- Modify: `tui/mycli-shell/src/components/footer.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/index.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing component tests**

Add direct rendering tests for:

```typescript
const rendered = new PendingInputPreviewComponent({
	steering: [{ text: "inspect current output", hasImages: false }],
	followUps: [{ text: "summarize afterward", hasImages: true }],
});
const output = stripAnsi(rendered.render(80).join("\n"));

assert.match(output, /• Messages to be submitted after next tool call/);
assert.match(output, /press esc to interrupt and send immediately/);
assert.match(output, /↳ inspect current output/);
assert.match(output, /• Queued follow-up inputs/);
assert.match(output, /↳ summarize afterward/);
assert.match(output, /alt\+up edit last queued message/);
```

Add tests for steering-only, follow-up-only, multiline text, CJK text, a message exceeding three visual lines, and width 48. Assert every rendered line has `visibleWidth(line) <= width` and overflow contains `…`.

Update the existing footer test to assert queue counts are absent even when legacy count fields are set.

- [ ] **Step 2: Verify RED**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='pending input preview|footer.*queue'
```

Expected: FAIL because the component is missing and footer still renders queue counts.

- [ ] **Step 3: Implement the component**

Create `pending-input-preview.ts` with a `Component` that renders sections from `MycliShellPendingInput`. Use `Text.render(width)` to obtain visual lines. A message uses at most three lines total; when content overflows, the third line is the omission marker.

Core rendering shape:

```typescript
const PREVIEW_LINE_LIMIT = 3;

private messageLines(text: string, width: number): string[] {
	const sanitized = text
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, " ")
		.replace(/\t/g, "   ")
		.trim();
	const wrapped = new Text(sanitized, 4, 0).render(width);
	const visible =
		wrapped.length > PREVIEW_LINE_LIMIT
			? [...wrapped.slice(0, PREVIEW_LINE_LIMIT - 1), theme.fg("dim", "    …")]
			: wrapped.slice(0, PREVIEW_LINE_LIMIT);
	if (visible.length > 0) {
		visible[0] = visible[0]!.replace(/^ {4}/, "  ↳ ");
	}
	return visible;
}
```

Render steering first, a blank line between nonempty sections, then follow-ups. Add `keyHint("app.message.dequeue", "edit last queued message")` only to the follow-up section.

- [ ] **Step 4: Mount the component and remove count-only UI**

Replace `rebuildPending()`'s count row with:

```typescript
const pendingInput = this.state.pendingInput;
if (pendingInput && (pendingInput.steering.length > 0 || pendingInput.followUps.length > 0)) {
	this.pendingMessagesContainer.addChild(new Spacer(1));
	this.pendingMessagesContainer.addChild(new PendingInputPreviewComponent(pendingInput));
}
```

Remove `this.queueText()` from `FooterComponent.statsParts` and delete the private `queueText()` method. Do not remove background-terminal footer text.

Export the component and public types from `index.ts`.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern='pending input preview|footer|queue|queued'
npm --prefix tui/mycli-shell run typecheck
git add tui/mycli-shell/src/components/pending-input-preview.ts \
  tui/mycli-shell/src/components/footer.ts \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/src/index.ts \
  tui/mycli-shell/test/shell-app.test.ts
git commit -m "Render Codex-style pending input previews"
```

### Task 5: Edit The Last Follow-Up And Preserve Queues On Interrupt

**Files:**
- Modify: `tui/mycli-shell/src/gateway.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/test/shell-app.test.ts`
- Modify: `tests/integration/test_node_tui_gateway.py`

- [ ] **Step 1: Write the failing backend integration test**

Add to `tests/integration/test_node_tui_gateway.py` using a real `AgentRuntime`, `TurnService`, and `NodeTuiGateway`:

```python
def test_gateway_queue_pop_and_interrupt_preserve_pending_steering(
    tmp_path: Path,
) -> None:
    class NoModelRequestsAdapter:
        def next_turn(self, *, items: object, tools: object) -> ModelTurnResult:
            del items, tools
            raise AssertionError("queue management must not request the model")

    config = AgentConfig(
        workspace_root=tmp_path,
        session_id="gateway-queue-pop",
    )
    runtime = AgentRuntime(
        model_adapter=NoModelRequestsAdapter(),
        tool_registry=ToolRegistry.from_tools([]),
        config=config,
        home_dir=tmp_path / "home",
    )
    service = TurnService(
        runtime=runtime,
        config=config,
        home_dir=tmp_path / "home",
    )
    runtime.queue_steering_message("keep steering")
    runtime.queue_follow_up_message("first")
    runtime.queue_follow_up_message("second")
    gateway = NodeTuiGateway(service=service)

    popped = gateway.handle_request(
        RpcRequest(id="pop", method="turn.queue.pop", params={})
    )
    interrupted = gateway.handle_request(
        RpcRequest(id="interrupt", method="turn.interrupt", params={})
    )

    assert popped.result is not None
    assert popped.result["item"]["message"] == "second"
    assert runtime.queued_messages() == (("keep steering",), ("first",))
    assert interrupted.result is not None
    assert interrupted.result == {"interrupted": False}
    assert runtime.queued_messages() == (("keep steering",), ("first",))
```

- [ ] **Step 2: Write failing TUI edit tests**

Update the existing Alt+Up and Shift+Left tests so the callback returns only the newest follow-up and the initial state still contains one steering and one older follow-up. Assert:

- the popped text is restored before the draft;
- the pending preview still contains steering and the older follow-up after the state update;
- image placeholders and paths survive restoration.

Add a test where Escape interrupts a running turn and assert the queue preview remains present after the callback-driven state update.

Add a gateway failure regression around edit-last: reject the `turn.queue.pop`
request, assert the callback returns `null`, and assert the pending steering and
follow-up preview is unchanged. The failed request must not mutate either local
queue array.

- [ ] **Step 3: Verify RED**

```bash
uv run pytest tests/integration/test_node_tui_gateway.py \
  -k 'queue_pop_and_interrupt' -q
npm --prefix tui/mycli-shell test -- --test-name-pattern='edit last queued|interrupt.*queue'
```

Expected: FAIL because TypeScript still calls clear-all and clears queues before interrupt.

- [ ] **Step 4: Replace clear-all dequeue with pop-last**

Replace `dequeueQueuedInput()` in `gateway.ts` with:

```typescript
async function popLastQueuedFollowUp(): Promise<MycliShellQueuedInput | null> {
	try {
		const result = await send("turn.queue.pop", {}, { recordErrors: false });
		syncQueuedInputsFromResult(result);
		const popped = queuedItemsValue(
			result.item === null || result.item === undefined ? [] : [result.item],
			"followUp",
			[],
		)[0];
		return popped ? combineQueuedInputs([popped]) : null;
	} catch {
		return null;
	}
}
```

The backend snapshot is authoritative. A failed RPC leaves both local queue arrays
untouched so a transport error cannot silently discard a follow-up.

Pass this function as `onDequeueQueuedInput`.

- [ ] **Step 5: Stop clearing queues on interrupt**

Replace:

```typescript
async function interruptTurn(): Promise<void> {
	const restored = await dequeueQueuedInput();
	if (restored) {
		runtime?.restoreQueuedText(restored);
	}
	await send("turn.interrupt", {});
}
```

with:

```typescript
async function interruptTurn(): Promise<void> {
	await send("turn.interrupt", {});
}
```

Do not modify the local queue arrays in the interrupt path. Queue snapshots from subsequent gateway events remain authoritative.

- [ ] **Step 6: Update user-facing edit wording**

Change the `app.message.dequeue` keybinding description from `Restore queued message` to `Edit last queued follow-up`. Keep both `alt+up` and `shift+left` bindings.

- [ ] **Step 7: Verify and commit**

```bash
uv run pytest tests/integration/test_node_tui_gateway.py -q
npm --prefix tui/mycli-shell test -- --test-name-pattern='queue|queued|steer|follow-up|interrupt'
npm --prefix tui/mycli-shell run typecheck
git add tui/mycli-shell/src/gateway.ts \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/src/keybindings.ts \
  tui/mycli-shell/test/shell-app.test.ts \
  tests/integration/test_node_tui_gateway.py
git commit -m "Align queued input editing with Codex"
```

### Task 6: Run End-To-End Queue Regressions And Quality Gates

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run focused Python queue regressions**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py \
  tests/integration/test_turn_service.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/integration/test_node_tui_gateway.py -q
```

Expected: PASS.

- [ ] **Step 2: Run the complete TUI suite**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run repository quality gates**

```bash
uv run ruff check .
uv run mypy src
uv run pytest -q
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: no lint or type errors; all Python and TypeScript tests pass.

- [ ] **Step 4: Inspect protocol and UI regressions**

```bash
git diff --check
rg -n 'turn.queue.pop|turn.queue.clear' \
  src/mycli/domain/runtime/gateway_contract.py \
  src/mycli/cli/node_tui/gateway.py \
  tui/mycli-shell/src/gateway.ts
rg -n 'steer [0-9]|follow-up [0-9]|edit all queued messages' \
  tui/mycli-shell/src tui/mycli-shell/test
```

Expected:

- both pop and clear RPCs remain supported;
- production TUI code contains no count-only queue presentation;
- production TUI code contains no `edit all queued messages` wording;
- internal task notifications are still filtered from visible queue previews.

- [ ] **Step 5: Confirm the implementation worktree is clean**

```bash
git status --short
```

Expected: empty output. A nonempty result means one of Tasks 1-5 is incomplete; return the changes to that task's focused test and commit boundary before declaring completion.

## Completion Criteria

- Steering text is shown under `Messages to be submitted after next tool call`.
- Follow-up text is shown under `Queued follow-up inputs`.
- Each message preview is limited to three visual lines with an omission marker.
- Footer no longer repeats steering or follow-up counts.
- `Alt+Up` and `Shift+Left` restore only the newest follow-up.
- Steering, older follow-ups, image attachments, and client turn IDs survive edit-last.
- Escape interrupts without clearing either queue.
- Steering remains prioritized at the next eligible runtime boundary.
- Internal task notifications remain backend-visible and TUI-hidden.
- `turn.queue.clear` remains backward compatible.
- Ruff, mypy, full pytest, TUI tests, and TypeScript typecheck pass.
