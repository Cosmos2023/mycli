# Node TUI Gateway

## 1. Background

P6 proved that `mycli` can run a full-screen TUI, but the current Textual implementation puts terminal UI state, keyboard handling, streaming rendering, slash completion, and agent orchestration in the same Python process. That made the first version fast to ship, but it has already exposed pressure around input ergonomics, live transcript updates, and UI responsiveness.

The target direction is closer to Hermes-agent's split architecture: keep the agent/runtime in Python, and move the rich terminal interface to a Node.js process. Python remains the source of truth for model calls, tools, sessions, memory, compaction, rehydration, approvals, and slash-command behavior. Node owns terminal rendering, keybindings, input editing, popups, and transcript layout.

This spec is the first slice of that migration. It defines the Python-to-Node gateway, process lifecycle, and line-delimited JSON-RPC protocol. It does not attempt to replace the current TUI UI in one step.

## 2. Goals

### 2.1 Keep Python runtime authoritative

The Python side continues to own:

- `TurnService`
- `AgentRuntime`
- provider/model selection
- tool execution
- approval decisions
- session persistence and resume/fork behavior
- memory, plans, tracing, usage, context windows
- P7 `compaction_rehydration`

Node must not read or write session databases, invoke tools directly, mutate memory files, or construct model-visible prompts.

### 2.2 Add a first-class Node TUI gateway

Add a Python gateway layer that can launch and talk to a Node TUI subprocess.

Suggested Python modules:

```text
src/mycli/cli/node_tui/
  __init__.py
  gateway.py
  protocol.py
  subprocess.py
```

Responsibilities:

- locate the Node TUI entrypoint
- start the Node process
- send lifecycle/status events to Node
- receive user commands from Node
- call existing `TurnService` methods
- translate `RuntimeStreamEvent`, `TurnResponse`, and command results into UI protocol events
- shut down cleanly when either side exits

The gateway should be testable without launching a real Node binary by using in-memory streams or a fake subprocess adapter.

### 2.3 Define a stable JSON-RPC protocol

Python and Node communicate over newline-delimited JSON messages on dedicated subprocess pipes.

Important terminal boundary:

- Node needs terminal stdin/stdout or an explicitly opened TTY to render the full-screen UI and read keys.
- RPC traffic must not share the same terminal stream as UI rendering.
- The gateway should use stdio-style process pipes for JSON-RPC, but keep them separate from the TTY stream used by the Node UI.
- The implementation plan must choose one concrete pipe strategy before coding: extra file descriptors such as fd 3/4, or Node opening the controlling TTY for UI while stdin/stdout remain RPC pipes.

Rules:

- One JSON object per line.
- UTF-8 only.
- No terminal control sequences in protocol payloads.
- Every request has an `id`.
- Every response has the same `id`.
- Notifications have no `id`.
- Protocol errors are model-invisible and must not enter session history.

Base envelope:

```json
{
  "jsonrpc": "2.0",
  "id": "req_1",
  "method": "turn.submit",
  "params": {}
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": "req_1",
  "result": {}
}
```

Error:

```json
{
  "jsonrpc": "2.0",
  "id": "req_1",
  "error": {
    "code": "invalid_request",
    "message": "Missing message"
  }
}
```

Notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "turn.event",
  "params": {}
}
```

### 2.4 Support the current interactive workflows

The gateway must expose enough operations for Node to replace the current TUI later.

Required Node-to-Python requests:

```text
session.bootstrap
turn.submit
turn.interrupt
decision.resolve
command.run
completion.slash
completion.path
status.inspect
session.resume
session.list
shutdown
```

Required Python-to-Node notifications:

```text
runtime.ready
status.changed
turn.started
turn.event
turn.completed
turn.failed
turn.interrupted
approval.pending
command.output
session.changed
gateway.error
```

This slice may implement a minimal Node protocol client that renders only enough terminal output to prove the gateway works. Full Claude Code-like layout belongs to the later `node-tui-shell` spec.

### 2.5 Preserve existing CLI behavior

Existing behavior must remain available:

- `mycli --plain` keeps the line-oriented Python REPL.
- Non-interactive stdin/stdout keeps plain behavior.
- Existing evaluation flags keep working.
- Existing Python Textual TUI can remain available during migration.

The Node gateway should be opt-in for the first implementation slice.

Acceptable activation shapes:

```text
mycli --node-tui
MYCLI_TUI_BACKEND=node mycli
```

Defaulting plain `mycli` to Node should wait until `node-tui-shell` is usable and smoke-tested.

### 2.6 Keep stream rendering incremental

Python should forward runtime events as they occur instead of waiting for the whole turn.

Event mapping:

```text
RuntimeStreamEvent(kind="reasoning")   -> turn.event phase=reasoning
RuntimeStreamEvent(kind="text_delta")  -> turn.event phase=assistant_delta
RuntimeStreamEvent(kind="tool_call")   -> turn.event phase=tool_call
RuntimeStreamEvent(kind="heartbeat")   -> turn.event phase=heartbeat
RuntimeStreamEvent(kind="completed")   -> turn.event phase=model_completed
TurnResponse final answer              -> turn.completed
```

The gateway does not decide final transcript styling. It only preserves event order and enough typed metadata for Node to render compactly.

### 2.7 Interrupt and pending approval semantics

Node can request interruption with:

```text
turn.interrupt
```

First-slice behavior:

- If no turn is running, return `{"interrupted": false}`.
- If a turn is running and Python can cancel it safely, return `{"interrupted": true}` and emit `turn.interrupted`.
- If the underlying model/tool call cannot be cancelled yet, mark the turn as interruption-requested, emit a gateway status update, and let the running Python turn finish or hit its existing interruption boundary.

The spec does not require hard-killing model/tool execution in this slice. It does require the protocol shape to support hard cancellation later.

Pending approvals remain Python-owned:

- Python emits `approval.pending`.
- Node renders the prompt.
- Node sends `decision.resolve` with the selected choice.
- Python calls `TurnService.resolve_pending_decision()`.

### 2.8 Keep slash commands Python-owned

Node may render suggestions and collect input, but command behavior stays in Python.

`command.run` calls the existing command-handler surface for:

```text
/help
/status
/context
/usage
/view
/resume
/sessions
/tools
/bashes
/changes
/undo
/plan
/subagents
/memory
/trace
/fork
/stats
/quit
```

Node should not duplicate command implementations. It can cache command metadata for completion, but Python remains the source of truth.

## 3. Non-goals

`node-tui-gateway` does not:

- replace the current Textual TUI as the default
- build the final Claude Code-like Node UI
- add command palette UI
- add resume picker UI
- redesign slash-command semantics
- change model-visible prompts
- change tool execution semantics
- change session database format
- change P7 compaction or rehydration behavior
- add MCP or provider protocol changes
- implement hard process-level cancellation for all tool/model calls
- require Node for `--plain`, tests, evaluation, or non-interactive use

## 4. Architecture

### 4.1 Process topology

```text
terminal
  │
  ▼
Python mycli process
  ├─ builds AgentConfig and TurnService
  ├─ starts Node TUI subprocess
  ├─ reads JSON-RPC requests from the Node RPC output pipe
  ├─ writes JSON-RPC responses/events to the Node RPC input pipe
  └─ owns all runtime state

Node TUI process
  ├─ owns terminal raw mode and rendering through TTY streams
  ├─ sends user actions to Python
  ├─ receives typed runtime events
  └─ exits when Python exits or shutdown succeeds
```

The Python process is the parent. Node is disposable UI. If Node crashes, Python should print a concise error and fall back or exit cleanly; it must not corrupt session state.

### 4.2 Transport

Use line-delimited JSON-RPC over dedicated process streams.

Rationale:

- simple to test
- works cross-platform
- avoids port allocation
- avoids exposing a local network service
- matches the subprocess lifecycle
- avoids mixing protocol payloads with terminal escape sequences

Do not use WebSockets or HTTP in this slice.

The implementation plan must explicitly prove that the Node UI stream and the RPC stream cannot corrupt each other. This matters because full-screen terminal UIs write escape sequences frequently and often switch terminal input into raw mode.

### 4.3 Python gateway components

Suggested components:

```python
class NodeTuiProtocol:
    def encode(message: ProtocolMessage) -> str: ...
    def decode(line: str) -> ProtocolMessage: ...
```

```python
class NodeTuiGateway:
    def run(self) -> int: ...
    def handle_request(self, request: RpcRequest) -> RpcResponse: ...
    def emit(self, method: str, params: dict[str, object]) -> None: ...
```

```python
class NodeTuiProcess:
    def start(self) -> None: ...
    def write_line(self, line: str) -> None: ...
    def read_line(self) -> str: ...
    def terminate(self) -> None: ...
```

The implementation plan can refine names, but responsibilities should remain separated:

- protocol parsing/validation
- subprocess IO
- `TurnService` command dispatch
- event conversion

### 4.4 Node package placement

The first implementation should keep Node files in a clearly isolated path.

Preferred:

```text
tui/node/
  package.json
  tsconfig.json
  src/
    index.ts
    protocol.ts
    client.ts
```

Reasons:

- keeps Python `src/` clean
- makes Node dependency installation explicit
- leaves room for future `node-tui-shell` without mixing it into Python packages

The gateway should fail with a clear message if Node is missing:

```text
Node TUI requires Node.js >= 20. Use mycli --plain or install Node.
```

### 4.5 Protocol versioning

Bootstrap must include a protocol version.

Node-to-Python:

```json
{
  "jsonrpc": "2.0",
  "id": "req_1",
  "method": "session.bootstrap",
  "params": {
    "protocol_version": 1,
    "client": {
      "name": "mycli-node-tui",
      "version": "0.1.0"
    }
  }
}
```

Python response:

```json
{
  "jsonrpc": "2.0",
  "id": "req_1",
  "result": {
    "protocol_version": 1,
    "session_id": "default",
    "workspace": "/repo",
    "model": "deepseek-v4-flash",
    "provider": "deepseek/chat_completions",
    "status": {
      "pending_decision": false,
      "suspended_turn": false
    }
  }
}
```

If versions are incompatible, Python returns an RPC error and exits the gateway without starting a turn.

## 5. Protocol Surface

### 5.1 `turn.submit`

Request:

```json
{
  "method": "turn.submit",
  "params": {
    "message": "read pyproject.toml",
    "client_turn_id": "client_turn_1"
  }
}
```

Behavior:

- Reject empty messages.
- Reject if another turn is running.
- Start a Python worker/thread or otherwise keep gateway IO responsive.
- Emit `turn.started`.
- Forward stream events as `turn.event`.
- Emit `turn.completed` with authoritative final answer.

`turn.completed` params:

```json
{
  "client_turn_id": "client_turn_1",
  "assistant_message": "...",
  "activity_events": [],
  "progress_updates": [],
  "plan_steps": [],
  "pending_decision": null,
  "usage": {}
}
```

### 5.2 `command.run`

Request:

```json
{
  "method": "command.run",
  "params": {
    "command": "/usage"
  }
}
```

Response:

```json
{
  "result": {
    "lines": [
      "[usage] session=default",
      "[usage] turns=1"
    ],
    "mutated_session": false
  }
}
```

Commands that change session state, such as `/resume`, should also emit `session.changed`.

### 5.3 `completion.slash`

Request:

```json
{
  "method": "completion.slash",
  "params": {
    "prefix": "/sta"
  }
}
```

Response:

```json
{
  "result": {
    "items": [
      {
        "value": "/status",
        "description": "Show runtime status"
      },
      {
        "value": "/stats",
        "description": "Show aggregate stats"
      }
    ]
  }
}
```

The first slice can use the same command list as the P6 completion module. Later specs can add richer metadata.

### 5.4 `completion.path`

Path completion must reuse the workspace-safe P5 completion behavior.

Request:

```json
{
  "method": "completion.path",
  "params": {
    "prefix": "@src/mycli/cl"
  }
}
```

Response:

```json
{
  "result": {
    "items": [
      {
        "value": "@src/mycli/cli/main.py",
        "kind": "file"
      }
    ]
  }
}
```

Python must enforce workspace boundaries. Node must treat returned paths as display/input candidates only.

### 5.5 `status.inspect`

Returns the same status data currently used by CLI/TUI status rendering.

The gateway should prefer structured fields over preformatted lines:

```json
{
  "session_id": "default",
  "workspace": "mycli",
  "model": "deepseek-v4-flash",
  "provider": "deepseek/chat_completions",
  "context_window": {
    "used_tokens": 3983,
    "max_tokens": 100000,
    "source": "provider"
  },
  "pending_decision": false,
  "suspended_turn": false
}
```

The first implementation may include formatted fallback lines if some fields are not yet structured.

## 6. Error Handling

### 6.1 Protocol errors

Invalid JSON:

- Python emits/logs `gateway.error`.
- If possible, respond with `parse_error`.
- Do not crash the agent runtime.

Unknown method:

- Return JSON-RPC error `method_not_found`.

Invalid params:

- Return JSON-RPC error `invalid_params`.

### 6.2 Node process failure

If Node exits before startup completes:

- print a concise error
- return a non-zero exit code
- do not start a model turn

If Node exits during an idle session:

- shut down Python cleanly

If Node exits during a running turn:

- request interruption if supported
- allow Python cleanup/finalization to run
- persist any existing runtime state through current interruption handling
- exit with non-zero status if the turn cannot be completed cleanly

### 6.3 Python runtime errors

Runtime errors should be converted into:

```text
turn.failed
gateway.error
```

depending on whether a turn was active.

Stack traces may be logged to workspace logs, but the protocol should send bounded messages suitable for UI display.

## 7. Testing Requirements

### 7.1 Python unit tests

Required:

- protocol encode/decode roundtrip
- parse error handling
- unknown method error
- `session.bootstrap` response shape
- `turn.submit` rejects empty input
- `turn.submit` rejects concurrent turns
- stream events are forwarded in order
- final answer is emitted through `turn.completed`
- `command.run` delegates to existing slash command handler
- `completion.path` does not return paths outside workspace
- Node missing error message is clear

### 7.2 Node tests

Required if a Node package is introduced:

- protocol parser handles request/response/notification
- client can send requests and receive events over mocked streams
- bootstrap failure renders a clear error

### 7.3 Integration tests

Required:

- fake Node subprocess smoke using in-memory or fixture IO
- real `node --version` gate when Node is present
- `mycli --node-tui` with a fake Node entrypoint can submit one turn through a fake `TurnService`
- `mycli --plain` remains unaffected
- non-interactive `mycli` still avoids TUI mode

### 7.4 Real smoke

After implementation, run a real smoke similar to:

```bash
HOME="$(mktemp -d)" uv run mycli --node-tui --session node-tui-gateway-smoke
```

For the first gateway slice, this can use a minimal Node UI that sends:

```text
read pyproject.toml and report project name
/usage
/session
/quit
```

Expected:

- process exits 0
- Python starts Node
- Node sends `turn.submit`
- Python executes a real model turn
- stream events reach Node
- final answer reaches Node
- `/usage` and `/session` work
- no pending decision or suspended turn remains

## 8. Rollout

### 8.1 First slice behavior

Add the gateway behind an opt-in flag:

```text
mycli --node-tui
```

Do not change default `mycli` behavior yet.

### 8.2 Later default switch

Default switching belongs to `node-tui-shell`, after:

- Node UI has feature parity with the current TUI basics
- real smoke covers submit, slash commands, resume, usage, interrupt, and approval
- fallback to `--plain` remains reliable

### 8.3 Compatibility

If Node dependencies are not installed:

- `mycli --node-tui` prints a clear setup message
- `mycli --plain` works
- existing Python Textual path can continue to work while it remains in the repo

## 9. Open Decisions For Plan

These should be resolved in the implementation plan, not left ambiguous during coding:

- exact Node package manager: npm is the conservative default unless the repo already chooses pnpm/yarn
- exact Node TUI framework: Ink is likely the right default for the later shell, but the gateway can start with a minimal Node script
- whether `--node-tui` should coexist with a generic `--tui-backend node`
- whether gateway IO is implemented with threads, selectors, or asyncio
- how much of `TurnResponse` should be structured in protocol v1 versus sent as rendered fallback lines

## 10. Acceptance Criteria

- `mycli --node-tui` starts a Node subprocess through Python.
- Python and Node complete `session.bootstrap` using protocol version 1.
- Node can submit a user turn through JSON-RPC.
- Python forwards stream events and final answer to Node.
- Node can run existing slash commands through Python.
- Path completion remains workspace-safe.
- Existing `mycli --plain` behavior is unchanged.
- Missing Node produces a clear actionable error.
- Protocol and gateway behavior have focused tests.
- A real provider-backed smoke proves one full turn can flow through Python -> Node -> Python -> model -> Node.
