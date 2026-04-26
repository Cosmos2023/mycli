# MyCLI Visible DeepSeek Reasoning Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose DeepSeek `reasoning_content` by default in CLI activity output, trace, workspace logs, and session history while preserving DeepSeek tool-loop replay metadata.

**Architecture:** Keep `reasoning_content` stored as provider metadata on tool-call blocks. Add a runtime display helper that emits visible reasoning before tool execution, then teach CLI rendering to preserve provider reasoning text exactly instead of semanticizing or summarizing it.

**Tech Stack:** Python 3.13, dataclasses, existing mycli runtime blocks/events, pytest, ruff, mypy

---

## Scope Check

This plan covers one focused behavior change: visible DeepSeek provider reasoning. It does not add a config flag, truncation controls, non-DeepSeek metadata exposure, or changes to OpenAI Responses reasoning summaries.

## File Structure

- Modify: `src/mycli/application/runtime/agent_runtime.py`
  Responsibility: read DeepSeek `reasoning_content` from tool-call block metadata, emit visible thinking activity/progress/turn items, and write a structured workspace log event.
- Modify: `src/mycli/cli/main.py`
  Responsibility: render provider reasoning turn items exactly and completely, bypassing existing reasoning semanticization/summarization.
- Modify: `README.md`
  Responsibility: document that DeepSeek `reasoning_content` is displayed by default, fully shown in CLI, and still replayed as provider metadata.
- Modify: `tests/unit/application/test_agent_runtime_provider_metadata.py`
  Responsibility: verify runtime visibility, metadata replay preservation, malformed metadata handling, trace/session persistence, and workspace log persistence.
- Modify: `tests/unit/cli/test_main.py`
  Responsibility: verify CLI rendering preserves full provider reasoning content without semanticization or truncation.

## Task 1: Emit Visible DeepSeek Reasoning From Runtime Metadata

**Files:**
- Modify: `tests/unit/application/test_agent_runtime_provider_metadata.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`

- [x] **Step 1: Replace the runtime provider metadata test adapter with a configurable adapter**

In `tests/unit/application/test_agent_runtime_provider_metadata.py`, replace `MetadataToolThenDoneAdapter` with this configurable version:

```python
class MetadataToolThenDoneAdapter:
    def __init__(
        self,
        *,
        metadata: dict[str, object] | None = None,
        tool_call_id: str = "call_read_file_1",
    ) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []
        self.metadata = {} if metadata is None else dict(metadata)
        self.tool_call_id = tool_call_id

    def next_turn(self, *, items, tools):
        del tools
        self.seen_items.append(items)
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "mission.txt"},
                                call_id=self.tool_call_id,
                                metadata=dict(self.metadata),
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Read complete"),),
                ),
            ),
            done=True,
        )
```

Update `test_agent_runtime_preserves_tool_call_metadata_for_next_turn()` so it constructs the adapter with the explicit DeepSeek metadata:

```python
adapter = MetadataToolThenDoneAdapter(
    metadata={
        "deepseek": {
            "reasoning_content": "I need to inspect the requested file."
        }
    }
)
```

- [x] **Step 2: Add failing runtime visibility and persistence test**

Add this test to `tests/unit/application/test_agent_runtime_provider_metadata.py`:

```python
def test_agent_runtime_exposes_deepseek_reasoning_content_for_tool_call(
    tmp_path: Path,
) -> None:
    reasoning_content = (
        "The user asked for mission.txt, so I need to read that exact file before answering."
    )
    (tmp_path / "mission.txt").write_text("mission accomplished\n", encoding="utf-8")
    adapter = MetadataToolThenDoneAdapter(
        metadata={"deepseek": {"reasoning_content": reasoning_content}},
    )
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("read mission.txt")

    assert reasoning_content in response.progress_updates
    assert any(
        event.kind == "thinking" and event.message == f"Thinking: {reasoning_content}"
        for event in response.activity_events
    )
    assert response.turn is not None
    reasoning_item = next(
        item
        for item in response.turn.items
        if item.type.value == "reasoning"
        and item.metadata.get("source") == "provider_reasoning_content"
    )
    assert reasoning_item.text == f"Thinking: {reasoning_content}"
    assert reasoning_item.metadata == {
        "provider_id": None,
        "provider": "deepseek",
        "source": "provider_reasoning_content",
        "deepseek": {"reasoning_content": reasoning_content},
    }

    app_log = (tmp_path / "log" / "app.log").read_text(encoding="utf-8")
    assert "provider_reasoning_content" in app_log
    assert reasoning_content in app_log
```

- [x] **Step 3: Add failing malformed metadata test**

Add this test to `tests/unit/application/test_agent_runtime_provider_metadata.py`:

```python
def test_agent_runtime_ignores_malformed_deepseek_reasoning_metadata(
    tmp_path: Path,
) -> None:
    (tmp_path / "mission.txt").write_text("mission accomplished\n", encoding="utf-8")
    adapter = MetadataToolThenDoneAdapter(
        metadata={"deepseek": {"reasoning_content": "   "}},
    )
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("read mission.txt")

    assert response.assistant_message == "Read complete"
    assert not any(
        event.kind == "thinking" and event.message == "Thinking:    "
        for event in response.activity_events
    )
    assert response.turn is not None
    assert not any(
        item.type.value == "reasoning"
        and item.metadata.get("source") == "provider_reasoning_content"
        for item in response.turn.items
    )
```

- [x] **Step 4: Run runtime tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime_provider_metadata.py -v
```

Expected: fail because runtime preserves DeepSeek metadata but does not yet emit visible reasoning or workspace log entries.

- [x] **Step 5: Add DeepSeek reasoning metadata reader and emitter**

In `src/mycli/application/runtime/agent_runtime.py`, add this helper method near `_consume_assistant_blocks()`:

```python
    def _deepseek_reasoning_content_from_block(
        self,
        block: RuntimeBlock,
    ) -> str | None:
        deepseek_metadata = block.metadata.get("deepseek")
        if not isinstance(deepseek_metadata, dict):
            return None
        reasoning_content = deepseek_metadata.get("reasoning_content")
        if not isinstance(reasoning_content, str):
            return None
        stripped = reasoning_content.strip()
        if not stripped:
            return None
        return reasoning_content
```

Add this helper below it:

```python
    def _emit_visible_provider_reasoning(
        self,
        *,
        block: RuntimeBlock,
        turn_id: str,
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
    ) -> None:
        reasoning_content = self._deepseek_reasoning_content_from_block(block)
        if reasoning_content is None:
            return
        message = f"Thinking: {reasoning_content}"
        metadata = {
            "provider_id": block.provider_id,
            "provider": "deepseek",
            "source": "provider_reasoning_content",
            "deepseek": {"reasoning_content": reasoning_content},
        }
        progress_updates.append(reasoning_content)
        activity_events.append(ActivityEvent(kind="thinking", message=message))
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.REASONING,
                text=message,
                metadata=metadata,
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event="provider_reasoning_content",
            message="Exposed provider reasoning content",
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                **metadata,
            },
        )
```

- [x] **Step 6: Call the emitter before tool execution**

In `src/mycli/application/runtime/agent_runtime.py`, inside `_consume_assistant_blocks()`, after:

```python
                flush_pending_text()
                turn_has_tool_call = True
                tool_call = self._tool_call_from_block(block)
```

insert:

```python
                self._emit_visible_provider_reasoning(
                    block=block,
                    turn_id=turn_id,
                    progress_updates=progress_updates,
                    activity_events=activity_events,
                    turn_items=turn_items,
                )
```

This placement displays provider reasoning before unsupported-tool checks, approval checks, and tool execution. That preserves the fact that the provider emitted the reasoning before the runtime decided what to do with the requested tool.

- [x] **Step 7: Run runtime tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime_provider_metadata.py -v
```

Expected: all tests pass.

- [x] **Step 8: Run focused lint and type checks for runtime changes**

Run:

```bash
uv run ruff check src/mycli/application/runtime/agent_runtime.py tests/unit/application/test_agent_runtime_provider_metadata.py
uv run mypy src/mycli/application/runtime/agent_runtime.py
```

Expected: ruff passes and mypy reports no issues for `agent_runtime.py`.

- [x] **Step 9: Commit runtime visibility**

Run:

```bash
git add src/mycli/application/runtime/agent_runtime.py tests/unit/application/test_agent_runtime_provider_metadata.py
git commit -m "Expose DeepSeek reasoning content during tool calls" \
  -m "DeepSeek reasoning_content stored on tool-call metadata is now emitted as visible thinking activity, persisted in turn items, and written to workspace logs before tool execution." \
  -m "Constraint: reasoning_content remains provider metadata for replay" \
  -m "Rejected: Convert reasoning_content into assistant message text | would pollute final answer transcript" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/application/test_agent_runtime_provider_metadata.py -v" \
  -m "Tested: uv run ruff check src/mycli/application/runtime/agent_runtime.py tests/unit/application/test_agent_runtime_provider_metadata.py" \
  -m "Tested: uv run mypy src/mycli/application/runtime/agent_runtime.py"
```

## Task 2: Preserve Full Provider Reasoning In CLI Rendering

**Files:**
- Modify: `tests/unit/cli/test_main.py`
- Modify: `src/mycli/cli/main.py`

- [ ] **Step 1: Add failing CLI full-render test**

Add this test to `tests/unit/cli/test_main.py` near the existing `render_activity_lines` tests:

```python
def test_render_activity_lines_preserves_provider_reasoning_content_verbatim() -> None:
    reasoning_content = (
        "The user wants me to read mission.txt. "
        "I need to inspect mission.txt before answering, even if this sentence is long enough "
        "that ordinary reasoning rendering would normally summarize it."
    )
    response = TurnResponse(
        assistant_message="Read complete",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-26T00:00:00+00:00",
            completed_at="2026-04-26T00:00:01+00:00",
            items=(
                TurnItem(
                    type=TurnItemType.REASONING,
                    text=f"Thinking: {reasoning_content}",
                    metadata={
                        "provider": "deepseek",
                        "source": "provider_reasoning_content",
                        "deepseek": {"reasoning_content": reasoning_content},
                    },
                ),
                TurnItem(
                    type=TurnItemType.TOOL_CALL,
                    text="Reading: mission.txt",
                    tool_name="read_file",
                    call_id="call_read_file_1",
                ),
            ),
        ),
    )

    assert render_activity_lines(response) == [
        f"[activity] Thinking: {reasoning_content}",
        "[activity] Reading: mission.txt",
    ]
```

- [ ] **Step 2: Run CLI rendering test and verify it fails**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_render_activity_lines_preserves_provider_reasoning_content_verbatim -v
```

Expected: fail because `_render_turn_activity_lines()` currently sends all reasoning through semanticization/summarization.

- [ ] **Step 3: Add provider reasoning flush path**

In `src/mycli/cli/main.py`, add this helper near `_flush_reasoning_activity()`:

```python
def _is_provider_reasoning_item(item: TurnItem) -> bool:
    return item.metadata.get("source") == "provider_reasoning_content"
```

Add this helper below it:

```python
def _append_provider_reasoning_activity_line(
    lines: list[str],
    item: TurnItem,
) -> None:
    label, body = _split_reasoning_item(item.text)
    if label is None or not body:
        return
    _append_unique_activity_line(lines, f"[activity] {label}: {body}")
```

- [ ] **Step 4: Update turn activity rendering to bypass semanticization for provider reasoning**

In `src/mycli/cli/main.py`, inside `_render_turn_activity_lines()`, replace the top of the `if item.type == TurnItemType.REASONING:` branch with:

```python
        if item.type == TurnItemType.REASONING:
            if _is_provider_reasoning_item(item):
                _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
                reasoning_label = None
                reasoning_fragments = []
                _append_provider_reasoning_activity_line(lines, item)
                continue
            label, body = _split_reasoning_item(item.text)
            if label is None or not body:
                continue
            if reasoning_fragments and reasoning_label != label:
                _flush_reasoning_activity(lines, reasoning_label, reasoning_fragments)
                reasoning_fragments = []
            reasoning_label = label
            reasoning_fragments.append(body)
            continue
```

This preserves the existing behavior for normal reasoning and only bypasses it when `metadata["source"] == "provider_reasoning_content"`.

- [ ] **Step 5: Run CLI rendering test and verify it passes**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_render_activity_lines_preserves_provider_reasoning_content_verbatim -v
```

Expected: pass.

- [ ] **Step 6: Run the full CLI test file**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py -v
```

Expected: all tests pass.

- [ ] **Step 7: Run focused lint and type checks for CLI changes**

Run:

```bash
uv run ruff check src/mycli/cli/main.py tests/unit/cli/test_main.py
uv run mypy src/mycli/cli/main.py
```

Expected: ruff passes and mypy reports no issues for `main.py`.

- [ ] **Step 8: Commit CLI rendering**

Run:

```bash
git add src/mycli/cli/main.py tests/unit/cli/test_main.py
git commit -m "Render provider reasoning content verbatim" \
  -m "CLI activity rendering now preserves provider_reasoning_content turn items exactly instead of semanticizing or summarizing them." \
  -m "Constraint: DeepSeek reasoning_content must be shown fully in CLI output" \
  -m "Rejected: Reuse normal reasoning semanticization | would rewrite or truncate provider-returned content" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/cli/test_main.py -v" \
  -m "Tested: uv run ruff check src/mycli/cli/main.py tests/unit/cli/test_main.py" \
  -m "Tested: uv run mypy src/mycli/cli/main.py"
```

## Task 3: Update Documentation And Verify End-To-End Behavior

**Files:**
- Modify: `README.md`
- Test: `tests/unit/application/test_agent_runtime_provider_metadata.py`
- Test: `tests/unit/cli/test_main.py`
- Test: `tests/unit/infrastructure/models/test_native_tool_adapter.py`
- Test: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Update README DeepSeek reasoning wording**

In `README.md`, replace this paragraph:

```markdown
当 DeepSeek thinking mode 在工具循环中返回 provider-private `reasoning_content` 时，`mycli` 会把它保存为内部 metadata，并在工具结果 follow-up 请求里传回 DeepSeek。它不会作为 assistant 文本展示，也不会被当成用户可见 transcript 内容。
```

with:

```markdown
当 DeepSeek thinking mode 在工具循环中返回 provider-private `reasoning_content` 时，`mycli` 会默认完整展示为 `[activity] Thinking: ...`，同时把它保存为内部 metadata，并在工具结果 follow-up 请求里传回 DeepSeek。它不会作为 assistant 最终回答文本写入，但会进入 activity、trace、workspace log 和 session turn history，方便调试 DeepSeek 的工具调用推理链路。
```

- [ ] **Step 2: Run focused regression suite**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime_provider_metadata.py tests/unit/cli/test_main.py tests/unit/infrastructure/models/test_native_tool_adapter.py tests/integration/test_cli_repl.py -v
```

Expected: all selected tests pass.

- [ ] **Step 3: Run full unit and integration tests**

Run:

```bash
uv run pytest
```

Expected: all tests pass.

- [ ] **Step 4: Run lint**

Run:

```bash
uv run ruff check src tests
```

Expected: `All checks passed!`

- [ ] **Step 5: Run mypy baseline check**

Run:

```bash
uv run mypy src
```

Expected: either success, or the existing unrelated baseline failures in `responses_protocol.py`, `runtime_policy.py`, `evaluation/runner.py`, `tool_exposure_planner.py`, and `turn_executor.py`. Do not claim full mypy cleanliness if those baseline failures remain.

- [ ] **Step 6: Run a live DeepSeek visible reasoning check**

Use the existing DeepSeek API environment without printing the key. Run:

```bash
tmp_home=$(mktemp -d)
tmp_workspace=$(mktemp -d)
printf '%s\n' 'runtime task result: deepseek used mycli tools successfully' > "$tmp_workspace/mission.txt"
cd "$tmp_workspace" || exit 1
printf '%s\n%s\n' '请使用工具读取 mission.txt，然后只用一行中文总结文件内容。' '/quit' | env \
MYCLI_API_KEY="$DEEPSEEK_API_KEY" \
MYCLI_BASE_URL='https://api.deepseek.com' \
MYCLI_PROVIDER='deepseek' \
MYCLI_MODEL='deepseek-v4-flash' \
MYCLI_PROTOCOL='chat_completions' \
MYCLI_MAX_OUTPUT_TOKENS='512' \
MYCLI_THINKING_ENABLED='true' \
HOME="$tmp_home" \
uv run --project /Users/cosmos/Desktop/mycli mycli --session deepseek-visible-reasoning-live-test
```

Expected output includes:

```text
[activity] Thinking:
[activity] Reading: mission.txt
[activity] Done reading: mission.txt
```

The final assistant message should remain a one-line Chinese summary rather than the raw reasoning content.

- [ ] **Step 7: Commit docs and verification**

Run:

```bash
git add README.md
git commit -m "Document visible DeepSeek reasoning content" \
  -m "The README now states that DeepSeek reasoning_content is displayed by default as full activity output while remaining metadata for replay, trace, logs, and session history." \
  -m "Constraint: reasoning_content is visible activity, not final assistant answer text" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/application/test_agent_runtime_provider_metadata.py tests/unit/cli/test_main.py tests/unit/infrastructure/models/test_native_tool_adapter.py tests/integration/test_cli_repl.py -v" \
  -m "Tested: uv run pytest" \
  -m "Tested: uv run ruff check src tests" \
  -m "Tested: live DeepSeek visible reasoning check"
```

## Final Verification Checklist

- [ ] `uv run pytest tests/unit/application/test_agent_runtime_provider_metadata.py tests/unit/cli/test_main.py tests/unit/infrastructure/models/test_native_tool_adapter.py tests/integration/test_cli_repl.py -v`
- [ ] `uv run pytest`
- [ ] `uv run ruff check src tests`
- [ ] `uv run mypy src`
- [ ] Live DeepSeek visible reasoning check
- [ ] `git status --short` reviewed so only intended files are modified or committed

## Self-Review Notes

- Spec coverage: runtime visibility is covered by Task 1; CLI verbatim rendering is covered by Task 2; README and live verification are covered by Task 3.
- Placeholder scan: no unresolved placeholder patterns remain.
- Type consistency: plan uses existing `RuntimeBlock`, `ActivityEvent`, `TurnItem`, `TurnItemType.REASONING`, `LogLevel.INFO`, and `WorkspaceLogService.log()` signatures.
