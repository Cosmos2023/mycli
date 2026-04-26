# mycli Risk Decision UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/confirm` and `/reject` with a numeric risk-decision flow where workspace-trusted actions run automatically and risky actions present `1/2/3` options including session-scoped allowlisting for similar commands.

**Architecture:** Keep the existing CLI, tool implementations, and session persistence, but replace `PendingApproval` with a richer `PendingDecision` model and move safety from risk-only classification to decision-oriented policy evaluation. The CLI becomes state-aware, `TurnService` owns decision resolution, `SessionService` persists both pending decisions and per-session command allowlists, and `SafetyPolicy` becomes the source of truth for auto-allow vs needs-choice vs deny.

**Tech Stack:** Python 3.13, `dataclasses`, `argparse`, `pathlib`, `pytest`, `ruff`, `mypy`

---

## Scope Check

This plan is intentionally scoped to the risk-decision UX and policy model only. It does not change the broader agent harness, skill loading model, or context manager design. The output should be a working CLI experience where numeric decisions replace slash-command approval without introducing a full TUI framework.

## File Structure

### Runtime and Domain Model

- Modify: `src/mycli/domain/runtime.py`
  Replace `PendingApproval` with decision-oriented runtime models that can represent numeric choices and session allowlisting.

### Services

- Modify: `src/mycli/services/safety_policy.py`
  Upgrade from `RiskLevel` classification to a richer decision result for auto-allow, needs-choice, and deny.
- Modify: `src/mycli/services/session_service.py`
  Persist pending decision state and session command allowlists.
- Modify: `src/mycli/application/turn_service.py`
  Replace approval orchestration with decision orchestration and session-allowlist support.

### Tools

- Modify: `src/mycli/tools/run_shell.py`
  Add command-pattern extraction helpers and keep argument validation centralized.

### CLI

- Modify: `src/mycli/cli/main.py`
  Replace `/confirm` and `/reject` with numeric `1/2/3` handling while a decision is pending.

### Tests

- Modify: `tests/unit/domain/test_runtime.py`
- Modify: `tests/unit/services/test_safety_policy.py`
- Modify: `tests/unit/services/test_session_service.py`
- Modify: `tests/unit/tools/test_run_shell.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/integration/test_cli_repl.py`
- Modify: `tests/integration/test_turn_service.py`

### Docs

- Modify: `README.md`
  Document the new numeric decision flow and remove slash approval guidance.

---

### Task 1: Replace Pending Approval With Decision Models

**Files:**
- Modify: `src/mycli/domain/runtime.py`
- Test: `tests/unit/domain/test_runtime.py`

- [ ] **Step 1: Write the failing runtime-model test**

```python
from pathlib import Path

from mycli.domain.runtime import (
    AgentConfig,
    DecisionAction,
    DecisionKind,
    PendingDecision,
    SessionCommandAllowance,
)
from mycli.domain.tools import ToolCall


def test_runtime_exposes_decision_models(tmp_path: Path) -> None:
    decision = PendingDecision(
        tool_call=ToolCall(
            name="run_shell",
            arguments={"args": ["git", "reset", "--hard"]},
            reason="reset workspace state",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Potentially destructive shell command.",
        preview="git reset --hard",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT, DecisionAction.ALLOW_SESSION),
        command_pattern="git reset --hard",
    )
    allowance = SessionCommandAllowance(command_pattern="git reset --hard")

    assert AgentConfig(workspace_root=tmp_path).session_id == "default"
    assert decision.options[-1] is DecisionAction.ALLOW_SESSION
    assert allowance.command_pattern == "git reset --hard"
```

- [ ] **Step 2: Run the targeted runtime test to verify it fails**

Run: `./.venv/bin/pytest tests/unit/domain/test_runtime.py::test_runtime_exposes_decision_models -q`

Expected: FAIL because `DecisionAction`, `DecisionKind`, `PendingDecision`, and `SessionCommandAllowance` do not exist yet.

- [ ] **Step 3: Implement the new runtime models**

`src/mycli/domain/runtime.py`

```python
from enum import StrEnum


class DecisionKind(StrEnum):
    AUTO_ALLOW = "auto_allow"
    NEEDS_CHOICE = "needs_choice"
    DENY = "deny"


class DecisionAction(StrEnum):
    APPROVE_ONCE = "approve_once"
    REJECT = "reject"
    ALLOW_SESSION = "allow_session"


@dataclass(slots=True, frozen=True)
class PendingDecision:
    tool_call: ToolCall
    kind: DecisionKind
    reason: str
    preview: str
    options: tuple[DecisionAction, ...]
    command_pattern: str | None = None


@dataclass(slots=True, frozen=True)
class SessionCommandAllowance:
    command_pattern: str
```

Also update `TurnResponse` so it carries `pending_decision` instead of `pending_approval`.

- [ ] **Step 4: Run the runtime test and existing runtime suite**

Run: `./.venv/bin/pytest tests/unit/domain/test_runtime.py -q`

Expected: PASS

---

### Task 2: Upgrade Session Persistence For Decisions And Allowlists

**Files:**
- Modify: `src/mycli/services/session_service.py`
- Test: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write failing session-service tests**

```python
from pathlib import Path

from mycli.domain.runtime import DecisionAction, DecisionKind, PendingDecision, SessionCommandAllowance
from mycli.domain.tools import ToolCall
from mycli.services.session_service import SessionService


def test_session_service_round_trips_pending_decision(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    decision = PendingDecision(
        tool_call=ToolCall(
            name="run_shell",
            arguments={"args": ["git", "push"]},
            reason="publish branch",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Push modifies remote state.",
        preview="git push",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT, DecisionAction.ALLOW_SESSION),
        command_pattern="git push",
    )

    service.save_pending_decision("demo", decision)
    loaded = service.load_pending_decision("demo")

    assert loaded is not None
    assert loaded.command_pattern == "git push"


def test_session_service_round_trips_allowlist(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    allowance = SessionCommandAllowance(command_pattern="git push")

    service.add_command_allowance("demo", allowance)

    assert service.is_command_allowed("demo", "git push") is True
    assert service.is_command_allowed("demo", "git reset --hard") is False
```

- [ ] **Step 2: Run the targeted session tests to verify they fail**

Run: `./.venv/bin/pytest tests/unit/services/test_session_service.py -q`

Expected: FAIL because the new save/load/add helpers do not exist yet.

- [ ] **Step 3: Implement pending-decision and allowlist persistence**

`src/mycli/services/session_service.py`

```python
    def save_pending_decision(self, session_id: str, decision: PendingDecision) -> None:
        payload = {
            "tool_call": {
                "name": decision.tool_call.name,
                "arguments": decision.tool_call.arguments,
                "reason": decision.tool_call.reason,
            },
            "kind": decision.kind.value,
            "reason": decision.reason,
            "preview": decision.preview,
            "options": [option.value for option in decision.options],
            "command_pattern": decision.command_pattern,
        }
        write_json(self._sessions_root / f"{session_id}-decision.json", payload)

    def load_pending_decision(self, session_id: str) -> PendingDecision | None:
        payload = read_json(self._sessions_root / f"{session_id}-decision.json", None)
        if payload is None:
            return None
        return PendingDecision(
            tool_call=ToolCall(
                name=payload["tool_call"]["name"],
                arguments=payload["tool_call"]["arguments"],
                reason=payload["tool_call"]["reason"],
            ),
            kind=DecisionKind(payload["kind"]),
            reason=payload["reason"],
            preview=payload["preview"],
            options=tuple(DecisionAction(option) for option in payload["options"]),
            command_pattern=payload.get("command_pattern"),
        )

    def add_command_allowance(self, session_id: str, allowance: SessionCommandAllowance) -> None:
        path = self._sessions_root / f"{session_id}-allowlist.json"
        payload = list(read_json(path, []))
        if allowance.command_pattern not in payload:
            payload.append(allowance.command_pattern)
        write_json(path, payload)

    def is_command_allowed(self, session_id: str, command_pattern: str | None) -> bool:
        if not command_pattern:
            return False
        path = self._sessions_root / f"{session_id}-allowlist.json"
        payload = list(read_json(path, []))
        return command_pattern in payload
```

Keep backward compatibility helpers only if still needed during the refactor; otherwise remove the old pending-approval methods in the same task.

- [ ] **Step 4: Run the session-service test suite**

Run: `./.venv/bin/pytest tests/unit/services/test_session_service.py -q`

Expected: PASS

---

### Task 3: Rebuild Safety Policy Around Decision Outcomes

**Files:**
- Modify: `src/mycli/services/safety_policy.py`
- Modify: `src/mycli/tools/run_shell.py`
- Test: `tests/unit/services/test_safety_policy.py`
- Test: `tests/unit/tools/test_run_shell.py`

- [ ] **Step 1: Write the failing safety-policy and shell-pattern tests**

```python
from mycli.domain.runtime import DecisionKind
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy
from mycli.tools.run_shell import derive_command_pattern


def test_safety_policy_auto_allows_workspace_reads() -> None:
    decision = SafetyPolicy().evaluate(
        ToolCall(name="read_file", arguments={"path": "README.md"}, reason="inspect")
    )
    assert decision.kind is DecisionKind.AUTO_ALLOW


def test_safety_policy_requires_choice_for_git_push() -> None:
    decision = SafetyPolicy().evaluate(
        ToolCall(name="run_shell", arguments={"args": ["git", "push", "origin", "main"]}, reason="publish"})
    )
    assert decision.kind is DecisionKind.NEEDS_CHOICE
    assert decision.command_pattern == "git push"


def test_safety_policy_denies_invalid_shell_call() -> None:
    decision = SafetyPolicy().evaluate(
        ToolCall(name="run_shell", arguments={}, reason="broken")
    )
    assert decision.kind is DecisionKind.DENY


def test_derive_command_pattern_handles_known_prefixes() -> None:
    assert derive_command_pattern(["git", "reset", "--hard", "HEAD~1"]) == "git reset --hard"
    assert derive_command_pattern(["python", "manage.py", "migrate"]) == "python manage.py migrate"
```

- [ ] **Step 2: Run the targeted policy tests to verify they fail**

Run: `./.venv/bin/pytest tests/unit/services/test_safety_policy.py tests/unit/tools/test_run_shell.py -q`

Expected: FAIL because `evaluate()` and `derive_command_pattern()` do not exist yet.

- [ ] **Step 3: Implement safety evaluation and command-pattern helpers**

`src/mycli/tools/run_shell.py`

```python
def derive_command_pattern(args: list[str]) -> str:
    if args[:3] == ["git", "reset", "--hard"]:
        return "git reset --hard"
    if args[:2] == ["git", "push"]:
        return "git push"
    if args[:2] == ["rm", "-rf"]:
        return "rm -rf"
    if len(args) >= 3 and args[0] == "python" and args[1].endswith(".py"):
        return " ".join(args[:3])
    return " ".join(args[: min(3, len(args))])
```

`src/mycli/services/safety_policy.py`

```python
@dataclass(slots=True, frozen=True)
class ToolSafetyDecision:
    kind: DecisionKind
    reason: str
    preview: str
    command_pattern: str | None = None


class SafetyPolicy:
    def evaluate(self, call: ToolCall) -> ToolSafetyDecision:
        if call.name in {"list_directory", "read_file", "search_text"}:
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=call.name,
            )
        if call.name == "edit_file":
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=str(call.arguments.get("path", "")),
            )
        if call.name == "run_shell":
            args = call.arguments.get("args")
            if not isinstance(args, list) or not args or not all(isinstance(item, str) for item in args):
                return ToolSafetyDecision(
                    kind=DecisionKind.DENY,
                    reason="run_shell requires a non-empty args list.",
                    preview="invalid shell call",
                )
            pattern = derive_command_pattern(list(args))
            preview = " ".join(args)
            if pattern in {"git push", "git reset --hard", "rm -rf"}:
                return ToolSafetyDecision(
                    kind=DecisionKind.NEEDS_CHOICE,
                    reason=call.reason,
                    preview=preview,
                    command_pattern=pattern,
                )
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=preview,
                command_pattern=pattern,
            )
        return ToolSafetyDecision(kind=DecisionKind.DENY, reason="Unsupported tool.", preview=call.name)
```

- [ ] **Step 4: Run the policy and shell tests**

Run: `./.venv/bin/pytest tests/unit/services/test_safety_policy.py tests/unit/tools/test_run_shell.py -q`

Expected: PASS

---

### Task 4: Replace Approval Flow With Decision Resolution In TurnService

**Files:**
- Modify: `src/mycli/application/turn_service.py`
- Test: `tests/integration/test_turn_service.py`

- [ ] **Step 1: Write the failing turn-service decision tests**

```python
from pathlib import Path

from mycli.application.turn_service import TurnService
from mycli.domain.runtime import AgentConfig
from mycli.domain.tools import ToolCall, ToolResult


class PushModel:
    def decide(self, *_args, **_kwargs):
        return ModelDecision(
            progress_message="Preparing a risky push",
            tool_call=ToolCall(
                name="run_shell",
                arguments={"args": ["git", "push", "origin", "main"]},
                reason="publish branch",
            ),
        )


def test_turn_service_returns_pending_decision_for_risky_command(tmp_path: Path) -> None:
    service = TurnService(
        model_client=PushModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    response = service.handle_user_turn("push the branch")

    assert response.pending_decision is not None
    assert response.pending_decision.command_pattern == "git push"


def test_turn_service_allows_session_pattern_after_choice_three(tmp_path: Path) -> None:
    service = TurnService(...)
    service.handle_user_turn("push the branch")

    resolved = service.resolve_pending_decision("3")

    assert "approved" in resolved.assistant_message.lower()
    assert service._session_service.is_command_allowed("demo", "git push") is True
```

- [ ] **Step 2: Run the turn-service tests to verify they fail**

Run: `./.venv/bin/pytest tests/integration/test_turn_service.py -q`

Expected: FAIL because `pending_decision` and `resolve_pending_decision()` do not exist yet.

- [ ] **Step 3: Implement decision-oriented turn orchestration**

`src/mycli/application/turn_service.py`

```python
    def handle_user_turn(self, user_message: str) -> TurnResponse:
        pending_decision = self._session_service.load_pending_decision(self._config.session_id)
        if pending_decision is not None:
            return TurnResponse(
                assistant_message="A risky action is waiting for your choice. Select 1, 2, or 3.",
                pending_decision=pending_decision,
            )

        ...
        response = self._agent.run(user_message=user_message, context=context)
        ...
        if response.pending_decision is not None:
            self._session_service.save_pending_decision(self._config.session_id, response.pending_decision)
        else:
            self._session_service.clear_pending_decision(self._config.session_id)

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        decision = self._session_service.load_pending_decision(self._config.session_id)
        if decision is None:
            return TurnResponse(assistant_message="There is no pending decision.")
        if choice == "2":
            self._session_service.clear_pending_decision(self._config.session_id)
            return TurnResponse(assistant_message=f"Rejected {decision.tool_call.name}.")
        if choice == "3" and decision.command_pattern is not None:
            self._session_service.add_command_allowance(
                self._config.session_id,
                SessionCommandAllowance(command_pattern=decision.command_pattern),
            )
        if choice not in {"1", "3"}:
            return TurnResponse(
                assistant_message="Please choose 1, 2, or 3.",
                pending_decision=decision,
            )
        tool_result = self._tool_registry.run(decision.tool_call)
        self._session_service.clear_pending_decision(self._config.session_id)
        if not tool_result.success:
            return TurnResponse(assistant_message=tool_result.error or tool_result.summary)
        return TurnResponse(assistant_message=f"Approved {decision.tool_call.name}: {tool_result.summary}")
```

Also, when `SafetyPolicy.evaluate()` returns `AUTO_ALLOW`, let the agent continue automatically; when it returns `DENY`, return an explanatory assistant message instead of creating a pending decision.

- [ ] **Step 4: Run the turn-service suite**

Run: `./.venv/bin/pytest tests/integration/test_turn_service.py -q`

Expected: PASS

---

### Task 5: Replace Slash Approval With Numeric Choice UI

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `README.md`
- Test: `tests/integration/test_cli_repl.py`
- Test: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Write the failing CLI tests**

```python
from mycli.cli.main import handle_slash_command, run_repl


def test_help_no_longer_lists_confirm_or_reject() -> None:
    output = handle_slash_command("/help")
    assert "/confirm" not in output
    assert "/reject" not in output


def test_run_repl_routes_numeric_decision_when_pending() -> None:
    outputs: list[str] = []
    scripted_inputs = iter(["3", "/quit"])

    run_repl(
        turn_handler=lambda _message: ["Risky action detected:", "[1] ...", "[2] ...", "[3] ..."],
        decision_handler=lambda choice: [f"[decision] {choice}", "approved"],
        pending_decision_provider=lambda: True,
        input_func=lambda _prompt: next(scripted_inputs),
        output_func=outputs.append,
    )

    assert "[decision] 3" in outputs
```

- [ ] **Step 2: Run the CLI tests to verify they fail**

Run: `./.venv/bin/pytest tests/integration/test_cli_repl.py tests/unit/cli/test_main.py -q`

Expected: FAIL because the CLI still depends on `/confirm` and `/reject`.

- [ ] **Step 3: Implement numeric decision UX**

`src/mycli/cli/main.py`

```python
def handle_slash_command(command: str) -> str:
    if command == "/help":
        return "\n".join(
            [
                "/help",
                "/skill",
                "/skills",
                "/memory",
                "/plan",
                "/tools",
                "/session",
                "/quit",
            ]
        )


def run_repl(..., decision_handler: Callable[[str], Iterable[str]] | None = None, pending_decision_provider: Callable[[], bool] | None = None) -> None:
    while True:
        ...
        if pending_decision_provider is not None and pending_decision_provider():
            if raw in {"1", "2", "3"} and decision_handler is not None:
                for line in decision_handler(raw):
                    output_func(line)
            else:
                output_func("Please choose 1, 2, or 3.")
            continue
        ...


    def handle_user_message(raw: str) -> list[str]:
        response = service.handle_user_turn(raw)
        rendered = [f"[progress] {update}" for update in response.progress_updates]
        if response.pending_decision is not None:
            rendered.extend(
                [
                    "Risky action detected:",
                    f"Tool: {response.pending_decision.tool_call.name}",
                    f"Preview: {response.pending_decision.preview}",
                    f"Reason: {response.pending_decision.reason}",
                    "[1] 仅本次允许",
                    "[2] 拒绝",
                    "[3] 本次会话内始终允许同类命令",
                ]
            )
        rendered.append(response.assistant_message)
        return rendered
```

Update `README.md` to document the new `1/2/3` flow and remove `/confirm` and `/reject`.

- [ ] **Step 4: Run the CLI and documentation-related tests**

Run: `./.venv/bin/pytest tests/integration/test_cli_repl.py tests/unit/cli/test_main.py -q`

Expected: PASS

---

### Task 6: Run End-to-End Verification

**Files:**
- Modify: `README.md`
- Test: `tests/unit/domain/test_runtime.py`
- Test: `tests/unit/services/test_session_service.py`
- Test: `tests/unit/services/test_safety_policy.py`
- Test: `tests/unit/tools/test_run_shell.py`
- Test: `tests/unit/cli/test_main.py`
- Test: `tests/integration/test_cli_repl.py`
- Test: `tests/integration/test_turn_service.py`

- [ ] **Step 1: Run the full targeted test slice**

Run:

```bash
./.venv/bin/pytest \
  tests/unit/domain/test_runtime.py \
  tests/unit/services/test_session_service.py \
  tests/unit/services/test_safety_policy.py \
  tests/unit/tools/test_run_shell.py \
  tests/unit/cli/test_main.py \
  tests/integration/test_cli_repl.py \
  tests/integration/test_turn_service.py -q
```

Expected: all pass

- [ ] **Step 2: Run repository-wide verification**

Run:

```bash
./.venv/bin/pytest -q
./.venv/bin/ruff check .
./.venv/bin/mypy src
```

Expected:

- `pytest`: all green
- `ruff`: `All checks passed!`
- `mypy`: `Success: no issues found ...`

- [ ] **Step 3: Smoke-test the new CLI flow manually**

Run:

```bash
printf '你是谁\n1\n/quit\n' | ./.venv/bin/mycli --session smoke
```

Expected:

- normal assistant response for the first turn if no risk decision is needed
- if a risky command is proposed, CLI prints `1/2/3` options rather than `/confirm` and `/reject`
- no traceback

- [ ] **Step 4: Commit**

```bash
git add README.md \
  src/mycli/domain/runtime.py \
  src/mycli/services/session_service.py \
  src/mycli/services/safety_policy.py \
  src/mycli/tools/run_shell.py \
  src/mycli/application/turn_service.py \
  src/mycli/cli/main.py \
  tests/unit/domain/test_runtime.py \
  tests/unit/services/test_session_service.py \
  tests/unit/services/test_safety_policy.py \
  tests/unit/tools/test_run_shell.py \
  tests/unit/cli/test_main.py \
  tests/integration/test_cli_repl.py \
  tests/integration/test_turn_service.py
git commit -m "feat: replace slash approval with risk decision ui"
```

---

## Self-Review

- Spec coverage:
  - Numeric `1/2/3` flow: covered in Tasks 4-5
  - Session-scoped allowlist: covered in Tasks 2-4
  - Workspace-trusted auto-run model: covered in Task 3
  - Removal of `/confirm` and `/reject`: covered in Task 5
- Placeholder scan:
  - No `TODO`/`TBD` placeholders remain
  - Each task includes exact files, tests, commands, and code snippets
- Type consistency:
  - Plan consistently uses `PendingDecision`, `DecisionAction`, `DecisionKind`, and `SessionCommandAllowance`
  - Service API consistently shifts from approval methods to `resolve_pending_decision()`
