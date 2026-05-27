# Node TUI Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Node TUI gateway so Python remains the authoritative agent runtime while a Node subprocess can drive interactive UI through a typed JSON-RPC boundary.

**Architecture:** Python launches Node as a disposable child process. JSON-RPC uses child stdin/stdout as dedicated protocol pipes; human/UI output from the first Node client goes to stderr, and a future full-screen UI can open the controlling TTY explicitly without sharing the RPC stream. Python owns `TurnService`, sessions, tools, model calls, slash command behavior, completions, and all model-visible state.

**Tech Stack:** Python 3.13, stdlib `subprocess`/`threading`, existing `TurnService`, pytest, ruff, mypy, Node.js >= 20, npm, Node built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-27-node-tui-gateway.md`

---

## File Structure

- `src/mycli/cli/node_tui/__init__.py`: public exports for `run_node_tui`.
- `src/mycli/cli/node_tui/protocol.py`: JSON-RPC message dataclasses, validation, encoding, decoding, and error helpers.
- `src/mycli/cli/node_tui/gateway.py`: Python request dispatcher, event conversion, turn worker, and `TurnService` delegation.
- `src/mycli/cli/node_tui/process.py`: Node executable/version validation, entrypoint resolution, and subprocess wrapper.
- `src/mycli/cli/main.py`: add `--node-tui`, `MYCLI_TUI_BACKEND=node` routing, and keep `--plain`/non-interactive behavior unchanged.
- `tui/node/package.json`: npm metadata and `node --test` script.
- `tui/node/src/protocol.js`: minimal JSON-RPC helpers for the Node side.
- `tui/node/src/client.js`: protocol client over stdin/stdout, with UI/human output restricted to stderr.
- `tui/node/src/index.js`: minimal gateway smoke client controlled by `MYCLI_NODE_TUI_SCRIPT`.
- `tui/node/test/protocol.test.js`: Node protocol tests.
- `tui/node/test/client.test.js`: Node client stream tests.
- `tests/unit/cli/node_tui/test_protocol.py`: Python protocol tests.
- `tests/unit/cli/node_tui/test_gateway.py`: Python gateway request/turn tests with fake services.
- `tests/unit/cli/node_tui/test_process.py`: Node launcher/version/entrypoint tests.
- `tests/unit/cli/test_main.py`: CLI routing tests for `--node-tui`, env backend, and `--plain` precedence.
- `tests/integration/test_node_tui_gateway.py`: fake Node subprocess integration smoke.
- `docs/superpowers/reports/2026-05-27-node-tui-gateway-smoke.md`: final verification evidence.

Implementation decisions locked by this plan:

- Use npm and plain ESM JavaScript for the gateway slice. Do not add Ink/React/TypeScript yet; the full UI belongs to `node-tui-shell`.
- Use child stdin/stdout for JSON-RPC only. Node must write human-readable smoke output to stderr, not stdout.
- Run `TurnService.handle_user_turn()` in a Python worker thread so the gateway read loop can still answer `turn.interrupt` and reject concurrent turns.
- First-slice `turn.interrupt` is cooperative: it records an interruption request and returns whether a turn is running. It does not hard-kill provider or tool calls.

---

### Task 1: Python JSON-RPC Protocol

**Files:**
- Create: `src/mycli/cli/node_tui/__init__.py`
- Create: `src/mycli/cli/node_tui/protocol.py`
- Create: `tests/unit/cli/node_tui/test_protocol.py`

- [ ] **Step 1: Write failing protocol tests**

Create `tests/unit/cli/node_tui/test_protocol.py`:

```python
from __future__ import annotations

import json

import pytest

from mycli.cli.node_tui.protocol import (
    JsonRpcError,
    RpcNotification,
    RpcRequest,
    RpcResponse,
    decode_message,
    encode_message,
    error_response,
    notification,
    result_response,
)


def test_protocol_decodes_request_response_and_notification() -> None:
    request = decode_message(
        '{"jsonrpc":"2.0","id":"req_1","method":"status.inspect","params":{"x":1}}'
    )
    response = decode_message('{"jsonrpc":"2.0","id":"req_1","result":{"ok":true}}')
    note = decode_message('{"jsonrpc":"2.0","method":"runtime.ready","params":{"ok":true}}')

    assert isinstance(request, RpcRequest)
    assert request.id == "req_1"
    assert request.method == "status.inspect"
    assert request.params == {"x": 1}
    assert isinstance(response, RpcResponse)
    assert response.result == {"ok": True}
    assert isinstance(note, RpcNotification)
    assert note.method == "runtime.ready"


def test_protocol_encode_outputs_one_json_line() -> None:
    line = encode_message(result_response("req_1", {"ok": True}))

    assert line.endswith("\n")
    payload = json.loads(line)
    assert payload == {"jsonrpc": "2.0", "id": "req_1", "result": {"ok": True}}


def test_protocol_rejects_invalid_json() -> None:
    with pytest.raises(JsonRpcError) as exc_info:
        decode_message("{not json")

    assert exc_info.value.code == "parse_error"


def test_protocol_rejects_unknown_shape() -> None:
    with pytest.raises(JsonRpcError) as exc_info:
        decode_message('{"jsonrpc":"2.0","id":"req_1","params":{}}')

    assert exc_info.value.code == "invalid_request"


def test_protocol_builds_error_and_notification() -> None:
    error = error_response("req_1", code="invalid_params", message="Missing message")
    note = notification("turn.started", {"client_turn_id": "c1"})

    assert error.id == "req_1"
    assert error.error == {"code": "invalid_params", "message": "Missing message"}
    assert note.method == "turn.started"
    assert note.params == {"client_turn_id": "c1"}
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_protocol.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mycli.cli.node_tui'`.

- [ ] **Step 3: Add protocol implementation**

Create `src/mycli/cli/node_tui/__init__.py`:

```python
from __future__ import annotations

__all__: list[str] = []
```

Create `src/mycli/cli/node_tui/protocol.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, TypeAlias

JsonObject: TypeAlias = dict[str, Any]
JsonValue: TypeAlias = str | int | float | bool | None | JsonObject | list[Any]


@dataclass(slots=True, frozen=True)
class JsonRpcError(Exception):
    code: str
    message: str
    id: str | int | None = None

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass(slots=True, frozen=True)
class RpcRequest:
    id: str | int
    method: str
    params: JsonObject


@dataclass(slots=True, frozen=True)
class RpcNotification:
    method: str
    params: JsonObject


@dataclass(slots=True, frozen=True)
class RpcResponse:
    id: str | int | None
    result: JsonObject | None = None
    error: JsonObject | None = None


RpcMessage = RpcRequest | RpcNotification | RpcResponse


def decode_message(line: str) -> RpcMessage:
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as exc:
        raise JsonRpcError(code="parse_error", message=str(exc)) from exc
    if not isinstance(raw, dict):
        raise JsonRpcError(code="invalid_request", message="Message must be an object.")
    if raw.get("jsonrpc") != "2.0":
        raise JsonRpcError(code="invalid_request", message="jsonrpc must be '2.0'.")
    message_id = raw.get("id")
    method = raw.get("method")
    params = raw.get("params", {})
    if "result" in raw or "error" in raw:
        error = raw.get("error")
        result = raw.get("result")
        if error is not None and not isinstance(error, dict):
            raise JsonRpcError(code="invalid_request", message="error must be an object.")
        if result is not None and not isinstance(result, dict):
            raise JsonRpcError(code="invalid_request", message="result must be an object.")
        return RpcResponse(
            id=_valid_id_or_none(message_id),
            result=result if isinstance(result, dict) else None,
            error=error if isinstance(error, dict) else None,
        )
    if not isinstance(method, str) or not method:
        raise JsonRpcError(code="invalid_request", message="method is required.")
    if not isinstance(params, dict):
        raise JsonRpcError(code="invalid_request", message="params must be an object.")
    if message_id is None:
        return RpcNotification(method=method, params=params)
    if not isinstance(message_id, (str, int)) or isinstance(message_id, bool):
        raise JsonRpcError(code="invalid_request", message="id must be a string or integer.")
    return RpcRequest(id=message_id, method=method, params=params)


def encode_message(message: RpcMessage) -> str:
    payload: JsonObject = {"jsonrpc": "2.0"}
    if isinstance(message, RpcRequest):
        payload.update({"id": message.id, "method": message.method, "params": message.params})
    elif isinstance(message, RpcNotification):
        payload.update({"method": message.method, "params": message.params})
    else:
        payload["id"] = message.id
        if message.error is not None:
            payload["error"] = message.error
        else:
            payload["result"] = message.result or {}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


def result_response(message_id: str | int, result: JsonObject) -> RpcResponse:
    return RpcResponse(id=message_id, result=result)


def error_response(
    message_id: str | int | None,
    *,
    code: str,
    message: str,
) -> RpcResponse:
    return RpcResponse(id=message_id, error={"code": code, "message": message})


def notification(method: str, params: JsonObject | None = None) -> RpcNotification:
    return RpcNotification(method=method, params=params or {})


def _valid_id_or_none(value: object) -> str | int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise JsonRpcError(code="invalid_request", message="id must be a string or integer.")
    return value
```

- [ ] **Step 4: Run protocol tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_protocol.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/cli/node_tui tests/unit/cli/node_tui/test_protocol.py
git commit -m "Define Node TUI JSON-RPC protocol"
```

---

### Task 2: Gateway Request Handlers Without Turns

**Files:**
- Create: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/cli/node_tui/__init__.py`
- Create: `tests/unit/cli/node_tui/test_gateway.py`

- [ ] **Step 1: Write failing gateway handler tests**

Create `tests/unit/cli/node_tui/test_gateway.py`:

```python
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from mycli.cli.node_tui.gateway import NodeTuiGateway
from mycli.cli.node_tui.protocol import RpcRequest


class FakeSessionService:
    def load_pending_decision(self, _session_id: str) -> object | None:
        return None

    def load_suspended_turn(self, _session_id: str) -> object | None:
        return None

    def list_sessions(self, limit: int = 20):
        del limit
        return (
            SimpleNamespace(
                session_id="demo",
                last_active_at="2026-05-27T01:33:04Z",
                message_count=4,
                status="active",
                summary_count=0,
            ),
        )


class FakeService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = SimpleNamespace(
            session_id="demo",
            workspace_root=workspace_root,
            model="deepseek-v4-flash",
            provider=SimpleNamespace(value="deepseek"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=100000,
        )
        self._session_service = FakeSessionService()

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=demo", "turns=1")

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=demo context=unknown",)

    def current_context_window_metrics(self) -> dict[str, object]:
        return {"input_tokens": 123, "max_tokens": 100000, "source": "provider"}

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id or 'demo'}", "messages=4")


def test_gateway_bootstrap_returns_structured_runtime_state(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="session.bootstrap",
            params={"protocol_version": 1, "client": {"name": "test", "version": "0"}},
        )
    )

    assert response.result is not None
    assert response.result["protocol_version"] == 1
    assert response.result["session_id"] == "demo"
    assert response.result["workspace"] == str(tmp_path)
    assert response.result["provider"] == "deepseek/chat_completions"
    assert response.error is None


def test_gateway_rejects_incompatible_protocol_version(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="session.bootstrap", params={"protocol_version": 999})
    )

    assert response.error == {
        "code": "incompatible_protocol",
        "message": "Unsupported Node TUI protocol version: 999",
    }


def test_gateway_command_run_delegates_existing_commands(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="command.run", params={"command": "/usage"})
    )
    help_response = gateway.handle_request(
        RpcRequest(id="req_2", method="command.run", params={"command": "/help"})
    )

    assert response.result == {"lines": ["[usage] session=demo", "[usage] turns=1"], "mutated_session": False}
    assert help_response.result is not None
    assert any("/status" in line for line in help_response.result["lines"])


def test_gateway_slash_completion_filters_candidates(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(id="req_1", method="completion.slash", params={"prefix": "/sta"})
    )

    assert response.result is not None
    values = [item["value"] for item in response.result["items"]]
    assert "/status" in values
    assert "/stats" in values


def test_gateway_path_completion_stays_inside_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "src").mkdir()
    (workspace / "src" / "main.py").write_text("print('ok')", encoding="utf-8")
    gateway = NodeTuiGateway(service=FakeService(workspace))

    inside = gateway.handle_request(
        RpcRequest(id="req_1", method="completion.path", params={"prefix": "@src/ma"})
    )
    outside = gateway.handle_request(
        RpcRequest(id="req_2", method="completion.path", params={"prefix": "@../"})
    )

    assert inside.result == {"items": [{"value": "@src/main.py", "kind": "file"}]}
    assert outside.result == {"items": []}


def test_gateway_session_list_and_resume(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    listed = gateway.handle_request(RpcRequest(id="req_1", method="session.list", params={}))
    resumed = gateway.handle_request(
        RpcRequest(id="req_2", method="session.resume", params={"session_id": "demo"})
    )

    assert listed.result == {
        "sessions": [
            {
                "id": "demo",
                "last_active": "2026-05-27T01:33:04Z",
                "message_count": 4,
                "current": True,
            }
        ]
    }
    assert resumed.result == {
        "session_id": "demo",
        "lines": ["[session] resumed demo", "[session] messages=4"],
    }


def test_gateway_unknown_method_returns_json_rpc_error(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(RpcRequest(id="req_1", method="missing.method", params={}))

    assert response.error == {"code": "method_not_found", "message": "Unknown method: missing.method"}
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py -q
```

Expected: FAIL because `mycli.cli.node_tui.gateway` does not exist.

- [ ] **Step 3: Add gateway handlers**

Create `src/mycli/cli/node_tui/gateway.py`:

```python
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from mycli.application.turn_service import TurnService
from mycli.cli.autocomplete import path_completion_candidates
from mycli.cli.repl import build_command_handler, handle_slash_command
from mycli.cli.tui.completion import slash_command_candidates
from mycli.cli.node_tui.protocol import (
    RpcRequest,
    RpcResponse,
    error_response,
    result_response,
)

PROTOCOL_VERSION = 1


class NodeTuiGateway:
    def __init__(
        self,
        *,
        service: TurnService,
        emit: Callable[[str, dict[str, object]], None] | None = None,
    ) -> None:
        self.service = service
        self._emit = emit
        self._command_handler = build_command_handler(service)

    def handle_request(self, request: RpcRequest) -> RpcResponse:
        try:
            if request.method == "session.bootstrap":
                return result_response(request.id, self._handle_bootstrap(request.params))
            if request.method == "command.run":
                return result_response(request.id, self._handle_command_run(request.params))
            if request.method == "completion.slash":
                return result_response(request.id, self._handle_completion_slash(request.params))
            if request.method == "completion.path":
                return result_response(request.id, self._handle_completion_path(request.params))
            if request.method == "status.inspect":
                return result_response(request.id, self._status_payload())
            if request.method == "session.list":
                return result_response(request.id, self._handle_session_list())
            if request.method == "session.resume":
                return result_response(request.id, self._handle_session_resume(request.params))
            if request.method == "shutdown":
                return result_response(request.id, {"ok": True})
            return error_response(
                request.id,
                code="method_not_found",
                message=f"Unknown method: {request.method}",
            )
        except ValueError as exc:
            return error_response(request.id, code="invalid_params", message=str(exc))

    def _handle_bootstrap(self, params: dict[str, object]) -> dict[str, object]:
        version = params.get("protocol_version")
        if version != PROTOCOL_VERSION:
            raise _GatewayError(
                code="incompatible_protocol",
                message=f"Unsupported Node TUI protocol version: {version}",
            )
        return {
            "protocol_version": PROTOCOL_VERSION,
            "session_id": self.service._config.session_id,
            "workspace": str(self.service._config.workspace_root),
            "model": self.service._config.model,
            "provider": (
                f"{self.service._config.provider.value}/"
                f"{self.service._config.protocol.value}"
            ),
            "status": self._status_payload(),
        }

    def _handle_command_run(self, params: dict[str, object]) -> dict[str, object]:
        command = _required_str(params, "command").strip()
        if not command.startswith("/"):
            raise ValueError("command must start with '/'.")
        builtin = handle_slash_command(command)
        if builtin == "quit":
            lines = ["Bye."]
        elif builtin.startswith("Unknown command:"):
            lines = [line for line in self._command_handler(command)]
        else:
            lines = builtin.splitlines()
        mutated_session = command.startswith(("/resume", "/fork"))
        if mutated_session and self._emit is not None:
            self._emit("session.changed", {"session_id": self.service._config.session_id})
        return {"lines": lines, "mutated_session": mutated_session}

    def _handle_completion_slash(self, params: dict[str, object]) -> dict[str, object]:
        prefix = _optional_str(params.get("prefix")) or "/"
        return {
            "items": [
                {"value": command, "description": _slash_description(command)}
                for command in slash_command_candidates()
                if command.startswith(prefix)
            ]
        }

    def _handle_completion_path(self, params: dict[str, object]) -> dict[str, object]:
        prefix = _optional_str(params.get("prefix")) or "@"
        items = []
        for value in path_completion_candidates(self.service._config.workspace_root, prefix):
            kind = "directory" if value.endswith("/") else "file"
            items.append({"value": value, "kind": kind})
        return {"items": items}

    def _handle_session_list(self) -> dict[str, object]:
        overviews = self.service._session_service.list_sessions(limit=20)
        return {
            "sessions": [
                {
                    "id": overview.session_id,
                    "last_active": overview.last_active_at,
                    "message_count": overview.message_count,
                    "current": overview.session_id == self.service._config.session_id,
                }
                for overview in overviews
            ]
        }

    def _handle_session_resume(self, params: dict[str, object]) -> dict[str, object]:
        session_id = _required_str(params, "session_id").strip()
        if not session_id:
            raise ValueError("session_id is required.")
        lines = [f"[session] {line}" for line in self.service.resume_session(session_id)]
        if self._emit is not None:
            self._emit("session.changed", {"session_id": self.service._config.session_id})
        return {"session_id": self.service._config.session_id, "lines": lines}

    def _status_payload(self) -> dict[str, object]:
        context_window = self.service.current_context_window_metrics()
        pending = self.service._session_service.load_pending_decision(self.service._config.session_id)
        suspended = self.service._session_service.load_suspended_turn(self.service._config.session_id)
        return {
            "session_id": self.service._config.session_id,
            "workspace": Path(self.service._config.workspace_root).name,
            "model": self.service._config.model,
            "provider": (
                f"{self.service._config.provider.value}/"
                f"{self.service._config.protocol.value}"
            ),
            "context_window": {
                "used_tokens": _int_metric(
                    context_window.get("input_tokens") or context_window.get("total_tokens")
                ),
                "max_tokens": _int_metric(context_window.get("max_tokens"))
                or self.service._config.max_prompt_tokens,
                "source": str(context_window.get("source") or "estimate"),
            },
            "pending_decision": pending is not None,
            "suspended_turn": suspended is not None,
        }


class _GatewayError(ValueError):
    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _required_str(params: dict[str, object], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} is required.")
    return value


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _int_metric(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _slash_description(command: str) -> str:
    descriptions = {
        "/status": "Show runtime status",
        "/stats": "Show aggregate stats",
        "/usage": "Show usage for the current session",
        "/context": "Show context-window diagnostics",
        "/resume <session>": "Resume a saved session",
        "/sessions": "List saved sessions",
        "/quit": "Exit mycli",
    }
    return descriptions.get(command, "")
```

Then adjust `handle_request()` so `_GatewayError` preserves its code. Replace the `except ValueError` block with:

```python
        except _GatewayError as exc:
            return error_response(request.id, code=exc.code, message=exc.message)
        except ValueError as exc:
            return error_response(request.id, code="invalid_params", message=str(exc))
```

Modify `src/mycli/cli/node_tui/__init__.py`:

```python
from __future__ import annotations

from mycli.cli.node_tui.gateway import NodeTuiGateway as NodeTuiGateway

__all__ = ["NodeTuiGateway"]
```

- [ ] **Step 4: Run gateway tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/cli/node_tui tests/unit/cli/node_tui/test_gateway.py
git commit -m "Add Node TUI gateway request handlers"
```

---

### Task 3: Turn Worker And Event Forwarding

**Files:**
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`

- [ ] **Step 1: Add failing turn tests**

Append to `tests/unit/cli/node_tui/test_gateway.py`:

```python
from mycli.domain.runtime import RuntimeStreamEvent, TurnResponse


class FakeTurnService(FakeService):
    def __init__(self, workspace_root: Path) -> None:
        super().__init__(workspace_root)
        self.turn_calls: list[str] = []

    def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
        self.turn_calls.append(message)
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="reasoning", text="thinking"))
            stream_sink(RuntimeStreamEvent(kind="tool_call", tool_name="Read"))
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="hello"))
            stream_sink(RuntimeStreamEvent(kind="completed", metadata={"response_status": "completed"}))
        return TurnResponse(
            assistant_message="hello world",
            streamed_chunks=("hello", " world"),
            progress_updates=("[progress] done",),
            plan_steps=("completed: smoke",),
        )


def test_gateway_turn_submit_emits_ordered_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    gateway = NodeTuiGateway(service=FakeTurnService(tmp_path), emit=lambda method, params: events.append((method, params)))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="turn.submit",
            params={"message": "hello", "client_turn_id": "client_1"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {"accepted": True, "client_turn_id": "client_1"}
    assert [method for method, _params in events] == [
        "turn.started",
        "turn.event",
        "turn.event",
        "turn.event",
        "turn.event",
        "turn.completed",
        "status.changed",
    ]
    completed = events[-2][1]
    assert completed["assistant_message"] == "hello world"
    assert completed["progress_updates"] == ["[progress] done"]
    assert completed["plan_steps"] == ["completed: smoke"]


def test_gateway_turn_submit_rejects_empty_and_concurrent_turns(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeTurnService(tmp_path))

    empty = gateway.handle_request(
        RpcRequest(id="req_1", method="turn.submit", params={"message": "   "})
    )
    accepted = gateway.handle_request(
        RpcRequest(id="req_2", method="turn.submit", params={"message": "hello"})
    )
    concurrent = gateway.handle_request(
        RpcRequest(id="req_3", method="turn.submit", params={"message": "again"})
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert empty.error == {"code": "invalid_params", "message": "message is required."}
    assert accepted.result == {"accepted": True, "client_turn_id": "req_2"}
    assert concurrent.error == {"code": "turn_in_progress", "message": "A turn is already running."}


def test_gateway_turn_interrupt_reports_running_state(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeTurnService(tmp_path))
    idle = gateway.handle_request(RpcRequest(id="req_1", method="turn.interrupt", params={}))
    accepted = gateway.handle_request(
        RpcRequest(id="req_2", method="turn.submit", params={"message": "hello"})
    )
    running = gateway.handle_request(RpcRequest(id="req_3", method="turn.interrupt", params={}))
    gateway.wait_for_current_turn(timeout=2.0)

    assert idle.result == {"interrupted": False}
    assert accepted.result == {"accepted": True, "client_turn_id": "req_2"}
    assert running.result == {"interrupted": True}
```

- [ ] **Step 2: Run failing turn tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_submit_emits_ordered_events tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_submit_rejects_empty_and_concurrent_turns tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_interrupt_reports_running_state -q
```

Expected: FAIL because `turn.submit`, `turn.interrupt`, and `wait_for_current_turn()` are not implemented.

- [ ] **Step 3: Add turn worker support**

Modify `src/mycli/cli/node_tui/gateway.py`.

Add imports:

```python
from threading import Lock, Thread

from mycli.domain.runtime import RuntimeStreamEvent, TurnResponse
```

In `NodeTuiGateway.__init__`, add:

```python
        self._turn_lock = Lock()
        self._turn_thread: Thread | None = None
        self._turn_running = False
        self._interrupt_requested = False
```

In `handle_request()`, add before `command.run`:

```python
            if request.method == "turn.submit":
                return self._handle_turn_submit(request)
            if request.method == "turn.interrupt":
                return result_response(request.id, self._handle_turn_interrupt())
```

Add methods:

```python
    def wait_for_current_turn(self, timeout: float | None = None) -> None:
        thread = self._turn_thread
        if thread is not None:
            thread.join(timeout=timeout)

    def _handle_turn_submit(self, request: RpcRequest) -> RpcResponse:
        message = _required_str(request.params, "message").strip()
        if not message:
            return error_response(request.id, code="invalid_params", message="message is required.")
        client_turn_id = _optional_str(request.params.get("client_turn_id")) or str(request.id)
        with self._turn_lock:
            if self._turn_running:
                return error_response(
                    request.id,
                    code="turn_in_progress",
                    message="A turn is already running.",
                )
            self._turn_running = True
            self._interrupt_requested = False
            self._turn_thread = Thread(
                target=self._run_turn_worker,
                kwargs={"message": message, "client_turn_id": client_turn_id},
                daemon=True,
            )
            self._turn_thread.start()
        return result_response(request.id, {"accepted": True, "client_turn_id": client_turn_id})

    def _handle_turn_interrupt(self) -> dict[str, object]:
        with self._turn_lock:
            running = self._turn_running
            if running:
                self._interrupt_requested = True
        if running and self._emit is not None:
            self._emit("turn.interrupted", {"requested": True})
        return {"interrupted": running}

    def _run_turn_worker(self, *, message: str, client_turn_id: str) -> None:
        self._emit_event("turn.started", {"client_turn_id": client_turn_id})
        try:
            response = self.service.handle_user_turn(
                message,
                stream_sink=lambda event: self._forward_stream_event(client_turn_id, event),
            )
        except Exception as exc:
            self._emit_event(
                "turn.failed",
                {"client_turn_id": client_turn_id, "message": str(exc)},
            )
        else:
            self._emit_event(
                "turn.completed",
                self._turn_completed_payload(client_turn_id=client_turn_id, response=response),
            )
        finally:
            with self._turn_lock:
                self._turn_running = False
            self._emit_event("status.changed", self._status_payload())

    def _forward_stream_event(self, client_turn_id: str, event: RuntimeStreamEvent) -> None:
        self._emit_event(
            "turn.event",
            {
                "client_turn_id": client_turn_id,
                "phase": _phase_for_stream_event(event),
                "kind": event.kind,
                "text": event.text,
                "tool_name": event.tool_name,
                "metadata": event.metadata,
            },
        )

    def _turn_completed_payload(
        self,
        *,
        client_turn_id: str,
        response: TurnResponse,
    ) -> dict[str, object]:
        return {
            "client_turn_id": client_turn_id,
            "assistant_message": response.assistant_message,
            "activity_events": [
                {
                    "kind": item.kind,
                    "message": item.message,
                    "tool_name": item.tool_name,
                    "path": item.path,
                    "query": item.query,
                    "preview": item.preview,
                }
                for item in response.activity_events
            ],
            "progress_updates": list(response.progress_updates),
            "plan_steps": list(response.plan_steps),
            "pending_decision": response.pending_decision is not None,
            "usage": {},
        }

    def _emit_event(self, method: str, params: dict[str, object]) -> None:
        if self._emit is not None:
            self._emit(method, params)
```

Add helper:

```python
def _phase_for_stream_event(event: RuntimeStreamEvent) -> str:
    if event.kind == "reasoning":
        return "reasoning"
    if event.kind == "text_delta":
        return "assistant_delta"
    if event.kind == "tool_call":
        return "tool_call"
    if event.kind == "heartbeat":
        return "heartbeat"
    if event.kind == "completed":
        return "model_completed"
    return event.kind
```

- [ ] **Step 4: Run gateway tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/cli/node_tui/gateway.py tests/unit/cli/node_tui/test_gateway.py
git commit -m "Forward turns through Node TUI gateway"
```

---

### Task 4: Node Process Launcher

**Files:**
- Create: `src/mycli/cli/node_tui/process.py`
- Modify: `src/mycli/cli/node_tui/__init__.py`
- Create: `tests/unit/cli/node_tui/test_process.py`

- [ ] **Step 1: Write failing process tests**

Create `tests/unit/cli/node_tui/test_process.py`:

```python
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from mycli.cli.node_tui.process import (
    NodeTuiProcessError,
    check_node_version,
    resolve_node_entrypoint,
)


def test_check_node_version_accepts_node_20() -> None:
    runner = lambda _cmd: SimpleNamespace(returncode=0, stdout="v20.11.1\n", stderr="")

    assert check_node_version(runner=runner) == "v20.11.1"


def test_check_node_version_rejects_old_node() -> None:
    runner = lambda _cmd: SimpleNamespace(returncode=0, stdout="v18.19.0\n", stderr="")

    with pytest.raises(NodeTuiProcessError, match="Node TUI requires Node.js >= 20"):
        check_node_version(runner=runner)


def test_check_node_version_reports_missing_node() -> None:
    def runner(_cmd):
        raise FileNotFoundError

    with pytest.raises(NodeTuiProcessError, match="Use mycli --plain or install Node"):
        check_node_version(runner=runner)


def test_resolve_node_entrypoint_prefers_env_override(tmp_path: Path) -> None:
    script = tmp_path / "fake-node.js"
    script.write_text("console.log('ok')", encoding="utf-8")

    assert resolve_node_entrypoint(repo_root=tmp_path, env={"MYCLI_NODE_TUI_ENTRYPOINT": str(script)}) == script


def test_resolve_node_entrypoint_reports_missing_default(tmp_path: Path) -> None:
    with pytest.raises(NodeTuiProcessError, match="Node TUI entrypoint not found"):
        resolve_node_entrypoint(repo_root=tmp_path, env={})
```

- [ ] **Step 2: Run failing process tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_process.py -q
```

Expected: FAIL because `process.py` does not exist.

- [ ] **Step 3: Add process launcher**

Create `src/mycli/cli/node_tui/process.py`:

```python
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import os
import subprocess
from typing import Mapping, Protocol


class CompletedProcessLike(Protocol):
    returncode: int
    stdout: str
    stderr: str


class NodeTuiProcessError(RuntimeError):
    pass


class NodeTuiProcess:
    def __init__(
        self,
        *,
        args: list[str],
        env: Mapping[str, str],
        cwd: Path,
    ) -> None:
        self._args = args
        self._env = dict(env)
        self._cwd = cwd
        self._process: subprocess.Popen[str] | None = None

    def start(self) -> None:
        self._process = subprocess.Popen(
            self._args,
            cwd=self._cwd,
            env=self._env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    def write_line(self, line: str) -> None:
        if self._process is None or self._process.stdin is None:
            raise NodeTuiProcessError("Node TUI process is not started.")
        self._process.stdin.write(line)
        self._process.stdin.flush()

    def read_line(self) -> str:
        if self._process is None or self._process.stdout is None:
            raise NodeTuiProcessError("Node TUI process is not started.")
        return self._process.stdout.readline()

    def wait(self) -> int:
        if self._process is None:
            return 1
        return self._process.wait()

    def terminate(self) -> None:
        if self._process is not None and self._process.poll() is None:
            self._process.terminate()


def check_node_version(
    *,
    runner: Callable[[list[str]], CompletedProcessLike] | None = None,
) -> str:
    run = runner or _run_node_version
    try:
        completed = run(["node", "--version"])
    except FileNotFoundError as exc:
        raise NodeTuiProcessError(
            "Node TUI requires Node.js >= 20. Use mycli --plain or install Node."
        ) from exc
    version = completed.stdout.strip()
    if completed.returncode != 0 or not version.startswith("v"):
        raise NodeTuiProcessError(
            "Node TUI requires Node.js >= 20. Use mycli --plain or install Node."
        )
    major = _parse_node_major(version)
    if major < 20:
        raise NodeTuiProcessError(
            "Node TUI requires Node.js >= 20. Use mycli --plain or install Node."
        )
    return version


def resolve_node_entrypoint(*, repo_root: Path, env: Mapping[str, str]) -> Path:
    override = env.get("MYCLI_NODE_TUI_ENTRYPOINT")
    if override:
        candidate = Path(override).expanduser()
    else:
        candidate = repo_root / "tui" / "node" / "src" / "index.js"
    if not candidate.is_file():
        raise NodeTuiProcessError(f"Node TUI entrypoint not found: {candidate}")
    return candidate


def build_node_tui_process(
    *,
    repo_root: Path,
    env: Mapping[str, str],
) -> NodeTuiProcess:
    check_node_version()
    entrypoint = resolve_node_entrypoint(repo_root=repo_root, env=env)
    child_env = dict(os.environ)
    child_env.update(env)
    return NodeTuiProcess(args=["node", str(entrypoint)], env=child_env, cwd=repo_root)


def _run_node_version(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=False, capture_output=True, text=True)


def _parse_node_major(version: str) -> int:
    raw = version.removeprefix("v").split(".", maxsplit=1)[0]
    try:
        return int(raw)
    except ValueError:
        return 0
```

Modify `src/mycli/cli/node_tui/__init__.py`:

```python
from mycli.cli.node_tui.process import NodeTuiProcessError as NodeTuiProcessError
```

and include `"NodeTuiProcessError"` in `__all__`.

- [ ] **Step 4: Run process tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_process.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/cli/node_tui tests/unit/cli/node_tui/test_process.py
git commit -m "Add Node TUI subprocess launcher"
```

---

### Task 5: Gateway Process Loop And Node Client

**Files:**
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/cli/node_tui/__init__.py`
- Create: `tui/node/package.json`
- Create: `tui/node/src/protocol.js`
- Create: `tui/node/src/client.js`
- Create: `tui/node/src/index.js`
- Create: `tui/node/test/protocol.test.js`
- Create: `tui/node/test/client.test.js`
- Create: `tests/integration/test_node_tui_gateway.py`

- [ ] **Step 1: Add failing Python integration test**

Create `tests/integration/test_node_tui_gateway.py`:

```python
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from mycli.cli.node_tui.gateway import run_node_tui_gateway
from mycli.domain.runtime import RuntimeStreamEvent, TurnResponse


class FakeNodeProcess:
    def __init__(self, incoming: list[str]) -> None:
        self.incoming = incoming
        self.written: list[str] = []
        self.terminated = False

    def start(self) -> None:
        return None

    def read_line(self) -> str:
        if not self.incoming:
            return ""
        return self.incoming.pop(0)

    def write_line(self, line: str) -> None:
        self.written.append(line)

    def wait(self) -> int:
        return 0

    def terminate(self) -> None:
        self.terminated = True


class FakeService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = SimpleNamespace(
            session_id="demo",
            workspace_root=workspace_root,
            model="gpt-test",
            provider=SimpleNamespace(value="deepseek"),
            protocol=SimpleNamespace(value="chat_completions"),
            max_prompt_tokens=12000,
        )
        self._session_service = SimpleNamespace(
            load_pending_decision=lambda _session_id: None,
            load_suspended_turn=lambda _session_id: None,
            list_sessions=lambda limit=20: (),
        )

    def current_context_window_metrics(self) -> dict[str, object]:
        return {}

    def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
        assert message == "hello"
        if stream_sink is not None:
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="hi"))
        return TurnResponse(assistant_message="hi")

    def inspect_usage(self) -> tuple[str, ...]:
        return ("session=demo", "turns=1")

    def resume_session(self, session_id: str | None = None) -> tuple[str, ...]:
        return (f"resumed {session_id}",)


def test_run_node_tui_gateway_processes_fake_node_requests(tmp_path: Path) -> None:
    process = FakeNodeProcess(
        [
            '{"jsonrpc":"2.0","id":"1","method":"session.bootstrap","params":{"protocol_version":1}}\n',
            '{"jsonrpc":"2.0","id":"2","method":"turn.submit","params":{"message":"hello","client_turn_id":"c1"}}\n',
            '{"jsonrpc":"2.0","id":"3","method":"command.run","params":{"command":"/usage"}}\n',
            '{"jsonrpc":"2.0","id":"4","method":"shutdown","params":{}}\n',
        ]
    )

    exit_code = run_node_tui_gateway(service=FakeService(tmp_path), process=process)

    assert exit_code == 0
    output = "".join(process.written)
    assert '"id":"1"' in output
    assert '"method":"turn.started"' in output
    assert '"method":"turn.event"' in output
    assert '"method":"turn.completed"' in output
    assert '"[usage] session=demo"' in output
```

- [ ] **Step 2: Run failing integration test**

Run:

```bash
uv run pytest tests/integration/test_node_tui_gateway.py -q
```

Expected: FAIL because `run_node_tui_gateway` does not exist.

- [ ] **Step 3: Add Python gateway process loop**

Modify `src/mycli/cli/node_tui/gateway.py`.

Add imports:

```python
from mycli.cli.node_tui.protocol import (
    JsonRpcError,
    decode_message,
    encode_message,
    notification,
)
```

Add function:

```python
def run_node_tui_gateway(*, service: TurnService, process: object) -> int:
    process.start()

    def emit(method: str, params: dict[str, object]) -> None:
        process.write_line(encode_message(notification(method, params)))

    gateway = NodeTuiGateway(service=service, emit=emit)
    emit("runtime.ready", gateway._status_payload())
    try:
        while True:
            line = process.read_line()
            if not line:
                gateway.wait_for_current_turn(timeout=None)
                return process.wait()
            try:
                message = decode_message(line)
            except JsonRpcError as exc:
                emit("gateway.error", {"code": exc.code, "message": exc.message})
                continue
            if not isinstance(message, RpcRequest):
                emit("gateway.error", {"code": "invalid_request", "message": "Expected request."})
                continue
            response = gateway.handle_request(message)
            process.write_line(encode_message(response))
            if message.method == "shutdown":
                gateway.wait_for_current_turn(timeout=None)
                return process.wait()
    finally:
        process.terminate()
```

Modify `src/mycli/cli/node_tui/__init__.py`:

```python
from mycli.cli.node_tui.gateway import run_node_tui_gateway as run_node_tui_gateway
```

and include `"run_node_tui_gateway"` in `__all__`.

- [ ] **Step 4: Add Node package and protocol tests**

Create `tui/node/package.json`:

```json
{
  "name": "mycli-node-tui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Create `tui/node/src/protocol.js`:

```javascript
export function encodeMessage(message) {
  return `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
}

export function decodeMessage(line) {
  const payload = JSON.parse(line);
  if (!payload || payload.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC message");
  }
  return payload;
}

export function request(id, method, params = {}) {
  return { id, method, params };
}
```

Create `tui/node/test/protocol.test.js`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { decodeMessage, encodeMessage, request } from "../src/protocol.js";

test("encodes one JSON-RPC line", () => {
  const line = encodeMessage(request("1", "session.bootstrap", { protocol_version: 1 }));
  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(line), {
    jsonrpc: "2.0",
    id: "1",
    method: "session.bootstrap",
    params: { protocol_version: 1 },
  });
});

test("decodes JSON-RPC messages", () => {
  assert.deepEqual(decodeMessage('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}'), {
    jsonrpc: "2.0",
    id: "1",
    result: { ok: true },
  });
});
```

- [ ] **Step 5: Add Node client and tests**

Create `tui/node/src/client.js`:

```javascript
import { createInterface } from "node:readline";
import { decodeMessage, encodeMessage, request } from "./protocol.js";

export class GatewayClient {
  constructor({ input, output, log = () => {} }) {
    this.input = input;
    this.output = output;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.events = [];
  }

  start() {
    const rl = createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
  }

  send(method, params = {}) {
    const id = String(this.nextId++);
    this.output.write(encodeMessage(request(id, method, params)));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  handleLine(line) {
    const message = decodeMessage(line);
    if (message.id && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      this.events.push(message);
      this.log(message);
      this.resolveEventWaiters(message);
    }
  }

  waitForEvent(method, predicate = () => true) {
    for (const event of this.events) {
      if (event.method === method && predicate(event)) {
        return Promise.resolve(event);
      }
    }
    return new Promise((resolve) => {
      this.eventWaiters.push({ method, predicate, resolve });
    });
  }

  resolveEventWaiters(event) {
    const remaining = [];
    for (const waiter of this.eventWaiters) {
      if (event.method === waiter.method && waiter.predicate(event)) {
        waiter.resolve(event);
      } else {
        remaining.push(waiter);
      }
    }
    this.eventWaiters = remaining;
  }
}
```

Create `tui/node/test/client.test.js`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { GatewayClient } from "../src/client.js";

test("client sends requests and receives responses and events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes = [];
  output.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  const events = [];
  const client = new GatewayClient({ input, output, log: (event) => events.push(event) });
  client.start();

  const promise = client.send("status.inspect", {});
  assert.match(writes.join(""), /"method":"status.inspect"/);
  input.write('{"jsonrpc":"2.0","method":"runtime.ready","params":{"ok":true}}\n');
  input.write('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}\n');

  assert.deepEqual(await promise, { ok: true });
  assert.equal(events[0].method, "runtime.ready");
});

test("client waits for a matching event", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new GatewayClient({ input, output });
  client.start();

  const promise = client.waitForEvent(
    "turn.completed",
    (event) => event.params?.client_turn_id === "script_1",
  );
  input.write('{"jsonrpc":"2.0","method":"turn.event","params":{"client_turn_id":"script_1"}}\n');
  input.write('{"jsonrpc":"2.0","method":"turn.completed","params":{"client_turn_id":"script_1"}}\n');

  assert.equal((await promise).method, "turn.completed");
});
```

- [ ] **Step 6: Add minimal Node entrypoint**

Create `tui/node/src/index.js`:

```javascript
import { GatewayClient } from "./client.js";

const client = new GatewayClient({
  input: process.stdin,
  output: process.stdout,
  log: (event) => {
    process.stderr.write(`[node-tui] ${event.method}\n`);
  },
});

client.start();

async function main() {
  await client.send("session.bootstrap", {
    protocol_version: 1,
    client: { name: "mycli-node-tui", version: "0.1.0" },
  });
  const script = JSON.parse(process.env.MYCLI_NODE_TUI_SCRIPT || "[]");
  for (const item of script) {
    if (typeof item !== "string" || !item.trim()) {
      continue;
    }
    if (item.startsWith("/")) {
      const result = await client.send("command.run", { command: item });
      for (const line of result.lines ?? []) {
        process.stderr.write(`[node-tui] ${line}\n`);
      }
      continue;
    }
    const clientTurnId = `script_${Date.now()}`;
    await client.send("turn.submit", { message: item, client_turn_id: clientTurnId });
    await client.waitForEvent(
      "turn.completed",
      (event) => event.params?.client_turn_id === clientTurnId,
    );
  }
  await client.send("shutdown", {});
}

main().catch((error) => {
  process.stderr.write(`[node-tui] error: ${error.message}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 7: Run Python and Node tests**

Run:

```bash
uv run pytest tests/integration/test_node_tui_gateway.py tests/unit/cli/node_tui/test_gateway.py tests/unit/cli/node_tui/test_protocol.py -q
```

Expected: PASS.

Run:

```bash
npm --prefix tui/node test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mycli/cli/node_tui tests/integration/test_node_tui_gateway.py tui/node
git commit -m "Bridge Python gateway to minimal Node client"
```

---

### Task 6: CLI Routing For `--node-tui`

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Add failing CLI routing tests**

Append to `tests/unit/cli/test_main.py`:

```python
def test_main_routes_node_tui_flag_to_gateway(monkeypatch, tmp_path: Path) -> None:
    events: dict[str, object] = {}

    class FakeService:
        pass

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fake_run_node_tui(service, *, cwd, env):
        events["service"] = service
        events["cwd"] = cwd
        events["env"] = env
        return 0

    monkeypatch.setattr("mycli.cli.main.run_node_tui", fake_run_node_tui)

    assert main(
        ["--node-tui", "--session", "demo"],
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "x"},
    ) == 0
    assert isinstance(events["service"], FakeService)
    assert events["cwd"] == tmp_path


def test_main_routes_node_tui_env_backend(monkeypatch, tmp_path: Path) -> None:
    events: dict[str, object] = {}

    class FakeService:
        pass

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())
    monkeypatch.setattr(
        "mycli.cli.main.run_node_tui",
        lambda service, *, cwd, env: events.setdefault("called", True) and 0,
    )

    assert main(
        ["--session", "demo"],
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "x", "MYCLI_TUI_BACKEND": "node"},
    ) == 0
    assert events["called"] is True


def test_main_plain_overrides_node_tui_backend(monkeypatch, tmp_path: Path) -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["/quit"])

    class FakeService:
        def __init__(self) -> None:
            self._config = type(
                "Config",
                (),
                {
                    "session_id": "demo",
                    "workspace_root": tmp_path,
                    "view_mode": ViewMode.DEFAULT,
                    "statusline_enabled": False,
                },
            )()
            self._session_service = type(
                "Sessions",
                (),
                {"load_pending_decision": lambda _self, _session_id: None},
            )()

    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: FakeService())

    def fail_node_tui(*args, **kwargs):
        raise AssertionError("node tui should not run")

    monkeypatch.setattr("mycli.cli.main.run_node_tui", fail_node_tui)

    assert main(
        ["--plain", "--session", "demo"],
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "x", "MYCLI_TUI_BACKEND": "node"},
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    ) == 0
    assert outputs[-1] == "Bye."
```

- [ ] **Step 2: Run failing CLI tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_main_routes_node_tui_flag_to_gateway tests/unit/cli/test_main.py::test_main_routes_node_tui_env_backend tests/unit/cli/test_main.py::test_main_plain_overrides_node_tui_backend -q
```

Expected: FAIL because `--node-tui` and `run_node_tui` are not wired.

- [ ] **Step 3: Add CLI routing**

Modify imports in `src/mycli/cli/main.py`:

```python
from mycli.cli.node_tui import NodeTuiProcessError
from mycli.cli.node_tui import run_node_tui
```

Modify `build_parser()`:

```python
    parser.add_argument(
        "--node-tui",
        action="store_true",
        help="Run the experimental Node.js TUI gateway",
    )
```

Add helper:

```python
def should_use_node_tui(cli_args: dict[str, object], env: dict[str, str] | None) -> bool:
    if bool(cli_args.get("plain")):
        return False
    if bool(cli_args.get("node_tui")):
        return True
    env_vars = env or os.environ
    return env_vars.get("MYCLI_TUI_BACKEND", "").strip().lower() == "node"
```

In `main()`, after `service = build_turn_service(...)` and before `should_use_tui(args)`:

```python
    if should_use_node_tui(args, env):
        try:
            return run_node_tui(service, cwd=cwd or Path.cwd(), env=env or dict(os.environ))
        except NodeTuiProcessError as exc:
            output_func(str(exc))
            return 2
```

Implement `run_node_tui` in `src/mycli/cli/node_tui/__init__.py`:

```python
from pathlib import Path
from typing import Mapping

from mycli.application.turn_service import TurnService
from mycli.cli.node_tui.gateway import run_node_tui_gateway as run_node_tui_gateway
from mycli.cli.node_tui.process import build_node_tui_process


def run_node_tui(
    service: TurnService,
    *,
    cwd: Path,
    env: Mapping[str, str],
) -> int:
    repo_root = Path(__file__).resolve().parents[4]
    process = build_node_tui_process(repo_root=repo_root, env=env)
    return run_node_tui_gateway(service=service, process=process)
```

Keep the previous exports from earlier tasks in `__all__`.

- [ ] **Step 4: Run CLI routing tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_main_routes_node_tui_flag_to_gateway tests/unit/cli/test_main.py::test_main_routes_node_tui_env_backend tests/unit/cli/test_main.py::test_main_plain_overrides_node_tui_backend -q
```

Expected: PASS.

- [ ] **Step 5: Run focused gateway suite**

Run:

```bash
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py::test_main_non_interactive_stdout_uses_plain_mode -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/cli/main.py src/mycli/cli/node_tui tests/unit/cli/test_main.py
git commit -m "Route CLI to experimental Node TUI gateway"
```

---

### Task 7: End-To-End Verification And Smoke Report

**Files:**
- Create: `docs/superpowers/reports/2026-05-27-node-tui-gateway-smoke.md`
- Modify only if verification exposes a focused defect: files from earlier tasks.

- [ ] **Step 1: Run Python focused suite**

Run:

```bash
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py::test_main_routes_node_tui_flag_to_gateway tests/unit/cli/test_main.py::test_main_routes_node_tui_env_backend tests/unit/cli/test_main.py::test_main_plain_overrides_node_tui_backend -q
```

Expected: PASS.

- [ ] **Step 2: Run Node tests**

Run:

```bash
npm --prefix tui/node test
```

Expected: PASS.

- [ ] **Step 3: Run static checks**

Run:

```bash
uv run ruff check src tests
```

Expected: PASS.

Run:

```bash
uv run mypy src/mycli
```

Expected: PASS.

- [ ] **Step 4: Run full Python test suite**

Run:

```bash
uv run pytest -q
```

Expected: PASS.

- [ ] **Step 5: Run real Node gateway smoke**

Run:

```bash
SMOKE_HOME="$(mktemp -d)"
SESSION="node-tui-gateway-smoke-$(date +%Y%m%d%H%M%S)"
SCRIPT='["请使用 Read 工具读取 pyproject.toml，然后用一句话回答项目名和 CLI 入口点。","/usage","/session","/quit"]'
HOME="$SMOKE_HOME" MYCLI_NODE_TUI_SCRIPT="$SCRIPT" uv run mycli --node-tui --session "$SESSION"
```

Expected:

- exit code 0
- stderr contains Node event lines such as `[node-tui] runtime.ready`, `[node-tui] turn.event`, and `[node-tui] turn.completed`
- real provider-backed turn completes
- `/usage` and `/session` commands return through `command.run`
- no pending decision or suspended turn remains

- [ ] **Step 6: Write smoke report**

Create `docs/superpowers/reports/2026-05-27-node-tui-gateway-smoke.md`:

```markdown
# Node TUI Gateway Smoke

## Scope

- Python remains the authoritative runtime.
- Node subprocess communicates with Python through line-delimited JSON-RPC.
- RPC stdout/stdin stay separate from human-readable Node output.
- `mycli --plain` remains unaffected.

## Verification

| Command | Result |
| --- | --- |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py::test_main_routes_node_tui_flag_to_gateway tests/unit/cli/test_main.py::test_main_routes_node_tui_env_backend tests/unit/cli/test_main.py::test_main_plain_overrides_node_tui_backend -q` | PASS |
| `npm --prefix tui/node test` | PASS |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS |
| `HOME="$(mktemp -d)" MYCLI_NODE_TUI_SCRIPT='[...]' uv run mycli --node-tui --session <smoke-session>` | PASS |

## Notes

- The first Node client is a protocol smoke client, not the final Claude Code-like TUI.
- Human-readable Node output uses stderr; stdout remains reserved for RPC payloads.
- `turn.interrupt` is cooperative in this slice and does not hard-kill provider or tool calls.
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/reports/2026-05-27-node-tui-gateway-smoke.md
git commit -m "Record Node TUI gateway smoke evidence"
```

---

## Self-Review Checklist

- Spec coverage:
  - Python runtime authority: Tasks 2, 3, 5, 6.
  - JSON-RPC protocol versioning and validation: Task 1.
  - Session bootstrap/list/resume: Task 2.
  - Command delegation and Python-owned slash behavior: Task 2.
  - Slash/path completion: Task 2.
  - Stream forwarding and final answer: Task 3.
  - Cooperative interrupt shape: Task 3.
  - Node subprocess and Node >= 20 gate: Task 4.
  - Dedicated RPC streams separate from human output: Task 5 Node client uses stdout only for RPC and stderr for human output.
  - Opt-in CLI routing and plain fallback: Task 6.
  - Node tests required: Task 5 and Task 7.
  - Real smoke: Task 7.
- Scope control:
  - No Ink/React UI in this plan.
  - No default replacement of the current Textual TUI.
  - No session/tool/model mutation from Node.
  - No model-visible prompt changes.
- Type consistency:
  - Python request/response shapes use `RpcRequest`, `RpcResponse`, and `RpcNotification`.
  - Gateway protocol version is `PROTOCOL_VERSION = 1`.
  - Node method names match the spec: `session.bootstrap`, `turn.submit`, `turn.interrupt`, `command.run`, `completion.slash`, `completion.path`, `status.inspect`, `session.list`, `session.resume`, and `shutdown`.
- Verification:
  - Focused Python tests, Node tests, ruff, mypy, full pytest, and real provider smoke are all required before completion.
