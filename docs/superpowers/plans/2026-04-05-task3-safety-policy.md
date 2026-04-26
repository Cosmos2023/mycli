# Task 3 Safety Decision Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a decision-aware safety policy that can auto-allow simple calls, require choices on destructive shell commands, and extract command patterns for tooling.

**Architecture:** Extend the runtime enums with the new decision kinds, keep the legacy risk classification for the existing agent loop, and give the safety policy a `ToolSafetyDecision` API while moving `run_shell` command pattern heuristics into a reusable helper.

**Tech Stack:** Python 3.13, dataclasses, enum.StrEnum, pytest, uv + ruff/ruff-style static checks.

---

I'm using the writing-plans skill to create the implementation plan.

### Task 1: Decision-aware policy plus shell helper

**Files:**
- Modify: `src/mycli/domain/runtime.py`
- Modify: `src/mycli/services/safety_policy.py`
- Modify: `src/mycli/tools/run_shell.py`
- Modify: `tests/unit/services/test_safety_policy.py`
- Modify: `tests/unit/tools/test_run_shell.py`

- [ ] **Step 1: Write the failing tests** that capture auto-allow, needs-choice, deny, and command-pattern extraction.

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
        ToolCall(name="run_shell", arguments={"args": ["git", "push", "origin", "main"]}, reason="publish")
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

- [ ] **Step 2: Run the combined policy and shell tests to confirm the new assertions fail** (the helper and evaluation logic do not yet exist).

```
./.venv/bin/pytest tests/unit/services/test_safety_policy.py tests/unit/tools/test_run_shell.py -q
Expected: FAIL because `SafetyPolicy.evaluate` / `derive_command_pattern` are missing.
```

- [ ] **Step 3: Implement the policy evaluation, command-pattern helper, and runtime enums.**

```python
from dataclasses import dataclass
from mycli.domain.runtime import DecisionKind, RiskLevel
from mycli.domain.tools import ToolCall


class SafetyPolicy:
    def classify(self, call: ToolCall) -> RiskLevel:
        if call.name in {"list_directory", "read_file", "search_text"}:
            return RiskLevel.LOW
        if call.name == "edit_file":
            return RiskLevel.MEDIUM
        return RiskLevel.HIGH


@dataclass(slots=True, frozen=True)
class ToolSafetyDecision:
    kind: DecisionKind
    reason: str
    preview: str
    command_pattern: str | None = None

    @classmethod
    def from_call(cls, call: ToolCall, *, kind: DecisionKind, preview: str, command_pattern: str | None = None) -> "ToolSafetyDecision":
        return cls(kind=kind, reason=call.reason, preview=preview, command_pattern=command_pattern)


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

- [ ] **Step 4: Run the same policy+shell suite to confirm the new helper/policy implementation makes the tests pass.**

```
./.venv/bin/pytest tests/unit/services/test_safety_policy.py tests/unit/tools/test_run_shell.py -q
Expected: PASS
```

- [ ] **Step 5: Skip committing changes per the user request.** No command is issued.

Plan complete and saved to `docs/superpowers/plans/2026-04-05-task3-safety-policy.md`. Two execution options:
1. Subagent-Driven (recommended) – use superpowers:subagent-driven-development per the plan.
2. Inline Execution – use superpowers:executing-plans to implement the steps in this session.
Which approach?
