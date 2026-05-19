# P2 Capability Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the next P2 capability slice: real provider streaming, Bash background jobs, visible file history, permission v1, and CLI command polish.

**Architecture:** Keep each lane independently shippable. Reuse existing runtime boundaries: provider clients/adapters emit stream events, tools stay behind `ToolRegistry`, file history stays in `FileHistoryService`, safety stays behind approval/policy services, CLI remains line-oriented. Do not introduce async runtime, MCP defer loading, Microcompact, or new dependencies.

**Tech Stack:** Python 3.13, dataclasses, stdlib subprocess/select/threading, pytest, ruff, mypy. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-20-p2-capability-pack.md`

---

## File Structure

- `src/mycli/llms/clients/openai_chat.py`: add chat-completions streaming event generator and request logging for stream mode.
- `src/mycli/llms/adapters/native_tool_adapter.py`: expose `stream_turn()` for chat-completions providers.
- `src/mycli/llms/clients/anthropic_messages.py`: add Anthropic messages streaming event generator.
- `src/mycli/llms/adapters/anthropic_messages_adapter.py`: expose `stream_turn()` for Anthropic messages.
- `src/mycli/tools/bash.py`: move background process state behind a registry and use it from `BashTool`.
- `src/mycli/tools/bash_output.py`: new `BashOutput` tool for incremental output/status.
- `src/mycli/tools/kill_shell.py`: terminate shells through the shared registry.
- `src/mycli/tools/registry.py` and `src/mycli/cli/bootstrap.py`: register `BashOutput`.
- `src/mycli/services/file_history.py`: add list/describe APIs for snapshots.
- `src/mycli/application/turn_service.py`: expose `inspect_file_changes()` and `inspect_bashes()`.
- `src/mycli/cli/repl.py`: add `/changes` and `/bashes`.
- `src/mycli/cli/rendering.py`: render diff/change/status lines using existing line-oriented style.
- `src/mycli/services/approval/safety_policy.py` and `src/mycli/services/approval/approval_service.py`: formalize permission v1 decisions without replacing existing approval behavior.
- Tests under `tests/unit/infrastructure/models/`, `tests/unit/test_bash.py`, `tests/unit/test_kill_shell.py`, `tests/unit/tools/`, `tests/unit/services/`, `tests/unit/cli/`, and `tests/integration/`.
- Reports under `docs/superpowers/reports/`.

---

### Task 1: Provider Streaming For Chat Completions

**Files:**
- Modify: `src/mycli/llms/clients/openai_chat.py`
- Modify: `src/mycli/llms/adapters/native_tool_adapter.py`
- Modify: `tests/unit/infrastructure/models/test_native_tool_adapter.py`
- Modify: `tests/unit/infrastructure/test_openai_client.py`

- [ ] **Step 1: Write failing adapter test**

Append to `tests/unit/infrastructure/models/test_native_tool_adapter.py`:

```python
class FakeStreamingNativeClient(FakeNativeClient):
    def stream_events(self, *, input_items, tools):
        self.captured_messages = input_items
        self.captured_tools = tools
        yield ModelEvent(type=ModelEventType.REASONING_DELTA, text="I will answer directly.")
        yield ModelEvent.message_delta(text="streaming ")
        yield ModelEvent.message_delta(text="ok")
        yield ModelEvent(
            type=ModelEventType.TURN_COMPLETED,
            response_id="chatcmpl_1",
            usage={"input_tokens": 11, "output_tokens": 2},
        )


def test_native_tool_adapter_stream_turn_uses_client_stream_events() -> None:
    client = FakeStreamingNativeClient()
    adapter = NativeToolModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[
                RuntimeItem(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text="Say ok."),),
                )
            ],
            tools=[],
        )
    )

    assert [event["type"] for event in events] == [
        "reasoning",
        "text_delta",
        "text_delta",
        "completed",
    ]
    assert client.captured_messages == [{"role": "user", "content": "Say ok."}]
    assert events[-1]["metadata"] == {"usage": {"input_tokens": 11, "output_tokens": 2}}
```

- [ ] **Step 2: Run adapter test to verify failure**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_native_tool_adapter.py::test_native_tool_adapter_stream_turn_uses_client_stream_events -q
```

Expected: fails because `NativeToolModelAdapter.stream_turn()` is missing.

- [ ] **Step 3: Implement `NativeToolModelAdapter.stream_turn()`**

In `src/mycli/llms/adapters/native_tool_adapter.py`, add:

```python
    def stream_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ):
        serialized_messages = self._serialize_messages(
            self._messages_from_runtime_items(items)
        )
        serialized_tools = self._serialize_tools(tools)
        stream_events = getattr(self._client, "stream_events", None)
        if not callable(stream_events):
            raise ModelResponseError("Native tool client does not support stream_events.")
        for event in stream_events(input_items=serialized_messages, tools=serialized_tools):
            if event.type is ModelEventType.REASONING_DELTA and event.text:
                yield {"type": "reasoning", "text": event.text}
            elif event.type is ModelEventType.MESSAGE_DELTA and event.text:
                yield {"type": "text_delta", "text": event.text}
            elif event.type is ModelEventType.TOOL_CALL_REQUESTED:
                yield {
                    "type": "tool_call",
                    "block": RuntimeBlock(
                        type="tool_call",
                        tool_name=event.tool_name,
                        tool_arguments=event.tool_arguments or {},
                        call_id=event.call_id or "",
                        provider_id=event.provider_id,
                        source=event.source.value if event.source is not None else None,
                        metadata=dict(event.metadata),
                    ),
                }
            elif event.type is ModelEventType.TURN_COMPLETED:
                yield {
                    "type": "completed",
                    "response_id": event.response_id,
                    "metadata": {"usage": event.usage} if event.usage is not None else {},
                }
```

Also import `ModelEventType` and `ToolExecutionSource` from `mycli.domain.model_events` if needed. Do not call blocking `complete()` from `stream_turn()`.

- [ ] **Step 4: Run adapter test to verify pass**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_native_tool_adapter.py::test_native_tool_adapter_stream_turn_uses_client_stream_events -q
```

Expected: pass.

- [ ] **Step 5: Write failing client stream test**

Add a unit test in `tests/unit/infrastructure/test_openai_client.py` using the existing fake SDK style in that file. The test must simulate chat-completions stream chunks with:

```python
[
    {"choices": [{"delta": {"reasoning_content": "thinking"}}]},
    {"choices": [{"delta": {"content": "hello "}}]},
    {"choices": [{"delta": {"content": "world"}}]},
    {"choices": [{"delta": {"tool_calls": [{"id": "call_1", "function": {"name": "Read", "arguments": "{\"file_path\":\"README.md\"}"}}]}}]},
    {"choices": [{"finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 10, "completion_tokens": 3}},
]
```

Assert `OpenAIChatClient.stream_events(input_items=[{"role": "user", "content": "inspect"}], tools=[])` yields `ModelEventType.REASONING_DELTA`, two `ModelEventType.MESSAGE_DELTA`, `ModelEventType.TOOL_CALL_REQUESTED`, and `ModelEventType.TURN_COMPLETED`.

- [ ] **Step 6: Implement `OpenAIChatClient.stream_events()`**

In `src/mycli/llms/clients/openai_chat.py`, add:

```python
    def stream_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
    ) -> Iterator[ModelEvent]:
        payload_body = self._chat_payload_body(input_items, tools or [])
        payload_body["stream"] = True
        payload_body["stream_options"] = {"include_usage": True}
        stream = self._sdk_client.chat.completions.create(**payload_body)
        yield from self._events_from_chat_stream(stream)
```

Refactor the existing `complete()` request-body creation into a private helper `_chat_payload_body(messages, tools)` to keep blocking and streaming identical except for `stream`.

Streaming parser requirements:

- `delta.reasoning_content` -> `ModelEvent(type=ModelEventType.REASONING_DELTA, text=value)`
- `delta.content` -> `ModelEvent.message_delta(text=value)`
- accumulated `delta.tool_calls[*].function.arguments` must be parsed once finish reason is `tool_calls`, then emitted with `ModelEvent.tool_call_requested(...)`
- final event -> `ModelEvent(type=ModelEventType.TURN_COMPLETED, response_id=id, usage=normalized_usage)`

- [ ] **Step 7: Run provider streaming tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/models/test_native_tool_adapter.py::test_native_tool_adapter_stream_turn_uses_client_stream_events -q
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/mycli/llms/clients/openai_chat.py src/mycli/llms/adapters/native_tool_adapter.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/models/test_native_tool_adapter.py
git commit -m "Stream chat completion provider events" -m "Expose chat-completions stream chunks through the native tool adapter so the P2 runtime stream sink can render current provider output in realtime." -m "Constraint: P2 remains synchronous and line-oriented; no async runtime or streaming tool execution semantics." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: targeted OpenAI chat client and NativeToolModelAdapter streaming tests"
```

---

### Task 2: Provider Streaming For Anthropic Messages

**Files:**
- Modify: `src/mycli/llms/clients/anthropic_messages.py`
- Modify: `src/mycli/llms/adapters/anthropic_messages_adapter.py`
- Modify: `tests/unit/infrastructure/test_anthropic_messages_client.py`
- Modify: `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`

- [ ] **Step 1: Write failing adapter test**

Append to `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`:

```python
class FakeStreamingAnthropicMessagesClient(FakeAnthropicMessagesClient):
    def stream_message(self, *, system, messages, tools):
        self.captured_system = system
        self.captured_messages = messages
        self.captured_tools = tools
        yield {"type": "reasoning", "text": "Need a concise answer."}
        yield {"type": "text_delta", "text": "anthropic "}
        yield {"type": "text_delta", "text": "ok"}
        yield {
            "type": "completed",
            "response_id": "msg_stream_1",
            "metadata": {"usage": {"input_tokens": 9, "output_tokens": 2}},
        }


def test_anthropic_adapter_stream_turn_uses_client_stream_message() -> None:
    client = FakeStreamingAnthropicMessagesClient({"id": "unused", "content": []})
    adapter = AnthropicMessagesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[
                RuntimeItem(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text="Say ok."),),
                )
            ],
            tools=[],
        )
    )

    assert [event["type"] for event in events] == [
        "reasoning",
        "text_delta",
        "text_delta",
        "completed",
    ]
    assert client.captured_messages == [
        {"role": "user", "content": [{"type": "text", "text": "Say ok."}]}
    ]
```

- [ ] **Step 2: Run adapter test to verify failure**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_anthropic_messages_adapter.py::test_anthropic_adapter_stream_turn_uses_client_stream_message -q
```

Expected: fails because `stream_turn()` is missing.

- [ ] **Step 3: Implement adapter stream forwarding**

In `src/mycli/llms/adapters/anthropic_messages_adapter.py`, add:

```python
    def stream_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ):
        system, messages = self._serialize_items(items)
        stream_message = getattr(self._client, "stream_message", None)
        if not callable(stream_message):
            raise AttributeError("client does not support streaming")
        yield from stream_message(
            system=system,
            messages=messages,
            tools=self._serialize_tools(tools),
        )
```

- [ ] **Step 4: Add Anthropic client stream tests**

Append to `tests/unit/infrastructure/test_anthropic_messages_client.py`:

```python
class FakeMessagesStreamResource(FakeMessagesResource):
    def __init__(self) -> None:
        super().__init__({"id": "unused", "content": []})

    def stream(self, **kwargs: object):
        self.kwargs = dict(kwargs)
        return iter(
            [
                {
                    "type": "content_block_delta",
                    "delta": {"type": "thinking_delta", "thinking": "Thinking."},
                },
                {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "hello "},
                },
                {
                    "type": "content_block_delta",
                    "delta": {"type": "input_json_delta", "partial_json": "{\"file_path\":\"README.md\"}"},
                    "index": 1,
                },
                {
                    "type": "content_block_stop",
                    "index": 1,
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": {"file_path": "README.md"},
                    },
                },
                {
                    "type": "message_stop",
                    "message": {
                        "id": "msg_stream_1",
                        "usage": {"input_tokens": 9, "output_tokens": 2},
                    },
                },
            ]
        )


class FakeAnthropicStreamingSdkClient:
    def __init__(self) -> None:
        self.messages = FakeMessagesStreamResource()


def test_anthropic_client_stream_message_normalizes_events(tmp_path: Path) -> None:
    sdk_client = FakeAnthropicStreamingSdkClient()
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=4096,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )

    events = list(
        client.stream_message(
            system=None,
            messages=[{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
            tools=[],
        )
    )

    assert [event["type"] for event in events] == [
        "reasoning",
        "text_delta",
        "tool_call",
        "completed",
    ]
    assert events[0]["text"] == "Thinking."
    assert events[1]["text"] == "hello "
    assert events[2]["block"].tool_name == "Read"
    assert events[3]["response_id"] == "msg_stream_1"
    assert events[3]["metadata"] == {"usage": {"input_tokens": 9, "output_tokens": 2}}
```

- [ ] **Step 5: Implement `AnthropicMessagesClient.stream_message()`**

In `src/mycli/llms/clients/anthropic_messages.py`, add stream request code using `self._sdk_client.messages.stream(**payload_body)`. Normalize provider events to the same dictionaries used by `ModelTurnRequester`.

Required event mapping:

- `content_block_delta` with `thinking_delta.thinking` -> `{"type": "reasoning", "text": "Thinking."}`
- `content_block_delta` with `text_delta.text` -> `{"type": "text_delta", "text": "hello "}`
- `content_block_stop` for accumulated `tool_use` -> `{"type": "tool_call", "block": RuntimeBlock(type="tool_call", tool_name="Read", tool_arguments={"file_path": "README.md"}, call_id="toolu_1")}`
- `message_stop` -> completed with response id and usage

- [ ] **Step 6: Run Anthropic streaming tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_anthropic_messages_client.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py::test_anthropic_adapter_stream_turn_uses_client_stream_message -q
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/llms/clients/anthropic_messages.py src/mycli/llms/adapters/anthropic_messages_adapter.py tests/unit/infrastructure/test_anthropic_messages_client.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py
git commit -m "Stream Anthropic message provider events" -m "Expose Anthropic Messages stream deltas through the runtime stream event path so CLI realtime output works for Anthropic-compatible providers." -m "Constraint: Tool execution still starts after a complete model turn; this only streams visible model output." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: targeted Anthropic client and adapter streaming tests"
```

---

### Task 3: Bash Background Output Lifecycle

**Files:**
- Create: `src/mycli/tools/shell_registry.py`
- Create: `src/mycli/tools/bash_output.py`
- Modify: `src/mycli/tools/bash.py`
- Modify: `src/mycli/tools/kill_shell.py`
- Modify: `src/mycli/tools/registry.py`
- Modify: `src/mycli/cli/bootstrap.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `tests/unit/test_bash.py`
- Modify: `tests/unit/test_kill_shell.py`
- Create: `tests/unit/tools/test_bash_output.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/integration/test_toolset_smoke.py`

- [ ] **Step 1: Write failing shell registry tests**

Create `tests/unit/tools/test_bash_output.py`:

```python
from mycli.tools.bash import execute_bash
from mycli.tools.bash_output import BashOutputTool
from mycli.tools.kill_shell import kill_shell


def test_bash_output_reads_background_output_incrementally(tmp_path):
    result = execute_bash(
        "python3 -c \"import time; print('ready', flush=True); time.sleep(2)\"",
        workdir=str(tmp_path),
        run_in_background=True,
    )
    shell_id = str(result["shell_id"])

    output_tool = BashOutputTool()
    output = output_tool.execute({"shell_id": shell_id})

    assert output.success is True
    assert output.raw_payload["shell_id"] == shell_id
    assert "ready" in str(output.raw_payload["output"])
    assert output.raw_payload["status"] in {"running", "exited"}

    kill_shell(shell_id)


def test_bash_output_reports_missing_shell() -> None:
    output = BashOutputTool().execute({"shell_id": "missing"})

    assert output.success is False
    assert output.raw_payload["error_kind"] == "shell_not_found"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/tools/test_bash_output.py -q
```

Expected: import fails because `BashOutputTool` does not exist.

- [ ] **Step 3: Implement shell registry and BashOutput**

Create `src/mycli/tools/shell_registry.py` with:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
import os
from pathlib import Path
import subprocess
import threading
from uuid import uuid4


@dataclass(slots=True)
class ShellProcess:
    shell_id: str
    command: str
    process: subprocess.Popen[str]
    started_at: str
    output: list[str] = field(default_factory=list)
    read_offset: int = 0


class ShellProcessRegistry:
    def __init__(self) -> None:
        self._processes: dict[str, ShellProcess] = {}
        self._lock = threading.Lock()

    def start(self, command: str, *, workdir: str | None = None) -> ShellProcess:
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=workdir or os.getcwd(),
            executable=os.environ.get("SHELL", "/bin/bash"),
        )
        shell_id = uuid4().hex[:8]
        shell = ShellProcess(
            shell_id=shell_id,
            command=command,
            process=process,
            started_at=datetime.now(tz=UTC).isoformat(),
        )
        with self._lock:
            self._processes[shell_id] = shell
        threading.Thread(target=self._drain_output, args=(shell,), daemon=True).start()
        return shell

    def read(self, shell_id: str) -> dict[str, object]:
        with self._lock:
            shell = self._processes.get(shell_id)
            if shell is None:
                return {"error_kind": "shell_not_found", "error": f"No such shell: {shell_id}"}
            output = "".join(shell.output[shell.read_offset:])
            shell.read_offset = len(shell.output)
            return {
                "shell_id": shell.shell_id,
                "command": shell.command,
                "status": "running" if shell.process.poll() is None else "exited",
                "exit_code": shell.process.poll(),
                "output": output,
                "started_at": shell.started_at,
            }

    def list(self) -> list[dict[str, object]]:
        with self._lock:
            return [
                {
                    "shell_id": shell.shell_id,
                    "command": shell.command,
                    "status": "running" if shell.process.poll() is None else "exited",
                    "exit_code": shell.process.poll(),
                    "started_at": shell.started_at,
                }
                for shell in self._processes.values()
            ]

    def kill(self, shell_id: str) -> dict[str, object]:
        with self._lock:
            shell = self._processes.pop(shell_id, None)
        if shell is None:
            return {"error_kind": "shell_not_found", "error": f"No such shell: {shell_id}"}
        shell.process.terminate()
        try:
            shell.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            shell.process.kill()
            shell.process.wait()
        return {"status": "killed", "exit_code": shell.process.returncode, "shell_id": shell_id}

    def _drain_output(self, shell: ShellProcess) -> None:
        stdout = shell.process.stdout
        if stdout is None:
            return
        for line in stdout:
            with self._lock:
                shell.output.append(line)


SHELL_REGISTRY = ShellProcessRegistry()
```

Create `src/mycli/tools/bash_output.py` with a `BashOutputTool` using `SHELL_REGISTRY.read()`.

- [ ] **Step 4: Refactor Bash/KillShell to use registry**

In `src/mycli/tools/bash.py`, remove direct `subprocess.Popen` state and call `SHELL_REGISTRY.start(...)` from `_run_background()`.

In `src/mycli/tools/kill_shell.py`, call `SHELL_REGISTRY.kill(shell_id)`.

Keep `_background_processes` only if needed as a compatibility alias for old tests; prefer updating tests to inspect `SHELL_REGISTRY.list()`.

- [ ] **Step 5: Register BashOutput and CLI `/bashes`**

Add `BashOutputTool()` to both `default_tools()` and `build_turn_service()` tool registry construction.

In `src/mycli/application/turn_service.py`, add:

```python
    def inspect_bashes(self) -> tuple[str, ...]:
        from mycli.tools.shell_registry import SHELL_REGISTRY

        rows = SHELL_REGISTRY.list()
        if not rows:
            return ("no background shells",)
        return tuple(
            f"{row['shell_id']} {row['status']} exit={row['exit_code']} {row['command']}"
            for row in rows
        )
```

In `src/mycli/cli/repl.py`, add `/bashes` to help and command handler.

- [ ] **Step 6: Run Bash lifecycle tests**

Run:

```bash
uv run pytest tests/unit/test_bash.py tests/unit/test_kill_shell.py tests/unit/tools/test_bash_output.py tests/unit/cli/test_main.py::test_help_lists_sessions_command tests/integration/test_toolset_smoke.py -q
```

Expected: pass; update expected tool list to include `BashOutput`.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/tools/shell_registry.py src/mycli/tools/bash_output.py src/mycli/tools/bash.py src/mycli/tools/kill_shell.py src/mycli/tools/registry.py src/mycli/cli/bootstrap.py src/mycli/application/turn_service.py src/mycli/cli/repl.py tests/unit/test_bash.py tests/unit/test_kill_shell.py tests/unit/tools/test_bash_output.py tests/unit/cli/test_main.py tests/integration/test_toolset_smoke.py
git commit -m "Add Bash background output lifecycle" -m "Manage background Bash processes through a shared registry and expose BashOutput plus /bashes for status and incremental output." -m "Constraint: P2 does not add PTY stdin or cross-process shell recovery." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: targeted Bash, KillShell, BashOutput, CLI, and toolset smoke tests"
```

---

### Task 4: File History Listing And `/changes`

**Files:**
- Modify: `src/mycli/services/file_history.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `tests/unit/services/test_file_history.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing file history list test**

Append to `tests/unit/services/test_file_history.py`:

```python
def test_file_history_lists_recent_snapshots_with_paths(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    service = FileHistoryService(home_dir=home, workspace_root=workspace)

    snapshot = service.snapshot_path(
        session_id="demo",
        turn_id="turn_1",
        raw_path="notes.txt",
        tool_name="Edit",
    )

    rows = service.list_snapshots(session_id="demo", limit=5)

    assert rows == [
        {
            "snapshot_id": snapshot.snapshot_id,
            "turn_id": "turn_1",
            "tool_name": "Edit",
            "paths": ("notes.txt",),
        }
    ]
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_file_history.py::test_file_history_lists_recent_snapshots_with_paths -q
```

Expected: fails because `list_snapshots()` is missing.

- [ ] **Step 3: Implement `list_snapshots()`**

In `src/mycli/services/file_history.py`, add:

```python
    def list_snapshots(self, *, session_id: str, limit: int = 10) -> tuple[dict[str, object], ...]:
        rows: list[dict[str, object]] = []
        for item in reversed(self._load_index(session_id)[-limit:]):
            snapshot_id = str(item.get("snapshot_id", ""))
            turn_id = str(item.get("turn_id", ""))
            manifest_path = self._snapshot_dir(session_id, snapshot_id) / "manifest.json"
            if not snapshot_id or not manifest_path.exists():
                continue
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            entries = manifest.get("entries")
            if not isinstance(entries, list):
                continue
            paths = tuple(
                str(entry.get("path"))
                for entry in entries
                if isinstance(entry, dict) and entry.get("path")
            )
            tool_name = ""
            for entry in entries:
                if isinstance(entry, dict) and isinstance(entry.get("tool_name"), str):
                    tool_name = str(entry["tool_name"])
                    break
            rows.append(
                {
                    "snapshot_id": snapshot_id,
                    "turn_id": turn_id,
                    "tool_name": tool_name,
                    "paths": paths,
                }
            )
        return tuple(rows)
```

- [ ] **Step 4: Add `/changes` service and CLI tests**

Append to `tests/unit/cli/test_main.py`:

```python
def test_changes_command_renders_file_history_lines() -> None:
    service = SimpleNamespace(
        inspect_file_changes=lambda: ("snapshot_1 turn_1 Edit notes.txt",)
    )
    handler = build_command_handler(service)

    assert list(handler("/changes")) == ["[change] snapshot_1 turn_1 Edit notes.txt"]
```

Expected failure: `/changes` unknown.

- [ ] **Step 5: Implement service and command**

In `TurnService`, add `inspect_file_changes()` using `FileHistoryService.list_snapshots()`.

In `handle_slash_command("/help")`, add `/changes`.

In `build_command_handler()`, add:

```python
        if command == "/changes":
            return [f"[change] {line}" for line in service.inspect_file_changes()]
```

- [ ] **Step 6: Run file history and CLI tests**

Run:

```bash
uv run pytest tests/unit/services/test_file_history.py tests/unit/cli/test_main.py::test_changes_command_renders_file_history_lines tests/unit/application/test_agent_runtime.py::test_agent_runtime_file_history_undo_restores_mutating_tool_change -q
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/services/file_history.py src/mycli/application/turn_service.py src/mycli/cli/repl.py tests/unit/services/test_file_history.py tests/unit/cli/test_main.py tests/unit/application/test_agent_runtime.py
git commit -m "Expose session file change history" -m "List file history snapshots through TurnService and /changes so users can inspect recent Edit and Write recovery points before undoing them." -m "Constraint: This reuses session-aware snapshots and does not replace git or add multi-snapshot transaction rollback." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: targeted file history, CLI /changes, and runtime undo tests"
```

---

### Task 5: Permission Model V1

**Files:**
- Modify: `src/mycli/services/approval/safety_policy.py`
- Modify: `src/mycli/services/approval/approval_service.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `tests/unit/services/test_safety_policy.py`
- Modify: `tests/unit/services/test_approval_service.py`
- Modify: `tests/unit/services/test_session_service.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing deny-overrides-allowance test**

Append to `tests/unit/services/test_approval_service.py`:

```python
from mycli.domain.runtime import SessionCommandAllowance


def test_approval_service_denies_even_when_session_allowance_matches() -> None:
    service = ApprovalService(
        session_allowances=(SessionCommandAllowance(command_pattern="rm -rf /"),)
    )

    outcome = service.evaluate(
        ToolCall(
            name="Bash",
            arguments={"command": "rm -rf /"},
            reason="cleanup",
        )
    )

    assert outcome.denied_reason is not None
    assert outcome.auto_approved is False
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_approval_service.py::test_approval_service_denies_even_when_session_allowance_matches -q
```

Expected: fails because `ApprovalService` does not accept session allowances or does not apply precedence.

- [ ] **Step 3: Add permission precedence to approval service**

In `ApprovalService.__init__`, accept:

```python
session_allowances: tuple[SessionCommandAllowance, ...] = ()
```

In `evaluate()`:

1. Ask `SafetyPolicy.evaluate(call)` first.
2. If policy says deny, return deny regardless of allowance.
3. If call is Bash and command pattern matches a session allowance, auto approve only if policy is not deny.
4. If policy says needs approval, return pending approval.

Keep existing default behavior when no allowances are passed.

- [ ] **Step 4: Add workspace write boundary tests**

In `tests/unit/services/test_safety_policy.py`, add:

```python
def test_safety_policy_denies_write_outside_workspace() -> None:
    policy = SafetyPolicy(workspace_root=Path("/workspace"))

    decision = policy.evaluate(
        ToolCall(
            name="Write",
            arguments={"file_path": "../outside.txt", "content": "x"},
            reason="write outside",
        )
    )

    assert decision.allowed is False
    assert "workspace" in decision.reason.lower()
```

If `SafetyPolicy` cannot currently accept `workspace_root`, add it as optional and only enforce boundary when provided.

- [ ] **Step 5: Run permission tests**

Run:

```bash
uv run pytest tests/unit/services/test_safety_policy.py tests/unit/services/test_approval_service.py tests/unit/application/test_agent_runtime.py::test_agent_runtime_resumes_after_approval -q
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/services/approval/safety_policy.py src/mycli/services/approval/approval_service.py src/mycli/domain/runtime/__init__.py tests/unit/services/test_safety_policy.py tests/unit/services/test_approval_service.py tests/unit/application/test_agent_runtime.py
git commit -m "Formalize permission precedence rules" -m "Ensure deny decisions override session allowances and add a workspace write boundary hook for mutating tools." -m "Constraint: P2 permission v1 keeps the existing approval UX and does not introduce OS sandboxing or classifier calls." -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: targeted safety policy, approval service, and approval resume tests"
```

---

### Task 6: CLI Experience Polish For P2 Commands

**Files:**
- Modify: `src/mycli/cli/rendering.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/unit/application/test_tool_execution_service.py`

- [ ] **Step 1: Write failing diff-rendering test**

Append to `tests/unit/application/test_tool_execution_service.py`:

```python
def test_tool_execution_records_edit_diff_in_turn_item(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    path = workspace / "notes.txt"
    path.write_text("before\n", encoding="utf-8")

    class DiffEditTool(FakeEditTool):
        def execute(self, arguments: dict[str, object]) -> ToolResult:
            target = self._workspace_root / str(arguments["path"])
            before = target.read_text(encoding="utf-8")
            target.write_text(str(arguments["new_content"]), encoding="utf-8")
            return ToolResult(
                success=True,
                summary="Edited notes.txt",
                raw_payload={
                    "path": "notes.txt",
                    "diff": "@@ -1 +1 @@\n-before\n+after",
                    "before": before,
                },
            )

    edit_tool = DiffEditTool(workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([edit_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="edit_file",
            arguments={"path": "notes.txt", "new_content": "after\n"},
            reason="edit",
            call_id="call_edit_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("edit_file"),
                    source=ToolRouteSource.REGISTRY,
                    spec=edit_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    result_items = [item for item in turn_items if item.type is TurnItemType.TOOL_RESULT]
    assert result_items[0].metadata["diff"] == "@@ -1 +1 @@\n-before\n+after"
```

Expected failure: `diff` only exists inside `metadata["raw_payload"]`, not as a top-level `metadata["diff"]` value for renderers.

- [ ] **Step 2: Add rendering test**

Append to `tests/unit/cli/test_main.py`:

```python
def test_render_activity_lines_includes_edit_diff_lines() -> None:
    response = TurnResponse(
        assistant_message="done",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-04-11T00:00:00+00:00",
            completed_at="2026-04-11T00:00:01+00:00",
            items=(
                TurnItem(
                    type=TurnItemType.TOOL_RESULT,
                    text="notes.txt",
                    tool_name="Edit",
                    metadata={"diff": "@@ -1 +1 @@\n-before\n+after"},
                ),
            ),
        ),
    )

    lines = render_activity_lines(response)

    assert "[activity] Done: notes.txt" in lines
    assert "[diff] 0001 @@ -1 +1 @@" in lines
    assert "[diff] 0002 -before" in lines
    assert "[diff] 0003 +after" in lines
```

- [ ] **Step 3: Implement diff propagation and rendering**

In `ToolExecutionService._record_tool_outcome()`, before creating the `TurnItemType.TOOL_RESULT`, build metadata explicitly:

```python
result_metadata: dict[str, object] = {
    "success": result.success,
    "summary": result.summary,
    "error": result.error,
    "path": result.raw_payload.get("path"),
    "error_kind": result.raw_payload.get("error_kind"),
    "raw_payload": dict(result.raw_payload),
    "transcript_content": guarded_tool_transcript_content,
    "file_changes": self._file_changes_for_tool_result(
        call=normalized_call,
        result_payload=result.raw_payload,
    ),
}
diff = result.raw_payload.get("diff")
if isinstance(diff, str) and diff:
    result_metadata["diff"] = diff
```

Pass `metadata=result_metadata` into the `TurnItem`.

In `cli/rendering.py`, when rendering `TurnItemType.TOOL_RESULT`, append diff lines after the activity line:

```python
diff = item.metadata.get("diff")
if isinstance(diff, str) and diff:
    lines.extend(render_diff_lines(diff))
```

Prefix returned diff lines with `[diff] ` if `render_diff_lines()` does not already do that.

- [ ] **Step 4: Run CLI polish tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_render_activity_lines_includes_edit_diff_lines tests/unit/application/test_tool_execution_service.py::test_tool_execution_records_edit_diff_in_turn_item -q
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/cli/rendering.py src/mycli/application/runtime/tools/tool_execution_service.py tests/unit/cli/test_main.py tests/unit/application/test_tool_execution_service.py
git commit -m "Render edit diffs in CLI activity" -m "Carry Edit diffs from tool results into turn items and render stable line-numbered diff output in the CLI." -m "Constraint: P2 keeps text output deterministic and does not add a rich live diff panel." -m "Confidence: medium" -m "Scope-risk: narrow" -m "Tested: targeted tool execution and CLI rendering tests"
```

---

### Task 7: Full Verification And Smoke Report

**Files:**
- Create: `docs/superpowers/reports/2026-05-20-p2-capability-pack-smoke.md`
- Modify: `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`

- [ ] **Step 1: Run full verification**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 2: Run real CLI smoke**

Run:

```bash
printf 'Reply with exactly this short sentence: p2 streaming ok\n/quit\n' | uv run mycli --session p2-capability-smoke
printf '/bashes\n/changes\n/usage\n/quit\n' | uv run mycli --session p2-capability-smoke
```

Expected:

- Streaming-capable provider shows `[stream]` lines before final answer.
- `/bashes` returns no shells or current shell list.
- `/changes` returns no file history or recent snapshots.
- `/usage` returns at least one turn after model smoke.

- [ ] **Step 3: Run Bash background smoke**

Run:

```bash
uv run python - <<'PY'
from pathlib import Path
from mycli.tools.bash import BashTool
from mycli.tools.bash_output import BashOutputTool
from mycli.tools.kill_shell import KillShellTool

root = Path.cwd()
started = BashTool(root).execute({"command": "python3 -c \"import time; print('ready', flush=True); time.sleep(5)\"", "run_in_background": True})
print(started.raw_payload)
shell_id = started.raw_payload["shell_id"]
print(BashOutputTool().execute({"shell_id": shell_id}).raw_payload)
print(KillShellTool().execute({"shell_id": shell_id}).raw_payload)
PY
```

Expected: shell starts, output contains `ready` or running status, kill succeeds.

- [ ] **Step 4: Update gap doc**

Update `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`:

- Mark 9.1 streaming as ✅ or ⚠️ depending on smoke.
- Mark 3.3 Bash background as ⚠️ if BashOutput and `/bashes` exist but no PTY/recovery.
- Mark 3.8 File history as ⚠️ or ✅ depending on `/changes` and `/undo` result.
- Mark 4.1 Permission model as ⚠️ with P2 v1 details.
- Keep MCP and Microcompact deferred notes unchanged.

- [ ] **Step 5: Write smoke report**

Create `docs/superpowers/reports/2026-05-20-p2-capability-pack-smoke.md` with:

```markdown
# P2 Capability Pack Smoke Report

## Commands

- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`
- `printf 'Reply with exactly this short sentence: p2 streaming ok\n/quit\n' | uv run mycli --session p2-capability-smoke`
- `printf '/bashes\n/changes\n/usage\n/quit\n' | uv run mycli --session p2-capability-smoke`
- Bash background Python smoke command from the plan

## Results

- Static verification:
- Type verification:
- Test verification:
- Streaming smoke:
- Bash background smoke:
- `/bashes`:
- `/changes`:
- `/usage`:

## Notes

- MCP defer loading remains deferred.
- Microcompact remains deferred to protect provider prompt cache hit.
```

- [ ] **Step 6: Commit report and gap update**

```bash
git add docs/superpowers/reports/2026-05-20-p2-capability-pack-smoke.md docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md
git commit -m "Record P2 capability pack smoke evidence" -m "Capture verification and real CLI smoke results for provider streaming, Bash background jobs, file changes, and permission v1." -m "Constraint: MCP defer loading and Microcompact remain intentionally deferred." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: full ruff, mypy, pytest, CLI smoke, and Bash background smoke recorded in report"
```

---

## Plan Self-Review

- Spec coverage: Provider streaming, Bash background lifecycle, file history visibility, permission v1, CLI diff/commands, smoke reporting, and gap update are covered by Tasks 1-7.
- Placeholder scan: the only intentionally flexible point is the Anthropic SDK stream fake shape because it must match the local SDK/test harness. The task still defines required normalized event output.
- Type consistency: `RuntimeStreamEvent` already exists from the prior P2 plan; this plan uses provider stream dictionaries consumed by `ModelTurnRequester`, not a new event type.
- Scope guard: MCP defer loading, Microcompact, async runtime, PTY stdin, and rich TUI are explicitly excluded.
