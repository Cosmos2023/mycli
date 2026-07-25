# Codex-Style Compact Slimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's layered L1-L4 compaction with a Codex-style active-history replacement that preserves a bounded summary and the last two completed user/assistant turns.

**Architecture:** Keep `history_items` append-only for transcript replay and replace only `conversation_messages`, which is the model-visible active window. A focused replacement builder selects the exact tail and removed prefix; a trigger policy emits typed reason/phase decisions; the runtime runs one local compact turn and atomically installs the replacement. Canonical instructions and dynamic context continue to be rebuilt by the normal request pipeline.

**Tech Stack:** Python 3.13, dataclasses/enums, existing `Conversation`/`Message` domain, SQLite session store, pytest, Ruff, mypy.

---

## File Map

- Create `src/mycli/services/context/compaction/replacement.py`: canonical replacement-history selection and validation.
- Create `src/mycli/services/context/compaction/trigger.py`: typed trigger reason, phase, token status, and compatibility decision.
- Modify `src/mycli/services/context/compaction/pipeline.py`: reduce LLM summarization to removed-prefix summarization and replacement installation.
- Modify `src/mycli/services/context/compaction/__init__.py`: export the new domain types.
- Modify `src/mycli/domain/runtime/__init__.py`: add absolute compact limit and exact-tail budget configuration.
- Modify `src/mycli/config/settings.py` and `src/mycli/config/toml_format.py`: parse and persist the new settings while accepting legacy ratio settings.
- Modify `src/mycli/application/runtime/agent_runtime.py`: retain provider token status and construct compact services.
- Modify `src/mycli/application/runtime/turn_executor.py`: replace duplicate L4 checks with one pre-sampling decision and one mid-turn decision.
- Modify `src/mycli/application/runtime/context/runtime_context_builder.py`: stop injecting separate compact summaries and heavy rehydration.
- Modify `src/mycli/state/session_service.py`: atomically install active replacement history without rewriting durable `history_items`.
- Modify `src/mycli/cli/slash_command_registry.py`, `src/mycli/cli/slash_command_dispatch.py`, and `src/mycli/application/turn_service.py`: expose manual `/compact` through the same replacement path.
- Modify TUI compaction projection only if event fields change; preserve the existing compact lifecycle cell.

### Task 1: Canonical Replacement Builder

**Files:**
- Create: `src/mycli/services/context/compaction/replacement.py`
- Modify: `src/mycli/services/context/compaction/__init__.py`
- Test: `tests/unit/services/context/compaction/test_replacement.py`

- [ ] **Step 1: Write failing tests for exact-tail selection**

Cover completed turns, tool-preface assistant messages, interrupted turns, assistant-only fragments, and a two-turn token budget. The expected canonical shape is one user-role summary followed by chronological exact user/assistant pairs.

```python
def test_replacement_keeps_summary_and_two_final_turn_answers() -> None:
    source = conversation_with_three_completed_tool_turns()
    selection = CompactionReplacementBuilder(tail_turns=2, tail_max_tokens=2_000).select(source)
    assert [message.content for message in selection.removed_prefix][-1] == "first answer"
    assert [(message.role, message.content) for message in selection.exact_tail] == [
        ("user", "second request"),
        ("assistant", "second answer"),
        ("user", "third request"),
        ("assistant", "third answer"),
    ]
    assert all(not message.tool_calls for message in selection.exact_tail)
```

- [ ] **Step 2: Run the replacement tests and verify RED**

Run: `uv run pytest -q tests/unit/services/context/compaction/test_replacement.py`

Expected: collection fails because `CompactionReplacementBuilder` does not exist.

- [ ] **Step 3: Implement immutable selection types and builder**

```python
@dataclass(frozen=True, slots=True)
class CompactionSelection:
    removed_prefix: tuple[Message, ...]
    exact_tail: tuple[Message, ...]
    retained_turns: int


class CompactionReplacementBuilder:
    def select(self, conversation: Conversation) -> CompactionSelection: ...

    def build(self, *, selection: CompactionSelection, summary: str) -> Conversation:
        return Conversation(
            session_id=conversation.session_id,
            messages=[
                Message(role="user", content=summary, metadata={"compaction": True}),
                *selection.exact_tail,
            ],
        )
```

The builder groups by durable turn metadata, accepts only completed user/assistant turns, uses the last final assistant message in each turn, strips blocks/tool calls from retained answers, and evicts the oldest retained turn when over budget.

- [ ] **Step 4: Run replacement tests and existing transcript-validity tests**

Run: `uv run pytest -q tests/unit/services/context/compaction/test_replacement.py tests/unit/test_compaction_transcript_validity.py`

Expected: all pass.

- [ ] **Step 5: Commit the replacement builder**

```bash
git add src/mycli/services/context/compaction/replacement.py src/mycli/services/context/compaction/__init__.py tests/unit/services/context/compaction/test_replacement.py
git commit -m "feat: build compact replacement history"
```

### Task 2: Typed Compact Trigger Policy

**Files:**
- Create: `src/mycli/services/context/compaction/trigger.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/config/settings.py`
- Modify: `src/mycli/config/toml_format.py`
- Test: `tests/unit/services/context/compaction/test_trigger.py`
- Test: `tests/unit/services/test_config_service.py`

- [ ] **Step 1: Write failing tests for all trigger reasons**

```python
def test_context_limit_uses_provider_tokens_before_estimate() -> None:
    status = CompactTokenStatus(provider_input_tokens=87_100, estimated_request_tokens=20_000)
    decision = CompactTriggerPolicy(limit_tokens=87_000).pre_turn(status)
    assert decision.reason is CompactReason.CONTEXT_LIMIT
    assert decision.phase is CompactPhase.PRE_TURN


def test_model_downshift_precedes_context_limit() -> None:
    decision = policy.model_transition(previous=large_model, current=small_model, active_tokens=60_000)
    assert decision.reason is CompactReason.MODEL_DOWNSHIFT
```

Also cover compatibility hash changes, mid-turn estimates, manual compact, no-op below limit, and ratio-to-absolute legacy migration.

- [ ] **Step 2: Run trigger tests and verify RED**

Run: `uv run pytest -q tests/unit/services/context/compaction/test_trigger.py tests/unit/services/test_config_service.py -k compact`

Expected: new trigger tests fail because typed policy is absent.

- [ ] **Step 3: Implement trigger types and policy**

```python
class CompactReason(StrEnum):
    CONTEXT_LIMIT = "context_limit"
    MODEL_DOWNSHIFT = "model_downshift"
    COMPATIBILITY_CHANGED = "compatibility_changed"
    MID_TURN_LIMIT = "mid_turn_limit"
    USER_REQUESTED = "user_requested"


class CompactPhase(StrEnum):
    PRE_TURN = "pre_turn"
    MID_TURN = "mid_turn"
    STANDALONE = "standalone"


@dataclass(frozen=True, slots=True)
class CompactDecision:
    should_compact: bool
    reason: CompactReason | None
    phase: CompactPhase
    trigger_tokens: int
    limit_tokens: int
```

Add `compaction_token_limit`, `compaction_reserved_output_tokens`, `compaction_tail_turns=2`, and `compaction_tail_max_tokens`. Derive an absolute limit from legacy ratio/buffer settings only when the new limit is unset.

- [ ] **Step 4: Run trigger and configuration tests**

Run: `uv run pytest -q tests/unit/services/context/compaction/test_trigger.py tests/unit/services/test_config_service.py`

Expected: all pass.

- [ ] **Step 5: Commit trigger policy**

```bash
git add src/mycli/services/context/compaction/trigger.py src/mycli/domain/runtime/__init__.py src/mycli/config/settings.py src/mycli/config/toml_format.py tests/unit/services/context/compaction/test_trigger.py tests/unit/services/test_config_service.py
git commit -m "feat: add codex-style compact triggers"
```

### Task 3: Slim Local Summarization

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Test: `tests/unit/services/context/compaction/test_pipeline.py`
- Test: `tests/unit/application/test_agent_runtime_l4.py`

- [ ] **Step 1: Replace legacy expectations with failing summary-scope tests**

```python
def test_local_compact_summarizes_removed_prefix_only() -> None:
    summarizer = CapturingSummarizer("summary")
    result = service.compact(conversation, decision)
    assert summarizer.messages == selection.removed_prefix
    assert [(m.role, m.content) for m in result.messages] == [
        ("user", compact_marker("summary")),
        ("user", "recent request"),
        ("assistant", "recent answer"),
    ]
```

Assert that tool schemas, runtime reminders, exact tail, files, and skill bodies never enter the summarizer request.

- [ ] **Step 2: Run pipeline tests and verify RED**

Run: `uv run pytest -q tests/unit/services/context/compaction/test_pipeline.py tests/unit/application/test_agent_runtime_l4.py`

Expected: failures show the old assistant summary, continuation marker, full request snapshot, and rehydration behavior.

- [ ] **Step 3: Reduce `LLMSummarization` to a local compact service**

The service accepts `CompactionSelection` and `CompactDecision`, invokes the summarizer with tools and thinking disabled, validates non-empty bounded text, prefixes it with a compact marker, and delegates replacement construction to `CompactionReplacementBuilder`.

Define a `CompactProvider` protocol returning untrusted replacement messages. The local
provider returns one summary message; a normalizer drops provider-returned developer/context
wrappers, tool calls, and tool outputs before passing summary text to the same replacement
builder. Add a fake native provider test proving local and native paths produce identical
canonical history.

Remove summary generation from `CompactionPipeline.apply()` and delete the assistant continuation message. Keep bounded tool-result projection at tool-result ingestion rather than as an L1 compaction stage.

- [ ] **Step 4: Run pipeline and model-request tests**

Run: `uv run pytest -q tests/unit/services/context/compaction/test_pipeline.py tests/unit/application/test_agent_runtime_l4.py tests/unit/application/test_model_turn_requester.py`

Expected: all pass with one summary message and no continuation marker.

- [ ] **Step 5: Commit slim summarization**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/services/context/compaction/test_pipeline.py tests/unit/application/test_agent_runtime_l4.py
git commit -m "refactor: slim local compaction summary"
```

### Task 4: Runtime Trigger Integration

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/runtime/context/runtime_context_builder.py`
- Modify: `src/mycli/services/context/turn_context_assembler.py`
- Test: `tests/unit/application/test_turn_executor.py`
- Test: `tests/unit/application/test_turn_recovery_and_budget.py`
- Test: `tests/unit/application/test_agent_runtime_l4.py`

- [ ] **Step 1: Write failing runtime tests for pre-turn and mid-turn compact**

Assert one compact attempt per sampling boundary, provider usage priority, no compact during pending approval/clarification, mid-turn compact only after tool results complete, and forced compact on context-overflow retry.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `uv run pytest -q tests/unit/application/test_turn_executor.py tests/unit/application/test_turn_recovery_and_budget.py tests/unit/application/test_agent_runtime_l4.py -k compact`

Expected: old duplicate conversation/request-budget compaction calls violate the new assertions.

- [ ] **Step 3: Install one pre-sampling decision path**

```python
decision = runtime._compact_trigger_policy.pre_turn(
    runtime._compact_token_status(request_shape=request_shape)
)
if decision.should_compact:
    conversation = runtime._compact_active_history(conversation, decision=decision)
    request_shape = runtime._rebuild_request_after_compact(...)
```

Run the same helper after completed tool batches with `CompactPhase.MID_TURN`. Remove the full-context snapshot summary path and the separate file/skill rehydration injection. Context-overflow recovery invokes the helper with a forced `CONTEXT_LIMIT` decision once.

- [ ] **Step 4: Run runtime regression tests**

Run: `uv run pytest -q tests/unit/application/test_turn_executor.py tests/unit/application/test_turn_recovery_and_budget.py tests/unit/application/test_agent_runtime_l4.py tests/unit/application/test_agent_runtime.py`

Expected: all pass.

- [ ] **Step 5: Commit runtime integration**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/context/runtime_context_builder.py src/mycli/services/context/turn_context_assembler.py tests/unit/application/test_turn_executor.py tests/unit/application/test_turn_recovery_and_budget.py tests/unit/application/test_agent_runtime_l4.py tests/unit/application/test_agent_runtime.py
git commit -m "refactor: install compact replacement at sampling boundaries"
```

### Task 5: Persistence, Replay, And Manual Compact

**Files:**
- Modify: `src/mycli/state/session_service.py`
- Modify: `src/mycli/services/history_replay.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/slash_command_registry.py`
- Modify: `src/mycli/cli/slash_command_dispatch.py`
- Test: `tests/unit/services/test_session_service.py`
- Test: `tests/unit/services/test_history_replay.py`
- Test: `tests/unit/cli/test_slash_command_dispatch.py`

- [ ] **Step 1: Write failing persistence and `/compact` tests**

Assert that installing replacement changes `conversation_messages`, leaves `history_items` unchanged, survives resume, preserves fork/rollback behavior, and records a compact checkpoint event. `/compact` must use `USER_REQUESTED/STANDALONE` and must not create a model-visible slash message.

- [ ] **Step 2: Run persistence tests and verify RED**

Run: `uv run pytest -q tests/unit/services/test_session_service.py tests/unit/services/test_history_replay.py tests/unit/cli/test_slash_command_dispatch.py -k compact`

Expected: active replacement and manual command APIs are missing.

- [ ] **Step 3: Implement atomic active-window installation**

```python
def install_compact_replacement(
    self,
    session_id: str,
    *,
    replacement: Conversation,
    checkpoint: CompactCheckpoint,
) -> None:
    self.save_conversation(replacement)
    self.append_turn_rollout(session_id, checkpoint.to_rollout())
```

Do not call the existing destructive `compact_history()` from the runtime path. Clear Responses continuation state after replacement and register `/compact` as a local control command that invokes the same service.

- [ ] **Step 4: Run persistence, resume, fork, and CLI tests**

Run: `uv run pytest -q tests/unit/services/test_session_service.py tests/unit/services/test_history_replay.py tests/unit/cli/test_slash_command_dispatch.py tests/integration/test_cli_repl.py`

Expected: all pass.

- [ ] **Step 5: Commit persistence and manual compact**

```bash
git add src/mycli/state/session_service.py src/mycli/services/history_replay.py src/mycli/application/turn_service.py src/mycli/cli/slash_command_registry.py src/mycli/cli/slash_command_dispatch.py tests/unit/services/test_session_service.py tests/unit/services/test_history_replay.py tests/unit/cli/test_slash_command_dispatch.py tests/integration/test_cli_repl.py
git commit -m "feat: persist compact active-window checkpoints"
```

### Task 6: Remove Legacy Weight And Verify

**Files:**
- Modify: `src/mycli/services/context/context_manager.py`
- Modify: `src/mycli/services/context/compaction/rehydration.py`
- Modify: `src/mycli/application/runtime/request/request_shape_builder.py`
- Modify: tests that explicitly assert legacy rehydration or L1-L4 behavior.

- [ ] **Step 1: Delete unreachable compact summary and rehydration paths**

Remove `ContextManager.build()`, separate `session_summaries` injection for active compact history, full file/skill compact rehydration, continuation-marker handling, and obsolete L1-L4 metrics. Retain compatibility readers for old persisted summaries without injecting them into new provider requests.

- [ ] **Step 2: Run focused compaction and cache tests**

Run: `uv run pytest -q tests/unit/services/context/compaction tests/unit/application/test_agent_runtime_l4.py tests/unit/services/test_cache_stability_regressions.py tests/unit/services/test_request_shape_builder.py`

Expected: all pass and compact summaries appear once in provider payloads.

- [ ] **Step 3: Run static verification**

```bash
uv run ruff check src tests
uv run mypy src
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Run full Python and TUI suites**

```bash
uv run pytest -q
cd tui/mycli-shell && npm test
cd tui/mycli-shell && npm run typecheck
```

Expected: all tests and type checks pass.

- [ ] **Step 5: Commit cleanup**

```bash
git add src tests tui/mycli-shell
git commit -m "refactor: remove legacy layered compaction"
```
