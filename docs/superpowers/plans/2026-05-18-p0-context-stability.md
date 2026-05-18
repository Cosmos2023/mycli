# P0 Context Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make L4 compaction reliable before the prompt is full, recover once from provider context-window errors, and restore enough recent file content after compaction to keep the same turn moving.

**Architecture:** Keep the existing `CompactionPipeline` and `LLMSummarization` ownership model. Add a buffer-aware trigger ratio to `LLMSummarization`, use the existing summarizer client for both pre-request and reactive compaction, and inject recent-file rehydration through volatile runtime reminders rather than session transcript messages.

**Tech Stack:** Python 3.13, dataclasses, pathlib, pytest, ruff, mypy. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-18-p0-context-stability.md`

---

### Task 1: Add L4 Buffer Configuration And Trigger Math

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/config/settings.py`
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `tests/unit/services/test_config_service.py`
- Modify: `tests/unit/test_l4_summarizer.py`

- [ ] **Step 1: Write failing config test**

Add this assertion to `tests/unit/services/test_config_service.py::test_resolve_config_reads_compaction_l4_settings` after the existing `compaction_l4_summarizer_model` config line:

```python
"compaction_l4_buffer_tokens = 9000",
```

Then add this assertion at the end of that test:

```python
assert config.compaction_l4_buffer_tokens == 9000
```

- [ ] **Step 2: Write failing trigger-ratio tests**

Add these tests to `tests/unit/test_l4_summarizer.py`:

```python
from mycli.services.context.compaction.pipeline import effective_l4_trigger_ratio


def test_effective_l4_trigger_ratio_uses_buffer_before_configured_ratio() -> None:
    ratio = effective_l4_trigger_ratio(
        configured_ratio=0.95,
        max_tokens=100_000,
        buffer_tokens=13_000,
    )

    assert ratio == 0.87


def test_effective_l4_trigger_ratio_keeps_lower_configured_ratio() -> None:
    ratio = effective_l4_trigger_ratio(
        configured_ratio=0.50,
        max_tokens=100_000,
        buffer_tokens=13_000,
    )

    assert ratio == 0.50


def test_effective_l4_trigger_ratio_scales_buffer_for_small_windows() -> None:
    ratio = effective_l4_trigger_ratio(
        configured_ratio=0.95,
        max_tokens=10_000,
        buffer_tokens=13_000,
    )

    assert ratio == 0.80
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py::test_resolve_config_reads_compaction_l4_settings tests/unit/test_l4_summarizer.py::test_effective_l4_trigger_ratio_uses_buffer_before_configured_ratio tests/unit/test_l4_summarizer.py::test_effective_l4_trigger_ratio_keeps_lower_configured_ratio tests/unit/test_l4_summarizer.py::test_effective_l4_trigger_ratio_scales_buffer_for_small_windows -q
```

Expected: config test fails because `AgentConfig` has no `compaction_l4_buffer_tokens`; trigger tests fail because `effective_l4_trigger_ratio` is missing.

- [ ] **Step 4: Add config field**

In `src/mycli/domain/runtime/__init__.py`, add this field to `AgentConfig` immediately after `compaction_l4_trigger_ratio`:

```python
compaction_l4_buffer_tokens: int = 13_000
```

- [ ] **Step 5: Read config and env setting**

In `src/mycli/config/settings.py`, add this block immediately after `compaction_l4_trigger_ratio_value`:

```python
compaction_l4_buffer_tokens_value = (
    env.get("MYCLI_COMPACTION_L4_BUFFER_TOKENS")
    or project_config.get("compaction_l4_buffer_tokens")
    or user_config.get("compaction_l4_buffer_tokens")
    or 13_000
)
```

Then pass it into `AgentConfig(...)` immediately after `compaction_l4_trigger_ratio`:

```python
compaction_l4_buffer_tokens=int(str(compaction_l4_buffer_tokens_value)),
```

- [ ] **Step 6: Add buffer trigger helper and wire into LLMSummarization**

In `src/mycli/services/context/compaction/pipeline.py`, add this function near `CompactionCostMetrics`:

```python
def effective_l4_trigger_ratio(
    *,
    configured_ratio: float,
    max_tokens: int,
    buffer_tokens: int,
) -> float:
    if max_tokens <= 0:
        return max(0.0, configured_ratio)
    normalized_configured = max(0.0, min(1.0, configured_ratio))
    normalized_buffer = max(0, buffer_tokens)
    if max_tokens <= normalized_buffer:
        normalized_buffer = max(0, int(max_tokens * 0.20))
    buffer_ratio = max(0.0, (max_tokens - normalized_buffer) / max_tokens)
    return min(normalized_configured, buffer_ratio)
```

In `LLMSummarization.__init__`, add a parameter and field:

```python
buffer_tokens: int = 13_000,
```

```python
self._buffer_tokens = buffer_tokens
```

Replace `_active_trigger_ratio()` with:

```python
def _active_trigger_ratio(self, max_tokens: int | None = None) -> float:
    if self._model_name is None:
        configured = self._trigger_ratio
    else:
        configured = self._trigger_ratios_by_model.get(self._model_name, self._trigger_ratio)
    if max_tokens is None:
        return configured
    return effective_l4_trigger_ratio(
        configured_ratio=configured,
        max_tokens=max_tokens,
        buffer_tokens=self._buffer_tokens,
    )
```

In `LLMSummarization.apply()`, replace:

```python
trigger_ratio = self._active_trigger_ratio()
```

with:

```python
trigger_ratio = self._active_trigger_ratio(budget.max_tokens)
```

- [ ] **Step 7: Record buffer metrics**

In every `self._last_cost_metrics = {...}` dict inside `LLMSummarization.apply()`, include:

```python
"buffer_tokens": self._buffer_tokens,
"buffer_trigger_ratio": trigger_ratio,
```

In `_estimate_cost_metrics()`, include the same two keys in the returned dict:

```python
"buffer_tokens": self._buffer_tokens,
"buffer_trigger_ratio": trigger_ratio,
```

- [ ] **Step 8: Configure runtime summarization buffer**

In `src/mycli/application/runtime/agent_runtime.py::_configure_l4_summarization`, add:

```python
summarization._buffer_tokens = config.compaction_l4_buffer_tokens
```

- [ ] **Step 9: Run tests**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py::test_resolve_config_reads_compaction_l4_settings tests/unit/test_l4_summarizer.py::test_effective_l4_trigger_ratio_uses_buffer_before_configured_ratio tests/unit/test_l4_summarizer.py::test_effective_l4_trigger_ratio_keeps_lower_configured_ratio tests/unit/test_l4_summarizer.py::test_effective_l4_trigger_ratio_scales_buffer_for_small_windows -q
```

Expected: all selected tests pass.

- [ ] **Step 10: Commit task**

```bash
git add src/mycli/domain/runtime/__init__.py src/mycli/config/settings.py src/mycli/services/context/compaction/pipeline.py src/mycli/application/runtime/agent_runtime.py tests/unit/services/test_config_service.py tests/unit/test_l4_summarizer.py
git commit -m "Trigger L4 before the prompt reaches the hard limit" -m "Add a configurable auto-compact buffer so L4 starts while there is still room to summarize and retry safely." -m "Constraint: Default buffer follows Claude Code's 13K reservation while scaling down for small test windows." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: targeted config and L4 trigger-ratio tests"
```

---

### Task 2: Add TEXT ONLY Guard To L4 Summary Prompt

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Modify: `tests/unit/test_l4_summarizer.py`

- [ ] **Step 1: Write failing prompt guard test**

Add this test to `tests/unit/test_l4_summarizer.py`:

```python
def test_summary_prompt_forbids_tools_and_non_text_outputs() -> None:
    mock_client = MagicMock()
    mock_client.complete.return_value = "summary"
    summarizer = LLMSummarization(
        trigger_ratio=0.1,
        summarizer_client=mock_client,
    )

    summarizer._call_summarizer([Message(role="user", content="summarize safely")])

    prompt = mock_client.complete.call_args.kwargs["messages"][0]["content"]
    assert "CRITICAL: Respond with TEXT ONLY." in prompt
    assert "Do NOT call tools." in prompt
    assert "Do NOT output JSON, XML, or code fences." in prompt
    assert "Do NOT continue the task." in prompt
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/test_l4_summarizer.py::test_summary_prompt_forbids_tools_and_non_text_outputs -q
```

Expected: FAIL because the prompt lacks the guard text.

- [ ] **Step 3: Update `SUMMARY_PROMPT`**

In `src/mycli/services/context/compaction/pipeline.py`, prepend this text to `SUMMARY_PROMPT`:

```python
SUMMARY_PROMPT = (
    "CRITICAL: Respond with TEXT ONLY. "
    "Do NOT call tools. "
    "Do NOT output JSON, XML, or code fences. "
    "Do NOT ask the user for confirmation. "
    "Do NOT continue the task. "
    "Only produce the summary requested below.\n\n"
    "Summarize this conversation. Output exactly these 9 sections. "
```

Keep the existing 9-section content after that prefix.

- [ ] **Step 4: Run test**

Run:

```bash
uv run pytest tests/unit/test_l4_summarizer.py::test_summary_prompt_forbids_tools_and_non_text_outputs tests/unit/test_l4_summarizer.py -q
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit task**

```bash
git add src/mycli/services/context/compaction/pipeline.py tests/unit/test_l4_summarizer.py
git commit -m "Constrain L4 summaries to text-only output" -m "The summarizer adapter already disables tools, but the prompt now also forbids tool calls and structured output for provider compatibility." -m "Constraint: No new summarizer protocol or dependency." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: L4 summarizer prompt tests"
```

---

### Task 3: Rehydrate Recent File Content After L4

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `tests/unit/test_l4_rehydration.py`
- Modify: `tests/unit/application/test_agent_runtime_l4.py`

- [ ] **Step 1: Write failing rehydration unit tests**

Add these tests to `tests/unit/test_l4_rehydration.py`:

```python
from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.runtime import AgentConfig


def test_runtime_builds_recent_file_rehydration_block(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    target = tmp_path / "src" / "app.py"
    target.write_text("def answer():\n    return 42\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=object(),
    )
    runtime.rebind_session(AgentConfig(workspace_root=tmp_path))

    reminders = runtime._build_l4_rehydration_reminders(
        {"recent_files": ["src/app.py"]}
    )

    assert len(reminders) == 1
    assert "src/app.py" in reminders[0]
    assert "def answer()" in reminders[0]
    assert "Compaction rehydration" in reminders[0]


def test_runtime_rehydration_rejects_paths_outside_workspace(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside.py"
    outside.write_text("secret = True\n", encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=object(),
    )
    runtime.rebind_session(AgentConfig(workspace_root=tmp_path))

    reminders = runtime._build_l4_rehydration_reminders(
        {"recent_files": [str(outside)]}
    )

    assert reminders == ()


def test_runtime_rehydration_truncates_large_files(tmp_path: Path) -> None:
    target = tmp_path / "large.py"
    target.write_text("x = 1\n" * 10_000, encoding="utf-8")
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=object(),
    )
    runtime.rebind_session(AgentConfig(workspace_root=tmp_path))

    reminders = runtime._build_l4_rehydration_reminders(
        {"recent_files": ["large.py"]}
    )

    assert reminders
    assert "truncated" in reminders[0].lower()
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/test_l4_rehydration.py::test_runtime_builds_recent_file_rehydration_block tests/unit/test_l4_rehydration.py::test_runtime_rehydration_rejects_paths_outside_workspace tests/unit/test_l4_rehydration.py::test_runtime_rehydration_truncates_large_files -q
```

Expected: FAIL because `_build_l4_rehydration_reminders` is missing.

- [ ] **Step 3: Add runtime rehydration helper**

In `src/mycli/application/runtime/agent_runtime.py`, add these constants near the imports:

```python
_L4_REHYDRATION_MAX_FILES = 3
_L4_REHYDRATION_MAX_FILE_TOKENS = 5_000
_L4_REHYDRATION_MAX_TOTAL_TOKENS = 15_000
```

Then add this method to `AgentRuntime` near `_record_context_window_metrics`:

```python
def _build_l4_rehydration_reminders(
    self,
    cost_metrics: dict[str, int | float | str | list[str]] | None,
) -> tuple[str, ...]:
    if cost_metrics is None:
        return ()
    raw_files = cost_metrics.get("recent_files")
    if not isinstance(raw_files, list):
        return ()
    workspace_root = self._config.workspace_root.resolve()
    remaining_total = _L4_REHYDRATION_MAX_TOTAL_TOKENS
    blocks: list[str] = []
    seen: set[str] = set()
    for raw_path in raw_files:
        if len(blocks) >= _L4_REHYDRATION_MAX_FILES:
            break
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        display_path = raw_path.strip()
        if display_path in seen:
            continue
        seen.add(display_path)
        path = Path(display_path)
        candidate = path if path.is_absolute() else workspace_root / path
        try:
            resolved = candidate.resolve()
            resolved.relative_to(workspace_root)
        except (OSError, ValueError):
            continue
        if not resolved.is_file():
            continue
        try:
            content = resolved.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        file_tokens = self._token_counter.count(content)
        token_limit = min(_L4_REHYDRATION_MAX_FILE_TOKENS, remaining_total)
        truncated = False
        while file_tokens > token_limit and content:
            truncated = True
            content = content[: max(1, int(len(content) * 0.8))]
            file_tokens = self._token_counter.count(content)
        if not content or token_limit <= 0:
            break
        remaining_total -= min(file_tokens, token_limit)
        suffix = "\n[truncated]" if truncated else ""
        relative_display = str(resolved.relative_to(workspace_root))
        blocks.append(
            f"### {relative_display}\n"
            f"```text\n{content}{suffix}\n```"
        )
    if not blocks:
        return ()
    return (
        "[Compaction rehydration]\n"
        "Recent file snapshots are current disk content. "
        "Use them as context, and re-read files if exact content matters.\n\n"
        + "\n\n".join(blocks),
    )
```

- [ ] **Step 4: Replace reminder-only injection**

In `src/mycli/application/runtime/turn_executor.py`, replace both calls to `_apply_l4_recent_file_hints(...)` with this expression:

```python
runtime_reminders = tuple(
    dict.fromkeys(
        (
            *runtime_reminders,
            *runtime._build_l4_rehydration_reminders(
                runtime._compaction_pipeline.llm_summarization.last_cost_metrics
            ),
            *_apply_l4_recent_file_hints(
                (),
                runtime._compaction_pipeline.llm_summarization.last_cost_metrics,
            ),
        )
    )
)
```

Keep `_apply_l4_recent_file_hints` for the short fallback reminder.

- [ ] **Step 5: Write integration test that rehydration is volatile**

Add this test to `tests/unit/application/test_agent_runtime_l4.py`:

```python
def test_agent_runtime_l4_rehydrates_recent_file_without_persisting_snapshot(
    tmp_path: Path,
) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "target.py").write_text(
        "VALUE = 'current after compaction'\n",
        encoding="utf-8",
    )
    adapter = SummarizingDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=10_000,
            compaction_l4_trigger_ratio=0.5,
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(34):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 80),
            )
        )
    conversation.append(
        Message(
            role="tool",
            content="read src/target.py",
            metadata={"tool_name": "Read", "path": "src/target.py"},
        )
    )
    conversation.append(Message(role="assistant", content="noted"))
    runtime._session_service.save_conversation(conversation)

    response = runtime.handle_user_turn("finish from compacted context")

    assert response.assistant_message == "done"
    main_request_text = "\n".join(message.content for message in adapter.main_requests[0])
    assert "[Compaction rehydration]" in main_request_text
    assert "VALUE = 'current after compaction'" in main_request_text
    persisted = runtime._session_service.load_conversation(runtime._config.session_id)
    assert not any(
        "VALUE = 'current after compaction'" in message.content
        for message in persisted.messages
        if message.metadata.get("compaction") is True
    )
```

- [ ] **Step 6: Run rehydration tests**

Run:

```bash
uv run pytest tests/unit/test_l4_rehydration.py tests/unit/application/test_agent_runtime_l4.py::test_agent_runtime_l4_rehydrates_recent_file_without_persisting_snapshot -q
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit task**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py tests/unit/test_l4_rehydration.py tests/unit/application/test_agent_runtime_l4.py
git commit -m "Rehydrate recent files after L4 compaction" -m "Inject current disk snapshots through volatile runtime reminders so compacted turns keep enough context without polluting transcript history." -m "Constraint: Rehydration must stay inside workspace and budget caps." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: L4 rehydration unit and runtime tests"
```

---

### Task 4: Add Reactive Compact Retry For Context Window Errors

**Files:**
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `tests/unit/application/test_agent_runtime_l4.py`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Write failing reactive compact integration test**

In `tests/unit/application/test_agent_runtime_l4.py`, update the runtime imports to include `StopReason`:

```python
from mycli.domain.runtime import AgentConfig, ModelTurnResult, RuntimeBlock, RuntimeItem, StopReason
```

Add this import near the existing model adapter imports:

```python
from mycli.llms import ModelResponseError
```

Add this adapter to `tests/unit/application/test_agent_runtime_l4.py`:

```python
class ContextWindowThenReactiveSummaryAdapter(ModelAdapter):
    def __init__(self) -> None:
        self.main_requests: list[list[ModelMessage]] = []
        self.summarizer_prompts: list[str] = []

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        if not tools and messages and "Summarize this conversation" in messages[0].content:
            self.summarizer_prompts.append(messages[0].content)
            return ModelAction(
                assistant_message="## 1. Primary Request\nReactive summary.",
                done=True,
            )
        self.main_requests.append(messages)
        if len(self.main_requests) == 1:
            raise ModelResponseError(
                "prompt is too long",
                stop_reason=StopReason.CONTEXT_WINDOW_EXCEEDED,
                failure_kind="context_window_exceeded",
            )
        return ModelAction(assistant_message="recovered", done=True)
```

Add this test:

```python
def test_agent_runtime_reactive_compacts_once_after_context_window_error(
    tmp_path: Path,
) -> None:
    adapter = ContextWindowThenReactiveSummaryAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(
        AgentConfig(
            workspace_root=tmp_path,
            provider=ProviderId.DEEPSEEK,
            protocol=ProtocolId.CHAT_COMPLETIONS,
            model="deepseek-v4-flash",
            max_prompt_tokens=100_000,
            compaction_l4_trigger_ratio=0.95,
        )
    )
    conversation = Conversation(session_id=runtime._config.session_id)
    for index in range(20):
        conversation.append(
            Message(
                role="user" if index % 2 == 0 else "assistant",
                content=f"message {index} " + ("token " * 50),
            )
        )
    runtime._session_service.save_conversation(conversation)

    response = runtime.handle_user_turn("recover from provider overflow")

    assert response.assistant_message == "recovered"
    assert len(adapter.summarizer_prompts) == 1
    assert len(adapter.main_requests) == 2
    retry_text = "\n".join(message.content for message in adapter.main_requests[1])
    assert "Reactive summary." in retry_text
    metrics = runtime._compaction_pipeline.llm_summarization.last_cost_metrics
    assert metrics is not None
    assert metrics["source"] == "reactive_error"
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime_l4.py::test_agent_runtime_reactive_compacts_once_after_context_window_error -q
```

Expected: FAIL because context-window recovery does not call L4 compaction before retry.

- [ ] **Step 3: Add force/source parameters to LLMSummarization**

In `src/mycli/services/context/compaction/pipeline.py`, change `LLMSummarization.apply` signature to:

```python
def apply(
    self,
    conversation: Conversation,
    zones: CacheZones,
    budget: ContextBudget,
    *,
    snapshot: FullContextSnapshot | None = None,
    force: bool = False,
    source: str = "pre_request",
) -> Conversation:
```

Replace the threshold check with:

```python
trigger_ratio = self._active_trigger_ratio(budget.max_tokens)
if not force and budget.usage_ratio < trigger_ratio:
    self._last_cost_metrics = {
        "decision": "skip_threshold",
        "trigger_ratio": trigger_ratio,
        "usage_ratio": budget.usage_ratio,
        "buffer_tokens": self._buffer_tokens,
        "buffer_trigger_ratio": trigger_ratio,
        "source": source,
    }
    return conversation
```

Add `"source": source` to the other `last_cost_metrics` and `cost_metrics` paths in `apply()`.

- [ ] **Step 4: Extend LoopState**

In `src/mycli/application/runtime/turn_executor.py`, change `LoopState` to:

```python
@dataclass(slots=True, frozen=True)
class LoopState:
    context_window_retries: int = 0
    transport_retries: int = 0
    output_token_retries: int = 0
    context_recovery_stage: str | None = None
    reactive_compact_attempted: bool = False
```

Update every `LoopState(...)` construction in `_recovery_action_for_model_error` to pass through:

```python
reactive_compact_attempted=loop_state.reactive_compact_attempted,
```

- [ ] **Step 5: Add context-window predicate and reactive helper**

In `src/mycli/application/runtime/turn_executor.py`, add this function near `_set_max_output_tokens`:

```python
def _is_context_window_error(exc: ModelResponseError) -> bool:
    return (
        exc.stop_reason is StopReason.CONTEXT_WINDOW_EXCEEDED
        or exc.failure_kind
        in {
            "context_window_exceeded",
            "prompt_too_long",
            "too_many_tokens",
            "max_prompt_tokens",
        }
    )
```

Inside the `except ModelResponseError as exc:` block in `_run_turn_loop`, before calling `_recovery_action_for_model_error`, insert:

```python
                if _is_context_window_error(exc) and not loop_state.reactive_compact_attempted:
                    before_reactive = conversation
                    reactive_budget = ContextBudget(
                        max_tokens=runtime._config.max_prompt_tokens,
                        total_tokens=runtime._config.max_prompt_tokens,
                    )
                    reactive_compacted = runtime._compaction_pipeline.llm_summarization.apply(
                        conversation,
                        CacheZones.from_conversation(conversation),
                        reactive_budget,
                        snapshot=runtime._full_context_snapshot(request_shape),
                        force=True,
                        source="reactive_error",
                    )
                    loop_state = LoopState(
                        context_window_retries=loop_state.context_window_retries + 1,
                        transport_retries=loop_state.transport_retries,
                        output_token_retries=loop_state.output_token_retries,
                        context_recovery_stage="reactive_compact",
                        reactive_compact_attempted=True,
                    )
                    if reactive_compacted is not before_reactive:
                        conversation = reactive_compacted
                        runtime._record_compaction_metric(
                            before_messages=before_reactive,
                            after_messages=reactive_compacted,
                        )
                        carryover_runtime_reminders = tuple(
                            dict.fromkeys(
                                (
                                    *runtime_reminders,
                                    *runtime._build_l4_rehydration_reminders(
                                        runtime._compaction_pipeline.llm_summarization.last_cost_metrics
                                    ),
                                    *_apply_l4_recent_file_hints(
                                        (),
                                        runtime._compaction_pipeline.llm_summarization.last_cost_metrics,
                                    ),
                                )
                            )
                        )
                        runtime._append_turn_item(
                            turn_id=turn_id,
                            turn_items=turn_items,
                            item=TurnItem(
                                type=TurnItemType.WARNING,
                                text="Context window exceeded. Reactive compaction applied; retrying the same turn.",
                            ),
                        )
                        continue
```

- [ ] **Step 6: Update recovery tests for LoopState field**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py -q
```

If failures are only dataclass equality or field construction, update the expected `LoopState(...)` objects to include `reactive_compact_attempted=False`.

- [ ] **Step 7: Run reactive tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime_l4.py::test_agent_runtime_reactive_compacts_once_after_context_window_error tests/unit/application/test_turn_recovery_and_budget.py -q
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit task**

```bash
git add src/mycli/services/context/compaction/pipeline.py src/mycli/application/runtime/turn_executor.py tests/unit/application/test_agent_runtime_l4.py tests/unit/application/test_turn_recovery_and_budget.py
git commit -m "Retry once with reactive L4 compaction on context overflow" -m "Provider context-window errors now trigger one forced L4 compaction in the same turn before rebuilding the request and retrying." -m "Constraint: Reactive compact is guarded by LoopState to prevent compact retry loops." -m "Confidence: medium" -m "Scope-risk: broad" -m "Tested: reactive L4 runtime and turn recovery tests"
```

---

### Task 5: Preserve Provider Input Token Restoration

**Files:**
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/application/test_agent_runtime_l4.py`

- [ ] **Step 1: Add regression assertion for session restore**

In `tests/unit/application/test_agent_runtime.py::test_agent_runtime_restores_provider_input_budget_when_rebinding_session`, keep this assertion:

```python
assert snapshot.budget_curve == (0.5,)
```

Add this assertion immediately after it:

```python
assert runtime._session_service.load_turn_rollouts("first")
```

- [ ] **Step 2: Add regression assertion for reactive compact source metrics**

In `tests/unit/application/test_agent_runtime_l4.py::test_agent_runtime_reactive_compacts_once_after_context_window_error`, keep:

```python
assert metrics["source"] == "reactive_error"
```

Add:

```python
assert metrics["decision"] == "summarize"
assert metrics["buffer_tokens"] == runtime._config.compaction_l4_buffer_tokens
```

- [ ] **Step 3: Run regression tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_restores_provider_input_budget_when_rebinding_session tests/unit/application/test_agent_runtime_l4.py::test_agent_runtime_reactive_compacts_once_after_context_window_error -q
```

Expected: both tests pass.

- [ ] **Step 4: Commit task**

```bash
git add tests/unit/application/test_agent_runtime.py tests/unit/application/test_agent_runtime_l4.py
git commit -m "Lock session token restoration through L4 changes" -m "Regression tests keep provider input token restoration and reactive compaction metrics from drifting while context recovery evolves." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: targeted provider token and reactive L4 regression tests"
```

---

### Task 6: Full Verification And Real CLI Smoke

**Files:**
- No source files should change in this task.

- [ ] **Step 1: Run formatting and type checks**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
```

Expected:

```text
All checks passed!
Success: no issues found in 189 source files
```

- [ ] **Step 2: Run full tests**

Run:

```bash
uv run pytest -q
```

Expected: all tests pass. The current baseline before this plan is `719 passed`; the final count may increase after adding tests.

- [ ] **Step 3: Run real CLI smoke for buffer and session restoration**

Run:

```bash
SESSION="smoke-p0-context-$(date +%Y%m%d%H%M%S)"
printf '不要调用任何工具，只回答 OK。\n/stats\n/fork %s-fork\n/stats\n/resume %s\n/stats\n/quit\n' "$SESSION" "$SESSION" | uv run mycli --session "$SESSION"
```

Expected output shape:

```text
OK
[stats] budget_curve=(...)
[session] forked smoke-p0-context-... -> smoke-p0-context-...-fork
[stats] budget_curve=()
[session] resumed smoke-p0-context-...
[stats] budget_curve=(same value as first stats)
```

- [ ] **Step 4: Run real CLI smoke for reactive context recovery**

Use a small test config in a temporary home so normal config is not modified:

```bash
TMP_HOME="$(mktemp -d)"
mkdir -p "$TMP_HOME/.config/mycli"
cat > "$TMP_HOME/.config/mycli/config.toml" <<'EOF'
api_key = "test-key"
api_base_url = "https://api.deepseek.com/v1"
provider = "deepseek"
protocol = "chat_completions"
model = "deepseek-chat"
max_prompt_tokens = 10000
compaction_l4_trigger_ratio = 0.95
compaction_l4_buffer_tokens = 3000
EOF
printf '请用一句话回答：context smoke。\n/stats\n/quit\n' | HOME="$TMP_HOME" uv run mycli --session smoke-reactive
```

Expected: command reaches the model, prints an assistant response, and `/stats` prints a non-empty `budget_curve`. If the provider rejects `test-key`, rerun with the real existing config and do not print config file contents.

- [ ] **Step 5: Commit verification note if source changed during fixes**

If Step 1-4 required source or test fixes, commit only those files:

```bash
git add <changed-files-from-verification>
git commit -m "Stabilize P0 context recovery verification" -m "Fixes found during full verification of buffer-triggered and reactive L4 compaction." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: ruff, mypy, pytest, CLI smoke"
```

If Step 1-4 required no changes, do not create an empty commit.
