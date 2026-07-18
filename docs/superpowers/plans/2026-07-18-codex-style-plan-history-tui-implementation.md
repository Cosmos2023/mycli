# Codex-Style Plan History TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the composer-adjacent mutable Plan panel with durable Codex-style `Updated Plan` transcript blocks and a compact latest-task footer count.

**Architecture:** A successful Plan state change records a model-hidden `PLAN_UPDATE` turn/history item with structured steps. Transcript projection exposes that item to both snapshots and `transcript.load`, while provider replay ignores it. The TypeScript runtime normalizes live and resumed payloads into one `plan_update` transcript block, renders it with a dedicated component, and derives only the latest completed/total count for the footer.

**Tech Stack:** Python 3.12 dataclasses and enums, SQLite-backed session history, JSON-RPC gateway schemas, TypeScript 5.9, Node test runner, custom mycli TUI components.

---

## File Map

**Python domain and runtime**

- Modify `src/mycli/domain/runtime/protocol.py`: add the turn-level `PLAN_UPDATE` item type.
- Modify `src/mycli/domain/runtime/session_history.py`: add the durable `PLAN_UPDATE` history type.
- Modify `src/mycli/application/runtime/tools/tool_execution_service.py`: append structured Plan updates only when `PlanState` changes.
- Modify `src/mycli/application/runtime/ledger/runtime_event_ledger.py`: persist Plan updates while keeping provider-facing filtering explicit.

**Python projection and gateway**

- Modify `src/mycli/services/transcript_projection.py`: project Plan history to snapshot and TUI wire shapes.
- Modify `src/mycli/domain/runtime/gateway_contract.py`: advertise the structured `plan.updated` payload.
- Verify `src/mycli/cli/node_tui/gateway.py`: its existing metadata forwarding must preserve the canonical payload unchanged; no production edit is expected.

**TypeScript state and rendering**

- Modify `tui/mycli-shell/src/model.ts`: add Plan-update transcript and footer types; remove `activePlan`.
- Modify `tui/mycli-shell/src/adapters/runtime-state.ts`: append live Plan updates, restore resumed updates, and track latest task progress.
- Create `tui/mycli-shell/src/components/plan-update.ts`: render the complete checklist as history.
- Delete `tui/mycli-shell/src/components/plan-panel.ts`: remove the mutable composer panel.
- Modify `tui/mycli-shell/src/shell-app.ts`: render Plan updates in static transcript output.
- Modify `tui/mycli-shell/src/shell-runtime.ts`: render and cache Plan updates in the live transcript; remove pending-panel mounting.
- Modify `tui/mycli-shell/src/components/footer.ts`: render optional `Tasks completed/total` with low width priority.
- Modify `tui/mycli-shell/src/index.ts`: export `PlanUpdateComponent` instead of `PlanPanelComponent`.

**Tests**

- Modify `tests/unit/application/runtime/test_runtime_event_ledger.py`.
- Modify `tests/unit/application/test_agent_runtime.py`.
- Modify `tests/unit/services/test_context_manager.py`.
- Modify `tests/unit/services/test_transcript_projection.py`.
- Modify `tests/unit/domain/runtime/test_gateway_contract.py`.
- Modify `tests/unit/cli/node_tui/test_gateway.py`.
- Modify `tui/mycli-shell/test/runtime-state.test.ts`.
- Modify `tui/mycli-shell/test/gateway-events.test.ts`.
- Modify `tui/mycli-shell/test/shell-app.test.ts`.

### Task 1: Define Durable, Model-Hidden Plan History Types

**Files:**
- Modify: `src/mycli/domain/runtime/protocol.py`
- Modify: `src/mycli/domain/runtime/session_history.py`
- Modify: `src/mycli/application/runtime/ledger/runtime_event_ledger.py`
- Test: `tests/unit/application/runtime/test_runtime_event_ledger.py`
- Test: `tests/unit/services/test_context_manager.py`

- [ ] **Step 1: Write failing ledger and replay tests**

Add a Plan item between a tool call and result and assert that the durable history keeps all three items in order, while provider history and reconstructed model messages omit the Plan item:

```python
def test_runtime_event_ledger_persists_plan_update_but_excludes_it_from_provider_history() -> None:
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn-1",
        status=TurnStatus.COMPLETED,
        started_at="2026-07-18T10:00:00Z",
        items=(
            TurnItem(
                type=TurnItemType.TOOL_CALL,
                text="Update plan",
                tool_name="Plan",
                call_id="call-plan-1",
            ),
            TurnItem(
                type=TurnItemType.PLAN_UPDATE,
                text="Updated Plan",
                metadata={
                    "source": "Plan",
                    "completed": 0,
                    "total": 1,
                    "items": [
                        {"id": "inspect", "text": "Inspect runtime", "status": "in_progress"}
                    ],
                    "model_visible": False,
                },
            ),
            TurnItem(
                type=TurnItemType.TOOL_RESULT,
                text="Plan updated",
                tool_name="Plan",
                call_id="call-plan-1",
            ),
        ),
    )

    durable = _ledger().history_items_from_turn(turn)
    provider = _ledger().provider_history_items_from_turn(turn)

    assert [item.type for item in durable] == [
        HistoryItemType.TOOL_CALL,
        HistoryItemType.PLAN_UPDATE,
        HistoryItemType.TOOL_RESULT,
    ]
    assert [item.type for item in provider] == [
        HistoryItemType.TOOL_CALL,
        HistoryItemType.TOOL_RESULT,
    ]
```

In `tests/unit/services/test_context_manager.py`, add:

```python
def test_context_manager_ignores_tui_only_plan_update_history() -> None:
    messages = ContextManager().messages_from_history(
        (
            HistoryItem(
                id="plan-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.PLAN_UPDATE,
                text="Updated Plan",
                metadata={"model_visible": False, "items": []},
            ),
        )
    )

    assert messages == ()
```

- [ ] **Step 2: Run the focused tests and verify enum failures**

Run:

```bash
uv run pytest -q \
  tests/unit/application/runtime/test_runtime_event_ledger.py \
  tests/unit/services/test_context_manager.py
```

Expected: FAIL because `TurnItemType.PLAN_UPDATE`, `HistoryItemType.PLAN_UPDATE`, and `history_items_from_turn` do not exist.

- [ ] **Step 3: Add Plan types and split durable history from provider history**

Add `PLAN_UPDATE = "plan_update"` to both enums. In `RuntimeEventLedger`, introduce a durable mapping and retain the existing provider filter:

```python
def history_items_from_turn(self, turn: TurnRecord) -> tuple[HistoryItem, ...]:
    history_items: list[HistoryItem] = []
    for index, item in enumerate(turn.items, start=1):
        history_item_type = self._history_type_for_turn_item(item)
        if history_item_type is None:
            continue
        history_items.append(
            HistoryItem(
                id=f"{turn.turn_id}:item:{index}",
                thread_id=turn.thread_id,
                turn_id=turn.turn_id,
                type=history_item_type,
                text=item.text,
                tool_name=item.tool_name,
                call_id=item.call_id,
                metadata=dict(item.metadata),
            )
        )
    return tuple(history_items)

def provider_history_items_from_turn(self, turn: TurnRecord) -> tuple[HistoryItem, ...]:
    return tuple(
        item
        for item in self.history_items_from_turn(turn)
        if item.type is not HistoryItemType.PLAN_UPDATE
    )

def _history_type_for_turn_item(self, item: TurnItem) -> HistoryItemType | None:
    if item.type is TurnItemType.PLAN_UPDATE:
        return HistoryItemType.PLAN_UPDATE
    return self._provider_transcript_type_for_turn_item(item)
```

Change `persist_structured_runtime_state` to append `history_items_from_turn(turn)` rather than `provider_history_items_from_turn(turn)`. Do not add Plan updates to `_PROVIDER_TRANSCRIPT_TURN_ITEM_TYPES`; this keeps the model-facing boundary explicit.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the domain and ledger boundary**

```bash
git add \
  src/mycli/domain/runtime/protocol.py \
  src/mycli/domain/runtime/session_history.py \
  src/mycli/application/runtime/ledger/runtime_event_ledger.py \
  tests/unit/application/runtime/test_runtime_event_ledger.py \
  tests/unit/services/test_context_manager.py
git commit -m "feat: persist model-hidden Plan history"
```

### Task 2: Record Structured Plan Updates at the State-Change Boundary

**Files:**
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Extend the existing Plan runtime test with turn-item assertions**

In `test_agent_runtime_applies_update_plan_tool_and_returns_plan_steps`, assert the canonical item:

```python
assert response.turn is not None
plan_updates = [
    item for item in response.turn.items if item.type is TurnItemType.PLAN_UPDATE
]
assert len(plan_updates) == 1
assert plan_updates[0].text == "Updated Plan"
assert plan_updates[0].metadata == {
    "source": "Plan",
    "completed": 0,
    "total": 2,
    "items": [
        {
            "id": "inspect",
            "text": "Inspect the repository layout",
            "status": "in_progress",
        },
        {
            "id": "summarize",
            "text": "Summarize the findings",
            "status": "pending",
        },
    ],
    "model_visible": False,
}
```

Add this no-op adapter and test beside the existing Plan adapters:

```python
class NoOpPlanThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *, messages, tools):
        del messages, tools
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "progress_message": "Keeping the existing plan",
                    "tool_call": ToolCall(
                        name="Plan",
                        arguments={
                            "plan": [
                                {
                                    "id": "inspect",
                                    "content": "Inspect runtime",
                                    "status": "in_progress",
                                }
                            ]
                        },
                        reason="confirm current plan",
                    ),
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Plan unchanged",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_does_not_record_unchanged_plan(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=NoOpPlanThenDoneAdapter(),
    )
    runtime._session_service.save_plan_state(
        runtime._config.session_id,
        PlanState(
            items=(
                PlanItem(
                    id="inspect",
                    content="Inspect runtime",
                    status=PlanStatus.IN_PROGRESS,
                ),
            )
        ),
    )
    events: list[RuntimeStreamEvent] = []

    response = runtime.handle_user_turn("keep the current plan", stream_sink=events.append)

    assert response.turn is not None
    assert all(item.type is not TurnItemType.PLAN_UPDATE for item in response.turn.items)
    assert all(event.kind != "plan_updated" for event in events)
```

- [ ] **Step 2: Run the Plan runtime tests and verify they fail**

Run:

```bash
uv run pytest -q tests/unit/application/test_agent_runtime.py -k "plan"
```

Expected: FAIL because changed Plan states emit only a stream event and no durable Plan turn item.

- [ ] **Step 3: Build one canonical metadata object and use it for history and live events**

Add helpers beside `_plan_payload`:

```python
def _plan_update_metadata(plan_state: PlanState, *, source: str) -> dict[str, object]:
    items = [_plan_item_payload(item) for item in plan_state.items]
    return {
        "source": source,
        "completed": sum(
            item.status is PlanStatus.COMPLETED for item in plan_state.items
        ),
        "total": len(plan_state.items),
        "items": items,
        "model_visible": False,
    }

def _live_plan_update_payload(
    plan_state: PlanState,
    *,
    metadata: dict[str, object],
) -> dict[str, object]:
    return {
        "plan_steps": _render_plan_steps(plan_state),
        "plan": {"items": list(metadata["items"])},
        "source": metadata["source"],
        "completed": metadata["completed"],
        "total": metadata["total"],
    }
```

Inside `if next_plan_state != plan_state`, append the turn item before notifying the lifecycle sink:

```python
plan_update_metadata = _plan_update_metadata(
    next_plan_state,
    source=normalized_call.name,
)
self._append_turn_item(
    turn_id=turn_id,
    turn_items=turn_items,
    item=TurnItem(
        type=TurnItemType.PLAN_UPDATE,
        text="Updated Plan",
        metadata=plan_update_metadata,
    ),
)
self._notify_lifecycle_sink(
    lifecycle_sink,
    RuntimeStreamEvent(
        kind="plan_updated",
        metadata=_live_plan_update_payload(
            next_plan_state,
            metadata=plan_update_metadata,
        ),
    ),
)
```

Keep the equality guard as the sole append condition so successful no-op calls remain invisible.

- [ ] **Step 4: Run the Plan runtime tests and verify they pass**

Run the command from Step 2.

Expected: PASS, including rich evidence and no-op coverage.

- [ ] **Step 5: Commit runtime Plan recording**

```bash
git add \
  src/mycli/application/runtime/tools/tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py
git commit -m "feat: record structured Plan updates"
```

### Task 3: Project Plan History into Session Snapshots and TUI Transcript Loads

**Files:**
- Modify: `src/mycli/services/transcript_projection.py`
- Test: `tests/unit/services/test_transcript_projection.py`
- Test: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write failing projection and snapshot persistence tests**

Add a projection test using structured metadata and assert the exact TUI shape:

```python
def test_plan_update_history_projects_to_structured_tui_item() -> None:
    item = HistoryItem(
        id="turn-1:item:2",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.PLAN_UPDATE,
        text="Updated Plan",
        metadata={
            "source": "Plan",
            "completed": 1,
            "total": 2,
            "items": [
                {"id": "inspect", "text": "Inspect runtime", "status": "completed"},
                {"id": "verify", "text": "Run tests", "status": "in_progress"},
            ],
            "model_visible": False,
            "provider_blob": "do-not-project",
        },
    )

    snapshot = project_history_items_for_snapshot((item,))[0].to_dict()
    tui_item = snapshot_item_to_tui_items(snapshot)[0]

    assert snapshot == {
        "id": "turn-1:item:2",
        "type": "plan_update",
        "text": "Updated Plan",
        "metadata": {
            "source": "Plan",
            "completed": 1,
            "total": 2,
            "items": [
                {"id": "inspect", "text": "Inspect runtime", "status": "completed"},
                {"id": "verify", "text": "Run tests", "status": "in_progress"},
            ],
        },
    }
    assert tui_item["type"] == "plan_update"
    assert "provider_blob" not in str(tui_item)
    assert "model_visible" not in str(tui_item)
```

In `tests/unit/services/test_session_service.py`, append user, Plan update, and assistant history items, then assert `session.json` preserves the same ordered `plan_update` snapshot entry.

- [ ] **Step 2: Run the focused projection tests and verify they fail**

Run:

```bash
uv run pytest -q \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/services/test_session_service.py -k "plan_update or visible_transcript"
```

Expected: FAIL because `PLAN_UPDATE` is not in `_VISIBLE_HISTORY_TYPES` and has no snapshot mapping.

- [ ] **Step 3: Add a strict Plan metadata projection**

Add `HistoryItemType.PLAN_UPDATE` to `_VISIBLE_HISTORY_TYPES`. Special-case Plan history before the generic `_history_snapshot_item` mapping:

```python
def _plan_update_snapshot_item(item: HistoryItem) -> TranscriptSnapshotItem:
    return TranscriptSnapshotItem(
        id=item.id,
        type="plan_update",
        text=item.text or "Updated Plan",
        created_at=_optional_str(item.metadata.get("created_at")),
        metadata=_visible_plan_update_metadata(item.metadata),
    )

def _visible_plan_update_metadata(metadata: dict[str, Any]) -> dict[str, object]:
    raw_items = metadata.get("items")
    items: list[dict[str, object]] = []
    if isinstance(raw_items, list):
        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                continue
            item_id = _optional_str(raw_item.get("id"))
            text = _optional_str(raw_item.get("text"))
            status = _optional_str(raw_item.get("status"))
            if item_id is None or text is None:
                continue
            item: dict[str, object] = {
                "id": item_id,
                "text": text,
                "status": status or "pending",
            }
            evidence = raw_item.get("evidence")
            if isinstance(evidence, list):
                item["evidence"] = [
                    entry for entry in evidence if isinstance(entry, str) and entry
                ]
            items.append(item)
    return {
        "source": _optional_str(metadata.get("source")) or "Plan",
        "completed": _optional_int(metadata.get("completed")) or 0,
        "total": _optional_int(metadata.get("total")) or len(items),
        "items": items,
    }
```

Use this helper from both `project_history_items_for_snapshot` and `project_history_item_for_tui`. Map snapshot type `plan_update` to TUI type `plan_update` in `snapshot_item_to_tui_items`. Do not pass arbitrary history metadata through this path.

- [ ] **Step 4: Run the focused projection tests and verify they pass**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit transcript projection**

```bash
git add \
  src/mycli/services/transcript_projection.py \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/services/test_session_service.py
git commit -m "feat: project Plan updates into TUI history"
```

### Task 4: Strengthen the Gateway Plan Contract and Resume Coverage

**Files:**
- Modify: `src/mycli/domain/runtime/gateway_contract.py`
- Test: `tests/unit/domain/runtime/test_gateway_contract.py`
- Test: `tests/unit/cli/node_tui/test_gateway.py`

- [ ] **Step 1: Write failing schema, live-forwarding, and resume tests**

Assert the event schema retains compatibility fields and advertises rich fields:

```python
def test_plan_updated_schema_exposes_structured_plan_payload() -> None:
    schema = gateway_event_payload_schemas()["plan.updated"]

    assert schema["required"] == ["client_turn_id", "plan_steps"]
    assert schema["properties"]["plan"] == {"type": "object"}
    assert schema["properties"]["completed"] == {"type": "integer"}
    assert schema["properties"]["total"] == {"type": "integer"}
```

Update `test_gateway_forwards_plan_updated_stream_event` so its fake event includes `plan`, `completed`, and `total`, and assert the direct `plan.updated` payload preserves all fields. Add a transcript-load case with `HistoryItemType.PLAN_UPDATE` between user and assistant and assert the returned order is `user`, `plan_update`, `assistant_final`.

- [ ] **Step 2: Run gateway tests and verify schema failure**

Run:

```bash
uv run pytest -q \
  tests/unit/domain/runtime/test_gateway_contract.py \
  tests/unit/cli/node_tui/test_gateway.py -k "plan_updated or transcript_load_projects_plan"
```

Expected: FAIL because `plan`, `completed`, and `total` are absent from the event schema.

- [ ] **Step 3: Extend the gateway schema and preserve canonical metadata**

Change the `plan.updated` properties to:

```python
properties=_with_client_turn(
    {
        "plan_steps": _ARRAY,
        "plan": _OBJECT,
        "source": _STRING,
        "completed": _INTEGER,
        "total": _INTEGER,
    }
),
```

The current `GatewayTurnStreamBridge` already spreads `event.metadata`; leave that production path unchanged and use the forwarding test to lock in the behavior. Do not synthesize history from latest `PlanState` during bootstrap.

- [ ] **Step 4: Run gateway tests and verify they pass**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit gateway contract changes**

```bash
git add \
  src/mycli/domain/runtime/gateway_contract.py \
  tests/unit/domain/runtime/test_gateway_contract.py \
  tests/unit/cli/node_tui/test_gateway.py
git commit -m "feat: expose structured Plan history events"
```

### Task 5: Normalize Live and Resumed Plan Updates in TUI State

**Files:**
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`
- Test: `tui/mycli-shell/test/gateway-events.test.ts`

- [ ] **Step 1: Replace active-panel tests with append-only history tests**

Delete tests that expect `shell.activePlan`. Add tests covering two live updates, empty Plan clearing, compatibility strings, malformed events, and resume:

```typescript
test("runtime adapter appends every live Plan update", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan: { items: [{ id: "inspect", text: "Inspect runtime", status: "in_progress" }] },
		source: "Plan",
		completed: 0,
		total: 1,
	});
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan: { items: [{ id: "inspect", text: "Inspect runtime", status: "completed" }] },
		source: "Plan",
		completed: 1,
		total: 1,
	});

	const shell = projectRuntimeState(state);
	assert.deepEqual(
		shell.transcript?.map((block) => block.kind),
		["plan_update", "plan_update"],
	);
	assert.deepEqual(shell.footer.taskProgress, { completed: 1, total: 1 });
});
```

For resume, pass two persisted `plan_update` transcript items to `runtimeStateFromTranscript` and assert both remain ordered while footer progress comes from the second. In `gateway-events.test.ts`, feed direct and mirrored `plan.updated` events through `GatewayEventDeduper` and assert one block.

- [ ] **Step 2: Run focused TypeScript tests and verify they fail**

Run:

```bash
npm --prefix tui/mycli-shell test -- \
  test/runtime-state.test.ts \
  test/gateway-events.test.ts
```

Expected: FAIL because the model has no `plan_update` block or footer task progress and the reducer still replaces `activePlan`.

- [ ] **Step 3: Add Plan-update and task-progress model types**

In `model.ts`, add:

```typescript
export type MycliShellPlanUpdate = {
	id: string;
	title: string;
	source?: string;
	steps: MycliShellPlanStep[];
	completed: number;
	total: number;
};

export type MycliShellTaskProgress = {
	completed: number;
	total: number;
};
```

Add `{ id: string; kind: "plan_update"; planUpdate: MycliShellPlanUpdate }` to `MycliShellTranscriptBlock`, add `taskProgress?: MycliShellTaskProgress` to `MycliShellFooterData`, and remove `activePlan` from `MycliShellState`.

In `RuntimeShellState`, replace `activePlan` with:

```typescript
taskProgress: { completed: number; total: number } | null;
```

- [ ] **Step 4: Normalize live and resumed items through one parser**

Introduce a strict parser that distinguishes an empty valid Plan from malformed input:

```typescript
function planUpdateFromPayload(
	payload: Record<string, unknown>,
	id: string,
	text = "Updated Plan",
): RuntimeTranscriptItem | null {
	const plan = recordValue(payload.plan);
	const rawItems = Array.isArray(plan.items)
		? plan.items
		: Array.isArray(payload.items)
			? payload.items
			: null;
	const steps = rawItems !== null
		? rawItems.map((item, index) => planStepFromRecord(recordValue(item), index))
			.filter((item): item is MycliShellPlanStep => item !== null)
		: Array.isArray(payload.plan_steps)
			? planStepsFromPayload(payload.plan_steps)
			: null;
	if (steps === null || (rawItems !== null && steps.length !== rawItems.length)) return null;
	const completed = steps.filter((step) => step.status === "completed").length;
	return {
		id,
		type: "plan_update",
		text,
		folded: false,
		metadata: {
			source: stringValue(payload.source) ?? "Plan",
			completed,
			total: steps.length,
			items: steps,
		},
	};
}
```

For live `plan.updated`, seal the active assistant stream, clear `activeAssistantItemId`, append a uniquely identified item using `nextId("plan-update")`, and set task progress from the normalized item. Ignore malformed payloads without changing state.

For `runtimeStateFromTranscript`, retain all valid persisted `plan_update` items and derive `taskProgress` from the last one. A valid empty update sets `taskProgress` to `null`. Remove Plan parsing and completed-plan clearing from `turn.completed`; compatibility `plan_steps` there no longer creates UI state.

In `projectRuntimeState`, map each valid transcript item to `kind: "plan_update"` and copy `state.taskProgress` into `footer.taskProgress`.

- [ ] **Step 5: Run focused TypeScript tests and verify they pass**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit TUI Plan state normalization**

```bash
git add \
  tui/mycli-shell/src/model.ts \
  tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/test/runtime-state.test.ts \
  tui/mycli-shell/test/gateway-events.test.ts
git commit -m "feat: append Plan updates to TUI history"
```

### Task 6: Render Codex-Style Plan History and Remove the Composer Panel

**Files:**
- Create: `tui/mycli-shell/src/components/plan-update.ts`
- Delete: `tui/mycli-shell/src/components/plan-panel.ts`
- Modify: `tui/mycli-shell/src/shell-app.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/index.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Replace panel rendering tests with history rendering tests**

Delete tests for `[plan]`, compact current evidence, and composer placement. Add tests for full history, ordering, wrapping, CJK width safety, empty plans, and absence above the composer:

```typescript
test("mycli shell renders complete Plan updates in transcript order", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "plan-1",
				kind: "plan_update",
				planUpdate: {
					id: "plan-1",
					title: "Updated Plan",
					source: "Plan",
					completed: 1,
					total: 3,
					steps: [
						{ id: "inspect", text: "Inspect runtime", status: "completed" },
						{ id: "render", text: "Render Plan history", status: "in_progress" },
						{ id: "verify", text: "Verify resume", status: "pending" },
					],
				},
			},
		],
	};

	const output = stripAnsi(renderMycliShell(state, 72).join("\n"));
	assert.match(output, /• Updated Plan/);
	assert.match(output, /✔ Inspect runtime/);
	assert.match(output, /□ Render Plan history/);
	assert.match(output, /□ Verify resume/);
	assert.doesNotMatch(output, /\[plan\]/);
});
```

Add a narrow-width test using a long unbroken token and Chinese text; assert every rendered line has `visibleWidth(line) <= width`. Add an empty-plan assertion for `(no steps provided)`.

- [ ] **Step 2: Run shell rendering tests and verify they fail**

Run:

```bash
npm --prefix tui/mycli-shell test -- test/shell-app.test.ts
```

Expected: FAIL because no `PlanUpdateComponent` or `plan_update` render branch exists.

- [ ] **Step 3: Create a width-safe Plan history component**

Create `PlanUpdateComponent implements Component`. Render a blank separator, `• Updated Plan`, then every step. Use `wrapTextWithAnsi` on raw step text with `Math.max(1, width - 4)`, prefix the first line with `  ✔ ` or `  □ `, and prefix continuation lines with four spaces. Apply styles after wrapping:

```typescript
private styleText(status: MycliShellPlanStepStatus, text: string): string {
	if (status === "completed") {
		return theme.fg("muted", theme.strikethrough(text));
	}
	if (status === "in_progress") {
		return theme.fg("text", theme.bold(text));
	}
	return theme.fg("muted", text);
}
```

Use `truncateToWidth` only as a final guard for each assembled line. Render `(no steps provided)` when `steps.length === 0`.

- [ ] **Step 4: Wire the new transcript block and remove all panel mounting**

Add `plan_update` branches to `TranscriptBlocksComponent`, `ChatBlockComponent`, and `syncChatBlock`. Remove:

- `PlanPanelComponent` imports and exports.
- `activePlanSignature` and its pending-section rebuild dependency.
- `activePlan` rendering from `MycliShellApp` and `MycliShellRuntime.rebuildPending`.
- The obsolete `plan-panel.ts` file.

Keep the existing `plan` branch and `ProposedPlanComponent` unchanged.

- [ ] **Step 5: Run shell rendering tests and typecheck**

Run:

```bash
npm --prefix tui/mycli-shell test -- test/shell-app.test.ts
npm --prefix tui/mycli-shell run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Plan history rendering**

```bash
git add \
  tui/mycli-shell/src/components/plan-update.ts \
  tui/mycli-shell/src/components/plan-panel.ts \
  tui/mycli-shell/src/shell-app.ts \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/src/index.ts \
  tui/mycli-shell/test/shell-app.test.ts
git commit -m "feat: render Codex-style Plan history"
```

### Task 7: Add Low-Priority Footer Task Progress

**Files:**
- Modify: `tui/mycli-shell/src/components/footer.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing wide and narrow footer tests**

```typescript
test("footer renders latest task progress when space allows", () => {
	const output = stripAnsi(new FooterComponent({
		cwd: "/repo",
		model: "gpt-5.4",
		taskProgress: { completed: 2, total: 5 },
	}).render(80).join("\n"));

	assert.match(output, /Tasks 2\/5/);
});

test("footer drops task progress before live status at narrow widths", () => {
	const output = stripAnsi(new FooterComponent({
		cwd: "/repo",
		model: "gpt-5.4-with-long-name",
		taskProgress: { completed: 2, total: 5 },
		liveState: "Running",
	}).render(32).join("\n"));

	assert.match(output, /Running/);
	assert.doesNotMatch(output, /Tasks 2\/5/);
});
```

- [ ] **Step 2: Run the focused footer tests and verify they fail**

Run:

```bash
npm --prefix tui/mycli-shell test -- test/shell-app.test.ts
```

Expected: FAIL because `FooterComponent` ignores `taskProgress`.

- [ ] **Step 3: Add task progress with explicit low-priority removal**

Build `taskText` only for `total > 0`:

```typescript
const taskText = this.data.taskProgress && this.data.taskProgress.total > 0
	? `Tasks ${this.data.taskProgress.completed}/${this.data.taskProgress.total}`
	: undefined;
```

Insert it before `liveState` in the left-side stats. Before truncating either side, compare the complete left and right widths; if they exceed the terminal width, rebuild the left stats without `taskText`. Preserve existing provider dropping and right-side truncation after this step.

- [ ] **Step 4: Run footer tests and typecheck**

Run:

```bash
npm --prefix tui/mycli-shell test -- test/shell-app.test.ts
npm --prefix tui/mycli-shell run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit footer progress**

```bash
git add \
  tui/mycli-shell/src/components/footer.ts \
  tui/mycli-shell/test/shell-app.test.ts
git commit -m "feat: show compact Plan task progress"
```

### Task 8: Verify Live/Resume Parity and Full Quality Gates

**Files:**
- Test: full Python and TypeScript suites

- [ ] **Step 1: Run the focused end-to-end Plan paths**

```bash
uv run pytest -q \
  tests/unit/application/runtime/test_runtime_event_ledger.py \
  tests/unit/application/test_agent_runtime.py -k "plan" \
  tests/unit/services/test_context_manager.py \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/services/test_session_service.py -k "plan_update or visible_transcript" \
  tests/unit/domain/runtime/test_gateway_contract.py \
  tests/unit/cli/node_tui/test_gateway.py -k "plan_updated or transcript_load"
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all selected tests pass; live and resumed Plan updates use the same item shape.

- [ ] **Step 2: Run all Python quality gates**

```bash
uv run pytest -q
uv run ruff check .
uv run mypy src/mycli
```

Expected: all tests pass, Ruff reports no errors, and mypy reports success for every source file.

- [ ] **Step 3: Run all TypeScript quality gates**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all Node tests and TypeScript typechecking pass.

- [ ] **Step 4: Inspect the final diff for scope and accidental user-file inclusion**

```bash
git status --short
git diff --check HEAD
git diff --stat HEAD
```

Expected: no whitespace errors; `.codex/config.toml` and `docs/superpowers/plans/2026-07-17-codex-style-unified-shell-runtime-implementation.md` remain untouched and uncommitted unless the user separately requests them.

- [ ] **Step 5: Commit any verification-only test corrections**

Run this only if full-suite failures required test or implementation corrections:

```bash
git add \
  src/mycli/domain/runtime/protocol.py \
  src/mycli/domain/runtime/session_history.py \
  src/mycli/application/runtime/tools/tool_execution_service.py \
  src/mycli/application/runtime/ledger/runtime_event_ledger.py \
  src/mycli/services/transcript_projection.py \
  src/mycli/domain/runtime/gateway_contract.py \
  tests/unit/application/runtime/test_runtime_event_ledger.py \
  tests/unit/application/test_agent_runtime.py \
  tests/unit/services/test_context_manager.py \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/services/test_session_service.py \
  tests/unit/domain/runtime/test_gateway_contract.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tui/mycli-shell/src/model.ts \
  tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/src/components/plan-update.ts \
  tui/mycli-shell/src/components/plan-panel.ts \
  tui/mycli-shell/src/shell-app.ts \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/src/components/footer.ts \
  tui/mycli-shell/src/index.ts \
  tui/mycli-shell/test/runtime-state.test.ts \
  tui/mycli-shell/test/gateway-events.test.ts \
  tui/mycli-shell/test/shell-app.test.ts
git commit -m "test: verify Plan history TUI integration"
```

If no correction was required, do not create an empty commit.
