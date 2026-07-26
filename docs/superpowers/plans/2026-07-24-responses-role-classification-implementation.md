# Responses Role Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve developer and user authority in mycli's canonical model timeline and make full HTTP Responses inputs append-only across unchanged and changed runtime context.

**Architecture:** Project every protocol from a persisted, model-visible provider timeline that is independent of the TUI transcript. Keep base instructions in the Responses `instructions` field; append developer and user context updates at their actual turn boundary; then append the current user message. The target sequence is `S -> D0 -> E0 -> U1 -> A1 -> E1 -> U2`. Full HTTP input uses this complete timeline, while WebSocket continuation remains a later transport-only optimization.

**Tech Stack:** Python 3.13, dataclasses, pytest, OpenAI Responses/Chat Completions adapters

---

## File Structure

- Modify `src/mycli/domain/conversation.py`: admit canonical `developer` messages.
- Modify `src/mycli/domain/runtime/session_history.py`: persist the role of baseline fragments with a backward-compatible default.
- Create `src/mycli/application/runtime/request/provider_timeline.py`: persist the provider-visible timeline, compare source-conversation cursors, and append changed context before the current user message.
- Modify `src/mycli/state/session_service.py`: persist provider timeline state independently from conversation and TUI history.
- Modify `src/mycli/application/runtime/agent_runtime.py`: project and persist the provider timeline before request-shape construction.
- Modify `src/mycli/application/runtime/ledger/runtime_event_ledger.py`: persist role-aware context updates rather than environment-only updates.
- Modify `src/mycli/services/context/context_manager.py`: restore context updates with their persisted role.
- Modify `src/mycli/services/context/instruction_contract_assembler.py`: make developer fragments replayable and classify runtime policy reminders separately.
- Modify `src/mycli/services/context/turn_context_assembler.py`: produce separate policy and factual reminder sections.
- Modify `src/mycli/domain/runtime/turn_context.py`: add the policy-reminder section type.
- Modify `src/mycli/application/runtime/request/request_pipeline.py`: apply durable context projection and remove transient hash-only context deletion.
- Modify `src/mycli/application/runtime/request/request_shape_builder.py`: place role-preserving context deltas immediately before the current user message.
- Modify `src/mycli/application/runtime/turn_executor.py`: persist interruption markers as developer messages and type runtime-owned policy reminders.
- Modify focused unit tests under `tests/unit/services`, `tests/unit/application/runtime`, and `tests/unit/infrastructure`.

### Task 1: Persist Canonical Context Roles

**Files:**
- Modify: `src/mycli/domain/conversation.py`
- Modify: `src/mycli/domain/runtime/session_history.py`
- Modify: `src/mycli/application/runtime/ledger/runtime_event_ledger.py`
- Modify: `src/mycli/services/context/context_manager.py`
- Test: `tests/unit/domain/test_runtime.py`
- Test: `tests/unit/services/test_context_manager.py`

- [ ] **Step 1: Write failing role round-trip and replay tests**

Add tests that require a developer baseline to survive JSON round-trip and replay:

```python
def test_baseline_fragment_round_trip_preserves_role() -> None:
    fragment = BaselineFragment(
        id="developer:permissions",
        kind="permissions",
        title="Runtime permissions",
        content="Do not write outside the workspace.",
        role="developer",
    )

    restored = BaselineFragment.from_dict(fragment.to_dict())

    assert restored.role == "developer"


def test_context_manager_replays_developer_context_update_with_developer_role() -> None:
    item = HistoryItem(
        id="turn-1:context:permissions",
        thread_id="thread-1",
        turn_id="turn-1",
        type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
        text="Do not write outside the workspace.",
        metadata={"role": "developer", "model_visible": True, "replayable": True},
    )

    messages = ContextManager().messages_from_history((item,))

    assert messages[0].role == "developer"
```

Also assert that a legacy baseline payload without `role` and a legacy context update without role metadata both default to `user`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py tests/unit/services/test_context_manager.py -q
```

Expected: the new tests fail because `BaselineFragment` does not persist `role` and context updates are restored as `user`.

- [ ] **Step 3: Add the role field and trusted replay helper**

Extend the canonical message and baseline types:

```python
Role = Literal["system", "developer", "user", "assistant", "tool"]


@dataclass(slots=True, frozen=True)
class BaselineFragment:
    id: str
    kind: str
    title: str
    content: str
    role: str = "user"
    source: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
```

Include `role` in `to_dict()` and default it to `user` in `from_dict()`. When `RuntimeEventLedger.context_baseline_from_contract()` visits `developer_sections`, store `role="developer"`; when it visits `contextual_user_sections`, store `role="user"`.

Restore baseline messages using a closed role set:

```python
def _context_update_role(self, item: HistoryItem) -> Role:
    role = item.metadata.get("role")
    if role in {"developer", "user"}:
        return cast(Role, role)
    return "user"
```

Do not accept arbitrary metadata values as model roles.

- [ ] **Step 4: Run focused tests**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py tests/unit/services/test_context_manager.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the canonical role support**

```bash
git add src/mycli/domain/conversation.py src/mycli/domain/runtime/session_history.py src/mycli/application/runtime/ledger/runtime_event_ledger.py src/mycli/services/context/context_manager.py tests/unit/domain/test_runtime.py tests/unit/services/test_context_manager.py
git commit -m "feat: preserve canonical context roles"
```

### Task 2: Build Durable Context Deltas

**Files:**
- Create: `src/mycli/application/runtime/request/context_timeline_projector.py`
- Modify: `src/mycli/application/runtime/request/__init__.py`
- Modify: `src/mycli/application/runtime/ledger/runtime_event_ledger.py`
- Modify: `src/mycli/services/context/instruction_contract_assembler.py`
- Test: `tests/unit/application/runtime/test_context_timeline_projector.py`
- Test: `tests/unit/application/runtime/test_runtime_event_ledger.py`

- [ ] **Step 1: Write failing projector tests**

Cover initial context, unchanged context, changed developer context, and changed user context:

```python
def test_projector_emits_all_context_without_baseline() -> None:
    projected = ContextTimelineProjector().project(contract(), previous=None)
    assert [item.kind for item in projected.developer_sections] == ["permissions"]
    assert [item.kind for item in projected.contextual_user_sections] == ["environment_context"]


def test_projector_omits_unchanged_context_from_current_delta() -> None:
    projected = ContextTimelineProjector().project(contract(), previous=matching_baseline())
    assert projected.developer_sections == ()
    assert projected.contextual_user_sections == ()


def test_projector_emits_changed_sections_with_original_roles() -> None:
    projected = ContextTimelineProjector().project(changed_contract(), previous=old_baseline())
    assert [item.kind for item in projected.developer_sections] == ["permissions"]
    assert [item.kind for item in projected.contextual_user_sections] == ["environment_context"]
```

The returned contract must retain `conversation_messages`, `current_user_request`, base instructions, and assistant scaffold unchanged.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
uv run pytest tests/unit/application/runtime/test_context_timeline_projector.py tests/unit/application/runtime/test_runtime_event_ledger.py -q
```

Expected: FAIL because `ContextTimelineProjector` does not exist and only environment updates are persisted.

- [ ] **Step 3: Implement stable context identities and projection**

Create a projector with a role-aware identity and content hash:

```python
@dataclass(slots=True, frozen=True)
class ContextTimelineProjector:
    def project(
        self,
        contract: InstructionContract,
        previous: ContextBaseline | None,
    ) -> InstructionContract:
        previous_by_key = {
            self._key(item.role, item.kind, item.source, item.title): stable_hash(item.content.strip())
            for item in (() if previous is None else previous.fragments)
        }
        developer = self._changed(
            contract.developer_sections,
            role="developer",
            previous_by_key=previous_by_key,
        )
        contextual = self._changed(
            contract.contextual_user_sections,
            role="user",
            previous_by_key=previous_by_key,
        )
        return replace(
            contract,
            developer_sections=developer,
            contextual_user_sections=contextual,
        )
```

Use `(role, kind, source, title)` as the identity. Preserve source order and emit a section only when its identity is absent or its normalized content hash changed.

- [ ] **Step 4: Persist every changed baseline fragment**

Replace `_runtime_environment_history_items()` with a generic role-aware comparison between the prior and current baselines. Emit one `CONTEXT_BASELINE_UPDATE` per new or changed fragment:

```python
metadata = {
    **self._baseline_metadata(fragment.metadata),
    "role": fragment.role,
    "context_kind": fragment.kind,
    "model_visible": True,
    "replayable": True,
    "context_hash": stable_hash(fragment.content.strip()),
}
```

Keep the environment raw-hash state only as a compatibility diagnostic; it must no longer be the sole persisted context update.

- [ ] **Step 5: Make developer fragments replayable**

Change `_developer_instruction_fragment()` metadata to:

```python
metadata.setdefault("durability", CanonicalTimelineDurability.PERSISTENT.value)
metadata.setdefault("scope", "session")
metadata.setdefault("model_visible", True)
metadata.setdefault("replayable", True)
```

This allows initial developer context and later updates to enter the same canonical history as user context.

- [ ] **Step 6: Run focused tests**

Run:

```bash
uv run pytest tests/unit/application/runtime/test_context_timeline_projector.py tests/unit/application/runtime/test_runtime_event_ledger.py tests/unit/services/test_instruction_contract_assembler.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit durable context deltas**

```bash
git add src/mycli/application/runtime/request/context_timeline_projector.py src/mycli/application/runtime/request/__init__.py src/mycli/application/runtime/ledger/runtime_event_ledger.py src/mycli/services/context/instruction_contract_assembler.py tests/unit/application/runtime/test_context_timeline_projector.py tests/unit/application/runtime/test_runtime_event_ledger.py tests/unit/services/test_instruction_contract_assembler.py
git commit -m "feat: persist role-aware context deltas"
```

### Task 3: Split Runtime Policy And Factual Context

**Files:**
- Modify: `src/mycli/domain/runtime/turn_context.py`
- Modify: `src/mycli/services/context/turn_context_assembler.py`
- Modify: `src/mycli/services/context/instruction_contract_assembler.py`
- Modify: `src/mycli/application/runtime/context/runtime_context_builder.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Test: `tests/unit/services/test_turn_context_assembler.py`
- Test: `tests/unit/services/test_instruction_contract_assembler.py`
- Test: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Write failing role-classification tests**

Add tests with one runtime-owned policy reminder and one ordinary contextual reminder:

```python
def test_instruction_contract_splits_policy_and_context_reminders() -> None:
    context = ExecutionContext(
        config=AgentConfig(workspace_root=Path("/tmp/workspace")),
        runtime_policy_reminders=("Answer now and avoid more tool calls.",),
        runtime_reminders=("Recent file: src/app.py",),
    )
    turn_context = TurnContextAssembler().assemble(user_message="continue", context=context)
    contract = InstructionContractAssembler().assemble(
        turn_context=turn_context,
        base_instructions="Base",
        conversation_messages=(),
    )

    assert any("Answer now" in item.content for item in contract.developer_sections)
    assert any("Recent file" in item.content for item in contract.contextual_user_sections)
```

Also assert that hook context remains user-role unless its section metadata contains runtime-owned `trusted_policy=True`.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py tests/unit/application/test_turn_recovery_and_budget.py -q
```

Expected: FAIL because policy reminders do not have a separate field or section.

- [ ] **Step 3: Add an explicit policy reminder channel**

Add to `ExecutionContext`:

```python
runtime_policy_reminders: tuple[str, ...] = ()
runtime_reminders: tuple[str, ...] = ()
```

Add `RUNTIME_POLICY_REMINDERS` to `TurnContextSectionType`. Render it as an ephemeral turn section and map it to a developer fragment. Keep `RUNTIME_REMINDERS` mapped to contextual user.

Add `runtime_policy_reminders` parameters to `RuntimeContextBuilder.build_context()`, `RuntimeContextBuilder.assemble_turn_context()`, and the matching `AgentRuntime` forwarding methods. Runtime-owned producers such as `BudgetNudge` and retry recovery pass their strings through this parameter. Existing untyped strings and hook additional context remain in the user context channel, which prevents accidental authority elevation.

- [ ] **Step 4: Remove hook duplication**

In `RuntimeContextBuilder.build_context()`, partition incoming contextual strings once:

```python
hook_contexts = tuple(item for item in runtime_reminders if item.startswith("[hook:"))
factual_reminders = tuple(item for item in runtime_reminders if not item.startswith("[hook:"))
```

Do not retain hook entries in both `hook_contexts` and `runtime_reminders`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
uv run pytest tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py tests/unit/application/test_turn_recovery_and_budget.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit reminder classification**

```bash
git add src/mycli/domain/runtime/turn_context.py src/mycli/services/context/turn_context_assembler.py src/mycli/services/context/instruction_contract_assembler.py src/mycli/application/runtime/context/runtime_context_builder.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py tests/unit/application/test_turn_recovery_and_budget.py
git commit -m "feat: classify runtime context authority"
```

### Task 4: Persist Interrupted Turns As Developer Context

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/services/transcript_projection.py`
- Test: `tests/unit/application/test_turn_recovery_and_budget.py`
- Test: `tests/unit/services/test_transcript_projection.py`

- [ ] **Step 1: Change interruption tests to require developer role**

Update assertions to require:

```python
assert conversation.messages[-1].role == "developer"
assert conversation.messages[-1].metadata["event_kind"] == "turn_aborted_marker"
```

Retain assertions that transcript projection hides the marker.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py tests/unit/services/test_transcript_projection.py -q
```

Expected: FAIL because the interrupted marker is currently a user message.

- [ ] **Step 3: Store the marker as developer context**

Change both the turn item metadata and conversation message:

```python
metadata = {
    "role": "developer",
    "event_kind": "turn_aborted_marker",
    "interrupted_turn_id": turn_id,
}
conversation.append(Message(role="developer", content=INTERRUPTED_TURN_MARKER, metadata=metadata))
```

Keep the warning turn item separate for UI diagnostics. Continue repairing missing tool results before appending the interruption marker.

- [ ] **Step 4: Run focused tests**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py tests/unit/services/test_transcript_projection.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit interruption authority fix**

```bash
git add src/mycli/application/runtime/turn_executor.py src/mycli/services/transcript_projection.py tests/unit/application/test_turn_recovery_and_budget.py tests/unit/services/test_transcript_projection.py
git commit -m "fix: replay interrupted turns as developer context"
```

### Task 5: Project Append-Only Responses Input

**Files:**
- Modify: `src/mycli/application/runtime/request/request_pipeline.py`
- Modify: `src/mycli/application/runtime/request/request_shape_builder.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Test: `tests/unit/services/test_request_shape_builder.py`
- Test: `tests/unit/services/test_cache_stability_regressions.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write a two-turn strict-extension regression test**

Build two Responses request shapes from a shared persisted history and assert:

```python
first_input = serializer.serialize_items(first_runtime_items)
second_input = serializer.serialize_items(second_runtime_items)

assert second_input[: len(first_input)] == first_input
assert second_input[-1]["role"] == "user"
assert second_input[-1]["content"][0]["text"] == "second question"
```

Add a second case where permissions and environment change. Assert the second request is:

```text
first input + first response output + developer permission update + user environment update + second user message
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_request_shape_builder.py tests/unit/services/test_cache_stability_regressions.py tests/unit/application/test_agent_runtime.py -q
```

Expected: FAIL because current developer/context sections are rebuilt ahead of replay and unchanged context is removed using in-memory hashes.

- [ ] **Step 3: Apply durable context projection before shape building**

Add a `previous_context_baseline: ContextBaseline | None` argument to `RequestPipeline.build_and_trace_request_shape()` and call `ContextTimelineProjector.project()` before `RequestShapeBuilder.build()`. Pass `context.context_baseline` explicitly from `TurnExecutor` through `AgentRuntime._build_and_trace_request_shape()`; the request pipeline must not read session storage itself. Remove `_apply_context_delta_projection()` and its `_previous_contextual_section_hashes` state; durable baseline comparison replaces it and works after resume.

Keep cache diagnostics based on complete logical shapes, not compressed wire deltas.

- [ ] **Step 4: Place current context updates after replay**

For Responses runtime items, use this order:

```python
items = []
items.extend(replay_before_current)
items.extend(developer_update_items)
items.extend(contextual_user_update_items)
items.append(current_user_item)
items.extend(replay_after_current)
```

`wire_instructions` remains the stable `base_instructions`. Do not emit a developer update before historical replay on later turns.

Apply the equivalent role-preserving order to provider message shapes used by dry runs and diagnostics.

- [ ] **Step 5: Preserve full logical input for HTTP**

Ensure `ResponsesRequestBuilder` receives the complete projected `input_items`. Its continuation optimizer may derive a delta only after strict prefix comparison. When capability is disabled, the payload remains:

```python
payload_body["input"] = [dict(item) for item in normalized_input]
```

Do not use `prompt_cache_key` as a substitute for strict prefix stability.

- [ ] **Step 6: Run focused Responses tests**

Run:

```bash
uv run pytest tests/unit/services/test_request_shape_builder.py tests/unit/services/test_cache_stability_regressions.py tests/unit/application/test_agent_runtime.py tests/unit/infrastructure/test_responses_request_builder.py tests/unit/infrastructure/test_openai_responses_client.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit append-only Responses projection**

```bash
git add src/mycli/application/runtime/request/request_pipeline.py src/mycli/application/runtime/request/request_shape_builder.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py tests/unit/services/test_request_shape_builder.py tests/unit/services/test_cache_stability_regressions.py tests/unit/application/test_agent_runtime.py
git commit -m "fix: make responses context append only"
```

### Task 6: Verify Protocol Compatibility And Resume

**Files:**
- Test: `tests/unit/infrastructure/test_provider_adapters.py`
- Test: `tests/unit/infrastructure/test_anthropic_messages_client.py`
- Test: `tests/unit/test_compaction_transcript_validity.py`
- Test: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Add compatibility tests for developer replay**

Assert that:

```python
assert openai_messages[0]["role"] == "developer"
assert deepseek_messages[0]["role"] == "system"
assert qwen_messages[0]["role"] == "developer"
```

OpenAI and Qwen keep the canonical developer role. DeepSeek continues using its existing adapter behavior that normalizes developer messages to system messages.

Add a resume fixture with a legacy role-less baseline and a new developer baseline. Both must load, while only the new baseline replays as developer.

Add regression assertions that Anthropic still places developer policy in its system representation, Responses reasoning/tool-call/tool-result blocks remain native provider items, and API-only history records do not appear in any provider payload.

- [ ] **Step 2: Run protocol and resume tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_provider_adapters.py tests/unit/infrastructure/test_anthropic_messages_client.py tests/unit/test_compaction_transcript_validity.py tests/integration/test_cli_repl.py -q
```

Expected: PASS.

- [ ] **Step 3: Run formatting and type-oriented checks**

Run:

```bash
uv run ruff check src/mycli tests/unit tests/integration/test_cli_repl.py
uv run ruff format --check src/mycli tests/unit tests/integration/test_cli_repl.py
```

Expected: both commands exit 0.

- [ ] **Step 4: Run the complete Python test suite**

Run:

```bash
uv run pytest -q
```

Expected: PASS. If unrelated dirty-worktree tests fail, record the exact failures and confirm focused role/Responses suites remain green.

- [ ] **Step 5: Commit compatibility adjustments**

```bash
git add tests/unit/infrastructure/test_provider_adapters.py tests/unit/infrastructure/test_anthropic_messages_client.py tests/unit/test_compaction_transcript_validity.py tests/integration/test_cli_repl.py
git commit -m "test: verify canonical roles across providers"
```

## Deferred Follow-Up

Responses WebSocket v2, `generate=false` prewarm, live `previous_response_id` ownership, and session-scoped HTTP fallback are intentionally excluded. They should consume the complete logical input established by this plan and must not alter canonical history.
