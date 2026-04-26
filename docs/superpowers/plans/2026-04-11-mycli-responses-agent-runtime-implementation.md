# mycli Responses Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `mycli` from a minimally compatible Responses client to a Responses-native agent runtime that understands reasoning/tool-call output and can display execution progress in both non-streaming and streaming modes.

**Architecture:** Keep the existing block/item-first runtime contract, but expand the Responses adapter so it can map `reasoning`, `summary`, `function_call`, and `message/output_text` into richer runtime blocks and metadata. Then add a streaming path to the Responses client and runtime that reuses the same activity/event model so CLI rendering stays simple.

**Tech Stack:** Python 3.13, standard library `urllib`/`json`/`dataclasses`, `pytest`, `ruff`, existing `AgentRuntime`, `ResponsesModelAdapter`, CLI activity stream, workspace logging

---

## Scope Check

This plan only covers the Responses-native agent runtime and execution visibility approved in [2026-04-11-mycli-responses-agent-runtime-design.md](/Users/cosmos/Desktop/mycli/docs/superpowers/specs/2026-04-11-mycli-responses-agent-runtime-design.md). It does not include hosted OpenAI tools, multimodal output, or a full TUI redesign.

## File Structure

- Modify: `src/mycli/domain/runtime/blocks.py`
  Extend `ModelTurnResult` to carry provider metadata needed by non-streaming and streaming consumers.
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
  Add a streaming entrypoint and normalize Responses provider events into a small internal event stream.
- Modify: `src/mycli/infrastructure/models/responses_adapter.py`
  Expand item parsing to support `reasoning`, richer `message` output, unknown-item warning handling, and metadata retention.
- Modify: `src/mycli/application/runtime/agent_runtime.py`
  Consume Responses-derived reasoning blocks as first-class activity events and introduce a streaming turn loop.
- Modify: `src/mycli/cli/main.py`
  Render richer activity/progress output and support streamed assistant text updates without breaking current REPL behavior.
- Modify: `src/mycli/domain/runtime/__init__.py`
  Add any response/stream metadata or response payload fields required for richer front-end rendering.
- Modify: `src/mycli/services/workspace_log_service.py`
  Add warning logging helpers or event categories if unknown Responses items / streaming events need observability.
- Test: `tests/unit/infrastructure/models/test_responses_adapter.py`
  Cover `reasoning`, `message`, `function_call`, unknown item handling, and metadata preservation.
- Modify: `tests/unit/infrastructure/test_openai_responses_client.py`
  Cover non-streaming + streaming request/response paths and event parsing.
- Modify: `tests/unit/application/test_agent_runtime.py`
  Cover reasoning-derived activities, streamed model output, and tool execution continuity.
- Modify: `tests/unit/cli/test_main.py`
  Cover richer activity rendering and streamed answer display.

## Task 1: Expand the non-streaming Responses semantic adapter

**Files:**
- Modify: `src/mycli/domain/runtime/blocks.py`
- Modify: `src/mycli/infrastructure/models/responses_adapter.py`
- Test: `tests/unit/infrastructure/models/test_responses_adapter.py`

- [ ] **Step 1: Write the failing adapter tests for reasoning and metadata**

```python
def test_responses_adapter_maps_reasoning_summary_to_reasoning_blocks() -> None:
    adapter = ResponsesModelAdapter(client=FakeResponsesClient())
    result = adapter._to_model_turn_result(
        {
            "id": "resp_123",
            "status": "completed",
            "usage": {"total_tokens": 42},
            "output": [
                {
                    "id": "rs_1",
                    "type": "reasoning",
                    "status": "completed",
                    "summary": [
                        {"type": "summary_text", "text": "I should inspect pyproject.toml first."}
                    ],
                }
            ],
        }
    )

    block = result.items[0].blocks[0]
    assert block.type == "reasoning"
    assert block.text == "I should inspect pyproject.toml first."
    assert block.metadata["provider_item_type"] == "reasoning"
    assert result.metadata["response_status"] == "completed"
```

- [ ] **Step 2: Run the targeted adapter tests and confirm they fail**

Run: `uv run pytest tests/unit/infrastructure/models/test_responses_adapter.py -k "reasoning or metadata" -v`

Expected: FAIL because `reasoning` items and `ModelTurnResult.metadata` are not supported yet.

- [ ] **Step 3: Extend the runtime turn result contract minimally**

```python
@dataclass(slots=True, frozen=True)
class ModelTurnResult:
    items: tuple[RuntimeItem, ...]
    done: bool
    response_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
```

- [ ] **Step 4: Implement richer Responses item mapping**

```python
if item_type == "reasoning":
    blocks.extend(
        RuntimeBlock(
            type="reasoning",
            text=summary_text,
            provider_id=provider_id,
            metadata={
                "provider_item_type": "reasoning",
                "status": item.get("status"),
            },
        )
        for summary_text in self._reasoning_texts(item)
        if summary_text
    )
    continue
```

- [ ] **Step 5: Add conservative unknown-item handling with warnings**

```python
if item_type not in SUPPORTED_RESPONSE_ITEM_TYPES:
    self._warn_unsupported_item(item_type=item_type, provider_id=provider_id)
    continue
```

- [ ] **Step 6: Re-run adapter tests and confirm the semantic mapping is green**

Run: `uv run pytest tests/unit/infrastructure/models/test_responses_adapter.py -v`

Expected: PASS with reasoning, text, tool-call, and unknown-item coverage.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/domain/runtime/blocks.py src/mycli/infrastructure/models/responses_adapter.py tests/unit/infrastructure/models/test_responses_adapter.py
git commit -m "feat: expand responses semantic adapter"
```

## Task 2: Add a streaming Responses client surface

**Files:**
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
- Modify: `tests/unit/infrastructure/test_openai_responses_client.py`

- [ ] **Step 1: Write the failing streaming client test**

```python
def test_openai_responses_client_streams_provider_events(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("urllib.request.urlopen", fake_streaming_urlopen)
    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        log_service=WorkspaceLogService(workspace_root=tmp_path),
    )

    events = list(
        client.stream_response(
            input_items=[{"role": "user", "content": "inspect"}],
            tools=[],
        )
    )

    assert events[0]["type"] == "response.reasoning.summary_text.delta"
    assert events[-1]["type"] == "response.completed"
```

- [ ] **Step 2: Run the targeted streaming test and confirm it fails**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py -k streams_provider_events -v`

Expected: FAIL because `stream_response()` does not exist yet.

- [ ] **Step 3: Implement a minimal streaming entrypoint in the Responses client**

```python
def stream_response(
    self,
    *,
    input_items: list[dict[str, object]],
    tools: list[dict[str, object]] | None = None,
) -> Iterable[dict[str, object]]:
    payload_body = {
        "model": self._model,
        "input": input_items,
        "tools": self._normalize_tool_definitions(tools or []),
        "max_output_tokens": self._max_output_tokens,
        "stream": True,
    }
    ...
    for line in response:
        parsed = self._parse_stream_line(line)
        if parsed is not None:
            yield parsed
```

- [ ] **Step 4: Log streaming lifecycle events without changing the existing non-streaming logs**

```python
self._log_service.log(
    level=LogLevel.INFO,
    event="model_stream_started",
    message="Started model stream",
    context={...},
)
```

- [ ] **Step 5: Re-run Responses client tests**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py -v`

Expected: PASS for both non-streaming and streaming tests.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/infrastructure/openai_responses_client.py tests/unit/infrastructure/test_openai_responses_client.py
git commit -m "feat: add responses streaming client"
```

## Task 3: Wire Responses reasoning and streaming into AgentRuntime

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write the failing runtime test for reasoning-derived activity**

```python
def test_agent_runtime_converts_responses_reasoning_into_activity_events(tmp_path: Path) -> None:
    adapter = FakeReasoningThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect the repo")

    assert any(event.kind == "thinking" for event in response.activity_events)
    assert any("inspect pyproject.toml first" in event.message.lower() for event in response.activity_events)
```

- [ ] **Step 2: Run the targeted runtime tests and confirm they fail**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py -k "reasoning_into_activity or streamed" -v`

Expected: FAIL because runtime does not yet promote Responses reasoning to activity events or support streamed turns.

- [ ] **Step 3: Promote reasoning blocks to first-class activity sources**

```python
if block.type == "reasoning" and block.text:
    progress_updates.append(block.text)
    activity_events.append(
        ActivityEvent(
            kind="planning" if self._looks_like_plan(block.text) else "thinking",
            message=(
                f"Planning: {block.text}"
                if self._looks_like_plan(block.text)
                else f"Thinking: {block.text}"
            ),
        )
    )
```

- [ ] **Step 4: Add a streaming model-turn path that reuses the same activity model**

```python
stream_turn = getattr(self._model_adapter, "stream_turn", None)
if callable(stream_turn):
    for event in stream_turn(items=runtime_items, tools=tools):
        self._consume_stream_event(event, activity_events, streamed_text_chunks)
```

- [ ] **Step 5: Extend `TurnResponse` only as needed for streamed assistant text fragments**

```python
@dataclass(slots=True, frozen=True)
class TurnResponse:
    assistant_message: str
    streamed_chunks: tuple[str, ...] = field(default_factory=tuple)
    ...
```

- [ ] **Step 6: Re-run runtime tests**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py -v`

Expected: PASS for reasoning-derived activity, tool execution continuity, and streamed output behavior.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/domain/runtime/__init__.py tests/unit/application/test_agent_runtime.py
git commit -m "feat: wire responses reasoning into runtime"
```

## Task 4: Render richer agent execution output in the CLI

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Write the failing CLI test for streamed and reasoning activity**

```python
def test_main_renders_reasoning_activity_and_streamed_answer(monkeypatch, tmp_path: Path) -> None:
    class FakeService:
        ...
        def handle_user_turn(self, _message: str) -> TurnResponse:
            return TurnResponse(
                assistant_message="Repository summary complete",
                activity_events=(
                    ActivityEvent(kind="thinking", message="Thinking: inspect pyproject.toml first"),
                ),
                streamed_chunks=("Repository ", "summary ", "complete"),
            )

    ...
    assert events["turn_output"] == [
        "[activity] Thinking: inspect pyproject.toml first",
        "[stream] Repository ",
        "[stream] summary ",
        "[stream] complete",
        "Repository summary complete",
    ]
```

- [ ] **Step 2: Run the targeted CLI tests and confirm they fail**

Run: `uv run pytest tests/unit/cli/test_main.py -k streamed_answer -v`

Expected: FAIL because streamed chunks are not rendered yet.

- [ ] **Step 3: Add CLI rendering for streamed assistant chunks without breaking current output**

```python
def render_stream_lines(response: object) -> list[str]:
    raw_chunks = getattr(response, "streamed_chunks", ())
    return [f"[stream] {chunk}" for chunk in raw_chunks if isinstance(chunk, str) and chunk]
```

- [ ] **Step 4: Keep activity, error, progress, plan, decision, and final message ordering stable**

```python
rendered = render_activity_lines(response)
rendered.extend(render_error_lines(response))
rendered.extend(render_stream_lines(response))
rendered.extend(f"[progress] {update}" for update in response.progress_updates)
...
rendered.append(response.assistant_message)
```

- [ ] **Step 5: Re-run CLI tests**

Run: `uv run pytest tests/unit/cli/test_main.py -v`

Expected: PASS with both current activity rendering and the new streamed-output path.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/cli/main.py tests/unit/cli/test_main.py
git commit -m "feat: render responses agent activity in cli"
```

## Task 5: Verify end-to-end behavior and logging

**Files:**
- Modify: `src/mycli/services/workspace_log_service.py`
- Modify: `tests/unit/infrastructure/test_openai_responses_client.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Add a failing test for unsupported Responses items logging warnings**

```python
def test_responses_adapter_logs_warning_for_unknown_output_item(tmp_path: Path) -> None:
    ...
    assert "unsupported_responses_item" in (tmp_path / "log" / "app.log").read_text(encoding="utf-8")
```

- [ ] **Step 2: Run the warning/logging tests and confirm they fail**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/application/test_agent_runtime.py -k "unsupported_responses_item or streaming" -v`

Expected: FAIL because unknown item warnings and stream lifecycle logging are not implemented yet.

- [ ] **Step 3: Implement minimal warning/logging support**

```python
self._workspace_log_service.log(
    level=LogLevel.WARNING,
    event="unsupported_responses_item",
    message=f"Ignored unsupported Responses item: {item_type}",
    context={"provider_id": provider_id},
)
```

- [ ] **Step 4: Run the focused verification suite**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/application/test_agent_runtime.py tests/unit/cli/test_main.py -q`

Expected: PASS

- [ ] **Step 5: Run lint verification**

Run: `uv run ruff check src/mycli/infrastructure/openai_responses_client.py src/mycli/infrastructure/models/responses_adapter.py src/mycli/application/runtime/agent_runtime.py src/mycli/cli/main.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/application/test_agent_runtime.py tests/unit/cli/test_main.py`

Expected: `All checks passed!`

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/workspace_log_service.py src/mycli/infrastructure/openai_responses_client.py src/mycli/infrastructure/models/responses_adapter.py src/mycli/application/runtime/agent_runtime.py src/mycli/cli/main.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/application/test_agent_runtime.py tests/unit/cli/test_main.py
git commit -m "feat: complete responses-native agent runtime"
```
