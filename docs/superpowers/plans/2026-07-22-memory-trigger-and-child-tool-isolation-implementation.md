# Memory Trigger And Child Tool Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mycli independently configurable memory extraction and dream triggers while preventing all child-agent Shell activity from leaking into the main TUI or resumed session history.

**Architecture:** Extend `AgentConfig` and TOML normalization with explicit memory subfeature settings, then gate extraction and dream independently at successful-turn finalization. Add a `ContextVar`-backed `ToolInvocationContext` at the router boundary so `RuntimeChildToolExecutor` can assign a child owner per call; Shell-family tools resolve that invocation owner and persist it in the shell registry instead of mutating shared tool instances.

**Tech Stack:** Python 3.13, frozen dataclasses, `contextvars.ContextVar`, `ThreadPoolExecutor`, pytest, existing mycli ToolRouter/Shell registry/Gateway contracts.

---

## File Map

### New Files

- `src/mycli/tools/invocation_context.py`: owns the immutable invocation context,
  scoped context manager, and owner resolver.
- `tests/unit/tools/test_tool_invocation_context.py`: proves nesting, exception
  restoration, thread isolation, and router integration.

### Modified Runtime Files

- `src/mycli/domain/runtime/__init__.py`: adds memory extraction/dream settings to
  `AgentConfig`.
- `src/mycli/config/settings.py`: resolves environment, sectioned TOML, and legacy
  flattened memory settings with validation.
- `src/mycli/config/toml_format.py`: maps the new settings to canonical `[memory]`
  keys.
- `src/mycli/application/runtime/agent_runtime.py`: passes configured dream
  thresholds into the service.
- `src/mycli/application/runtime/turn_executor.py`: gates extraction and dream
  independently after successful turns.
- `src/mycli/memory/extraction_service.py`: lets explicit requests bypass the
  disabled automatic interval.
- `src/mycli/tools/routing/tool_router.py`: establishes invocation scope around
  one routed tool execution.
- `src/mycli/application/runtime/subagents/loop.py`: passes child ownership to the
  router.
- `src/mycli/tools/bash.py`: resolves the invocation owner before starting Shell
  work.
- `src/mycli/tools/shell_output.py`: resolves the invocation owner before polling.
- `src/mycli/tools/write_stdin.py`: resolves the invocation owner before input or
  polling.
- `src/mycli/tools/kill_shell.py`: resolves the invocation owner before
  termination.
- `src/mycli/tools/shell_session_manager.py`: terminates the main owner and its
  colon-delimited child-owner tree without touching similarly named sessions.
- `src/mycli/tools/shell_registry.py`: exposes owner-tree termination to runtime
  shutdown.

### Modified Tests And Documentation

- `tests/unit/services/test_config_service.py`
- `tests/unit/cli/test_setup_wizard.py`
- `tests/unit/services/test_memory_extraction_service.py`
- `tests/unit/services/test_memory_dream_service.py`
- `tests/unit/application/test_agent_runtime.py`
- `tests/unit/application/runtime/subagents/test_runtime_child_adapters.py`
- `tests/unit/services/test_tool_router.py`
- `tests/unit/tools/test_shell_command_runtime.py`
- `tests/unit/tools/test_bash_output.py`
- `tests/unit/tools/test_write_stdin.py`
- `tests/unit/tools/test_shell_session_manager.py`
- `tests/unit/cli/node_tui/test_gateway.py`
- `README.md`

No TypeScript TUI source changes are required. The Gateway already filters Shell
lifecycle events by `owner_session_id`; the defect is incorrect owner propagation
before the event reaches that boundary.

---

### Task 1: Add The Explicit Memory Configuration Contract

**Files:**
- Modify: `tests/unit/services/test_config_service.py`
- Modify: `tests/unit/cli/test_setup_wizard.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/config/settings.py`
- Modify: `src/mycli/config/toml_format.py`

- [ ] **Step 1: Write failing configuration parsing tests**

Add a sectioned-config test that writes:

```toml
[memory]
enabled = true
extraction_enabled = false
extraction_interval_turns = -1
dream_enabled = false
dream_min_hours = 48
dream_min_sessions = 9
```

Assert the exact runtime fields:

```python
assert config.memory_enabled is True
assert config.memory_extraction_enabled is False
assert config.memory_extraction_interval_turns == -1
assert config.memory_dream_enabled is False
assert config.memory_dream_min_hours == 48
assert config.memory_dream_min_sessions == 9
```

Add one environment-precedence test using
`MYCLI_MEMORY_EXTRACTION_ENABLED`, `MYCLI_MEMORY_DREAM_ENABLED`,
`MYCLI_MEMORY_DREAM_MIN_HOURS`, and `MYCLI_MEMORY_DREAM_MIN_SESSIONS`. Include
explicit `"false"` values so truthy `or` fallback cannot accidentally discard
them.

Add parameterized invalid-value tests:

```python
@pytest.mark.parametrize(
    ("env_key", "value", "message"),
    [
        ("MYCLI_MEMORY_EXTRACTION_INTERVAL_TURNS", "-2", "must be -1, 0, or positive"),
        ("MYCLI_MEMORY_DREAM_MIN_HOURS", "0", "must be at least 1"),
        ("MYCLI_MEMORY_DREAM_MIN_SESSIONS", "0", "must be at least 1"),
    ],
)
```

Keep the existing test proving interval `0` normalizes to `1`.

- [ ] **Step 2: Run the parsing tests and verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py -k "memory" -q
```

Expected: FAIL because `AgentConfig` has no extraction/dream switch or dream
threshold fields, and invalid values do not yet raise.

- [ ] **Step 3: Add runtime fields and parse the new settings**

Extend `AgentConfig` next to the existing memory fields:

```python
memory_enabled: bool = True
memory_extraction_enabled: bool = True
memory_extraction_interval_turns: int = 5
memory_dream_enabled: bool = True
memory_dream_min_hours: int = 24
memory_dream_min_sessions: int = 5
```

Resolve each setting with `_config_value`, not a chain of `or` expressions:

```python
memory_extraction_enabled_value = _parse_optional_bool(
    _config_value(
        env=env,
        user_config=user_config,
        project_config=project_config,
        legacy_user_config=legacy_user_config,
        env_key="MYCLI_MEMORY_EXTRACTION_ENABLED",
        config_key="memory_extraction_enabled",
    )
)
```

Use the same structure for dream enabled, hours, and sessions. Apply defaults only
when `_config_value(...) is None`. Preserve interval `0 -> 1`; raise `ValueError`
for interval values below `-1` and dream thresholds below `1`, naming the exact
configuration key in each message.

Pass all resolved values into `AgentConfig`.

- [ ] **Step 4: Extend canonical TOML mapping and serialization coverage**

Add these mappings to the existing `memory` section in `CONFIG_SECTIONS`:

```python
("extraction_enabled", "memory_extraction_enabled"),
("extraction_interval_turns", "memory_extraction_interval_turns"),
("dream_enabled", "memory_dream_enabled"),
("dream_min_hours", "memory_dream_min_hours"),
("dream_min_sessions", "memory_dream_min_sessions"),
```

Extend the setup-wizard round-trip test to assert both the flattened payload and
rendered TOML retain explicit false values and integer thresholds under
`[memory]`.

- [ ] **Step 5: Run configuration and setup tests**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py tests/unit/cli/test_setup_wizard.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit the configuration contract**

```bash
git add src/mycli/domain/runtime/__init__.py src/mycli/config/settings.py \
  src/mycli/config/toml_format.py tests/unit/services/test_config_service.py \
  tests/unit/cli/test_setup_wizard.py
git commit -m "feat: add explicit memory feature settings"
```

---

### Task 2: Align Extraction And Dream Trigger Semantics

**Files:**
- Modify: `tests/unit/services/test_memory_extraction_service.py`
- Modify: `tests/unit/services/test_memory_dream_service.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `src/mycli/memory/extraction_service.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`

- [ ] **Step 1: Replace the negative-interval extraction expectation**

Change the existing negative-interval test so an explicit request starts:

```python
updates = service.maybe_start_background_extraction(
    MemoryExtractionRequest(
        session_id="demo",
        turn_id="turn_1",
        user_message="remember that I prefer terse final answers",
        assistant_message="Got it.",
        turn_items=(),
    )
)

assert updates == ("memory_extract_started",)
assert child_loop.calls
```

Add a second test with `user_message="continue"` and interval `-1`, asserting
`("memory_extract_skipped:disabled",)` and no child calls.

- [ ] **Step 2: Add runtime switch and threshold tests**

In `test_agent_runtime.py`, add separate tests proving:

```python
runtime._config = replace(
    runtime._config,
    memory_extraction_enabled=False,
    memory_dream_enabled=True,
)
```

calls only dream, while the inverse configuration calls only extraction. Extend
the runtime construction test to assert `MemoryDreamService._min_hours` and
`_min_sessions` match config values `48` and `9`.

Add a master-switch assertion that `append_session_summary`, extraction, and dream
are all skipped when `memory_enabled` is false. Use a recording fake memory service
instead of relying only on progress strings.

Update the existing extraction throttling and dream tests to inspect service calls
or `RuntimeTraceEvent` payloads. Add this response-level assertion for automatic,
explicit, and dream starts:

```python
assert not any(
    update.startswith("[memory]")
    for update in response.progress_updates
)
```

Use an existing failed-model adapter to assert a failed turn does not call either
fake scheduler.

- [ ] **Step 3: Run the trigger tests and verify failure**

Run:

```bash
uv run pytest \
  tests/unit/services/test_memory_extraction_service.py \
  tests/unit/services/test_memory_dream_service.py \
  tests/unit/application/test_agent_runtime.py \
  -k "memory" -q
```

Expected: FAIL because interval `-1` returns before explicit detection, feature
switches are ignored, and dream thresholds are still hard-coded defaults.

- [ ] **Step 4: Reorder extraction gates**

Keep direct-write suppression first, then detect explicit intent, and apply the
negative interval only to non-explicit requests:

```python
if self._has_memory_write(request.turn_items):
    self._trace(request, result="skipped_direct_write")
    return ("memory_extract_skipped:direct_write",)

explicit = extract_explicit_memory_request(request.user_message) is not None
if not explicit and self._automatic_interval_turns < 0:
    self._trace(request, result="skipped_disabled")
    return ("memory_extract_skipped:disabled",)
```

Leave interval counting, the in-progress lock, and fallback extraction unchanged.

- [ ] **Step 5: Gate the two services independently**

In the successful-turn block, retain summary persistence under the master switch,
then wrap each scheduler independently:

```python
if runtime._config.memory_enabled:
    runtime._memory_service.append_session_summary(
        runtime._config.session_id,
        assistant_message,
    )
    if runtime._config.memory_extraction_enabled:
        runtime._memory_extraction_service.maybe_start_background_extraction(
            MemoryExtractionRequest(
                session_id=runtime._config.session_id,
                turn_id=turn_id,
                user_message=user_message,
                assistant_message=assistant_message,
                turn_items=tuple(turn_items),
            )
        )
    if runtime._config.memory_dream_enabled:
        runtime._memory_dream_service.maybe_start_background_dream(
            MemoryDreamRequest(
                session_id=runtime._config.session_id,
                turn_id=turn_id,
                recent_session_ids=runtime._recent_session_ids_for_memory_dream(),
                now=datetime.now(UTC),
            )
        )
```

Pass `config.memory_dream_min_hours` and
`config.memory_dream_min_sessions` into `MemoryDreamService` during
`AgentRuntime` construction. Ensure any approval-rejection summary write is also
guarded by `memory_enabled`; it must not bypass the master switch.

The scheduler return values remain available to unit tests, but successful-turn
finalization intentionally does not project them into main-response
`progress_updates`. Trace events remain the diagnostic source for starts and
skips.

- [ ] **Step 6: Run focused memory tests**

Run:

```bash
uv run pytest \
  tests/unit/services/test_memory_extraction_service.py \
  tests/unit/services/test_memory_dream_service.py \
  tests/unit/application/test_agent_runtime.py \
  -k "memory" -q
```

Expected: PASS.

- [ ] **Step 7: Commit trigger semantics**

```bash
git add src/mycli/memory/extraction_service.py \
  src/mycli/application/runtime/agent_runtime.py \
  src/mycli/application/runtime/turn_executor.py \
  tests/unit/services/test_memory_extraction_service.py \
  tests/unit/services/test_memory_dream_service.py \
  tests/unit/application/test_agent_runtime.py
git commit -m "fix: align memory trigger semantics"
```

---

### Task 3: Introduce Invocation-Scoped Tool Ownership

**Files:**
- Create: `src/mycli/tools/invocation_context.py`
- Create: `tests/unit/tools/test_tool_invocation_context.py`
- Modify: `tests/unit/services/test_tool_router.py`
- Modify: `src/mycli/tools/routing/tool_router.py`

- [ ] **Step 1: Write context lifecycle tests**

Create tests for fallback, nesting, exception restoration, and thread isolation:

```python
def test_tool_invocation_scope_restores_owner_after_nested_failure() -> None:
    assert current_tool_owner_session_id("main") == "main"
    with tool_invocation_scope(ToolInvocationContext(owner_session_id="child-a")):
        assert current_tool_owner_session_id("main") == "child-a"
        with pytest.raises(RuntimeError):
            with tool_invocation_scope(
                ToolInvocationContext(owner_session_id="child-b")
            ):
                assert current_tool_owner_session_id("main") == "child-b"
                raise RuntimeError("boom")
        assert current_tool_owner_session_id("main") == "child-a"
    assert current_tool_owner_session_id("main") == "main"
```

Use a `ThreadPoolExecutor(max_workers=2)` test with a barrier so two simultaneous
scopes report distinct owners.

- [ ] **Step 2: Write a failing ToolRouter integration test**

Add a fake tool whose `execute` method captures
`current_tool_owner_session_id("main")`. Execute it through `ToolRouter` with:

```python
invocation_context=ToolInvocationContext(owner_session_id="child-session")
```

Assert the fake tool observed `child-session`, while a subsequent unscoped call
observes `main`.

- [ ] **Step 3: Run the tests and verify failure**

Run:

```bash
uv run pytest \
  tests/unit/tools/test_tool_invocation_context.py \
  tests/unit/services/test_tool_router.py \
  -q
```

Expected: collection or call failure because the invocation context API and router
parameter do not exist.

- [ ] **Step 4: Implement the context module**

Create the focused API:

```python
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator


@dataclass(frozen=True, slots=True)
class ToolInvocationContext:
    owner_session_id: str


_CURRENT_TOOL_INVOCATION: ContextVar[ToolInvocationContext | None] = ContextVar(
    "mycli_tool_invocation",
    default=None,
)


@contextmanager
def tool_invocation_scope(
    context: ToolInvocationContext | None,
) -> Iterator[None]:
    if context is None:
        yield
        return
    token = _CURRENT_TOOL_INVOCATION.set(context)
    try:
        yield
    finally:
        _CURRENT_TOOL_INVOCATION.reset(token)


def current_tool_owner_session_id(fallback: str) -> str:
    context = _CURRENT_TOOL_INVOCATION.get()
    return fallback if context is None else context.owner_session_id
```

- [ ] **Step 5: Scope ToolRouter execution**

Extend only `ToolRouter.execute`:

```python
def execute(
    self,
    call: ToolCall,
    *,
    exposure: ToolExposure,
    invocation_context: ToolInvocationContext | None = None,
) -> ToolResult:
    with tool_invocation_scope(invocation_context):
        return self._execute_scoped(call, exposure=exposure)
```

Move the existing execute body unchanged into `_execute_scoped`. Do not add owner
metadata to `ToolCall.arguments`, `ToolSpec`, or model-visible definitions.

- [ ] **Step 6: Run context and router tests**

Run:

```bash
uv run pytest \
  tests/unit/tools/test_tool_invocation_context.py \
  tests/unit/services/test_tool_router.py \
  -q
```

Expected: PASS.

- [ ] **Step 7: Commit the invocation context**

```bash
git add src/mycli/tools/invocation_context.py \
  src/mycli/tools/routing/tool_router.py \
  tests/unit/tools/test_tool_invocation_context.py \
  tests/unit/services/test_tool_router.py
git commit -m "refactor: add invocation-scoped tool ownership"
```

---

### Task 4: Make Shell-Family Tools Consume The Invocation Owner

**Files:**
- Modify: `src/mycli/tools/bash.py`
- Modify: `src/mycli/tools/shell_output.py`
- Modify: `src/mycli/tools/write_stdin.py`
- Modify: `src/mycli/tools/kill_shell.py`
- Modify: `tests/unit/tools/test_shell_command_runtime.py`
- Modify: `tests/unit/tools/test_bash_output.py`
- Modify: `tests/unit/tools/test_write_stdin.py`

- [ ] **Step 1: Write failing owner-override tests**

Start a background Shell from a `BashTool` configured for `main-session` while the
scope owner is `child-session`:

```python
with tool_invocation_scope(ToolInvocationContext("child-session")):
    started = bash.execute({"command": "sleep 30", "run_in_background": True})
```

Assert `ShellOutputTool(session_id="main-session")` is forbidden outside the
scope, but succeeds in a `child-session` scope. Terminate it through a
`KillShellTool` configured for the main session while the child scope is active.

Add a `WriteStdinTool` test using the existing fake transport and registry: create
the process for `child-session`, configure the tool for `main-session`, enter the
child scope, and assert interaction succeeds. Add a `ShellCommandRuntime` test
that inspects the registry row and sees the scoped child owner.

- [ ] **Step 2: Run Shell tests and verify failure**

Run:

```bash
uv run pytest \
  tests/unit/tools/test_shell_command_runtime.py \
  tests/unit/tools/test_bash_output.py \
  tests/unit/tools/test_write_stdin.py \
  -q
```

Expected: FAIL because all tools still use their mutable configured owner fields.

- [ ] **Step 3: Resolve the owner once per Shell operation**

Import `current_tool_owner_session_id` in each Shell-family module. In
`ShellCommandRuntime.execute` and `BashTool.execute`, resolve:

```python
owner_session_id = current_tool_owner_session_id(self._owner_session_id)
```

Pass that local value to `SHELL_REGISTRY.execute` or `ShellBackendRequest`. Do not
assign it back to `_owner_session_id`.

In `ShellOutputTool`, `WriteStdinTool`, and `KillShellTool`, resolve from
`self._session_id` immediately before the registry call and pass the local owner.
Keep `configure_shell_session` as the backward-compatible main-session fallback.

- [ ] **Step 4: Run focused Shell tests**

Run:

```bash
uv run pytest \
  tests/unit/tools/test_shell_command_runtime.py \
  tests/unit/tools/test_bash_output.py \
  tests/unit/tools/test_write_stdin.py \
  tests/unit/test_kill_shell.py \
  tests/unit/test_bash.py \
  tests/unit/tools/test_run_shell.py \
  -q
```

Expected: PASS, including existing ownership-denial behavior.

- [ ] **Step 5: Commit Shell owner resolution**

```bash
git add src/mycli/tools/bash.py src/mycli/tools/shell_output.py \
  src/mycli/tools/write_stdin.py src/mycli/tools/kill_shell.py \
  tests/unit/tools/test_shell_command_runtime.py \
  tests/unit/tools/test_bash_output.py tests/unit/tools/test_write_stdin.py
git commit -m "fix: scope shell tools to invocation owner"
```

---

### Task 5: Propagate Child Ownership And Lock In TUI Isolation

**Files:**
- Modify: `src/mycli/application/runtime/subagents/loop.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/tools/shell_session_manager.py`
- Modify: `src/mycli/tools/shell_registry.py`
- Modify: `tests/unit/application/runtime/subagents/test_runtime_child_adapters.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/tools/test_shell_session_manager.py`

- [ ] **Step 1: Make the child adapter test require invocation context**

Change `FakeRouter.calls` to include the context and accept the new keyword:

```python
def execute(
    self,
    call: ToolCall,
    *,
    exposure: ToolExposure,
    invocation_context: ToolInvocationContext | None = None,
) -> ToolResult:
    self.calls.append((call, exposure, invocation_context))
    return ToolResult(success=True, summary="ok", raw_payload={"content": "ok"})
```

Assert:

```python
assert router.calls[0][2] == ToolInvocationContext(
    owner_session_id="demo:sub:turn_1:abcd1234"
)
```

- [ ] **Step 2: Add Gateway child-event filtering coverage**

Next to the existing main-owner lifecycle test, emit an event with:

```python
owner_session_id=f"{service._config.session_id}:dream:turn_1:abcd1234"
```

Assert the Gateway emits no `shell.started` notification. Then emit a main-owner
event and assert it still appears. This test keeps Gateway filtering as the final
defensive boundary.

- [ ] **Step 3: Add the memory-dream regression shape**

In `test_agent_runtime.py`, construct a child tool exposure with a fake Shell tool
that records `current_tool_owner_session_id("main")`. Run child calls representing
`find`, `ls`, and `cat` through `RuntimeChildToolExecutor` using a dream child ID.
Assert all three observed that dream ID and that the main session's
`load_history_items` result has no corresponding tool items.

The regression must use this ID shape:

```text
main-session:dream:turn_1:abcd1234
```

It does not need a real model or real filesystem commands; the defect is event and
history ownership, not command execution correctness.

- [ ] **Step 4: Add failing owner-tree shutdown tests**

In `test_shell_session_manager.py`, start active sessions owned by:

```text
main-session
main-session:dream:turn_1:abcd1234
main-session:sub:turn_2:efgh5678
main-session-peer
```

Call `terminate_owner_tree("main-session")`. Assert the first three sessions are
terminated and `main-session-peer` remains active. The delimiter check must be
exactly `owner == root or owner.startswith(f"{root}:")`; a raw prefix match would
terminate an unrelated session.

Extend `test_agent_runtime_close_terminates_owned_shell_sessions` with one child
owner and one peer owner. Assert `runtime.close()` terminates the main and child
sessions and leaves the peer untouched.

- [ ] **Step 5: Run isolation tests and verify failure**

Run:

```bash
uv run pytest \
  tests/unit/application/runtime/subagents/test_runtime_child_adapters.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/unit/application/test_agent_runtime.py \
  tests/unit/tools/test_shell_session_manager.py \
  -k "child or dream or shell_lifecycle" -q
```

Expected: child adapter/regression FAIL because `RuntimeChildToolExecutor` still
discards `child_session_id`, and owner-tree tests FAIL because only exact-owner
termination exists; existing Gateway main-owner behavior remains green.

- [ ] **Step 6: Pass child ownership into ToolRouter**

Replace `del child_session_id` with:

```python
return self.tool_router.execute(
    call,
    exposure=exposure,
    invocation_context=ToolInvocationContext(
        owner_session_id=child_session_id,
    ),
)
```

Import the context type from `mycli.tools.invocation_context`. Do not mutate the
registry, Shell tool, or shared router before or after execution.

- [ ] **Step 7: Add strict owner-tree termination**

Add this manager API using the existing lock/snapshot pattern:

```python
def terminate_owner_tree(self, root_owner_session_id: str) -> tuple[ShellSessionSnapshot, ...]:
    child_prefix = f"{root_owner_session_id}:"
    with self._lock:
        owned = [
            (session.owner_session_id, shell_id)
            for shell_id, session in self._sessions.items()
            if (
                session.owner_session_id == root_owner_session_id
                or session.owner_session_id.startswith(child_prefix)
            )
            and session.transport.poll() is None
        ]
    return tuple(self.terminate(owner, shell_id) for owner, shell_id in owned)
```

Project it through `ShellProcessRegistry.terminate_owner_tree`, then replace
`SHELL_REGISTRY.terminate_owner(self._config.session_id)` in `AgentRuntime.close`
with `terminate_owner_tree`. Keep exact-owner termination for callers that need it.

- [ ] **Step 8: Run child, Gateway, shutdown, and runtime tests**

Run:

```bash
uv run pytest \
  tests/unit/application/runtime/subagents/test_runtime_child_adapters.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/unit/application/test_agent_runtime.py \
  tests/unit/tools/test_shell_session_manager.py \
  -q
```

Expected: PASS. The child owner reaches tools, child lifecycle events are filtered,
main-owner events remain visible, and runtime shutdown cleans only its owner tree.

- [ ] **Step 9: Commit child isolation**

```bash
git add src/mycli/application/runtime/subagents/loop.py \
  src/mycli/application/runtime/agent_runtime.py \
  src/mycli/tools/shell_session_manager.py src/mycli/tools/shell_registry.py \
  tests/unit/application/runtime/subagents/test_runtime_child_adapters.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/unit/application/test_agent_runtime.py \
  tests/unit/tools/test_shell_session_manager.py
git commit -m "fix: isolate child tool events from main sessions"
```

---

### Task 6: Document The Controls And Run Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update user-facing memory examples**

Replace the statement that `extraction_interval_turns = -1` completely disables
extraction. Document the complete canonical example:

```toml
[memory]
enabled = true
extraction_enabled = true
extraction_interval_turns = 5
dream_enabled = true
dream_min_hours = 24
dream_min_sessions = 5
```

Document these distinctions directly below it:

```text
enabled=false disables all memory behavior.
extraction_enabled=false disables explicit and automatic extraction.
extraction_interval_turns=-1 disables automatic extraction only.
dream_enabled=false disables background consolidation.
```

Include the four new environment variable names alongside the existing memory
environment settings.

- [ ] **Step 2: Run formatting and static checks**

Run:

```bash
uv run ruff check src/mycli tests
uv run mypy src/mycli
```

Expected: both commands exit `0`; these are the lint and typecheck tools declared
in `pyproject.toml`.

- [ ] **Step 3: Run focused regression suites**

Run:

```bash
uv run pytest \
  tests/unit/services/test_config_service.py \
  tests/unit/services/test_memory_extraction_service.py \
  tests/unit/services/test_memory_dream_service.py \
  tests/unit/services/test_tool_router.py \
  tests/unit/application/runtime/subagents/test_runtime_child_adapters.py \
  tests/unit/tools/test_tool_invocation_context.py \
  tests/unit/tools/test_shell_command_runtime.py \
  tests/unit/tools/test_bash_output.py \
  tests/unit/tools/test_write_stdin.py \
  tests/unit/tools/test_shell_session_manager.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/unit/application/test_agent_runtime.py \
  -q
```

Expected: PASS.

- [ ] **Step 4: Run the full Python and TUI suites**

Run:

```bash
uv run pytest -q
npm test --prefix tui/mycli-shell
npm run typecheck --prefix tui/mycli-shell
```

Expected: all Python tests pass with only known skips; all TUI tests pass; the
TypeScript typecheck exits `0`.

- [ ] **Step 5: Verify scope and working tree**

Run:

```bash
git diff --check
git status --short
git log -6 --oneline
```

Expected: no whitespace errors; only the files listed in this plan are changed by
this work; pre-existing unrelated dirty files remain untouched.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain memory trigger controls"
```

---

## Completion Checklist

- [ ] The six memory settings resolve from defaults, TOML, legacy flat keys, and
  environment variables.
- [ ] Explicit remember/forget requests work when the automatic interval is `-1`.
- [ ] Extraction and dream can each be disabled independently.
- [ ] A child owner is applied per invocation without shared mutable owner changes.
- [ ] Bash, ShellOutput, WriteStdin, and KillShell use the invocation owner.
- [ ] Dream/subagent Shell lifecycle events are absent from the main Gateway and
  main resumed history.
- [ ] Main-agent foreground and background Shell behavior is unchanged.
- [ ] Focused and full verification commands pass.
