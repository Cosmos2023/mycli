# P2 Streaming Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream model text/activity to the CLI as it arrives instead of only replaying chunks after the turn completes.

**Architecture:** Reuse the existing `stream_turn()` provider/adapter path and add a small runtime stream sink from `ModelTurnRequester` through `AgentRuntime`, `TurnExecutor`, and `TurnService` to `cli/main.py`. Render stream events as stable line-oriented CLI output for P2; do not introduce async runtime, rich live panels, or new provider protocols.

**Tech Stack:** Python 3.13, dataclasses, callable callbacks, pytest, ruff, mypy. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-20-p2-streaming-output.md`

---

## File Structure

- `src/mycli/domain/runtime/__init__.py`: add `RuntimeStreamEvent` dataclass and export it.
- `src/mycli/application/runtime/model/model_turn_requester.py`: call an optional stream sink while collecting existing stream events.
- `src/mycli/application/runtime/agent_runtime.py`: accept/pass stream sink through `handle_user_turn()` and `_request_model_turn()`.
- `src/mycli/application/runtime/turn_executor.py`: accept/pass stream sink through the turn loop.
- `src/mycli/application/turn_service.py`: expose optional stream sink from CLI into runtime.
- `src/mycli/cli/rendering.py`: render `RuntimeStreamEvent` into stable text lines.
- `src/mycli/cli/main.py`: create a CLI sink that writes realtime stream lines to `output_func`.
- `tests/unit/application/test_model_turn_requester.py`: focused requester sink tests.
- `tests/unit/application/test_agent_runtime.py`: runtime sink propagation tests.
- `tests/unit/cli/test_main.py`: rendering and CLI output ordering tests.
- `docs/superpowers/reports/2026-05-20-p2-streaming-output-smoke.md`: verification and real CLI smoke report.

---

### Task 1: Add Runtime Stream Event Domain Type

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `tests/unit/domain/test_runtime.py`

- [ ] **Step 1: Write failing domain test**

Append to `tests/unit/domain/test_runtime.py`:

```python
from mycli.domain.runtime import RuntimeStreamEvent


def test_runtime_stream_event_defaults_are_empty() -> None:
    event = RuntimeStreamEvent(kind="text_delta", text="hello")

    assert event.kind == "text_delta"
    assert event.text == "hello"
    assert event.tool_name is None
    assert event.metadata == {}
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_runtime_stream_event_defaults_are_empty -q
```

Expected: import fails because `RuntimeStreamEvent` does not exist.

- [ ] **Step 3: Add dataclass**

In `src/mycli/domain/runtime/__init__.py`, add after `ActivityEvent`:

```python
@dataclass(slots=True, frozen=True)
class RuntimeStreamEvent:
    kind: str
    text: str = ""
    tool_name: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
```

Add `"RuntimeStreamEvent"` to `__all__` near `"RuntimeRole"`.

- [ ] **Step 4: Run test to verify pass**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_runtime_stream_event_defaults_are_empty -q
```

Expected: pass.

- [ ] **Step 5: Commit task**

```bash
git add src/mycli/domain/runtime/__init__.py tests/unit/domain/test_runtime.py
git commit -m "Define runtime stream events for CLI output" -m "Introduce a small domain event used to bridge provider streaming events from runtime internals to line-oriented CLI rendering." -m "Constraint: P2 keeps streaming synchronous and line-oriented; no async runtime or rich live UI yet." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: uv run pytest tests/unit/domain/test_runtime.py::test_runtime_stream_event_defaults_are_empty -q"
```

---

### Task 2: Notify Stream Sink From ModelTurnRequester

**Files:**
- Modify: `src/mycli/application/runtime/model/model_turn_requester.py`
- Create or modify: `tests/unit/application/test_model_turn_requester.py`

- [ ] **Step 1: Write failing requester tests**

Create `tests/unit/application/test_model_turn_requester.py` if it does not exist:

```python
from __future__ import annotations

import pytest

from mycli.application.runtime.model.model_turn_requester import ModelTurnRequester
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolCall


class StreamingAdapter:
    def stream_turn(self, *, items, tools):
        del items, tools
        yield {"type": "reasoning", "text": "thinking"}
        yield {"type": "text_delta", "text": "hello "}
        yield {
            "type": "tool_call",
            "block": RuntimeBlock(
                type="tool_call",
                tool_name="Read",
                tool_arguments={"file_path": "README.md"},
                call_id="call_1",
            ),
        }
        yield {
            "type": "completed",
            "response_id": "resp_1",
            "metadata": {"usage": {"input_tokens": 10}},
        }


class SinkFailureAdapter:
    def stream_turn(self, *, items, tools):
        del items, tools
        yield {"type": "text_delta", "text": "hello"}
        yield {"type": "completed", "response_id": "resp_1", "metadata": {}}


def _requester(adapter: object) -> ModelTurnRequester:
    return ModelTurnRequester(
        model_adapter=adapter,  # type: ignore[arg-type]
        normalize_tool_call=lambda call: call,
    )


def test_model_turn_requester_notifies_stream_sink_in_order() -> None:
    events = []

    result, chunks = _requester(StreamingAdapter()).request_model_turn(
        runtime_items=[],
        legacy_messages=[],
        tools=[],
        stream_sink=events.append,
    )

    assert chunks == ("hello ",)
    assert result.response_id == "resp_1"
    assert [event.kind for event in events] == [
        "reasoning",
        "text_delta",
        "tool_call",
        "completed",
    ]
    assert events[0].text == "thinking"
    assert events[1].text == "hello "
    assert events[2].tool_name == "Read"
    assert events[3].metadata == {"usage": {"input_tokens": 10}}


def test_model_turn_requester_ignores_stream_sink_failures() -> None:
    def failing_sink(_event):
        raise RuntimeError("display failed")

    result, chunks = _requester(SinkFailureAdapter()).request_model_turn(
        runtime_items=[],
        legacy_messages=[],
        tools=[],
        stream_sink=failing_sink,
    )

    assert chunks == ("hello",)
    assert result.response_id == "resp_1"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/application/test_model_turn_requester.py -q
```

Expected: fails because `request_model_turn()` does not accept `stream_sink`.

- [ ] **Step 3: Add stream sink support**

In `src/mycli/application/runtime/model/model_turn_requester.py`, import:

```python
from collections.abc import Callable
from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeItem, RuntimeStreamEvent
```

Change `request_model_turn()` signature:

```python
    def request_model_turn(
        self,
        *,
        runtime_items: list[RuntimeItem],
        legacy_messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
```

Pass `stream_sink=stream_sink` into `_request_streaming_turn()`.

Change `_request_streaming_turn()` signature:

```python
    def _request_streaming_turn(
        self,
        *,
        stream_turn: object,
        runtime_items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
    ) -> tuple[ModelTurnResult, tuple[str, ...]]:
```

Add helper method to `ModelTurnRequester`:

```python
    @staticmethod
    def _notify_stream_sink(
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        event: RuntimeStreamEvent,
    ) -> None:
        if stream_sink is None:
            return
        try:
            stream_sink(event)
        except Exception:
            return
```

Inside `_request_streaming_turn()`:

- After adding a reasoning block:

```python
                    self._notify_stream_sink(
                        stream_sink,
                        RuntimeStreamEvent(kind="reasoning", text=text),
                    )
```

- After adding a text delta:

```python
                    self._notify_stream_sink(
                        stream_sink,
                        RuntimeStreamEvent(kind="text_delta", text=text),
                    )
```

- After accepting a tool call block:

```python
                self._notify_stream_sink(
                    stream_sink,
                    RuntimeStreamEvent(kind="tool_call", tool_name=block.tool_name or ""),
                )
```

- After completed metadata is parsed:

```python
                self._notify_stream_sink(
                    stream_sink,
                    RuntimeStreamEvent(kind="completed", metadata=metadata),
                )
```

Do not notify for non-streaming `next_turn()` fallback.

- [ ] **Step 4: Run requester tests**

Run:

```bash
uv run pytest tests/unit/application/test_model_turn_requester.py -q
```

Expected: pass.

- [ ] **Step 5: Commit task**

```bash
git add src/mycli/application/runtime/model/model_turn_requester.py tests/unit/application/test_model_turn_requester.py
git commit -m "Emit runtime stream events from model requester" -m "Notify an optional sink as streaming model events arrive while preserving the existing accumulated ModelTurnResult path." -m "Constraint: Sink failures are isolated from model execution so display issues cannot fail a turn." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: uv run pytest tests/unit/application/test_model_turn_requester.py -q"
```

---

### Task 3: Thread Stream Sink Through Runtime And Service

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Write failing runtime propagation test**

Append to `tests/unit/application/test_agent_runtime.py` near existing streaming tests:

```python
def test_agent_runtime_forwards_stream_events_to_sink(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=StreamReasoningTextDoneAdapter(),
    )
    events = []

    response = runtime.handle_user_turn("inspect the repo", stream_sink=events.append)

    assert response.assistant_message == "Repository summary complete."
    assert [event.kind for event in events] == [
        "reasoning",
        "text_delta",
        "text_delta",
        "completed",
    ]
    assert "".join(event.text for event in events if event.kind == "text_delta") == (
        "Repository summary complete."
    )
```

- [ ] **Step 2: Write failing service propagation test**

Append to `tests/unit/cli/test_main.py`:

```python
def test_turn_service_accepts_stream_sink(tmp_path: Path) -> None:
    class Runtime:
        def __init__(self) -> None:
            self._config = SimpleNamespace(session_id="demo", workspace_root=tmp_path)
            self._tool_registry = SimpleNamespace(list_names=lambda: [])
            self.seen_sink = None

        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            self.seen_sink = stream_sink
            if stream_sink is not None:
                stream_sink(SimpleNamespace(kind="text_delta", text="hi", tool_name=None, metadata={}))
            return TurnResponse(assistant_message=f"done {message}")

    runtime = Runtime()
    service = TurnService(
        config=runtime._config,
        home_dir=tmp_path / "home",
        runtime=runtime,
    )
    events = []

    response = service.handle_user_turn("hello", stream_sink=events.append)

    assert response.assistant_message == "done hello"
    assert runtime.seen_sink is events.append
    assert events[0].text == "hi"
```

Ensure `TurnService` is imported in `tests/unit/cli/test_main.py` if not already imported:

```python
from mycli.application.turn_service import TurnService
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_forwards_stream_events_to_sink tests/unit/cli/test_main.py::test_turn_service_accepts_stream_sink -q
```

Expected: fails because `handle_user_turn()` signatures do not accept `stream_sink`.

- [ ] **Step 4: Update signatures and plumbing**

In `src/mycli/application/turn_service.py`, import for type checking if needed:

```python
from collections.abc import Callable
from mycli.domain.runtime import RuntimeStreamEvent
```

Change:

```python
    def handle_user_turn(
        self,
        user_message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
```

Call:

```python
        return cast(TurnResponse, runtime.handle_user_turn(user_message, stream_sink=stream_sink))
```

In `src/mycli/application/runtime/agent_runtime.py`, import `Callable` and `RuntimeStreamEvent`, then change:

```python
    def handle_user_turn(
        self,
        user_message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        return TurnExecutor(self).execute_user_turn(user_message, stream_sink=stream_sink)
```

Change `_request_model_turn()` to accept and pass `stream_sink`.

In `src/mycli/application/runtime/turn_executor.py`, import `Callable` and `RuntimeStreamEvent`, then:

- Change `execute_user_turn(self, user_message: str, stream_sink: ... = None)`.
- Add `stream_sink` parameter to `_run_turn_loop()`.
- Pass `stream_sink=stream_sink` in every `_run_turn_loop()` call, using `None` for approval resume paths unless the method already receives a sink.
- Pass `stream_sink=stream_sink` into `runtime._request_model_turn(...)`.

Keep `resolve_pending_approval()` blocking for P2; approval resume streaming can be added later.

- [ ] **Step 5: Run propagation tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_forwards_stream_events_to_sink tests/unit/cli/test_main.py::test_turn_service_accepts_stream_sink -q
```

Expected: pass.

- [ ] **Step 6: Run existing streaming runtime tests**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_collects_streamed_chunks_and_reasoning_activity tests/unit/application/test_agent_runtime.py::test_agent_runtime_supports_streamed_tool_call_execution -q
```

Expected: pass.

- [ ] **Step 7: Commit task**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/turn_service.py tests/unit/application/test_agent_runtime.py tests/unit/cli/test_main.py
git commit -m "Thread stream sinks through runtime turns" -m "Carry realtime stream callbacks from the service boundary down to the model requester without changing blocking callers." -m "Constraint: Approval resume remains blocking in P2; ordinary user turns get realtime stream events." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: targeted runtime and service streaming propagation tests"
```

---

### Task 4: Render Runtime Stream Events In CLI

**Files:**
- Modify: `src/mycli/cli/rendering.py`
- Modify: `src/mycli/cli/main.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Write failing renderer tests**

Append to `tests/unit/cli/test_main.py`:

```python
from mycli.cli.rendering import render_runtime_stream_event
from mycli.domain.runtime import RuntimeStreamEvent


def test_render_runtime_stream_event_formats_text_delta() -> None:
    assert render_runtime_stream_event(
        RuntimeStreamEvent(kind="text_delta", text="hello")
    ) == ["[stream] hello"]


def test_render_runtime_stream_event_formats_reasoning() -> None:
    assert render_runtime_stream_event(
        RuntimeStreamEvent(kind="reasoning", text="thinking")
    ) == ["[activity] Thinking: thinking"]


def test_render_runtime_stream_event_formats_tool_call() -> None:
    assert render_runtime_stream_event(
        RuntimeStreamEvent(kind="tool_call", tool_name="Read")
    ) == ["[activity] Tool: Read"]


def test_render_runtime_stream_event_suppresses_completed() -> None:
    assert render_runtime_stream_event(
        RuntimeStreamEvent(kind="completed", metadata={"response_status": "completed"})
    ) == []
```

- [ ] **Step 2: Write failing CLI ordering test**

Append to `tests/integration/test_cli_repl.py`:

```python
from mycli.cli.main import main
from mycli.domain.runtime import RuntimeStreamEvent, TurnResponse


def test_main_outputs_stream_events_before_final_answer(monkeypatch, tmp_path: Path) -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["hello", "/quit"])

    class FakeService:
        def __init__(self) -> None:
            self._config = type("Config", (), {"session_id": "demo"})()
            self._session_service = type(
                "Sessions",
                (),
                {"load_pending_decision": lambda _self, _session_id: None},
            )()

        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            del message
            assert stream_sink is not None
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="hello"))
            stream_sink(RuntimeStreamEvent(kind="text_delta", text=" world"))
            return TurnResponse(
                assistant_message="hello world",
                streamed_chunks=("hello", " world"),
            )

        def resolve_pending_decision(self, choice: str) -> TurnResponse:
            del choice
            return TurnResponse(assistant_message="unused")

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())
    monkeypatch.setattr("builtins.input", lambda _prompt: next(scripted_inputs))
    monkeypatch.setattr("builtins.print", outputs.append)

    assert main(["--session", "demo"], cwd=tmp_path, home=tmp_path / "home", env={"MYCLI_API_KEY": "x"}) == 0

    assert outputs.index("[stream] hello") < outputs.index("hello world")
    assert outputs.index("[stream]  world") < outputs.index("hello world")
    assert outputs.count("[stream] hello") == 1
```

If `main()` does not use monkeypatched `builtins.print` due default binding, instead call `run_repl()` with a custom handler in this test and add a unit test for `handle_user_message` helper if it has been extracted in Step 4.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_render_runtime_stream_event_formats_text_delta tests/unit/cli/test_main.py::test_render_runtime_stream_event_formats_reasoning tests/unit/cli/test_main.py::test_render_runtime_stream_event_formats_tool_call tests/unit/cli/test_main.py::test_render_runtime_stream_event_suppresses_completed tests/integration/test_cli_repl.py::test_main_outputs_stream_events_before_final_answer -q
```

Expected: renderer import/function fails and CLI does not pass stream sink.

- [ ] **Step 4: Implement renderer**

In `src/mycli/cli/rendering.py`, import `RuntimeStreamEvent` and add:

```python
def render_runtime_stream_event(event: RuntimeStreamEvent) -> list[str]:
    if event.kind == "text_delta":
        return [f"[stream] {event.text}"] if event.text else []
    if event.kind == "reasoning":
        return [f"[activity] Thinking: {event.text}"] if event.text else []
    if event.kind == "tool_call":
        return [f"[activity] Tool: {event.tool_name}"] if event.tool_name else []
    if event.kind == "completed":
        return []
    return []
```

- [ ] **Step 5: Wire CLI sink**

In `src/mycli/cli/main.py`, import `RuntimeStreamEvent` and `render_runtime_stream_event`.

Inside `main()`, add helper before `handle_user_message()`:

```python
    def emit_stream_event(event: RuntimeStreamEvent) -> None:
        for line in render_runtime_stream_event(event):
            output_func(line)
```

Change:

```python
        response = service.handle_user_turn(raw)
```

to:

```python
        response = service.handle_user_turn(raw, stream_sink=emit_stream_event)
```

Remove `render_stream_lines(response)` from final rendering in `handle_user_message()` only. Keep it in `resolve_pending_decision()` for compatibility.

- [ ] **Step 6: Run CLI tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_render_runtime_stream_event_formats_text_delta tests/unit/cli/test_main.py::test_render_runtime_stream_event_formats_reasoning tests/unit/cli/test_main.py::test_render_runtime_stream_event_formats_tool_call tests/unit/cli/test_main.py::test_render_runtime_stream_event_suppresses_completed tests/integration/test_cli_repl.py::test_main_outputs_stream_events_before_final_answer -q
```

Expected: pass.

- [ ] **Step 7: Commit task**

```bash
git add src/mycli/cli/rendering.py src/mycli/cli/main.py tests/unit/cli/test_main.py tests/integration/test_cli_repl.py
git commit -m "Render model stream events as CLI lines" -m "Emit text deltas and stream activity through the existing output function before printing the final assistant answer." -m "Constraint: P2 uses predictable line-oriented output instead of rich live terminal rendering." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: targeted CLI streaming rendering tests"
```

---

### Task 5: Full Verification And Real CLI Smoke

**Files:**
- Create: `docs/superpowers/reports/2026-05-20-p2-streaming-output-smoke.md`

- [ ] **Step 1: Run full verification**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected: all pass. Fix failures before continuing.

- [ ] **Step 2: Run real CLI streaming smoke**

Run:

```bash
printf 'Reply with exactly this short sentence: streaming smoke ok\n/quit\n' | uv run mycli --session p2-streaming-smoke
```

Expected:

- At least one `[stream]` line appears before the final assistant answer when the configured provider supports streaming.
- Final assistant answer still appears once.
- If provider falls back to blocking, no `[stream]` line appears; record fallback in the report with provider/protocol.

- [ ] **Step 3: Run usage check**

Run:

```bash
printf '/usage\n/quit\n' | uv run mycli --session p2-streaming-smoke
```

Expected: usage has at least one turn if the smoke made a model request.

- [ ] **Step 4: Write smoke report**

Create `docs/superpowers/reports/2026-05-20-p2-streaming-output-smoke.md`:

```markdown
# P2 Streaming Output Smoke Report

## Commands

- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`
- `printf 'Reply with exactly this short sentence: streaming smoke ok\n/quit\n' | uv run mycli --session p2-streaming-smoke`
- `printf '/usage\n/quit\n' | uv run mycli --session p2-streaming-smoke`

## Results

- Static verification: PASS or failure details.
- Unit verification: PASS or failure details.
- Streaming CLI smoke: observed `[stream]` lines or provider fallback details.
- Final answer: observed final assistant answer behavior.
- `/usage`: observed provider usage/cache token lines.

## Notes

- P2 uses line-oriented stream output. Rich live rendering remains future work.
- Streaming output is terminal-only and is not inserted into model context.
```

- [ ] **Step 5: Commit report**

```bash
git add docs/superpowers/reports/2026-05-20-p2-streaming-output-smoke.md
git commit -m "Record P2 streaming output smoke evidence" -m "Capture full verification and real CLI observations for line-oriented streaming output." -m "Constraint: Provider streaming support may vary; report records observed behavior rather than assuming stream availability." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: ruff, mypy, pytest, and real CLI smoke commands recorded in report"
```

---

## Plan Self-Review

- Spec coverage: runtime sink, CLI realtime rendering, no duplicate post-hoc stream replay, fallback behavior, and smoke reporting are each covered by Tasks 1-5.
- Placeholder scan: no TBD/TODO placeholders remain; each task has concrete files, code, commands, expected results, and commit instructions.
- Type consistency: `RuntimeStreamEvent` is introduced before requester/runtime/CLI tasks use it; `stream_sink` signature is consistently `Callable[[RuntimeStreamEvent], None] | None`.
