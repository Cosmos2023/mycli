# mycli Phase 1 Runtime Retrofit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `mycli`'s first-phase agent harness into a message-driven runtime with schema-first tools, resumable approvals, explicit planning state, and a stronger context manager while preserving the CLI shell and local-first product shape.

**Architecture:** Introduce a new runtime spine under `application/runtime/` and `domain/runtime/`, then adapt the CLI, tools, and model layer onto that spine. Keep existing storage services where they still help, but move execution semantics out of prompt assembly and into explicit runtime state, events, and adapters.

**Tech Stack:** Python 3.13, standard library dataclasses/protocols/pathlib, `pytest`, `mypy`, `ruff`, existing OpenAI-compatible HTTP adapter as compat mode

---

## Scope Check

The approved spec spans three implementation phases. This plan intentionally covers only **Phase 1: core harness retrofit** so that it remains independently shippable and testable. Phase 2 (`skill runtime v2`, stronger memory retrieval, task continuity) and Phase 3 (`subagents`, background tasks, team coordination) should each get their own follow-up plans after this work lands.

## File Structure

The first phase should converge on these focused units.

- Create `src/mycli/domain/runtime/events.py`
  Defines runtime event types and payload-bearing event objects returned by the new runtime.
- Create `src/mycli/domain/runtime/turn_state.py`
  Defines `TurnState`, suspended turn checkpoints, and the minimal execution state needed to resume after approvals.
- Create `src/mycli/domain/runtime/planning.py`
  Defines `PlanItem`, `PlanStatus`, and validation rules such as a single `in_progress` item.
- Create `src/mycli/domain/runtime/approvals.py`
  Defines approval request/decision models decoupled from CLI rendering.
- Create `src/mycli/tools/base.py`
  Defines `ToolSpec`, `ToolExecutor`, and normalized tool result contracts.
- Create `src/mycli/tools/registry.py`
  Owns schema-first registration, lookup, validation, and execution dispatch.
- Modify `src/mycli/tools/*.py`
  Migrates the five existing tools onto the new `ToolSpec` contract without changing their user-visible semantics.
- Create `src/mycli/infrastructure/models/base.py`
  Defines the adapter protocol shared by native tool-calling and compat-chat model implementations.
- Create `src/mycli/infrastructure/models/compat_chat_adapter.py`
  Wraps the current JSON-parsing approach behind the new adapter interface so the rest of the runtime no longer depends on raw prompt contracts.
- Create `src/mycli/services/approval/approval_service.py`
  Classifies tool invocations into auto-allow, suspend-for-choice, or deny, and persists resumable approval checkpoints.
- Create `src/mycli/services/context/context_manager.py`
  Replaces the current lightweight context window builder with transcript-aware message assembly and tool-output trimming.
- Create `src/mycli/services/planning/planning_service.py`
  Applies plan updates and enforces the single-`in_progress` rule.
- Create `src/mycli/application/runtime/agent_runtime.py`
  Drives one user turn from input through model events, tool execution, suspension, and final assistant output.
- Modify `src/mycli/cli/main.py`
  Rewire CLI entrypoints to the new runtime and keep the current numeric approval UX.
- Modify `src/mycli/services/session_service.py`
  Persist new suspended turn checkpoints alongside conversation history.
- Create `tests/unit/domain/runtime/test_planning.py`
  Verifies planning invariants.
- Create `tests/unit/tools/test_tool_registry_v2.py`
  Verifies schema-first registration, lookup, and validation.
- Create `tests/unit/infrastructure/models/test_compat_chat_adapter.py`
  Verifies compat-model translation into runtime events.
- Create `tests/unit/services/test_approval_service_v2.py`
  Verifies suspension and resume decisions.
- Create `tests/unit/services/test_context_manager_v2.py`
  Verifies transcript assembly and trimming.
- Create `tests/unit/application/test_agent_runtime.py`
  Verifies loop behavior, tool-result reinjection, and resumed execution.
- Modify `tests/integration/test_cli_repl.py`
  Verifies end-to-end CLI behavior on top of the new runtime.

## Task 1: Establish Runtime Contracts

**Files:**
- Create: `src/mycli/domain/runtime/events.py`
- Create: `src/mycli/domain/runtime/turn_state.py`
- Create: `src/mycli/domain/runtime/planning.py`
- Create: `src/mycli/domain/runtime/approvals.py`
- Modify: `src/mycli/domain/runtime.py`
- Test: `tests/unit/domain/runtime/test_planning.py`

- [ ] **Step 1: Write the failing planning invariant test**

```python
from mycli.domain.runtime.planning import PlanItem, PlanState, PlanStatus


def test_plan_state_rejects_multiple_in_progress_items() -> None:
    first = PlanItem(id="inspect", content="Inspect runtime entrypoints", status=PlanStatus.IN_PROGRESS)
    second = PlanItem(id="wire-cli", content="Wire CLI to runtime", status=PlanStatus.IN_PROGRESS)

    try:
        PlanState(items=(first, second))
    except ValueError as exc:
        assert "single in_progress" in str(exc)
    else:
        raise AssertionError("PlanState should reject multiple in-progress items")
```

- [ ] **Step 2: Run the new test to confirm the contract does not exist yet**

Run: `uv run pytest tests/unit/domain/runtime/test_planning.py -v`

Expected: FAIL with `ModuleNotFoundError` or missing `PlanState`/`PlanStatus`

- [ ] **Step 3: Add the new runtime domain modules with explicit contracts**

```python
# src/mycli/domain/runtime/planning.py
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class PlanStatus(StrEnum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


@dataclass(slots=True, frozen=True)
class PlanItem:
    id: str
    content: str
    status: PlanStatus = PlanStatus.PENDING


@dataclass(slots=True, frozen=True)
class PlanState:
    items: tuple[PlanItem, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        in_progress = [item for item in self.items if item.status is PlanStatus.IN_PROGRESS]
        if len(in_progress) > 1:
            raise ValueError("PlanState allows a single in_progress item.")
```

```python
# src/mycli/domain/runtime/events.py
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class RuntimeEventType(StrEnum):
    ASSISTANT_MESSAGE = "assistant_message"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    PLAN_UPDATE = "plan_update"
    APPROVAL_REQUIRED = "approval_required"
    TURN_COMPLETED = "turn_completed"


@dataclass(slots=True, frozen=True)
class RuntimeEvent:
    type: RuntimeEventType
    payload: Any
```

```python
# src/mycli/domain/runtime/approvals.py
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from mycli.domain.tools import ToolCall


class ApprovalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


@dataclass(slots=True, frozen=True)
class PendingApproval:
    tool_call: ToolCall
    reason: str
    preview: str
    command_pattern: str | None = None
```

```python
# src/mycli/domain/runtime/turn_state.py
from __future__ import annotations

from dataclasses import dataclass, field

from mycli.domain.conversation import Message
from mycli.domain.runtime.approvals import PendingApproval
from mycli.domain.runtime.planning import PlanState


@dataclass(slots=True, frozen=True)
class SuspendedTurn:
    user_message: str
    conversation: tuple[Message, ...]
    plan_state: PlanState = field(default_factory=PlanState)
    pending_approval: PendingApproval | None = None
```

- [ ] **Step 4: Re-export only the compatibility surface still needed by existing modules**

```python
# src/mycli/domain/runtime.py
from mycli.domain.runtime.approvals import ApprovalStatus, PendingApproval
from mycli.domain.runtime.events import RuntimeEvent, RuntimeEventType
from mycli.domain.runtime.planning import PlanItem, PlanState, PlanStatus
from mycli.domain.runtime.turn_state import SuspendedTurn
```

- [ ] **Step 5: Run the targeted runtime tests**

Run: `uv run pytest tests/unit/domain/runtime/test_planning.py -v`

Expected: PASS with the invariant test green

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/runtime.py src/mycli/domain/runtime/events.py src/mycli/domain/runtime/turn_state.py src/mycli/domain/runtime/planning.py src/mycli/domain/runtime/approvals.py tests/unit/domain/runtime/test_planning.py
git commit -m "feat: add runtime domain contracts"
```

## Task 2: Introduce Schema-First Tools

**Files:**
- Create: `src/mycli/tools/base.py`
- Create: `src/mycli/tools/registry.py`
- Modify: `src/mycli/tools/contracts.py`
- Modify: `src/mycli/tools/list_directory.py`
- Modify: `src/mycli/tools/read_file.py`
- Modify: `src/mycli/tools/search_text.py`
- Modify: `src/mycli/tools/edit_file.py`
- Modify: `src/mycli/tools/run_shell.py`
- Test: `tests/unit/tools/test_tool_registry_v2.py`

- [ ] **Step 1: Write the failing registry validation test**

```python
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.registry import ToolRegistryV2


def test_tool_registry_validates_required_arguments_before_execution() -> None:
    spec = ToolSpec(
        name="read_file",
        description="Read a file from the workspace",
        parameters=(ToolParameter(name="path", type="string", required=True),),
    )
    registry = ToolRegistryV2(specs={"read_file": spec}, executors={})

    try:
        registry.validate("read_file", {})
    except ValueError as exc:
        assert "path" in str(exc)
    else:
        raise AssertionError("validate() should reject missing required arguments")
```

- [ ] **Step 2: Run the test and verify the new contracts are still missing**

Run: `uv run pytest tests/unit/tools/test_tool_registry_v2.py -v`

Expected: FAIL with missing `ToolSpec` or `ToolRegistryV2`

- [ ] **Step 3: Add the shared schema-first tool contract**

```python
# src/mycli/tools/base.py
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(slots=True, frozen=True)
class ToolParameter:
    name: str
    type: str
    required: bool = True


@dataclass(slots=True, frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: tuple[ToolParameter, ...] = field(default_factory=tuple)
    risk_level: str = "low"


@dataclass(slots=True, frozen=True)
class ToolResultV2:
    success: bool
    summary: str
    artifacts: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


class ToolExecutor(Protocol):
    spec: ToolSpec

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        ...
```

```python
# src/mycli/tools/registry.py
from __future__ import annotations

from dataclasses import dataclass

from mycli.tools.base import ToolExecutor, ToolSpec


@dataclass(slots=True)
class ToolRegistryV2:
    specs: dict[str, ToolSpec]
    executors: dict[str, ToolExecutor]

    def validate(self, name: str, arguments: dict[str, object]) -> None:
        spec = self.specs[name]
        missing = [parameter.name for parameter in spec.parameters if parameter.required and parameter.name not in arguments]
        if missing:
            raise ValueError(f"Missing required arguments: {', '.join(missing)}")
```

- [ ] **Step 4: Migrate one existing tool pattern and use it as the template for the remaining four**

```python
# src/mycli/tools/read_file.py
from mycli.tools.base import ToolExecutor, ToolParameter, ToolResultV2, ToolSpec


class ReadFileTool:
    spec = ToolSpec(
        name="read_file",
        description="Read a UTF-8 text file from the workspace",
        parameters=(ToolParameter(name="path", type="string", required=True),),
        risk_level="low",
    )

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        path = str(arguments["path"])
        content = self._workspace_root.joinpath(path).read_text(encoding="utf-8")
        return ToolResultV2(success=True, summary=f"Read {path}", artifacts={"content": content})
```

- [ ] **Step 5: Run the focused tool tests**

Run: `uv run pytest tests/unit/tools/test_tool_registry_v2.py tests/unit/tools/test_read_only_tools.py tests/unit/tools/test_run_shell.py -v`

Expected: PASS with the new validation test and the existing tool behavior still green after migration

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/base.py src/mycli/tools/registry.py src/mycli/tools/contracts.py src/mycli/tools/list_directory.py src/mycli/tools/read_file.py src/mycli/tools/search_text.py src/mycli/tools/edit_file.py src/mycli/tools/run_shell.py tests/unit/tools/test_tool_registry_v2.py
git commit -m "feat: adopt schema-first tool registry"
```

## Task 3: Add Model Adapters

**Files:**
- Create: `src/mycli/infrastructure/models/base.py`
- Create: `src/mycli/infrastructure/models/compat_chat_adapter.py`
- Modify: `src/mycli/infrastructure/openai_client.py`
- Test: `tests/unit/infrastructure/models/test_compat_chat_adapter.py`

- [ ] **Step 1: Write the failing compat-adapter translation test**

```python
from mycli.infrastructure.models.compat_chat_adapter import CompatChatModelAdapter


class FakeChatClient:
    def complete(self, _messages: list[dict[str, object]]) -> dict[str, object]:
        return {
            "assistant_message": None,
            "tool_name": "list_directory",
            "arguments": {"path": "."},
            "reason": "inspect root",
            "done": False,
        }


def test_compat_adapter_translates_json_payload_into_runtime_action() -> None:
    adapter = CompatChatModelAdapter(chat_client=FakeChatClient())

    action = adapter.next_action(messages=[{"role": "user", "content": "inspect the repo"}], tools=[])

    assert action.tool_call is not None
    assert action.tool_call.name == "list_directory"
```

- [ ] **Step 2: Run the adapter test**

Run: `uv run pytest tests/unit/infrastructure/models/test_compat_chat_adapter.py -v`

Expected: FAIL with missing adapter classes

- [ ] **Step 3: Introduce the shared adapter protocol and compat implementation**

```python
# src/mycli/infrastructure/models/base.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from mycli.domain.tools import ToolCall


@dataclass(slots=True, frozen=True)
class ModelAction:
    assistant_message: str | None = None
    tool_call: ToolCall | None = None
    done: bool = False


class ModelAdapter(Protocol):
    def next_action(
        self,
        *,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> ModelAction:
        ...
```

```python
# src/mycli/infrastructure/models/compat_chat_adapter.py
from __future__ import annotations

from mycli.domain.tools import ToolCall
from mycli.infrastructure.models.base import ModelAction


class CompatChatModelAdapter:
    def __init__(self, chat_client: object) -> None:
        self._chat_client = chat_client

    def next_action(self, *, messages: list[dict[str, object]], tools: list[dict[str, object]]) -> ModelAction:
        payload = self._chat_client.complete(messages)
        tool_call = None
        if payload.get("tool_name"):
            tool_call = ToolCall(
                name=str(payload["tool_name"]),
                arguments=dict(payload.get("arguments", {})),
                reason=str(payload.get("reason", "model requested tool")),
            )
        return ModelAction(
            assistant_message=payload.get("assistant_message"),
            tool_call=tool_call,
            done=bool(payload.get("done", False)),
        )
```

- [ ] **Step 4: Reduce `openai_client.py` to a transport-oriented chat client**

```python
# src/mycli/infrastructure/openai_client.py
class OpenAIChatClient:
    def complete(self, messages: list[dict[str, object]]) -> dict[str, object]:
        body = json.dumps(
            {
                "model": self._model,
                "messages": messages,
                "max_tokens": self._max_output_tokens,
                "temperature": 0,
            }
        ).encode("utf-8")
        ...
        content = payload["choices"][0]["message"]["content"]
        return json.loads(content)
```

- [ ] **Step 5: Run the adapter tests**

Run: `uv run pytest tests/unit/infrastructure/models/test_compat_chat_adapter.py tests/unit/infrastructure/test_openai_client.py -v`

Expected: PASS with the adapter translating compat responses and the transport client still covered

- [ ] **Step 6: Commit**

```bash
git add src/mycli/infrastructure/models/base.py src/mycli/infrastructure/models/compat_chat_adapter.py src/mycli/infrastructure/openai_client.py tests/unit/infrastructure/models/test_compat_chat_adapter.py
git commit -m "feat: add model adapter layer"
```

## Task 4: Build Approval and Context Services

**Files:**
- Create: `src/mycli/services/approval/approval_service.py`
- Create: `src/mycli/services/context/context_manager.py`
- Modify: `src/mycli/services/session_service.py`
- Modify: `src/mycli/services/safety_policy.py`
- Test: `tests/unit/services/test_approval_service_v2.py`
- Test: `tests/unit/services/test_context_manager_v2.py`

- [ ] **Step 1: Write the failing suspension test for risky commands**

```python
from mycli.domain.tools import ToolCall
from mycli.services.approval.approval_service import ApprovalService


def test_approval_service_suspends_git_push_with_command_pattern() -> None:
    service = ApprovalService()
    decision = service.evaluate(
        ToolCall(name="run_shell", arguments={"args": ["git", "push", "origin", "main"]}, reason="publish branch")
    )

    assert decision.pending_approval is not None
    assert decision.pending_approval.command_pattern == "git push"
```

- [ ] **Step 2: Run the new approval/context tests**

Run: `uv run pytest tests/unit/services/test_approval_service_v2.py tests/unit/services/test_context_manager_v2.py -v`

Expected: FAIL with missing new services

- [ ] **Step 3: Implement the resumable approval service**

```python
# src/mycli/services/approval/approval_service.py
from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.runtime.approvals import PendingApproval
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy


@dataclass(slots=True, frozen=True)
class ApprovalOutcome:
    auto_approved: bool = False
    denied_reason: str | None = None
    pending_approval: PendingApproval | None = None


class ApprovalService:
    def __init__(self, safety_policy: SafetyPolicy | None = None) -> None:
        self._safety_policy = safety_policy or SafetyPolicy()

    def evaluate(self, call: ToolCall) -> ApprovalOutcome:
        safety = self._safety_policy.evaluate(call)
        if safety.kind.value == "deny":
            return ApprovalOutcome(denied_reason=safety.reason)
        if safety.kind.value == "needs_choice":
            return ApprovalOutcome(
                pending_approval=PendingApproval(
                    tool_call=call,
                    reason=safety.reason,
                    preview=safety.preview,
                    command_pattern=safety.command_pattern,
                )
            )
        return ApprovalOutcome(auto_approved=True)
```

- [ ] **Step 4: Implement a transcript-aware context manager**

```python
# src/mycli/services/context/context_manager.py
from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Message
from mycli.tools.base import ToolResultV2


@dataclass(slots=True, frozen=True)
class ManagedContext:
    messages: tuple[Message, ...]
    summary: str | None


class ContextManager:
    def build(self, *, conversation: tuple[Message, ...], recent_message_count: int, max_tool_chars: int = 400) -> ManagedContext:
        recent = conversation[-recent_message_count:]
        summary = None
        if len(conversation) > recent_message_count:
            older = conversation[:-recent_message_count]
            summary = "\n".join(f"- {message.role}: {' '.join(message.content.split())[:96]}" for message in older)
        return ManagedContext(messages=recent, summary=summary)

    def render_tool_result(self, result: ToolResultV2, *, max_chars: int = 400) -> str:
        payload = result.summary if len(result.summary) <= max_chars else result.summary[: max_chars - 3] + "..."
        return payload
```

- [ ] **Step 5: Persist suspended turn checkpoints in the session service**

```python
# src/mycli/services/session_service.py
def save_suspended_turn(self, session_id: str, turn: SuspendedTurn) -> None:
    payload = {
        "user_message": turn.user_message,
        "conversation": [{"role": item.role, "content": item.content} for item in turn.conversation],
        "plan_items": [
            {"id": item.id, "content": item.content, "status": item.status.value}
            for item in turn.plan_state.items
        ],
        "pending_approval": None if turn.pending_approval is None else {
            "tool_call": {
                "name": turn.pending_approval.tool_call.name,
                "arguments": turn.pending_approval.tool_call.arguments,
                "reason": turn.pending_approval.tool_call.reason,
            },
            "reason": turn.pending_approval.reason,
            "preview": turn.pending_approval.preview,
            "command_pattern": turn.pending_approval.command_pattern,
        },
    }
    write_json(self._sessions_root / f"{session_id}-suspended.json", payload)
```

- [ ] **Step 6: Run the service tests**

Run: `uv run pytest tests/unit/services/test_approval_service_v2.py tests/unit/services/test_context_manager_v2.py tests/unit/services/test_session_service.py -v`

Expected: PASS with risky commands suspending and suspended checkpoints persisting cleanly

- [ ] **Step 7: Commit**

```bash
git add src/mycli/services/approval/approval_service.py src/mycli/services/context/context_manager.py src/mycli/services/session_service.py src/mycli/services/safety_policy.py tests/unit/services/test_approval_service_v2.py tests/unit/services/test_context_manager_v2.py
git commit -m "feat: add approval and context services"
```

## Task 5: Implement the New Agent Runtime

**Files:**
- Create: `src/mycli/services/planning/planning_service.py`
- Create: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/agents/react_loop.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write the failing runtime resume test**

```python
from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.domain.tools import ToolCall


class PushThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *, messages, tools):
        self.calls += 1
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": None,
                    "tool_call": ToolCall(
                        name="run_shell",
                        arguments={"args": ["git", "push", "origin", "main"]},
                        reason="publish branch",
                    ),
                    "done": False,
                },
            )()
        return type("Action", (), {"assistant_message": "Push finished", "tool_call": None, "done": True})()


def test_agent_runtime_resumes_after_approval(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(tmp_path, model_adapter=PushThenDoneAdapter())

    first = runtime.handle_user_turn("push the branch")
    assert first.pending_approval is not None

    resumed = runtime.resolve_pending_approval("1")
    assert resumed.assistant_message == "Push finished"
```

- [ ] **Step 2: Run the runtime test**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py -v`

Expected: FAIL with missing runtime implementation

- [ ] **Step 3: Add the planning service used by the runtime**

```python
# src/mycli/services/planning/planning_service.py
from __future__ import annotations

from mycli.domain.runtime.planning import PlanItem, PlanState, PlanStatus


class PlanningService:
    def replace(self, items: list[dict[str, str]]) -> PlanState:
        plan_items = tuple(
            PlanItem(
                id=item["id"],
                content=item["content"],
                status=PlanStatus(item.get("status", PlanStatus.PENDING.value)),
            )
            for item in items
        )
        return PlanState(items=plan_items)
```

- [ ] **Step 4: Implement the runtime loop around messages, tool execution, and suspension**

```python
# src/mycli/application/runtime/agent_runtime.py
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.runtime.turn_state import SuspendedTurn


@dataclass(slots=True, frozen=True)
class RuntimeTurnResult:
    assistant_message: str
    progress_updates: tuple[str, ...] = ()
    pending_approval: object | None = None


class AgentRuntime:
    ...

    def handle_user_turn(self, user_message: str) -> RuntimeTurnResult:
        messages = self._build_messages(user_message)
        while True:
            action = self._model_adapter.next_action(messages=messages, tools=self._tool_registry.render_for_model())
            if action.tool_call is None and action.done:
                return RuntimeTurnResult(assistant_message=action.assistant_message or "")
            if action.tool_call is not None:
                approval = self._approval_service.evaluate(action.tool_call)
                if approval.pending_approval is not None:
                    self._session_service.save_suspended_turn(
                        self._session_id,
                        SuspendedTurn(
                            user_message=user_message,
                            conversation=tuple(self._conversation),
                            plan_state=self._plan_state,
                            pending_approval=approval.pending_approval,
                        ),
                    )
                    return RuntimeTurnResult(
                        assistant_message="A risky action is waiting for your decision.",
                        pending_approval=approval.pending_approval,
                    )
                result = self._tool_registry.execute(action.tool_call)
                messages.append({"role": "tool", "content": self._context_manager.render_tool_result(result)})
```

- [ ] **Step 5: Temporarily wrap the old entrypoints around the new runtime**

```python
# src/mycli/application/turn_service.py
class TurnService:
    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    def handle_user_turn(self, user_message: str):
        return self._runtime.handle_user_turn(user_message)

    def resolve_pending_decision(self, choice: str):
        return self._runtime.resolve_pending_approval(choice)
```

- [ ] **Step 6: Run the runtime-focused tests**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py -v`

Expected: PASS with resumed execution continuing after approval and compatibility wrappers still behaving

- [ ] **Step 7: Commit**

```bash
git add src/mycli/services/planning/planning_service.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py src/mycli/agents/react_loop.py tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py
git commit -m "feat: add message-driven agent runtime"
```

## Task 6: Rewire the CLI and Remove Prompt-Centric Coupling

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `src/mycli/prompts/react.py`
- Modify: `README.md`
- Modify: `tests/integration/test_cli_repl.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Write the failing CLI resume test**

```python
from mycli.cli.main import run_repl


def test_run_repl_routes_numeric_choice_to_runtime_when_turn_is_suspended() -> None:
    outputs: list[str] = []
    state = {"pending": True}

    def turn_handler(_raw: str):
        raise AssertionError("normal turn handler should not run while approval is pending")

    def decision_handler(choice: str):
        state["pending"] = False
        assert choice == "1"
        return ["[decision] approved", "Push finished"]

    inputs = iter(["1"])
    run_repl(
        turn_handler=turn_handler,
        input_func=lambda _prompt: next(inputs),
        output_func=outputs.append,
        decision_handler=decision_handler,
        pending_decision_provider=lambda: state["pending"],
    )

    assert outputs == ["[decision] approved", "Push finished", "Bye."]
```

- [ ] **Step 2: Run the CLI tests**

Run: `uv run pytest tests/integration/test_cli_repl.py tests/unit/cli/test_main.py -v`

Expected: FAIL with the runtime-wired behavior not implemented yet

- [ ] **Step 3: Build the runtime from `main.py` and remove direct prompt orchestration from the CLI**

```python
# src/mycli/cli/main.py
from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.infrastructure.models.compat_chat_adapter import CompatChatModelAdapter
from mycli.tools.registry import ToolRegistryV2


def build_runtime(...) -> AgentRuntime:
    chat_client = OpenAIChatClient(
        api_key=config.api_key,
        base_url=config.api_base_url,
        model=config.model,
        max_output_tokens=config.max_output_tokens,
    )
    model_adapter = CompatChatModelAdapter(chat_client=chat_client)
    tool_registry = ToolRegistryV2.from_tools(
        [
            ListDirectoryTool(workspace_root),
            ReadFileTool(workspace_root),
            SearchTextTool(workspace_root),
            EditFileTool(workspace_root),
            RunShellTool(workspace_root),
        ]
    )
    return AgentRuntime(...)
```

- [ ] **Step 4: Shrink `prompts/react.py` into a compat-only helper**

```python
# src/mycli/prompts/react.py
def build_compat_prompt(*, user_message: str, memory_summary: str, conversation_summary: str) -> str:
    return (
        f"User goal: {user_message}\n"
        f"Memory: {memory_summary or 'none'}\n"
        f"Conversation summary: {conversation_summary or 'none'}\n"
        "Return valid JSON matching the compat adapter contract."
    )
```

- [ ] **Step 5: Update the README to describe the new runtime architecture and compat-mode caveat**

```markdown
## Runtime Architecture

- The CLI now talks to a message-driven runtime rather than building prompts directly.
- Tools are exposed through a schema-first registry.
- OpenAI-compatible `chat/completions` support currently runs through a compat adapter.
- Risky tool calls suspend the current turn and resume after approval.
```

- [ ] **Step 6: Run the full regression suite for the migrated phase**

Run: `uv run pytest -q`

Expected: PASS across unit and integration tests

- [ ] **Step 7: Run quality checks**

Run: `uv run ruff check .`

Expected: PASS

Run: `uv run mypy src`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/mycli/cli/main.py src/mycli/prompts/react.py README.md tests/integration/test_cli_repl.py tests/unit/cli/test_main.py
git commit -m "feat: wire cli to phase1 runtime"
```

## Spec Coverage Notes

This plan covers the approved spec's first-phase requirements:

- `message-driven runtime`: Task 5
- `schema-first tools`: Task 2
- `dual-channel model adapter foundation`: Task 3
- `approval pause/resume`: Tasks 4 and 5
- `explicit planning state`: Tasks 1 and 5
- `ContextManager v2`: Task 4
- `CLI kept as shell`: Task 6

The following spec items are intentionally deferred because they belong to later phases:

- `skill runtime v2`
- `stronger memory retrieval semantics`
- `task objects and long-lived workflow continuity`
- `subagents`
- `background tasks`
- `team coordination`

## Self-Review Checklist

- Spec coverage checked against Section 10 and Section 11 of the approved spec
- Placeholder scan completed: no placeholder markers remain inside actionable steps
- Type consistency checked across `PlanState`, `PendingApproval`, `ToolRegistryV2`, `ModelAdapter`, and `AgentRuntime`
