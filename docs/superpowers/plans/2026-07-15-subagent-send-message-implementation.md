# Sub-agent SendMessage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real `SendMessage` tool that queues input for running background sub-agents and resumes terminal sub-agents from persisted structured history.

**Architecture:** `SubAgentChildLoop` accepts optional prebuilt messages and a thread-safe pending-message provider, draining queued user input only at model/tool round boundaries. `SubAgentService` owns each running child's queue and reconstructs terminal child conversations from `HistoryItem` records before resubmitting the same child session. `SendMessageTool` is a thin validated adapter over that service API.

**Tech Stack:** Python 3.13, dataclasses, thread locks, pytest, existing mycli tool registry/runtime.

---

### Task 1: Child Loop Boundary Delivery

**Files:**
- Modify: `src/mycli/application/runtime/subagents/loop.py`
- Test: `tests/unit/application/runtime/subagents/test_child_loop.py`

- [x] **Step 1: Write failing tests for queued input delivery**

Add tests proving that queued messages are appended as user messages after tool results and that input arriving during a final-looking model response prevents premature completion.

- [x] **Step 2: Verify the tests fail for the missing API**

Run: `uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py -q`

Expected: failure because `SubAgentChildLoop.run()` does not accept `initial_messages` or `pending_message_provider`.

- [x] **Step 3: Implement boundary draining**

Extend `run()` with optional `initial_messages` and `pending_message_provider`. Preserve the existing fresh-run bootstrap when no initial messages are supplied. Drain pending nonblank messages after each model response, record them in the child transcript, and continue instead of accepting a terminal text response when new input exists.

- [x] **Step 4: Verify child-loop tests pass**

Run: `uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py -q`

Expected: all child-loop tests pass.

### Task 2: Service Queue And Resume

**Files:**
- Modify: `src/mycli/domain/subagents.py`
- Modify: `src/mycli/application/runtime/subagents/service.py`
- Test: `tests/unit/application/runtime/subagents/test_sub_agent_service.py`

- [x] **Step 1: Write failing service tests**

Add tests proving that `send_message()` rejects blank/unknown targets, queues input for a running child, and resumes a terminal child using the same session id and reconstructed transcript.

- [x] **Step 2: Verify the service tests fail**

Run: `uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py -q`

Expected: failure because `SubAgentService.send_message()` and resume reconstruction do not exist.

- [x] **Step 3: Implement running queues**

Add a pending-message deque to `_BackgroundRun`, keep queue access under `_run_state_lock`, and pass a drain callback into the child loop. Add a `SubAgentMessageResult` value type that identifies whether delivery was queued or resumed.

- [x] **Step 4: Implement structured history reconstruction and terminal resume**

Rebuild model messages from child `HistoryItem` values, preserving system/user/assistant/tool roles and tool-call ids. Resolve the original invocation from recent run metadata, append the new user message, and submit a background continuation with the same `child_session_id`. Atomically check pending input and transition the run to terminal state so a message racing with completion is either consumed by the finishing run or starts a continuation.

- [x] **Step 5: Verify service tests pass**

Run: `uv run pytest tests/unit/application/runtime/subagents/test_sub_agent_service.py -q`

Expected: all sub-agent service tests pass.

### Task 3: Tool And Runtime Integration

**Files:**
- Create: `src/mycli/tools/send_message.py`
- Modify: `src/mycli/tools/registry.py`
- Modify: `src/mycli/cli/bootstrap.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/services/approval/safety_policy.py`
- Modify: `src/mycli/tools/routing/tool_exposure_planner.py`
- Test: `tests/unit/tools/test_send_message.py`
- Test: `tests/integration/test_toolset_smoke.py`
- Test: `tests/unit/cli/test_main.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [x] **Step 1: Write failing tool and registration tests**

Test required arguments, unbound behavior, service delegation, builtin metadata, default registration, runtime binding, and model exposure.

- [x] **Step 2: Verify integration tests fail**

Run: `uv run pytest tests/unit/tools/test_send_message.py tests/integration/test_toolset_smoke.py tests/unit/application/test_agent_runtime.py -q`

Expected: failure because `SendMessageTool` is not implemented or registered.

- [x] **Step 3: Implement and register `SendMessageTool`**

Define required `child_session_id` and `message` parameters. Expose a low-risk workflow tool that reports queued/resumed status without embedding child transcript content in the result.

- [x] **Step 4: Verify tool and runtime tests pass**

Run: `uv run pytest tests/unit/tools/test_send_message.py tests/integration/test_toolset_smoke.py tests/unit/application/test_agent_runtime.py -q`

Expected: all selected tests pass.

### Task 4: Regression Verification

**Files:**
- Verify only: existing Python and Node TUI code

- [x] **Step 1: Run focused Python sub-agent and tool suites**

Run: `uv run pytest tests/unit/application/runtime/subagents tests/unit/tools/test_task_tool.py tests/unit/tools/test_subagent_output.py tests/unit/tools/test_send_message.py -q`

- [x] **Step 2: Run static checks**

Run: `uv run ruff check src/mycli/application/runtime/subagents src/mycli/tools/send_message.py tests/unit/application/runtime/subagents tests/unit/tools/test_send_message.py`

Run: `uv run mypy src/mycli`

- [x] **Step 3: Re-run the existing TUI suite**

Run the repository's Node TUI test and TypeScript check commands from `tui/mycli-shell`.

- [x] **Step 4: Validate the patch**

Run: `git diff --check`

Confirm `.codex/config.toml` remains untouched and unstaged.
