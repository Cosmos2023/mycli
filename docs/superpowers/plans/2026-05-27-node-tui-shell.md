# Node TUI Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily-usable Ink/React Node TUI that becomes the default interactive `mycli` shell while Python remains the only agent/runtime/session authority.

**Architecture:** Python continues to launch and own the Node child through the existing JSON-RPC gateway. Node keeps process stdin/stdout for RPC, opens the controlling TTY for Ink rendering and keyboard input, and stores only ephemeral UI state in reducer-managed React components. The Python gateway grows the protocol surface needed by the shell: welcome data, transcript loading, approval resolution, command presentation metadata, and view-mode synchronization.

**Tech Stack:** Python 3.13, pytest, ruff, mypy, Node.js >= 20, npm, TypeScript, tsx, React, Ink, Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-27-node-tui-shell.md`

---

## File Structure

- `src/mycli/cli/node_tui/gateway.py`: add welcome payload, `transcript.load`, `decision.resolve`, command presentation metadata, and richer event payload helpers.
- `src/mycli/cli/node_tui/process.py`: launch the TypeScript Ink shell through the local `tsx` binary and keep scripted smoke support.
- `src/mycli/cli/main.py`: make Node TUI the default interactive backend; keep `--plain` and non-interactive behavior unchanged; add fallback handling.
- `src/mycli/cli/node_tui/__init__.py`: export any new launcher helpers.
- `tests/unit/cli/node_tui/test_gateway.py`: protocol behavior for welcome, transcript loading, decision resolution, command metadata.
- `tests/unit/cli/node_tui/test_process.py`: Node/tsx entrypoint resolution and fallback error coverage.
- `tests/unit/cli/test_main.py`: default routing, `--plain`, env overrides, fallback behavior.
- `tests/integration/test_node_tui_gateway.py`: fake process integration for new protocol and shutdown.
- `tui/node/package.json`: add TypeScript, React, Ink, tsx scripts, and package dependencies.
- `tui/node/tsconfig.json`: strict TypeScript config for the Node TUI package.
- `tui/node/src/index.tsx`: production Ink entrypoint.
- `tui/node/src/index.js`: small compatibility wrapper that runs the scripted smoke client when `MYCLI_NODE_TUI_SCRIPT` is set, otherwise delegates to the production TypeScript entrypoint through the launcher path.
- `tui/node/src/protocol/types.ts`: typed JSON-RPC envelopes, requests, responses, notifications, and protocol payloads.
- `tui/node/src/protocol/client.ts`: typed gateway client over RPC streams.
- `tui/node/src/smoke/scriptedClient.ts`: existing scripted smoke behavior ported from JavaScript.
- `tui/node/src/state/types.ts`: UI state and transcript item types.
- `tui/node/src/state/reducer.ts`: shell reducer for runtime, turn, transcript, command, approval, view, completion, and status events.
- `tui/node/src/state/completion.ts`: completion state helpers and stale-response guards.
- `tui/node/src/state/transcript.ts`: transcript projection, folding, streaming, final-answer reconciliation, and tool summaries.
- `tui/node/src/terminal/tty.ts`: controlling TTY open/close adapter for Ink.
- `tui/node/src/terminal/keymap.ts`: key interpretation helpers.
- `tui/node/src/app/App.tsx`: top-level Ink app wiring protocol client to reducer and components.
- `tui/node/src/app/Transcript.tsx`: transcript list, streaming answer, folded tool rows, and markdown rendering boundary.
- `tui/node/src/app/InputBox.tsx`: editable prompt input, submit, interrupt, Ctrl+D, and local draft restore.
- `tui/node/src/app/CompletionPopup.tsx`: slash/path completion popup with selected-row scrolling.
- `tui/node/src/app/StatusLine.tsx`: bottom status line.
- `tui/node/src/app/Overlay.tsx`: command overlays.
- `tui/node/src/app/ApprovalPrompt.tsx`: pending approval prompt and decision dispatch.
- `tui/node/test/*.test.ts`: reducer, completion, transcript, protocol, and smoke tests.
- `tui/node/test/*.test.tsx`: Ink component snapshot tests.
- `docs/superpowers/reports/2026-05-27-node-tui-shell-smoke.md`: final verification report.

Implementation decisions locked by this plan:

- Use TypeScript for production Node shell code.
- Use `tsx` for local execution instead of checking compiled `dist/` artifacts into git.
- Keep the existing scripted smoke behavior, but move it under `src/smoke/`.
- Keep Python Textual TUI as an explicit fallback target only; do not delete it.
- Do not move slash command, approval, transcript history, session, tool, or prompt logic into Node.

---

### Task 1: Python Gateway Shell Protocol Extensions

**Files:**
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`

- [ ] **Step 1: Write failing gateway protocol tests**

Add these tests to `tests/unit/cli/node_tui/test_gateway.py`:

```python
from mycli.domain.runtime import (
    ActivityEvent,
    DecisionAction,
    DecisionKind,
    PendingDecision,
)
from mycli.domain.runtime.session_history import HistoryItem, HistoryItemType
from mycli.domain.tools import ToolCall


def test_gateway_bootstrap_includes_welcome_payload(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="session.bootstrap",
            params={"protocol_version": 1, "client": {"name": "test", "version": "0"}},
        )
    )

    assert response.result is not None
    welcome = response.result["welcome"]
    assert welcome["session_id"] == "demo"
    assert welcome["workspace"] == str(tmp_path)
    assert welcome["model"] == "deepseek-v4-flash"
    assert welcome["provider"] == "deepseek/chat_completions"
    assert welcome["context_window"] == {
        "used_tokens": 123,
        "max_tokens": 100000,
        "source": "provider",
    }
    assert welcome["startup_mark"]["name"] == "default"
    assert "mycli" in welcome["startup_mark"]["text"].lower()
    assert "/help" in welcome["tips"]


def test_gateway_command_run_returns_presentation_and_view_mode(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))

    usage = gateway.handle_request(
        RpcRequest(id="req_1", method="command.run", params={"command": "/usage"})
    )
    view = gateway.handle_request(
        RpcRequest(id="req_2", method="command.run", params={"command": "/view verbose"})
    )
    quit_response = gateway.handle_request(
        RpcRequest(id="req_3", method="command.run", params={"command": "/quit"})
    )

    assert usage.result is not None
    assert usage.result["presentation"] == "overlay"
    assert usage.result["exit_requested"] is False
    assert view.result is not None
    assert view.result["view_mode"] == "verbose"
    assert view.result["presentation"] == "transcript"
    assert quit_response.result is not None
    assert quit_response.result["exit_requested"] is True


def test_gateway_transcript_load_projects_history_items(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    service._session_service.history_items = (
        HistoryItem(
            id="hist_user",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.USER_MESSAGE,
            text="Read pyproject.toml",
            metadata={"created_at": "2026-05-27T08:00:00Z"},
        ),
        HistoryItem(
            id="hist_assistant",
            thread_id="demo",
            turn_id="turn_1",
            type=HistoryItemType.ASSISTANT_MESSAGE,
            text="The project is mycli.",
            metadata={"created_at": "2026-05-27T08:00:01Z"},
        ),
    )
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="transcript.load",
            params={"session_id": "demo", "limit": 20, "before": None},
        )
    )

    assert response.result == {
        "session_id": "demo",
        "items": [
            {
                "id": "hist_user",
                "type": "user",
                "text": "Read pyproject.toml",
                "created_at": "2026-05-27T08:00:00Z",
                "folded": False,
                "metadata": {},
            },
            {
                "id": "hist_assistant",
                "type": "assistant_final",
                "text": "The project is mycli.",
                "created_at": "2026-05-27T08:00:01Z",
                "folded": False,
                "metadata": {},
            },
        ],
        "next_before": None,
    }


def test_gateway_decision_resolve_maps_choice_and_emits_turn_events(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, object]]] = []
    service = FakeTurnService(tmp_path)
    service._session_service.pending_decision = PendingDecision(
        tool_call=ToolCall(name="Bash", arguments={"command": "git push"}, reason="push"),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    gateway = NodeTuiGateway(service=service, emit=lambda method, params: events.append((method, params)))

    response = gateway.handle_request(
        RpcRequest(
            id="req_1",
            method="decision.resolve",
            params={"decision_id": "decision_current", "choice": "approve_once"},
        )
    )
    gateway.wait_for_current_turn(timeout=2.0)

    assert response.result == {
        "accepted": True,
        "decision_id": "decision_current",
        "client_turn_id": "approval_req_1",
    }
    assert service.resolved_choices == ["1"]
    assert [method for method, _params in events] == [
        "turn.started",
        "turn.completed",
        "status.changed",
    ]
```

Extend the local fakes in the same test file:

```python
class FakeSessionService:
    def __init__(self) -> None:
        self.history_items: tuple[HistoryItem, ...] = ()
        self.pending_decision: object | None = None

    def load_pending_decision(self, _session_id: str) -> object | None:
        return self.pending_decision

    def load_history_items(self, _session_id: str) -> tuple[HistoryItem, ...]:
        return self.history_items
```

Add to `FakeTurnService`:

```python
        self.resolved_choices: list[str] = []

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        self.resolved_choices.append(choice)
        self._session_service.pending_decision = None
        return TurnResponse(assistant_message=f"resolved {choice}")
```

- [ ] **Step 2: Run failing gateway tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py -q
```

Expected: FAIL because `welcome`, `transcript.load`, `decision.resolve`, and command metadata are not implemented.

- [ ] **Step 3: Implement gateway protocol extensions**

Modify `src/mycli/cli/node_tui/gateway.py`:

```python
from mycli.cli.tui.marks import startup_mark
from mycli.domain.runtime import DecisionAction
from mycli.domain.runtime.session_history import HistoryItem, HistoryItemType


COMMAND_OVERLAYS = {"/help", "/status", "/usage", "/context", "/sessions", "/release-notes"}
DECISION_CHOICE_MAP = {
    "approve_once": "1",
    "reject": "2",
    "allow_session": "3",
}
```

Add request routing:

```python
            if request.method == "transcript.load":
                return result_response(request.id, self._handle_transcript_load(request.params))
            if request.method == "decision.resolve":
                return self._handle_decision_resolve(request)
```

Add `welcome` to `_handle_bootstrap()`:

```python
            "welcome": self._welcome_payload(),
```

Add helper methods:

```python
    def _welcome_payload(self) -> dict[str, object]:
        mark_name = str(getattr(self.service._config, "tui_startup_mark", "default") or "default")
        return {
            "version": "0.1.0",
            "session_id": self.service._config.session_id,
            "workspace": str(self.service._config.workspace_root),
            "model": self.service._config.model,
            "provider": (
                f"{self.service._config.provider.value}/"
                f"{self.service._config.protocol.value}"
            ),
            "context_window": self._status_payload()["context_window"],
            "startup_mark": {"name": mark_name, "text": startup_mark(mark_name)},
            "tips": ["/help", "/context", "/usage", "/sessions"],
            "release_notes_hint": "Run /release-notes",
        }

    def _handle_transcript_load(self, params: dict[str, object]) -> dict[str, object]:
        session_id = _optional_str(params.get("session_id")) or self.service._config.session_id
        limit = _positive_int(params.get("limit"), default=200)
        before = _optional_str(params.get("before"))
        items = list(self.service._session_service.load_history_items(session_id))
        if before is not None:
            before_index = next((index for index, item in enumerate(items) if item.id == before), len(items))
            items = items[:before_index]
        selected = items[-limit:]
        projected = [_project_history_item(item) for item in selected]
        next_before = selected[0].id if len(items) > len(selected) and selected else None
        return {"session_id": session_id, "items": projected, "next_before": next_before}

    def _handle_decision_resolve(self, request: RpcRequest) -> RpcResponse:
        decision_id = _required_str(request.params, "decision_id")
        if decision_id != "decision_current":
            return error_response(
                request.id,
                code="decision_not_pending",
                message="No pending decision matches the provided decision_id.",
            )
        choice = _required_str(request.params, "choice")
        mapped = DECISION_CHOICE_MAP.get(choice)
        if mapped is None:
            return error_response(request.id, code="invalid_params", message="Unsupported decision choice.")
        pending = self.service._session_service.load_pending_decision(self.service._config.session_id)
        if pending is None:
            return error_response(
                request.id,
                code="decision_not_pending",
                message="No pending decision is available.",
            )
        client_turn_id = f"approval_{request.id}"
        with self._turn_lock:
            if self._turn_running:
                return error_response(
                    request.id,
                    code="turn_in_progress",
                    message="A turn is already running.",
                )
            self._turn_running = True
            self._turn_thread = Thread(
                target=self._run_decision_worker,
                kwargs={"choice": mapped, "client_turn_id": client_turn_id},
                daemon=True,
            )
            self._turn_thread.start()
        return result_response(
            request.id,
            {"accepted": True, "decision_id": decision_id, "client_turn_id": client_turn_id},
        )

    def _run_decision_worker(self, *, choice: str, client_turn_id: str) -> None:
        self._emit_event("turn.started", {"client_turn_id": client_turn_id})
        try:
            response = self.service.resolve_pending_decision(choice)
        except Exception as exc:
            self._emit_event("turn.failed", {"client_turn_id": client_turn_id, "message": str(exc)})
        else:
            self._emit_event(
                "turn.completed",
                self._turn_completed_payload(client_turn_id=client_turn_id, response=response),
            )
        finally:
            with self._turn_lock:
                self._turn_running = False
            self._emit_event("status.changed", self._status_payload())
```

Update `_handle_command_run()` result:

```python
        result: dict[str, object] = {
            "lines": lines,
            "mutated_session": mutated_session,
            "presentation": "overlay" if command.split(maxsplit=1)[0] in COMMAND_OVERLAYS else "transcript",
            "exit_requested": builtin == "quit",
        }
        view_mode = _view_mode_from_command(command)
        if view_mode is not None:
            result["view_mode"] = view_mode
        return result
```

Add helpers:

```python
def _positive_int(value: object, *, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return default
    return value


def _view_mode_from_command(command: str) -> str | None:
    parts = command.split(maxsplit=1)
    if len(parts) == 2 and parts[0] == "/view" and parts[1] in {"default", "verbose", "focus"}:
        return parts[1]
    return None


def _project_history_item(item: HistoryItem) -> dict[str, object]:
    item_type = {
        HistoryItemType.USER_MESSAGE: "user",
        HistoryItemType.ASSISTANT_MESSAGE: "assistant_final",
        HistoryItemType.TOOL_CALL: "tool_summary",
        HistoryItemType.TOOL_RESULT: "tool_detail",
        HistoryItemType.APPROVAL_REQUEST: "approval",
        HistoryItemType.APPROVAL_RESOLUTION: "system_notice",
        HistoryItemType.WARNING: "warning",
        HistoryItemType.COMPACTION: "system_notice",
    }.get(item.type, "system_notice")
    return {
        "id": item.id,
        "type": item_type,
        "text": item.text or "",
        "created_at": str(item.metadata.get("created_at") or ""),
        "folded": item_type in {"tool_detail"},
        "metadata": dict(item.metadata),
    }
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
git commit -m "Extend Node TUI gateway for shell protocol"
```

---

### Task 2: Node TypeScript And Ink Tooling

**Files:**
- Modify: `tui/node/package.json`
- Create: `tui/node/tsconfig.json`
- Modify: `src/mycli/cli/node_tui/process.py`
- Modify: `tests/unit/cli/node_tui/test_process.py`

- [ ] **Step 1: Write failing process launcher tests**

Add to `tests/unit/cli/node_tui/test_process.py`:

```python
from mycli.cli.node_tui.process import build_node_command, resolve_node_entrypoint


def test_build_node_command_runs_tsx_shell_entrypoint(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "node"
    entrypoint = node_root / "src" / "index.tsx"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    entrypoint.parent.mkdir(parents=True)
    tsx_bin.parent.mkdir(parents=True)
    entrypoint.write_text("export {}", encoding="utf-8")
    tsx_bin.write_text("#!/usr/bin/env node\n", encoding="utf-8")

    assert build_node_command(repo_root=tmp_path, env={}) == [str(tsx_bin), str(entrypoint)]


def test_build_node_command_keeps_scripted_client_entrypoint(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "node"
    scripted = node_root / "src" / "index.js"
    scripted.parent.mkdir(parents=True)
    scripted.write_text("console.log('scripted')", encoding="utf-8")

    command = build_node_command(repo_root=tmp_path, env={"MYCLI_NODE_TUI_SCRIPT": "[]"})

    assert command == ["node", str(scripted)]
```

- [ ] **Step 2: Run failing launcher tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_process.py::test_build_node_command_runs_tsx_shell_entrypoint tests/unit/cli/node_tui/test_process.py::test_build_node_command_keeps_scripted_client_entrypoint -q
```

Expected: FAIL because `build_node_command()` is not implemented.

- [ ] **Step 3: Update Node package tooling**

Modify `tui/node/package.json`:

```json
{
  "name": "mycli-node-tui",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --import tsx --test \"test/**/*.test.ts\" \"test/**/*.test.tsx\" \"test/**/*.test.js\"",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "ink": "^6.5.0",
    "react": "^19.2.0",
    "tsx": "^4.20.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/react": "^19.0.0",
    "ink-testing-library": "^4.0.0",
    "typescript": "^5.9.0"
  }
}
```

Create `tui/node/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node", "react"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "test/**/*.tsx"]
}
```

- [ ] **Step 4: Install Node dependencies and create lockfile**

Run:

```bash
npm --prefix tui/node install
```

Expected: PASS and `tui/node/package-lock.json` created or updated.

- [ ] **Step 5: Implement launcher command helper**

Modify `src/mycli/cli/node_tui/process.py`:

```python
def build_node_command(*, repo_root: Path, env: Mapping[str, str]) -> list[str]:
    if env.get("MYCLI_NODE_TUI_SCRIPT"):
        return ["node", str(resolve_node_entrypoint(repo_root=repo_root, env=env))]
    override = env.get("MYCLI_NODE_TUI_ENTRYPOINT")
    if override:
        return ["node", str(Path(override).expanduser())]
    node_root = repo_root / "tui" / "node"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    entrypoint = node_root / "src" / "index.tsx"
    if not tsx_bin.is_file():
        raise NodeTuiProcessError(
            "Node TUI dependencies are not installed. Run: npm --prefix tui/node install"
        )
    if not entrypoint.is_file():
        raise NodeTuiProcessError(f"Node TUI entrypoint not found: {entrypoint}")
    return [str(tsx_bin), str(entrypoint)]
```

Update `build_node_tui_process()`:

```python
    return NodeTuiProcess(args=build_node_command(repo_root=repo_root, env=env), env=child_env, cwd=repo_root)
```

- [ ] **Step 6: Run process tests and Node typecheck**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_process.py -q
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/cli/node_tui/process.py tests/unit/cli/node_tui/test_process.py tui/node/package.json tui/node/package-lock.json tui/node/tsconfig.json
git commit -m "Add TypeScript Ink tooling for Node TUI"
```

---

### Task 3: Typed Node Protocol Client And Scripted Smoke Port

**Files:**
- Create: `tui/node/src/protocol/types.ts`
- Create: `tui/node/src/protocol/client.ts`
- Create: `tui/node/src/smoke/scriptedClient.ts`
- Modify: `tui/node/src/index.js`
- Delete after port if unused: `tui/node/src/protocol.js`
- Delete after port if unused: `tui/node/src/client.js`
- Modify: `tui/node/test/protocol.test.js`
- Modify: `tui/node/test/client.test.js`

- [ ] **Step 1: Write failing TypeScript protocol tests**

Create `tui/node/test/protocol.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { decodeMessage, encodeMessage, request } from "../src/protocol/client.ts";

test("encodes one JSON-RPC request line", () => {
  const line = encodeMessage(request("1", "status.inspect", {}));
  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(line), {
    jsonrpc: "2.0",
    id: "1",
    method: "status.inspect",
    params: {},
  });
});

test("decodes notifications and responses", () => {
  assert.deepEqual(
    decodeMessage('{"jsonrpc":"2.0","method":"runtime.ready","params":{"ok":true}}'),
    { jsonrpc: "2.0", method: "runtime.ready", params: { ok: true } },
  );
  assert.deepEqual(
    decodeMessage('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}'),
    { jsonrpc: "2.0", id: "1", result: { ok: true } },
  );
});
```

Create `tui/node/test/client.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { GatewayClient } from "../src/protocol/client.ts";

test("typed client sends requests and receives matching responses", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: string[] = [];
  output.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  const client = new GatewayClient({ input, output });
  client.start();

  const promise = client.send("status.inspect", {});
  input.write('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}\n');

  assert.match(writes.join(""), /"method":"status.inspect"/);
  assert.deepEqual(await promise, { ok: true });
  client.stop();
});

test("typed client waits for matching events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new GatewayClient({ input, output });
  client.start();

  const promise = client.waitForEvent(
    "turn.completed",
    (event) => event.params?.client_turn_id === "c1",
  );
  input.write('{"jsonrpc":"2.0","method":"turn.completed","params":{"client_turn_id":"c1"}}\n');

  assert.equal((await promise).method, "turn.completed");
  client.stop();
});
```

- [ ] **Step 2: Run failing TypeScript protocol tests**

Run:

```bash
npm --prefix tui/node test -- test/protocol.test.ts test/client.test.ts
```

Expected: FAIL because `src/protocol/client.ts` does not exist.

- [ ] **Step 3: Add protocol types and client**

Create `tui/node/src/protocol/types.ts`:

```ts
export type JsonObject = Record<string, unknown>;

export type RpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: JsonObject;
};

export type RpcResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: JsonObject;
  error?: { code: string; message: string };
};

export type RpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params: JsonObject;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export type GatewayEvent = RpcNotification;

export type GatewayClientOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (event: GatewayEvent) => void;
};
```

Create `tui/node/src/protocol/client.ts`:

```ts
import { createInterface, type Interface } from "node:readline";
import type {
  GatewayClientOptions,
  GatewayEvent,
  JsonObject,
  RpcMessage,
  RpcRequest,
} from "./types.ts";

type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
};

type EventWaiter = {
  method: string;
  predicate: (event: GatewayEvent) => boolean;
  resolve: (event: GatewayEvent) => void;
};

export function request(id: string, method: string, params: JsonObject = {}): RpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

export function encodeMessage(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeMessage(line: string): RpcMessage {
  const message = JSON.parse(line) as RpcMessage;
  if (message.jsonrpc !== "2.0") {
    throw new Error("Unsupported JSON-RPC version");
  }
  return message;
}

export class GatewayClient {
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private eventWaiters: EventWaiter[] = [];
  private events: GatewayEvent[] = [];
  private readline: Interface | null = null;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly log: (event: GatewayEvent) => void;

  constructor({ input, output, log = () => undefined }: GatewayClientOptions) {
    this.input = input;
    this.output = output;
    this.log = log;
  }

  start(): void {
    this.readline = createInterface({ input: this.input, crlfDelay: Infinity });
    this.readline.on("line", (line) => this.handleLine(line));
  }

  stop(): void {
    this.readline?.close();
    this.readline = null;
  }

  send(method: string, params: JsonObject = {}): Promise<JsonObject> {
    const id = String(this.nextId++);
    this.output.write(encodeMessage(request(id, method, params)));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  waitForEvent(
    method: string,
    predicate: (event: GatewayEvent) => boolean = () => true,
  ): Promise<GatewayEvent> {
    const existing = this.events.find((event) => event.method === method && predicate(event));
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => this.eventWaiters.push({ method, predicate, resolve }));
  }

  private handleLine(line: string): void {
    const message = decodeMessage(line);
    if ("id" in message && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      if (!pending) {
        return;
      }
      if ("error" in message && message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(("result" in message && message.result) || {});
      }
      return;
    }
    if ("method" in message) {
      this.events.push(message);
      this.log(message);
      this.resolveEventWaiters(message);
    }
  }

  private resolveEventWaiters(event: GatewayEvent): void {
    const remaining: EventWaiter[] = [];
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

- [ ] **Step 4: Port scripted smoke client**

Create `tui/node/src/smoke/scriptedClient.ts`:

```ts
import { GatewayClient } from "../protocol/client.ts";

export async function runScriptedClient(scriptRaw = process.env.MYCLI_NODE_TUI_SCRIPT || "[]"): Promise<void> {
  const client = new GatewayClient({
    input: process.stdin,
    output: process.stdout,
    log: (event) => {
      process.stderr.write(`[node-tui] ${event.method}\n`);
    },
  });
  client.start();
  try {
    await client.send("session.bootstrap", {
      protocol_version: 1,
      client: { name: "mycli-node-tui", version: "0.2.0" },
    });
    const script = JSON.parse(scriptRaw) as unknown[];
    for (const item of script) {
      if (typeof item !== "string" || !item.trim()) {
        continue;
      }
      if (item.startsWith("/")) {
        const result = await client.send("command.run", { command: item });
        for (const line of (result.lines as string[] | undefined) ?? []) {
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
  } finally {
    client.stop();
  }
}
```

Modify `tui/node/src/index.js`:

```js
import("./smoke/scriptedClient.ts")
  .then(({ runScriptedClient }) => runScriptedClient())
  .catch((error) => {
    process.stderr.write(`[node-tui] error: ${error.message}\n`);
    process.exitCode = 1;
  });
```

- [ ] **Step 5: Run Node protocol tests**

Run:

```bash
npm --prefix tui/node test -- test/protocol.test.ts test/client.test.ts
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 6: Remove obsolete JavaScript protocol files after tests pass**

Remove:

```bash
rm tui/node/src/protocol.js tui/node/src/client.js tui/node/test/protocol.test.js tui/node/test/client.test.js
```

Run:

```bash
npm --prefix tui/node test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tui/node
git commit -m "Port Node TUI protocol client to TypeScript"
```

---

### Task 4: Shell Reducer And Transcript State

**Files:**
- Create: `tui/node/src/state/types.ts`
- Create: `tui/node/src/state/transcript.ts`
- Create: `tui/node/src/state/reducer.ts`
- Create: `tui/node/test/reducer.test.ts`
- Create: `tui/node/test/transcript.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Create `tui/node/test/reducer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("bootstrap adds welcome notice and status", () => {
  const state = reduceShellState(initialState(), {
    type: "bootstrap.result",
    payload: {
      session_id: "demo",
      workspace: "/repo",
      model: "deepseek-v4",
      provider: "deepseek/chat_completions",
      status: {
        context_window: { used_tokens: 10, max_tokens: 100, source: "provider" },
      },
      welcome: {
        version: "0.1.0",
        session_id: "demo",
        workspace: "/repo",
        model: "deepseek-v4",
        provider: "deepseek/chat_completions",
        context_window: { used_tokens: 10, max_tokens: 100, source: "provider" },
        startup_mark: { name: "default", text: "mycli" },
        tips: ["/help"],
        release_notes_hint: "Run /release-notes",
      },
    },
  });

  assert.equal(state.sessionId, "demo");
  assert.equal(state.transcript[0]?.type, "system_notice");
  assert.match(state.transcript[0]?.text ?? "", /mycli/);
});

test("turn events stream into one assistant item and finalize authoritatively", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  state = reduceShellState(state, { type: "gateway.event", method: "turn.started", params: { client_turn_id: "c1" } });
  state = reduceShellState(state, { type: "gateway.event", method: "turn.event", params: { client_turn_id: "c1", phase: "assistant_delta", kind: "text_delta", text: "hel" } });
  state = reduceShellState(state, { type: "gateway.event", method: "turn.event", params: { client_turn_id: "c1", phase: "assistant_delta", kind: "text_delta", text: "lo" } });
  state = reduceShellState(state, { type: "gateway.event", method: "turn.completed", params: { client_turn_id: "c1", assistant_message: "hello final", activity_events: [], progress_updates: [], plan_steps: [], pending_decision: false } });

  assert.equal(state.turnRunning, false);
  assert.equal(state.transcript.at(-1)?.type, "assistant_final");
  assert.equal(state.transcript.at(-1)?.text, "hello final");
});

test("command view mode updates local UI state", () => {
  const state = reduceShellState(initialState(), {
    type: "command.result",
    command: "/view verbose",
    result: { lines: ["[view] mode=verbose"], presentation: "transcript", view_mode: "verbose" },
  });

  assert.equal(state.viewMode, "verbose");
});
```

Create `tui/node/test/transcript.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyToolEvent, reconcileFinalAnswer } from "../src/state/transcript.ts";
import type { TranscriptItem } from "../src/state/types.ts";

test("tool call creates folded summary in default view", () => {
  const items: TranscriptItem[] = [];
  const next = applyToolEvent(items, {
    client_turn_id: "c1",
    phase: "tool_call",
    kind: "tool_call",
    tool_name: "Read",
    metadata: { path: "pyproject.toml" },
  });

  assert.equal(next[0]?.type, "tool_summary");
  assert.equal(next[0]?.folded, true);
  assert.match(next[0]?.text ?? "", /Read/);
});

test("final answer replaces active stream without duplication", () => {
  const items: TranscriptItem[] = [
    { id: "a1", type: "assistant_stream", text: "hello", folded: false, metadata: {} },
  ];

  const next = reconcileFinalAnswer(items, "hello final");

  assert.equal(next.length, 1);
  assert.equal(next[0]?.type, "assistant_final");
  assert.equal(next[0]?.text, "hello final");
});
```

- [ ] **Step 2: Run failing reducer tests**

Run:

```bash
npm --prefix tui/node test -- test/reducer.test.ts test/transcript.test.ts
```

Expected: FAIL because state modules do not exist.

- [ ] **Step 3: Implement state types**

Create `tui/node/src/state/types.ts`:

```ts
export type ViewMode = "default" | "verbose" | "focus";

export type TranscriptItemType =
  | "user"
  | "assistant_stream"
  | "assistant_final"
  | "execution_status"
  | "tool_summary"
  | "tool_detail"
  | "command_output"
  | "warning"
  | "error"
  | "approval"
  | "system_notice";

export type TranscriptItem = {
  id: string;
  type: TranscriptItemType;
  text: string;
  folded: boolean;
  metadata: Record<string, unknown>;
};

export type CompletionState = {
  visible: boolean;
  requestId: number;
  prefix: string;
  items: Array<{ value: string; description?: string; kind?: string }>;
  selectedIndex: number;
};

export type OverlayState = {
  visible: boolean;
  title: string;
  lines: string[];
};

export type ShellState = {
  sessionId: string | null;
  workspace: string;
  model: string;
  provider: string;
  status: Record<string, unknown>;
  transcript: TranscriptItem[];
  inputDraft: string;
  restoredDraft: string;
  turnRunning: boolean;
  currentTurnId: string | null;
  viewMode: ViewMode;
  completion: CompletionState;
  overlay: OverlayState;
  pendingApproval: Record<string, unknown> | null;
};
```

- [ ] **Step 4: Implement transcript helpers and reducer**

Create `tui/node/src/state/transcript.ts`:

```ts
import type { TranscriptItem } from "./types.ts";

let nextItemId = 1;

export function itemId(prefix: string): string {
  return `${prefix}_${nextItemId++}`;
}

export function applyTextDelta(items: TranscriptItem[], text: string): TranscriptItem[] {
  const last = items.at(-1);
  if (last?.type === "assistant_stream") {
    return [...items.slice(0, -1), { ...last, text: `${last.text}${text}` }];
  }
  return [...items, { id: itemId("assistant"), type: "assistant_stream", text, folded: false, metadata: {} }];
}

export function reconcileFinalAnswer(items: TranscriptItem[], answer: string): TranscriptItem[] {
  const last = items.at(-1);
  const finalItem: TranscriptItem = {
    id: last?.type === "assistant_stream" ? last.id : itemId("assistant"),
    type: "assistant_final",
    text: answer,
    folded: false,
    metadata: {},
  };
  if (last?.type === "assistant_stream") {
    return [...items.slice(0, -1), finalItem];
  }
  return [...items, finalItem];
}

export function applyToolEvent(items: TranscriptItem[], event: Record<string, unknown>): TranscriptItem[] {
  const name = typeof event.tool_name === "string" ? event.tool_name : "Tool";
  const metadata = typeof event.metadata === "object" && event.metadata !== null ? event.metadata as Record<string, unknown> : {};
  const path = typeof metadata.path === "string" ? ` ${metadata.path}` : "";
  return [
    ...items,
    {
      id: itemId("tool"),
      type: "tool_summary",
      text: `${name}${path}`,
      folded: true,
      metadata,
    },
  ];
}
```

Create `tui/node/src/state/reducer.ts`:

```ts
import { applyTextDelta, applyToolEvent, reconcileFinalAnswer, itemId } from "./transcript.ts";
import type { ShellState, ViewMode } from "./types.ts";

export type ShellAction =
  | { type: "bootstrap.result"; payload: Record<string, any> }
  | { type: "user.submit"; message: string }
  | { type: "gateway.event"; method: string; params: Record<string, any> }
  | { type: "command.result"; command: string; result: Record<string, any> };

export function initialState(): ShellState {
  return {
    sessionId: null,
    workspace: "",
    model: "",
    provider: "",
    status: {},
    transcript: [],
    inputDraft: "",
    restoredDraft: "",
    turnRunning: false,
    currentTurnId: null,
    viewMode: "default",
    completion: { visible: false, requestId: 0, prefix: "", items: [], selectedIndex: 0 },
    overlay: { visible: false, title: "", lines: [] },
    pendingApproval: null,
  };
}

export function reduceShellState(state: ShellState, action: ShellAction): ShellState {
  if (action.type === "bootstrap.result") {
    const welcome = action.payload.welcome as Record<string, any> | undefined;
    const welcomeText = welcome ? `${welcome.startup_mark?.text ?? "mycli"}\n${welcome.workspace ?? ""}` : "mycli";
    return {
      ...state,
      sessionId: String(action.payload.session_id ?? ""),
      workspace: String(action.payload.workspace ?? ""),
      model: String(action.payload.model ?? ""),
      provider: String(action.payload.provider ?? ""),
      status: (action.payload.status as Record<string, unknown>) ?? {},
      transcript: [
        ...state.transcript,
        { id: itemId("welcome"), type: "system_notice", text: welcomeText, folded: false, metadata: welcome ?? {} },
      ],
    };
  }
  if (action.type === "user.submit") {
    return {
      ...state,
      restoredDraft: action.message,
      transcript: [...state.transcript, { id: itemId("user"), type: "user", text: action.message, folded: false, metadata: {} }],
    };
  }
  if (action.type === "gateway.event") {
    if (action.method === "turn.started") {
      return { ...state, turnRunning: true, currentTurnId: String(action.params.client_turn_id ?? "") };
    }
    if (action.method === "turn.event" && action.params.phase === "assistant_delta") {
      return { ...state, transcript: applyTextDelta(state.transcript, String(action.params.text ?? "")) };
    }
    if (action.method === "turn.event" && action.params.phase === "tool_call") {
      return { ...state, transcript: applyToolEvent(state.transcript, action.params) };
    }
    if (action.method === "turn.completed") {
      return {
        ...state,
        turnRunning: false,
        currentTurnId: null,
        transcript: reconcileFinalAnswer(state.transcript, String(action.params.assistant_message ?? "")),
      };
    }
  }
  if (action.type === "command.result") {
    const viewMode = action.result.view_mode as ViewMode | undefined;
    return {
      ...state,
      viewMode: viewMode ?? state.viewMode,
      transcript:
        action.result.presentation === "transcript"
          ? [
              ...state.transcript,
              { id: itemId("command"), type: "command_output", text: ((action.result.lines as string[]) ?? []).join("\n"), folded: false, metadata: {} },
            ]
          : state.transcript,
      overlay:
        action.result.presentation === "overlay"
          ? { visible: true, title: action.command, lines: (action.result.lines as string[]) ?? [] }
          : state.overlay,
    };
  }
  return state;
}
```

- [ ] **Step 5: Run reducer tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/reducer.test.ts test/transcript.test.ts
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tui/node/src/state tui/node/test/reducer.test.ts tui/node/test/transcript.test.ts
git commit -m "Add Node TUI shell reducer state"
```

---

### Task 5: Ink App Shell, TTY Adapter, And Component Snapshots

**Files:**
- Create: `tui/node/src/terminal/tty.ts`
- Create: `tui/node/src/app/App.tsx`
- Create: `tui/node/src/app/Transcript.tsx`
- Create: `tui/node/src/app/StatusLine.tsx`
- Create: `tui/node/src/app/Overlay.tsx`
- Create: `tui/node/src/app/ApprovalPrompt.tsx`
- Create: `tui/node/src/index.tsx`
- Create: `tui/node/test/app.test.tsx`

- [ ] **Step 1: Write failing Ink component snapshot tests**

Create `tui/node/test/app.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Transcript } from "../src/app/Transcript.tsx";
import { StatusLine } from "../src/app/StatusLine.tsx";
import { Overlay } from "../src/app/Overlay.tsx";
import type { ShellState } from "../src/state/types.ts";

const state: ShellState = {
  sessionId: "demo",
  workspace: "/repo",
  model: "deepseek-v4",
  provider: "deepseek/chat_completions",
  status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  transcript: [
    { id: "u1", type: "user", text: "read pyproject", folded: false, metadata: {} },
    { id: "t1", type: "tool_summary", text: "Read pyproject.toml", folded: true, metadata: {} },
    { id: "a1", type: "assistant_final", text: "Project is mycli.", folded: false, metadata: {} },
  ],
  inputDraft: "",
  restoredDraft: "",
  turnRunning: false,
  currentTurnId: null,
  viewMode: "default",
  completion: { visible: false, requestId: 0, prefix: "", items: [], selectedIndex: 0 },
  overlay: { visible: true, title: "/usage", lines: ["turns=1"] },
  pendingApproval: null,
};

test("transcript renders user, folded tool summary, and answer without role cards", () => {
  const { lastFrame } = render(<Transcript state={state} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /read pyproject/);
  assert.match(frame, /Read pyproject\.toml/);
  assert.match(frame, /Project is mycli/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
});

test("status line renders model and context usage", () => {
  const { lastFrame } = render(<StatusLine state={state} />);
  assert.match(lastFrame() ?? "", /deepseek-v4/);
  assert.match(lastFrame() ?? "", /3,983 \/ 100,000/);
});

test("overlay renders command lines", () => {
  const { lastFrame } = render(<Overlay overlay={state.overlay} />);
  assert.match(lastFrame() ?? "", /\/usage/);
  assert.match(lastFrame() ?? "", /turns=1/);
});
```

- [ ] **Step 2: Run failing component tests**

Run:

```bash
npm --prefix tui/node test -- test/app.test.tsx
```

Expected: FAIL because components do not exist.

- [ ] **Step 3: Add TTY adapter**

Create `tui/node/src/terminal/tty.ts`:

```ts
import fs from "node:fs";

export type TtyStreams = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  close: () => void;
};

export function openTtyStreams(): TtyStreams {
  const inputFd = fs.openSync("/dev/tty", "r");
  const outputFd = fs.openSync("/dev/tty", "w");
  const input = fs.createReadStream(null as never, { fd: inputFd, autoClose: true });
  const output = fs.createWriteStream(null as never, { fd: outputFd, autoClose: true });
  return {
    input,
    output,
    close: () => {
      input.destroy();
      output.end();
    },
  };
}
```

- [ ] **Step 4: Add Ink components**

Create `tui/node/src/app/Transcript.tsx`:

```tsx
import React, { memo } from "react";
import { Box, Text } from "ink";
import type { ShellState, TranscriptItem } from "../state/types.ts";

const TranscriptRow = memo(function TranscriptRow({ item, viewMode }: { item: TranscriptItem; viewMode: ShellState["viewMode"] }) {
  if (item.type === "tool_detail" && viewMode !== "verbose") {
    return null;
  }
  const marker = item.type === "user" ? "›" : item.type === "tool_summary" ? "·" : " ";
  const text = item.folded && viewMode === "default" ? `${item.text}` : item.text;
  return (
    <Box>
      <Text dimColor={item.type === "tool_summary"}>{marker} {text}</Text>
    </Box>
  );
});

export function Transcript({ state }: { state: ShellState }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {state.transcript.map((item) => (
        <TranscriptRow key={item.id} item={item} viewMode={state.viewMode} />
      ))}
      {state.turnRunning ? <Text dimColor>Thinking...</Text> : null}
    </Box>
  );
}
```

Create `tui/node/src/app/StatusLine.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ShellState } from "../state/types.ts";

function formatNumber(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "0";
}

export function StatusLine({ state }: { state: ShellState }) {
  const context = state.status.context_window as { used_tokens?: number; max_tokens?: number } | undefined;
  return (
    <Box justifyContent="space-between">
      <Text dimColor>{state.workspace}</Text>
      <Text dimColor>
        {state.model} context {formatNumber(context?.used_tokens)} / {formatNumber(context?.max_tokens)}
      </Text>
    </Box>
  );
}
```

Create `tui/node/src/app/Overlay.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { OverlayState } from "../state/types.ts";

export function Overlay({ overlay }: { overlay: OverlayState }) {
  if (!overlay.visible) {
    return null;
  }
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold>{overlay.title}</Text>
      {overlay.lines.map((line, index) => (
        <Text key={`${index}:${line}`}>{line}</Text>
      ))}
    </Box>
  );
}
```

Create `tui/node/src/app/ApprovalPrompt.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function ApprovalPrompt({ pendingApproval }: { pendingApproval: Record<string, unknown> | null }) {
  if (!pendingApproval) {
    return null;
  }
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text color="yellow">Approval required</Text>
      <Text>{String(pendingApproval.preview ?? "")}</Text>
    </Box>
  );
}
```

Create `tui/node/src/app/App.tsx`:

```tsx
import React from "react";
import { Box } from "ink";
import { Transcript } from "./Transcript.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { Overlay } from "./Overlay.tsx";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import type { ShellState } from "../state/types.ts";

export function App({ state }: { state: ShellState }) {
  return (
    <Box flexDirection="column" minHeight={10}>
      <Transcript state={state} />
      <Overlay overlay={state.overlay} />
      <ApprovalPrompt pendingApproval={state.pendingApproval} />
      <StatusLine state={state} />
    </Box>
  );
}
```

Create `tui/node/src/index.tsx`:

```tsx
import React from "react";
import { render } from "ink";
import { App } from "./app/App.tsx";
import { initialState } from "./state/reducer.ts";
import { openTtyStreams } from "./terminal/tty.ts";

const tty = openTtyStreams();
const instance = render(<App state={initialState()} />, {
  stdin: tty.input,
  stdout: tty.output,
  stderr: process.stderr,
});

process.on("exit", () => {
  instance.unmount();
  tty.close();
});
```

- [ ] **Step 5: Run component tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tui/node/src/app tui/node/src/terminal tui/node/src/index.tsx tui/node/test/app.test.tsx
git commit -m "Add Ink shell layout components"
```

---

### Task 6: Gateway-Backed App Runtime And Input Submission

**Files:**
- Modify: `tui/node/src/app/App.tsx`
- Create: `tui/node/src/app/InputBox.tsx`
- Modify: `tui/node/src/index.tsx`
- Create: `tui/node/test/input.test.tsx`
- Create: `tui/node/test/scripted-client.test.ts`

- [ ] **Step 1: Write failing input and scripted smoke tests**

Create `tui/node/test/input.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/app/InputBox.tsx";

test("input submits non-empty message and clears draft", () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      onDraftChange={() => undefined}
      onSubmit={(value) => submitted.push(value)}
      onInterrupt={() => undefined}
    />,
  );

  stdin.write("hello");
  stdin.write("\r");

  assert.deepEqual(submitted, ["hello"]);
  assert.doesNotMatch(lastFrame() ?? "", /hello/);
});
```

Create `tui/node/test/scripted-client.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runScriptedClient } from "../src/smoke/scriptedClient.ts";

test("scripted client still shuts down after commands", async () => {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: string[] = [];
  output.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  try {
    const promise = runScriptedClient('["/quit"]');
    input.write('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}\n');
    input.write('{"jsonrpc":"2.0","id":"2","result":{"lines":["Bye."],"exit_requested":true}}\n');
    input.write('{"jsonrpc":"2.0","id":"3","result":{"ok":true}}\n');
    await promise;
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
  }
  assert.match(writes.join(""), /session\.bootstrap/);
  assert.match(writes.join(""), /shutdown/);
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm --prefix tui/node test -- test/input.test.tsx test/scripted-client.test.ts
```

Expected: FAIL until `InputBox` exists and scripted client handles `exit_requested`.

- [ ] **Step 3: Implement input box**

Create `tui/node/src/app/InputBox.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export function InputBox({
  draft,
  turnRunning,
  completionVisible,
  onDraftChange,
  onSubmit,
  onInterrupt,
}: {
  draft: string;
  turnRunning: boolean;
  completionVisible: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onInterrupt: () => void;
}) {
  const [value, setValue] = useState(draft);
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (key.return) {
      const submitted = value.trim();
      if (submitted && !completionVisible) {
        onSubmit(submitted);
        setValue("");
        onDraftChange("");
      }
      return;
    }
    if (key.backspace || key.delete) {
      const next = value.slice(0, -1);
      setValue(next);
      onDraftChange(next);
      return;
    }
    if (!key.ctrl && input) {
      const next = `${value}${input}`;
      setValue(next);
      onDraftChange(next);
    }
  });
  return (
    <Box>
      <Text color={turnRunning ? "yellow" : "green"}>› </Text>
      <Text>{value}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Wire app to gateway client**

Modify `tui/node/src/app/App.tsx` to accept callbacks:

```tsx
export function App({
  state,
  onSubmit,
  onInterrupt,
  onDraftChange,
}: {
  state: ShellState;
  onSubmit?: (value: string) => void;
  onInterrupt?: () => void;
  onDraftChange?: (value: string) => void;
}) {
  return (
    <Box flexDirection="column" minHeight={10}>
      <Transcript state={state} />
      <Overlay overlay={state.overlay} />
      <ApprovalPrompt pendingApproval={state.pendingApproval} />
      <InputBox
        draft={state.inputDraft}
        turnRunning={state.turnRunning}
        completionVisible={state.completion.visible}
        onDraftChange={onDraftChange ?? (() => undefined)}
        onSubmit={onSubmit ?? (() => undefined)}
        onInterrupt={onInterrupt ?? (() => undefined)}
      />
      <StatusLine state={state} />
    </Box>
  );
}
```

Modify `tui/node/src/index.tsx` to bootstrap and submit turns:

```tsx
import React, { useEffect, useReducer } from "react";
import { render } from "ink";
import { App } from "./app/App.tsx";
import { initialState, reduceShellState } from "./state/reducer.ts";
import { openTtyStreams } from "./terminal/tty.ts";
import { GatewayClient } from "./protocol/client.ts";

const client = new GatewayClient({ input: process.stdin, output: process.stdout });
client.start();

function RuntimeApp() {
  const [state, dispatch] = useReducer(reduceShellState, undefined, initialState);
  useEffect(() => {
    void client
      .send("session.bootstrap", {
        protocol_version: 1,
        client: { name: "mycli-node-tui", version: "0.2.0" },
      })
      .then((payload) => dispatch({ type: "bootstrap.result", payload }));
  }, []);
  return (
    <App
      state={state}
      onSubmit={(message) => {
        dispatch({ type: "user.submit", message });
        void client.send("turn.submit", { message, client_turn_id: `ui_${Date.now()}` });
      }}
      onInterrupt={() => {
        void client.send("turn.interrupt", {});
      }}
      onDraftChange={() => undefined}
    />
  );
}

const tty = openTtyStreams();
const instance = render(<RuntimeApp />, { stdin: tty.input, stdout: tty.output, stderr: process.stderr });
process.on("exit", () => {
  client.stop();
  instance.unmount();
  tty.close();
});
```

- [ ] **Step 5: Update scripted client for `exit_requested`**

Modify command handling in `tui/node/src/smoke/scriptedClient.ts`:

```ts
      if (item.startsWith("/")) {
        const result = await client.send("command.run", { command: item });
        for (const line of (result.lines as string[] | undefined) ?? []) {
          process.stderr.write(`[node-tui] ${line}\n`);
        }
        if (result.exit_requested === true) {
          await client.send("shutdown", {});
          return;
        }
        continue;
      }
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm --prefix tui/node test -- test/input.test.tsx test/scripted-client.test.ts test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tui/node/src tui/node/test/input.test.tsx tui/node/test/scripted-client.test.ts
git commit -m "Wire Ink shell to gateway input flow"
```

---

### Task 7: Completion Popup And Keyboard Semantics

**Files:**
- Create: `tui/node/src/state/completion.ts`
- Create: `tui/node/src/app/CompletionPopup.tsx`
- Modify: `tui/node/src/app/InputBox.tsx`
- Modify: `tui/node/src/app/App.tsx`
- Create: `tui/node/test/completion.test.ts`
- Create: `tui/node/test/completion-popup.test.tsx`

- [ ] **Step 1: Write failing completion tests**

Create `tui/node/test/completion.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { acceptSelected, completionWindow, moveSelection, shouldComplete } from "../src/state/completion.ts";

const items = ["/help", "/status", "/usage", "/context", "/sessions", "/quit", "/view"].map((value) => ({ value }));

test("slash prefix opens completion without submitting bare slash", () => {
  assert.equal(shouldComplete("/"), "slash");
  assert.equal(shouldComplete("/sta"), "slash");
  assert.equal(shouldComplete("hello"), null);
});

test("selection movement wraps and keeps row in visible window", () => {
  assert.equal(moveSelection(0, 1, items.length), 1);
  assert.equal(moveSelection(0, -1, items.length), items.length - 1);
  const window = completionWindow(items, 6, 6);
  assert.deepEqual(window.map((item) => item.value), ["/status", "/usage", "/context", "/sessions", "/quit", "/view"]);
});

test("accept selected inserts command text", () => {
  assert.equal(acceptSelected(items, 2), "/usage");
});
```

Create `tui/node/test/completion-popup.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { CompletionPopup } from "../src/app/CompletionPopup.tsx";

test("completion popup renders selected row marker", () => {
  const { lastFrame } = render(
    <CompletionPopup
      visible
      items={[{ value: "/help" }, { value: "/usage" }]}
      selectedIndex={1}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\/help/);
  assert.match(frame, /› \/usage/);
});
```

- [ ] **Step 2: Run failing completion tests**

Run:

```bash
npm --prefix tui/node test -- test/completion.test.ts test/completion-popup.test.tsx
```

Expected: FAIL because completion helpers/components do not exist.

- [ ] **Step 3: Implement completion helpers**

Create `tui/node/src/state/completion.ts`:

```ts
export type CompletionKind = "slash" | "path";
export type CompletionItem = { value: string; description?: string; kind?: string };

export function shouldComplete(value: string): CompletionKind | null {
  if (value.startsWith("/")) {
    return "slash";
  }
  const atIndex = value.lastIndexOf("@");
  if (atIndex >= 0 && !/\s/.test(value.slice(atIndex + 1))) {
    return "path";
  }
  return null;
}

export function moveSelection(selectedIndex: number, delta: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (selectedIndex + delta + total) % total;
}

export function completionWindow<T>(items: T[], selectedIndex: number, size: number): T[] {
  const start = Math.min(Math.max(selectedIndex - size + 1, 0), Math.max(items.length - size, 0));
  return items.slice(start, start + size);
}

export function acceptSelected(items: CompletionItem[], selectedIndex: number): string | null {
  return items[selectedIndex]?.value ?? null;
}
```

Create `tui/node/src/app/CompletionPopup.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { completionWindow, type CompletionItem } from "../state/completion.ts";

export function CompletionPopup({
  visible,
  items,
  selectedIndex,
}: {
  visible: boolean;
  items: CompletionItem[];
  selectedIndex: number;
}) {
  if (!visible) {
    return null;
  }
  const windowItems = completionWindow(items, selectedIndex, 6);
  const offset = items.indexOf(windowItems[0] ?? items[0]);
  return (
    <Box flexDirection="column">
      {windowItems.map((item, index) => {
        const absolute = offset + index;
        return (
          <Text key={item.value} dimColor={absolute !== selectedIndex}>
            {absolute === selectedIndex ? "› " : "  "}{item.value}
          </Text>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: Wire popup into app**

Modify `tui/node/src/app/App.tsx`:

```tsx
import { CompletionPopup } from "./CompletionPopup.tsx";

// render before InputBox:
<CompletionPopup
  visible={state.completion.visible}
  items={state.completion.items}
  selectedIndex={state.completion.selectedIndex}
/>
```

Modify `InputBox` to expose arrow/tab/escape callbacks:

```tsx
onCompletionMove?: (delta: number) => void;
onCompletionAccept?: () => void;
onCompletionClose?: () => void;
```

Inside `useInput`:

```tsx
    if (completionVisible && key.downArrow) {
      onCompletionMove?.(1);
      return;
    }
    if (completionVisible && key.upArrow) {
      onCompletionMove?.(-1);
      return;
    }
    if (completionVisible && key.tab) {
      onCompletionAccept?.();
      return;
    }
    if (completionVisible && key.escape) {
      onCompletionClose?.();
      return;
    }
```

- [ ] **Step 5: Run completion tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/completion.test.ts test/completion-popup.test.tsx test/input.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tui/node/src/state/completion.ts tui/node/src/app/CompletionPopup.tsx tui/node/src/app/InputBox.tsx tui/node/src/app/App.tsx tui/node/test/completion.test.ts tui/node/test/completion-popup.test.tsx
git commit -m "Add Node TUI completion popup behavior"
```

---

### Task 8: Overlays, Approval Resolution, And Command Presentation

**Files:**
- Modify: `tui/node/src/state/reducer.ts`
- Modify: `tui/node/src/app/ApprovalPrompt.tsx`
- Modify: `tui/node/src/app/App.tsx`
- Modify: `tui/node/src/index.tsx`
- Create: `tui/node/test/approval.test.tsx`
- Modify: `tui/node/test/reducer.test.ts`

- [ ] **Step 1: Write failing approval and overlay reducer tests**

Add to `tui/node/test/reducer.test.ts`:

```ts
test("approval pending event stores prompt state", () => {
  const state = reduceShellState(initialState(), {
    type: "gateway.event",
    method: "approval.pending",
    params: {
      decision_id: "decision_current",
      preview: "git push",
      options: [{ choice: "approve_once", label: "Allow once" }],
    },
  });

  assert.equal(state.pendingApproval?.decision_id, "decision_current");
});

test("overlay command result opens overlay instead of transcript row", () => {
  const state = reduceShellState(initialState(), {
    type: "command.result",
    command: "/usage",
    result: { lines: ["turns=1"], presentation: "overlay" },
  });

  assert.equal(state.overlay.visible, true);
  assert.equal(state.overlay.lines[0], "turns=1");
  assert.equal(state.transcript.length, 0);
});
```

Create `tui/node/test/approval.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { ApprovalPrompt } from "../src/app/ApprovalPrompt.tsx";

test("approval prompt renders choices", () => {
  const { lastFrame } = render(
    <ApprovalPrompt
      pendingApproval={{
        decision_id: "decision_current",
        preview: "git push",
        options: [{ choice: "approve_once", label: "Allow once" }],
      }}
    />,
  );

  const frame = lastFrame() ?? "";
  assert.match(frame, /git push/);
  assert.match(frame, /Allow once/);
});
```

- [ ] **Step 2: Run failing approval tests**

Run:

```bash
npm --prefix tui/node test -- test/approval.test.tsx test/reducer.test.ts
```

Expected: FAIL until approval rendering and reducer event handling are complete.

- [ ] **Step 3: Extend reducer for approval and command presentation**

Modify `tui/node/src/state/reducer.ts` inside `gateway.event` handling:

```ts
    if (action.method === "approval.pending") {
      return {
        ...state,
        pendingApproval: action.params,
        transcript: [
          ...state.transcript,
          { id: itemId("approval"), type: "approval", text: String(action.params.preview ?? "Approval required"), folded: false, metadata: action.params },
        ],
      };
    }
    if (action.method === "status.changed") {
      return { ...state, status: action.params };
    }
    if (action.method === "turn.failed") {
      return {
        ...state,
        turnRunning: false,
        transcript: [
          ...state.transcript,
          { id: itemId("error"), type: "error", text: String(action.params.message ?? "Turn failed"), folded: false, metadata: action.params },
        ],
      };
    }
```

- [ ] **Step 4: Render approval choices**

Modify `tui/node/src/app/ApprovalPrompt.tsx`:

```tsx
type ApprovalOption = { choice: string; label: string };

export function ApprovalPrompt({ pendingApproval }: { pendingApproval: Record<string, unknown> | null }) {
  if (!pendingApproval) {
    return null;
  }
  const options = (pendingApproval.options as ApprovalOption[] | undefined) ?? [];
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text color="yellow">Approval required</Text>
      <Text>{String(pendingApproval.preview ?? "")}</Text>
      {options.map((option, index) => (
        <Text key={option.choice}>{index + 1}. {option.label}</Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 5: Wire command and decision runtime actions**

Modify `tui/node/src/index.tsx` callbacks:

```tsx
      onCommand={(command) => {
        void client.send("command.run", { command }).then((result) => {
          dispatch({ type: "command.result", command, result });
          if (result.exit_requested === true) {
            void client.send("shutdown", {}).then(() => process.exit(0));
          }
        });
      }}
      onDecision={(decisionId, choice) => {
        void client.send("decision.resolve", { decision_id: decisionId, choice });
      }}
```

Add matching optional props to `App` and pass them to `InputBox` / `ApprovalPrompt`.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/approval.test.tsx test/reducer.test.ts test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tui/node/src tui/node/test/approval.test.tsx tui/node/test/reducer.test.ts
git commit -m "Add Node TUI overlays and approval UI"
```

---

### Task 9: Transcript Loading, Default Routing, And Fallbacks

**Files:**
- Modify: `tui/node/src/index.tsx`
- Modify: `tui/node/src/state/reducer.ts`
- Modify: `src/mycli/cli/main.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/integration/test_node_tui_gateway.py`

- [ ] **Step 1: Write failing routing tests**

Add to `tests/unit/cli/test_main.py`:

```python
def test_main_interactive_defaults_to_node_tui(monkeypatch, tmp_path: Path) -> None:
    calls: list[str] = []

    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: object())
    monkeypatch.setattr("mycli.cli.main.run_node_tui", lambda *args, **kwargs: calls.append("node") or 0)

    assert main([], cwd=tmp_path, home=tmp_path / "home", env={}) == 0
    assert calls == ["node"]


def test_main_plain_still_overrides_default_node_tui(monkeypatch, tmp_path: Path) -> None:
    calls: list[str] = []

    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: object())
    monkeypatch.setattr("mycli.cli.main.run_repl", lambda *args, **kwargs: calls.append("plain"))

    assert main(["--plain"], cwd=tmp_path, home=tmp_path / "home", env={}) == 0
    assert calls == ["plain"]


def test_main_node_startup_fallback_to_plain(monkeypatch, tmp_path: Path) -> None:
    calls: list[str] = []

    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("mycli.cli.main.build_turn_service", lambda *args, **kwargs: object())
    monkeypatch.setattr(
        "mycli.cli.main.run_node_tui",
        lambda *args, **kwargs: (_ for _ in ()).throw(NodeTuiProcessError("node failed")),
    )
    monkeypatch.setattr("mycli.cli.main.run_repl", lambda *args, **kwargs: calls.append("plain"))

    assert main([], cwd=tmp_path, home=tmp_path / "home", env={"MYCLI_TUI_FALLBACK": "plain"}) == 0
    assert calls == ["plain"]
```

- [ ] **Step 2: Run failing routing tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_main_interactive_defaults_to_node_tui tests/unit/cli/test_main.py::test_main_plain_still_overrides_default_node_tui tests/unit/cli/test_main.py::test_main_node_startup_fallback_to_plain -q
```

Expected: FAIL because Node is not yet default and fallback is not implemented.

- [ ] **Step 3: Implement default routing and fallback**

Modify `src/mycli/cli/main.py`:

```python
def should_use_node_tui(cli_args: dict[str, object], env: dict[str, str] | None) -> bool:
    if bool(cli_args.get("plain")):
        return False
    env_vars = env or os.environ
    backend = env_vars.get("MYCLI_TUI_BACKEND", "").strip().lower()
    if backend == "textual":
        return False
    if bool(cli_args.get("node_tui")) or backend == "node":
        return True
    return stdin.isatty() and stdout.isatty()


def _node_tui_fallback(env: dict[str, str] | None) -> str:
    env_vars = env or os.environ
    return env_vars.get("MYCLI_TUI_FALLBACK", "").strip().lower()
```

Update `main()` Node error handling:

```python
        except NodeTuiProcessError as exc:
            fallback = _node_tui_fallback(env)
            if fallback == "plain":
                output_func(str(exc))
            elif fallback == "textual" and should_use_tui(args):
                output_func(str(exc))
                return run_tui(service, input_func=input_func, output_func=output_func)
            else:
                output_func(str(exc))
                return 2
```

Ensure the plain fallback falls through to the existing REPL path instead of returning.

- [ ] **Step 4: Load transcript after bootstrap in Node**

Modify `tui/node/src/index.tsx` bootstrap effect:

```tsx
      .then(async (payload) => {
        dispatch({ type: "bootstrap.result", payload });
        const transcript = await client.send("transcript.load", {
          session_id: payload.session_id,
          limit: 200,
          before: null,
        });
        dispatch({ type: "transcript.loaded", payload: transcript });
      });
```

Add reducer case:

```ts
  | { type: "transcript.loaded"; payload: Record<string, any> }
```

```ts
  if (action.type === "transcript.loaded") {
    const items = (action.payload.items as TranscriptItem[] | undefined) ?? [];
    return { ...state, transcript: [...state.transcript, ...items] };
  }
```

- [ ] **Step 5: Run routing and integration tests**

Run:

```bash
uv run pytest tests/unit/cli/test_main.py::test_main_interactive_defaults_to_node_tui tests/unit/cli/test_main.py::test_main_plain_still_overrides_default_node_tui tests/unit/cli/test_main.py::test_main_node_startup_fallback_to_plain -q
uv run pytest tests/integration/test_node_tui_gateway.py tests/unit/cli/node_tui -q
npm --prefix tui/node test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/cli/main.py tests/unit/cli/test_main.py tests/integration/test_node_tui_gateway.py tui/node/src
git commit -m "Make Node TUI the default interactive shell"
```

---

### Task 10: End-To-End Verification And Smoke Report

**Files:**
- Create: `docs/superpowers/reports/2026-05-27-node-tui-shell-smoke.md`
- Modify only if verification exposes a focused defect: files from earlier tasks.

- [ ] **Step 1: Run focused Python tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q
```

Expected: PASS.

- [ ] **Step 2: Run Node tests and typecheck**

Run:

```bash
npm --prefix tui/node test
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run static checks**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
```

Expected: PASS.

- [ ] **Step 4: Run full Python suite**

Run:

```bash
uv run pytest -q
```

Expected: PASS.

- [ ] **Step 5: Run scripted Node gateway smoke**

Run:

```bash
SMOKE_HOME="$(mktemp -d)"
SESSION="node-tui-shell-scripted-smoke-$(date +%Y%m%d%H%M%S)"
SCRIPT='["请使用 Read 工具读取 pyproject.toml，然后用一句话回答项目名和 CLI 入口点。","/view verbose","/usage","/sessions","/quit"]'
HOME="$SMOKE_HOME" MYCLI_NODE_TUI_SCRIPT="$SCRIPT" uv run mycli --node-tui --session "$SESSION"
```

Expected:

- exit code 0
- stderr contains `[node-tui] runtime.ready`, `[node-tui] turn.event`, and `[node-tui] turn.completed`
- `/view verbose`, `/usage`, `/sessions`, and `/quit` run through `command.run`
- no pending decision or suspended turn remains

- [ ] **Step 6: Run real interactive smoke**

Run:

```bash
uv run mycli --session node-tui-shell-manual-smoke
```

Manual steps:

```text
1. Confirm Node Ink TUI opens by default.
2. Submit: 请使用 Read 工具读取 pyproject.toml，然后用一句话回答项目名和 CLI 入口点。
3. Confirm user message appears immediately.
4. Confirm tool activity appears as folded summary.
5. Confirm final answer streams without freezing.
6. Run /view verbose and confirm tool detail visibility changes.
7. Run /usage and confirm overlay appears.
8. Run /sessions and confirm overlay appears.
9. Run /quit and confirm clean exit.
```

Expected:

- default `mycli` launches Node TUI
- stdout remains protocol-only
- UI uses TTY stream
- final answer and command overlays render
- clean exit code 0

- [ ] **Step 7: Write smoke report**

Create `docs/superpowers/reports/2026-05-27-node-tui-shell-smoke.md`:

```markdown
# Node TUI Shell Smoke

## Scope

- Interactive `mycli` defaults to Node Ink TUI.
- Python remains authoritative for runtime, sessions, tools, commands, approvals, and model-visible state.
- Node owns UI state, rendering, input, completion, overlays, and folded transcript state.
- RPC stdout/stdin stay separate from TTY UI rendering.

## Verification

| Command | Result |
| --- | --- |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q` | PASS |
| `npm --prefix tui/node test` | PASS |
| `npm --prefix tui/node run typecheck` | PASS |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS |
| `HOME="$(mktemp -d)" MYCLI_NODE_TUI_SCRIPT='[...]' uv run mycli --node-tui --session <scripted-session>` | PASS |
| `uv run mycli --session node-tui-shell-manual-smoke` | PASS |

## Manual Smoke Notes

- Default interactive route opened Node Ink TUI.
- User message rendered immediately.
- Tool call rendered as folded summary in default view.
- `/view verbose` exposed detailed tool rows.
- `/usage` and `/sessions` rendered overlays.
- `/quit` shut down cleanly.
- No pending decision or suspended turn remained after smoke.
```

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/reports/2026-05-27-node-tui-shell-smoke.md
git commit -m "Record Node TUI shell smoke evidence"
```

---

## Self-Review Checklist

- Spec coverage:
  - Default interactive Node TUI: Task 9.
  - `--plain` and non-interactive behavior: Task 9.
  - Ink/React full-screen shell: Tasks 2, 5, 6.
  - Python runtime authority: Tasks 1, 3, 8.
  - Startup welcome: Tasks 1, 4, 5.
  - Transcript rendering and streaming final answer: Tasks 4, 5, 6, 7.
  - Tool folding and verbose/focus modes: Tasks 4, 7, 8.
  - Slash/path completion keyboard behavior: Task 7.
  - Overlays and command output: Tasks 1, 8.
  - Interrupt and approval UI: Tasks 1, 6, 8.
  - Accurate status/usage: Tasks 1, 5, 8.
  - TTY/RPC separation: Tasks 2, 5, 10.
  - Real smoke: Task 10.
- Completeness scan:
  - Plan must not contain unowned implementation steps.
  - Every new protocol method named by Node has a Python gateway task.
  - Every new Node module has at least one test or snapshot in the same or following task.
- Verification:
  - Run both Python and Node focused suites before full suite.
  - Run real scripted smoke before manual interactive smoke.
  - Do not claim default route works until `uv run mycli` opens Node TUI without `--node-tui`.
