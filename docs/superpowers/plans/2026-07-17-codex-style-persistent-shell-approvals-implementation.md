# Codex-Style Persistent Shell Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users persist a validated, narrow Shell prefix to `~/.mycli/rules/default.rules` from the approval selector and make that rule effective immediately without restarting mycli.

**Architecture:** The model may propose an optional `prefix_rule`, but a pure validator owned by the runtime policy layer decides whether it is eligible. Approval state carries only validated immutable tokens; a locked atomic writer persists the user rule, and one strict runtime refresh publishes the new rules to both policy enforcement and model context before the suspended Shell call resumes.

**Tech Stack:** Python 3.13 dataclasses and standard-library file locking (`fcntl`/`msvcrt`), pytest, Ruff, Mypy, Node.js 22.19+, TypeScript 5.9, Node test runner.

---

## File Map

### New Python modules

- `src/mycli/services/execpolicy_proposals.py`: pure validation of model-proposed persistent Shell prefixes.
- `src/mycli/services/execpolicy_lock.py`: cross-platform advisory lock for the global rules writer.
- `src/mycli/services/execpolicy_writer.py`: deduplicating, atomic global `allow` rule persistence.
- `tests/unit/services/test_execpolicy_proposals.py`: structural, sensitive, broad, destructive, and policy-source validation.
- `tests/unit/services/test_execpolicy_writer.py`: serialization, permissions, locking, deduplication, and failure atomicity.

### Existing Python modules to modify

- `src/mycli/tools/bash.py`: expose optional `prefix_rule` only on the model-visible `Shell` schema.
- `src/mycli/tools/shell_safety.py`: expose the existing sensitive-token heuristic for proposal validation.
- `src/mycli/domain/runtime/approvals.py`: carry a validated immutable proposal on `PendingApproval`.
- `src/mycli/domain/runtime/__init__.py`: add `always_allow` and proposal state to `PendingDecision`.
- `src/mycli/domain/runtime/gateway_contract.py`: extend the stable gateway decision taxonomy and preview schema.
- `src/mycli/application/runtime/tools/runtime_policy.py`: validate and attach proposals after ordinary policy precedence has run.
- `src/mycli/application/runtime/approval_decisions.py`: expose `Always allow` only for validated proposals.
- `src/mycli/application/runtime/agent_runtime.py`: own the writer and provide strict in-process execpolicy refresh.
- `src/mycli/application/runtime/turn_executor.py`: resolve choice `4`, persist, refresh, audit, and resume exactly once.
- `src/mycli/application/turn_service.py`: keep CLI numeric-choice formatting aligned with the domain mapping.
- `src/mycli/services/execpolicy.py`: expose user-only loading and the typed runtime-refresh error while preserving existing combined loading.
- `src/mycli/state/session_service.py`: round-trip proposal tokens through pending and suspended state.
- `src/mycli/cli/node_tui/gateway.py`: map `always_allow`, label it, and send a bounded prefix preview.

### Node TUI modules to modify

- `tui/mycli-shell/src/model.ts`: retain the optional persistent-rule preview.
- `tui/mycli-shell/src/adapters/runtime-state.ts`: project the preview and backend-supplied options.
- `tui/mycli-shell/src/components/approval-selector.ts`: render stable `1` through `4` shortcuts and the prefix preview.

### Existing tests to modify

- `tests/unit/test_bash.py`
- `tests/unit/domain/test_runtime.py`
- `tests/unit/domain/runtime/test_gateway_contract.py`
- `tests/unit/application/test_tool_policy_runtime.py`
- `tests/unit/application/test_agent_runtime.py`
- `tests/unit/services/test_session_service.py`
- `tests/unit/cli/node_tui/test_gateway.py`
- `tests/integration/test_turn_service.py`
- `tui/mycli-shell/test/runtime-state.test.ts`
- `tui/mycli-shell/test/shell-app.test.ts`

## Task 1: Validate Model-Proposed Prefixes

**Files:**

- Create: `src/mycli/services/execpolicy_proposals.py`
- Create: `tests/unit/services/test_execpolicy_proposals.py`
- Modify: `src/mycli/tools/bash.py`
- Modify: `src/mycli/tools/shell_safety.py`
- Modify: `tests/unit/test_bash.py`

- [ ] **Step 1: Write failing Shell-schema and proposal-validator tests**

Add a schema assertion to `tests/unit/test_bash.py`:

```python
def test_shell_exposes_optional_persistent_prefix_but_legacy_bash_does_not(tmp_path: Path) -> None:
    shell_parameters = {parameter.name: parameter for parameter in ShellTool(tmp_path).spec.parameters}
    bash_parameters = {parameter.name: parameter for parameter in BashTool(tmp_path).spec.parameters}

    assert shell_parameters["prefix_rule"].required is False
    assert shell_parameters["prefix_rule"].type == "array"
    assert shell_parameters["prefix_rule"].items_schema == {"type": "string"}
    assert "prefix_rule" not in bash_parameters
```

Create `tests/unit/services/test_execpolicy_proposals.py` with table-driven cases around this API:

```python
from mycli.domain.runtime import ExecPolicyDecision, ExecPolicyRule, ExecPolicyRuleSet, ExecPolicySource, ShellKind
from mycli.domain.tooling.calls import ToolCall
from mycli.services.execpolicy_proposals import ExecPolicyProposalValidator


def _call(command: str, proposal: object) -> ToolCall:
    return ToolCall(
        name="Shell",
        arguments={"command": command, "prefix_rule": proposal},
        reason="run tests",
        call_id="call_shell_1",
    )


def test_accepts_narrow_prefix_for_unknown_segment() -> None:
    result = ExecPolicyProposalValidator().validate(
        call=_call("python -m pytest -q", ["python", "-m", "pytest"]),
        shell_kind=ShellKind.BASH,
        rules=ExecPolicyRuleSet(),
        approval_policy="shell_command_analysis",
    )

    assert result.pattern == ("python", "-m", "pytest")
    assert result.rejection_reason is None


def test_accepts_only_the_unknown_segment_in_a_plain_composite() -> None:
    result = ExecPolicyProposalValidator().validate(
        call=_call("pwd && python -m pytest -q", ["python", "-m", "pytest"]),
        shell_kind=ShellKind.BASH,
        rules=ExecPolicyRuleSet(),
        approval_policy="shell_command_analysis",
    )

    assert result.pattern == ("python", "-m", "pytest")


@pytest.mark.parametrize(
    ("command", "proposal"),
    [
        ("python script.py", []),
        ("python script.py", ["python", 7]),
        ("python script.py", ["node"]),
        ("python script.py | cat", ["python", "script.py", "cat"]),
        ("python $SCRIPT", ["python"]),
    ],
)
def test_rejects_invalid_non_prefix_cross_segment_and_complex_proposals(
    command: str,
    proposal: object,
) -> None:
    result = ExecPolicyProposalValidator().validate(
        call=_call(command, proposal),
        shell_kind=ShellKind.BASH,
        rules=ExecPolicyRuleSet(),
        approval_policy="shell_command_analysis",
    )

    assert result.pattern is None
    assert result.rejection_reason
```

Add explicit parameter sets for:

```python
BROAD = [
    ("python script.py", ["python"]),
    ("/usr/bin/python3 -c pass", ["/usr/bin/python3", "-c"]),
    ("node app.js", ["node"]),
    ("bash -lc make", ["bash", "-lc"]),
    ("sudo make install", ["sudo"]),
]
DESTRUCTIVE = [
    ("rm build.txt", ["rm"]),
    ("git reset --hard HEAD", ["git", "reset", "--hard"]),
    ("git clean -fd", ["git", "clean"]),
    ("git push --force origin main", ["git", "push", "--force"]),
    ("chmod -R 777 build", ["chmod", "-R"]),
    ("Remove-Item -Recurse build", ["Remove-Item", "-Recurse"]),
]
SENSITIVE = [
    ("tool --token abc123", ["tool", "--token", "abc123"]),
    ("env API_KEY=abc tool", ["env", "API_KEY=abc"]),
    ("tool password=abc", ["tool", "password=abc"]),
    ("tool <redacted>", ["tool", "<redacted>"]),
]
```

Also assert that `approval_policy="execpolicy_prefix_rule"`, a matching project `ASK`, a matching project `DENY`, legacy `Bash`, more than 16 tokens, a token over 256 characters, or more than 512 total characters returns no proposal.

- [ ] **Step 2: Run the focused tests to verify RED**

```bash
uv run pytest tests/unit/test_bash.py -k persistent_prefix -q
uv run pytest tests/unit/services/test_execpolicy_proposals.py -q
```

Expected: the schema assertion fails because `prefix_rule` is absent, and validator collection fails because `execpolicy_proposals` does not exist.

- [ ] **Step 3: Expose the schema and shared sensitive-token predicate**

Append only this parameter to `_CODEX_SHELL_PARAMETERS` in `src/mycli/tools/bash.py`:

```python
ToolParameter(
    name="prefix_rule",
    type="array",
    required=False,
    items_schema={"type": "string"},
    description=(
        "Optional narrow executable prefix proposed for persistent user approval. "
        "It is policy metadata and is never executed."
    ),
),
```

In `src/mycli/tools/shell_safety.py`, add a public predicate that uses the existing `_SENSITIVE_VALUE_FLAGS`, `_contains_sensitive_hint`, and `_looks_like_env_secret_assignment` definitions:

```python
def shell_tokens_contain_sensitive_values(args: tuple[str, ...]) -> bool:
    mask_next = False
    for arg in args:
        lowered = arg.casefold()
        if mask_next or arg == "<redacted>":
            return True
        if lowered in _SENSITIVE_VALUE_FLAGS:
            mask_next = True
            continue
        if "=" in arg:
            key, _, _value = arg.partition("=")
            if _contains_sensitive_hint(key) or _looks_like_env_secret_assignment(arg):
                return True
    return mask_next
```

- [ ] **Step 4: Implement the pure validator**

Create `src/mycli/services/execpolicy_proposals.py` with these public types and limits:

```python
from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePath, PureWindowsPath

from mycli.domain.runtime import ExecPolicyDecision, ExecPolicyRuleSet, ShellKind
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.shell_command_policy import (
    ShellParseKind,
    is_known_safe_segment,
    parse_shell_argv,
    parse_shell_command,
)
from mycli.tools.shell_safety import shell_tokens_contain_sensitive_values


MAX_PATTERN_TOKENS = 16
MAX_PATTERN_TOKEN_CHARS = 256
MAX_PATTERN_TOTAL_CHARS = 512


@dataclass(slots=True, frozen=True)
class ExecPolicyProposalValidation:
    pattern: tuple[str, ...] | None = None
    rejection_reason: str | None = None


class ExecPolicyProposalValidator:
    def validate(
        self,
        *,
        call: ToolCall,
        shell_kind: ShellKind,
        rules: ExecPolicyRuleSet,
        approval_policy: str,
    ) -> ExecPolicyProposalValidation:
        if call.name != "Shell":
            return self._reject("legacy shell call")
        if approval_policy != "shell_command_analysis":
            return self._reject("approval source is not eligible")
        pattern = self._pattern(call.arguments.get("prefix_rule"))
        if pattern is None:
            return self._reject("invalid prefix proposal")
        if shell_tokens_contain_sensitive_values(pattern):
            return self._reject("sensitive prefix proposal")
        if self._is_broad(pattern, shell_kind=shell_kind):
            return self._reject("broad prefix proposal")
        if self._is_destructive(pattern, shell_kind=shell_kind):
            return self._reject("destructive prefix proposal")

        parsed = self._parse_call(call, shell_kind=shell_kind)
        if parsed.kind is not ShellParseKind.PLAIN:
            return self._reject("command is not plain shell syntax")
        eligible_segments = []
        for segment in parsed.segments:
            if segment.words[: len(pattern)] != pattern:
                continue
            match = rules.match(segment.words)
            if match is not None:
                if match.rule.decision in {ExecPolicyDecision.ASK, ExecPolicyDecision.DENY}:
                    return self._reject("explicit policy blocks persistence")
                continue
            if not is_known_safe_segment(segment, shell_kind=shell_kind):
                eligible_segments.append(segment)
        if not eligible_segments:
            return self._reject("prefix does not match the segment awaiting approval")
        return ExecPolicyProposalValidation(pattern=pattern)
```

Implement the private helpers with explicit prefix semantics:

```python
    @staticmethod
    def _pattern(value: object) -> tuple[str, ...] | None:
        if not isinstance(value, list) or not value:
            return None
        if not all(isinstance(token, str) and token.strip() for token in value):
            return None
        pattern = tuple(value)
        if len(pattern) > MAX_PATTERN_TOKENS:
            return None
        if any(len(token) > MAX_PATTERN_TOKEN_CHARS for token in pattern):
            return None
        if sum(len(token) for token in pattern) > MAX_PATTERN_TOTAL_CHARS:
            return None
        return pattern

    @staticmethod
    def _parse_call(call: ToolCall, *, shell_kind: ShellKind) -> ShellParseResult:
        args = call.arguments.get("args")
        if isinstance(args, list) and args and all(isinstance(item, str) for item in args):
            return parse_shell_argv(tuple(args), shell_kind=shell_kind)
        command = call.arguments.get("command")
        if isinstance(command, str) and command:
            return parse_shell_command(command, shell_kind=shell_kind)
        return ShellParseResult(ShellParseKind.INVALID, reason="empty command")

    @staticmethod
    def _executable(pattern: tuple[str, ...], *, shell_kind: ShellKind) -> str:
        if shell_kind in {ShellKind.POWERSHELL, ShellKind.CMD}:
            executable = PureWindowsPath(pattern[0]).name.casefold()
            return executable[:-4] if executable.endswith(".exe") else executable
        return PurePath(pattern[0]).name

    def _is_broad(self, pattern: tuple[str, ...], *, shell_kind: ShellKind) -> bool:
        executable = self._executable(pattern, shell_kind=shell_kind)
        comparable = tuple(token.casefold() for token in pattern)
        if executable.casefold() in {"env", "sudo", "osascript"}:
            return True
        if executable.casefold() in {"python", "python3", "py"}:
            return len(pattern) == 1 or comparable[1:2] == ("-c",)
        if executable.casefold() == "node":
            return len(pattern) == 1 or comparable[1:2] == ("-e",)
        if executable.casefold() in {"bash", "sh", "zsh"}:
            return len(pattern) == 1 or comparable[1:2] in {("-c",), ("-lc",)}
        if executable.casefold() in {"pwsh", "powershell"}:
            return len(pattern) == 1 or comparable[1:2] == ("-command",)
        return False

    def _is_destructive(self, pattern: tuple[str, ...], *, shell_kind: ShellKind) -> bool:
        executable = self._executable(pattern, shell_kind=shell_kind).casefold()
        comparable = tuple(token.casefold() for token in pattern)
        if executable in {
            "rm", "rmdir", "del", "erase", "remove-item", "dd", "mkfs",
            "diskpart", "format", "clear-disk", "shutdown", "reboot", "halt", "poweroff",
        }:
            return True
        if executable == "git" and len(comparable) >= 2:
            if comparable[1] == "clean":
                return True
            if comparable[1:3] == ("reset", "--hard"):
                return True
            if comparable[1] == "push" and any(
                token in {"--force", "-f", "--force-with-lease"}
                for token in comparable[2:]
            ):
                return True
        if executable in {"chmod", "chown"} and any(
            token in {"-r", "--recursive"} for token in comparable[1:]
        ):
            return True
        return False

    @staticmethod
    def _reject(reason: str) -> ExecPolicyProposalValidation:
        return ExecPolicyProposalValidation(rejection_reason=reason)
```

Import `ShellParseResult` for the helper annotation. Broad launcher checks use `startswith` behavior for `python -c`, `node -e`, shell `-c`/`-lc`, and PowerShell `-Command`, so adding code text after those switches cannot bypass rejection. Specific module workflows such as `python -m pytest` remain eligible.

- [ ] **Step 5: Run tests and commit**

```bash
uv run pytest tests/unit/test_bash.py -k persistent_prefix -q
uv run pytest tests/unit/services/test_execpolicy_proposals.py -q
uv run ruff check src/mycli/services/execpolicy_proposals.py src/mycli/tools/bash.py src/mycli/tools/shell_safety.py tests/unit/services/test_execpolicy_proposals.py
uv run mypy src/mycli/services/execpolicy_proposals.py src/mycli/tools/bash.py src/mycli/tools/shell_safety.py
git add src/mycli/services/execpolicy_proposals.py src/mycli/tools/bash.py src/mycli/tools/shell_safety.py tests/unit/services/test_execpolicy_proposals.py tests/unit/test_bash.py
git commit -m "feat: validate persistent shell rule proposals"
```

Expected: all focused tests and static checks pass.

## Task 2: Carry Validated Proposals Through Approval Decisions

**Files:**

- Modify: `src/mycli/domain/runtime/approvals.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/application/runtime/tools/runtime_policy.py`
- Modify: `src/mycli/application/runtime/approval_decisions.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `tests/unit/domain/test_runtime.py`
- Modify: `tests/unit/application/test_tool_policy_runtime.py`

- [ ] **Step 1: Write failing domain and runtime-policy tests**

Add domain assertions:

```python
def test_pending_decision_requires_validated_pattern_for_always_allow() -> None:
    with pytest.raises(ValueError, match="proposed_execpolicy_pattern"):
        PendingDecision(
            tool_call=ToolCall(name="Shell", arguments={"command": "python -m pytest"}, reason="test"),
            kind=DecisionKind.NEEDS_CHOICE,
            reason="unknown command",
            preview="python -m pytest",
            options=(DecisionAction.APPROVE_ONCE, DecisionAction.ALWAYS_ALLOW),
        )


def test_pending_decision_accepts_validated_always_allow_pattern() -> None:
    decision = PendingDecision(
        tool_call=ToolCall(name="Shell", arguments={"command": "python -m pytest"}, reason="test"),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="unknown command",
        preview="python -m pytest",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT, DecisionAction.ALWAYS_ALLOW),
        proposed_execpolicy_pattern=("python", "-m", "pytest"),
    )

    assert decision.options[-1] is DecisionAction.ALWAYS_ALLOW
```

Add runtime-policy tests proving a valid proposal is attached for `Shell`, but absent for `Bash`, an explicit project `ASK`, destructive commands, and calls without `prefix_rule`.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/domain/test_runtime.py -k always_allow -q
uv run pytest tests/unit/application/test_tool_policy_runtime.py -k execpolicy_proposal -q
```

Expected: tests fail because `ALWAYS_ALLOW` and proposal fields do not exist.

- [ ] **Step 3: Extend immutable approval state and invariants**

Add to `PendingApproval`:

```python
proposed_execpolicy_pattern: tuple[str, ...] | None = None
```

Add to `DecisionAction`:

```python
ALWAYS_ALLOW = "always_allow"
```

Add the same optional field to `PendingDecision` and extend `__post_init__`:

```python
proposal = self.proposed_execpolicy_pattern
if proposal is not None and (not proposal or any(not token for token in proposal)):
    raise ValueError("proposed_execpolicy_pattern must contain non-empty tokens.")
if DecisionAction.ALWAYS_ALLOW in self.options:
    if proposal is None:
        raise ValueError("ALWAYS_ALLOW requires proposed_execpolicy_pattern.")
elif proposal is not None:
    raise ValueError("proposed_execpolicy_pattern requires ALWAYS_ALLOW.")
```

- [ ] **Step 4: Attach proposals after policy precedence and project options**

In `RuntimePolicyGate`, own `ExecPolicyProposalValidator` and, only after `ApprovalService` returns a pending Shell approval, validate the proposal with the active shell kind, current `ExecPolicyRuleSet`, and resolved `policy_name`. Use `dataclasses.replace` to attach only `validation.pattern`; never attach the rejection reason to traces or user-visible metadata.

In `RuntimeApprovalDecisions.pending_decision_from_approval`, append options in this exact order:

```python
options = [DecisionAction.APPROVE_ONCE, DecisionAction.REJECT]
if approval.command_pattern:
    options.append(DecisionAction.ALLOW_SESSION)
if approval.proposed_execpolicy_pattern:
    options.append(DecisionAction.ALWAYS_ALLOW)
```

Pass `proposed_execpolicy_pattern` into `PendingDecision`. Add `"4": DecisionAction.ALWAYS_ALLOW` to both numeric formatting maps in `approval_decisions.py` and `turn_service.py`.

- [ ] **Step 5: Run tests and commit**

```bash
uv run pytest tests/unit/domain/test_runtime.py tests/unit/application/test_tool_policy_runtime.py -q
uv run ruff check src/mycli/domain/runtime src/mycli/application/runtime/tools/runtime_policy.py src/mycli/application/runtime/approval_decisions.py src/mycli/application/turn_service.py
uv run mypy src/mycli/domain/runtime src/mycli/application/runtime/tools/runtime_policy.py src/mycli/application/runtime/approval_decisions.py
git add src/mycli/domain/runtime/approvals.py src/mycli/domain/runtime/__init__.py src/mycli/application/runtime/tools/runtime_policy.py src/mycli/application/runtime/approval_decisions.py src/mycli/application/turn_service.py tests/unit/domain/test_runtime.py tests/unit/application/test_tool_policy_runtime.py
git commit -m "feat: expose validated persistent approval choices"
```

Expected: all focused tests and static checks pass.

## Task 3: Persist Proposal State Across Resume

**Files:**

- Modify: `src/mycli/state/session_service.py`
- Modify: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write failing pending/suspended/reconstruction round-trip tests**

Add tests using `("python", "-m", "pytest")` that verify:

```python
service.save_pending_decision("session-1", decision)
loaded = service.load_pending_decision("session-1")
assert loaded is not None
assert loaded.proposed_execpolicy_pattern == ("python", "-m", "pytest")
assert loaded.options[-1] is DecisionAction.ALWAYS_ALLOW
```

Also round-trip the same value through `save_suspended_turn`/`load_suspended_turn`, and assert `reconstruct_suspended_turn` copies it from `PendingDecision`. Add one compatibility test that loads an old payload without the field and returns `None`.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/services/test_session_service.py -k proposed_execpolicy_pattern -q
```

Expected: round-trip assertions fail because the serializer drops the proposal.

- [ ] **Step 3: Add one strict optional-token parser**

Add a private helper in `src/mycli/state/session_service.py`:

```python
def _optional_string_tuple(value: object) -> tuple[str, ...] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        raise ValueError("Expected a non-empty string list.")
    return tuple(value)
```

Use it for deserialization. Serialize with `list(pattern)` only when the field is non-`None`.

- [ ] **Step 4: Thread the field through all three state paths**

Update:

1. `save_pending_decision` and `load_pending_decision`.
2. `save_suspended_turn` and `load_suspended_turn`.
3. `reconstruct_suspended_turn` when rebuilding `PendingApproval` from `PendingDecision`.

Keep absent fields backward compatible by calling `_optional_string_tuple(payload.get("proposed_execpolicy_pattern"))`.

- [ ] **Step 5: Run tests and commit**

```bash
uv run pytest tests/unit/services/test_session_service.py -q
uv run ruff check src/mycli/state/session_service.py tests/unit/services/test_session_service.py
uv run mypy src/mycli/state/session_service.py
git add src/mycli/state/session_service.py tests/unit/services/test_session_service.py
git commit -m "feat: persist shell rule proposals across resume"
```

Expected: the full session-service test file passes.

## Task 4: Atomically Write Global User Rules

**Files:**

- Create: `src/mycli/services/execpolicy_lock.py`
- Create: `src/mycli/services/execpolicy_writer.py`
- Create: `tests/unit/services/test_execpolicy_writer.py`
- Modify: `src/mycli/services/execpolicy.py`
- Modify: `tests/unit/services/test_execpolicy_loader.py`

- [ ] **Step 1: Write failing loader, lock, writer, and atomicity tests**

Add a loader test for `load_user_rules()` that ignores project rules. Create writer tests that assert:

```python
result = ExecPolicyWriter(home_dir=home).allow_prefix(("python", "-m", "pytest"))

assert result.status == "created"
assert rules_file.read_text(encoding="utf-8") == (
    'prefix_rule(pattern=["python", "-m", "pytest"], decision="allow")\n'
)
assert stat.S_IMODE(rules_file.stat().st_mode) == 0o600
```

Add cases for comments and a missing final newline, JSON escaping, identical-rule deduplication, existing malformed rules, and two concurrent threads writing different rules. Inject a failing `replace_file` callable and assert the original file remains byte-for-byte unchanged and parseable. Test lock dispatch by passing fake POSIX and Windows acquire/release callables into `execpolicy_file_lock` and asserting the dedicated lock file is used.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/services/test_execpolicy_loader.py -k user_rules -q
uv run pytest tests/unit/services/test_execpolicy_writer.py -q
```

Expected: loader lacks `load_user_rules`, and writer modules do not exist.

- [ ] **Step 3: Expose user-only loading and implement the lock adapter**

Add this method without changing `load()` precedence:

```python
def load_user_rules(self) -> ExecPolicyRuleSet:
    path = self.home_dir / ".mycli" / "rules" / "default.rules"
    return ExecPolicyRuleSet(
        rules=_parse_rules_file(path, source=ExecPolicySource.USER),
    )
```

Create `execpolicy_lock.py` with:

```python
@contextmanager
def execpolicy_file_lock(
    path: Path,
    *,
    os_name: str = os.name,
    posix_lock: LockOperation = _posix_lock,
    posix_unlock: LockOperation = _posix_unlock,
    windows_lock: LockOperation = _windows_lock,
    windows_unlock: LockOperation = _windows_unlock,
) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        harden_private_path(path, mode=0o600, os_name=os_name)
        acquire = windows_lock if os_name == "nt" else posix_lock
        release = windows_unlock if os_name == "nt" else posix_unlock
        acquire(handle)
        try:
            yield
        finally:
            release(handle)
```

`_posix_lock`/`_posix_unlock` import `fcntl` lazily and use `flock`. `_windows_lock` ensures the lock file has one byte, seeks to offset zero, lazily imports `msvcrt`, and uses `LK_LOCK`; release seeks to zero and uses `LK_UNLCK`.

- [ ] **Step 4: Implement the atomic writer**

Create these public types in `execpolicy_writer.py`:

```python
class ExecPolicyWriteError(RuntimeError):
    pass


@dataclass(slots=True, frozen=True)
class ExecPolicyWriteResult:
    status: Literal["created", "existing"]
    pattern_hash: str


@dataclass(slots=True)
class ExecPolicyWriter:
    home_dir: Path
    lock_factory: LockFactory = execpolicy_file_lock
    replace_file: ReplaceFile = os.replace

    def allow_prefix(self, pattern: tuple[str, ...]) -> ExecPolicyWriteResult:
        candidate = ExecPolicyRule(
            source=ExecPolicySource.USER,
            index=0,
            pattern=pattern,
            decision=ExecPolicyDecision.ALLOW,
        )
        rules_dir = self.home_dir / ".mycli" / "rules"
        rules_path = rules_dir / "default.rules"
        lock_path = rules_dir / "default.rules.lock"
        try:
            rules_dir.mkdir(parents=True, exist_ok=True)
            harden_private_path(rules_dir, mode=0o700)
            with self.lock_factory(lock_path):
                existing = ExecPolicyLoader(
                    home_dir=self.home_dir,
                    workspace_root=rules_dir / ".no-project-rules",
                ).load_user_rules()
                if any(
                    rule.pattern == pattern and rule.decision is ExecPolicyDecision.ALLOW
                    for rule in existing.rules
                ):
                    return ExecPolicyWriteResult("existing", candidate.pattern_hash)
                current = rules_path.read_text(encoding="utf-8") if rules_path.exists() else ""
                separator = "" if not current or current.endswith(("\n", "\r")) else "\n"
                line = self._serialize_allow(pattern)
                self._atomic_replace(rules_path, f"{current}{separator}{line}\n")
            return ExecPolicyWriteResult("created", candidate.pattern_hash)
        except (OSError, ValueError) as exc:
            raise ExecPolicyWriteError("Could not update global Shell approval rules.") from exc
```

Define the injected callable types as:

```python
LockFactory = Callable[[Path], AbstractContextManager[None]]
ReplaceFile = Callable[[Path, Path], None]
```

`_serialize_allow` uses `json.dumps(list(pattern), ensure_ascii=True)` and never accepts formatted model text. `_atomic_replace` uses `tempfile.mkstemp(dir=rules_path.parent)`, writes UTF-8 with `newline=""`, applies mode `0o600`, flushes and `os.fsync`s, calls injected `replace_file`, fsyncs the directory on POSIX, and removes an unpublished temporary file in `finally`.

- [ ] **Step 5: Run tests and commit**

```bash
uv run pytest tests/unit/services/test_execpolicy_loader.py tests/unit/services/test_execpolicy_writer.py -q
uv run ruff check src/mycli/services/execpolicy.py src/mycli/services/execpolicy_lock.py src/mycli/services/execpolicy_writer.py tests/unit/services/test_execpolicy_writer.py
uv run mypy src/mycli/services/execpolicy.py src/mycli/services/execpolicy_lock.py src/mycli/services/execpolicy_writer.py
git add src/mycli/services/execpolicy.py src/mycli/services/execpolicy_lock.py src/mycli/services/execpolicy_writer.py tests/unit/services/test_execpolicy_loader.py tests/unit/services/test_execpolicy_writer.py
git commit -m "feat: atomically persist global shell approval rules"
```

Expected: writer and loader tests pass, including concurrent and simulated-failure cases.

## Task 5: Refresh Runtime Policy And Resolve Always-Allow

**Files:**

- Modify: `src/mycli/application/runtime/tools/runtime_policy.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/services/execpolicy.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/integration/test_turn_service.py`

- [ ] **Step 1: Write failing refresh and resolution tests**

Add a runtime unit test:

```python
def test_refresh_execpolicy_rules_updates_gate_and_context_without_rebind(tmp_path: Path) -> None:
    home = tmp_path / "home"
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home,
        model_adapter=PushThenDoneAdapter(),
    )
    writer = ExecPolicyWriter(home_dir=home)
    writer.allow_prefix(("python", "-m", "pytest"))

    rules = runtime.refresh_execpolicy_rules()

    assert rules.match(("python", "-m", "pytest", "-q")) is not None
    decision = runtime._runtime_policy_gate.decide_execpolicy(
        ToolCall(name="Shell", arguments={"command": "python -m pytest -q"}, reason="test")
    )
    assert decision is not None
    assert decision.kind is ToolRuntimeDecisionKind.ALLOWED
```

Add integration scenarios for choice `4`:

1. A Shell call with `prefix_rule` returns options ending in `always_allow`.
2. Resolving `4` writes the global rule, refreshes policy, executes the suspended call once, and clears pending state.
3. A second matching Shell call in the same runtime is auto-allowed by user execpolicy.
4. A writer failure leaves both pending decision and suspended turn intact and executes nothing.
5. A successful write followed by refresh failure leaves the call pending; retrying deduplicates the rule.
6. Choice `1`, `2`, and `3` behavior remains unchanged.
7. An existing user `allow` decision reaches `AssistantBlockConsumer` as policy-approved and is not re-evaluated into a second approval by `ApprovalService`.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py -k refresh_execpolicy -q
uv run pytest tests/integration/test_turn_service.py -k always_allow -q
```

Expected: refresh method and choice `4` do not exist.

- [ ] **Step 3: Add strict runtime refresh**

Add to `RuntimePolicyGate`:

```python
def set_execpolicy_rules(self, rules: ExecPolicyRuleSet) -> None:
    self._execpolicy_rules = rules
```

Define `ExecPolicyRefreshError(RuntimeError)` in `src/mycli/services/execpolicy.py`, where both `AgentRuntime` and `TurnExecutor` can import it without a circular dependency. Construct `self._execpolicy_writer = ExecPolicyWriter(home_dir=home_dir)` in `AgentRuntime`. Add a strict method that converts any load or publication failure into that typed refresh error instead of falling back to an empty ruleset:

```python
def refresh_execpolicy_rules(self) -> ExecPolicyRuleSet:
    try:
        rules = ExecPolicyLoader(
            home_dir=self._home_dir,
            workspace_root=self._config.workspace_root,
        ).load()
        self._execpolicy_rules = rules
        self._runtime_policy_gate.set_execpolicy_rules(rules)
        self._runtime_context_builder.set_execpolicy_rules(rules)
        return rules
    except Exception as exc:
        raise ExecPolicyRefreshError("Could not refresh Shell approval rules.") from exc
```

Keep startup/rebind compatibility behavior in `_load_execpolicy_rules`; persistent approval must call the strict method directly.

Update `_runtime_policy_decision_for_block` so an allowed
`policy="execpolicy_prefix_rule"` decision is returned to `AssistantBlockConsumer`
instead of being collapsed to `None`. Trace that bounded decision before returning it.
Continue collapsing other allowed policies to `None`, preserving their current approval and
session-allowance behavior. `AssistantBlockConsumer` already treats a non-`None` allowed decision
as `policy_approved=True`, so no second policy implementation is added there.

- [ ] **Step 4: Resolve, audit, and fail without clearing pending state**

Add `"4": DecisionAction.ALWAYS_ALLOW` to `TurnExecutor.resolve_pending_approval`. Before clearing pending state:

```python
if selected_action is DecisionAction.ALWAYS_ALLOW:
    pattern = decision.proposed_execpolicy_pattern
    if pattern is None:
        return self._pending_approval_error(decision, "Persistent approval is unavailable.")
    try:
        write_result = runtime._execpolicy_writer.allow_prefix(pattern)
    except ExecPolicyWriteError as exc:
        _record_persistent_approval_failure(
            runtime=runtime,
            turn_id=turn_id,
            decision=decision,
            stage="write",
            exc=exc,
        )
        return TurnResponse(
            assistant_message="Could not persist the Shell approval. The command is still pending.",
            pending_decision=decision,
        )
    try:
        runtime.refresh_execpolicy_rules()
    except ExecPolicyRefreshError as exc:
        _record_persistent_approval_failure(
            runtime=runtime,
            turn_id=turn_id,
            decision=decision,
            stage="refresh",
            exc=exc,
        )
        return TurnResponse(
            assistant_message=(
                "The Shell rule was persisted but could not be activated in this runtime. "
                "The command is still pending."
            ),
            pending_decision=decision,
        )
    _record_persistent_approval(
        runtime=runtime,
        turn_id=turn_id,
        decision=decision,
        write_result=write_result,
    )
```

The success audit payload contains only:

```python
{
    "action": "always_allow",
    "shell_kind": _decision_shell_kind(decision).value,
    "rule_source": "user",
    "pattern_token_count": len(decision.proposed_execpolicy_pattern or ()),
    "pattern_hash": write_result.pattern_hash,
    "write_result": write_result.status,
}
```

The failure payload contains only action, failure `stage`, exception type as `error_kind`, and whether a validated pattern was present. It must not include tokens, raw command, command preview, or `command_pattern`. After successful persistence and refresh, continue through the existing clear-state and `policy_approved=True` execution path exactly once.

- [ ] **Step 5: Run tests and commit**

```bash
uv run pytest tests/unit/application/test_agent_runtime.py -k execpolicy -q
uv run pytest tests/integration/test_turn_service.py -k "approval or always_allow" -q
uv run ruff check src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/tools/runtime_policy.py src/mycli/services/execpolicy.py
uv run mypy src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/tools/runtime_policy.py src/mycli/services/execpolicy.py
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/tools/runtime_policy.py src/mycli/services/execpolicy.py tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py
git commit -m "feat: activate persistent shell approvals at runtime"
```

Expected: persistent approval succeeds in-process, failure keeps pending state, and all existing approval integration tests pass.

## Task 6: Expose Always-Allow Through Gateway And TUI

**Files:**

- Modify: `src/mycli/domain/runtime/gateway_contract.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `tests/unit/domain/runtime/test_gateway_contract.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/components/approval-selector.ts`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing gateway and TUI tests**

Update the stable taxonomy assertion to:

```python
assert schema["properties"]["choice"]["enum"] == [
    "approve_once",
    "reject",
    "allow_session",
    "always_allow",
]
```

Add a gateway payload test that expects:

```python
assert payload["options"][-1] == {"choice": "always_allow", "label": "Always allow"}
assert payload["persistent_rule_preview"] == '["python", "-m", "pytest"]'
assert "python -m pytest --token" not in str(payload)
```

Add TUI tests that feed all four backend options, press `3` and `4` in separate runtime instances, and assert `allow_session` and `always_allow` are submitted. Assert the rendered selector includes `4. Always allow` and the bounded persistent-rule preview. Keep the old-snapshot test with only options `1/2`.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/cli/node_tui/test_gateway.py -k "always_allow or persistent_rule" -q
npm --prefix tui/mycli-shell test -- --test-name-pattern="always allow|approval selector"
```

Expected: the new enum, payload field, and shortcuts are absent.

- [ ] **Step 3: Extend the gateway taxonomy and bounded preview**

Append `"always_allow"` to `APPROVAL_DECISION_CHOICES`, add `persistent_rule_preview` to the `approval.request` schema, and extend gateway maps:

```python
DECISION_CHOICE_MAP = {
    "approve_once": "1",
    "reject": "2",
    "allow_session": "3",
    "always_allow": "4",
}
DECISION_OPTION_LABELS = {
    DecisionAction.APPROVE_ONCE: "Allow once",
    DecisionAction.REJECT: "Reject",
    DecisionAction.ALLOW_SESSION: "Allow for session",
    DecisionAction.ALWAYS_ALLOW: "Always allow",
}
```

When a validated proposal exists, add a backend-generated preview:

```python
def _persistent_rule_preview(pattern: tuple[str, ...], *, max_chars: int = 160) -> str:
    rendered = json.dumps(list(pattern), ensure_ascii=True)
    return rendered if len(rendered) <= max_chars else f"{rendered[: max_chars - 3]}..."
```

Do not send raw proposal tokens as an executable string and do not derive an option from `command_pattern`.

- [ ] **Step 4: Project and render stable shortcuts in Node TUI**

Add `persistentRulePreview?: string` to `MycliShellPendingApproval` and project `persistent_rule_preview` in `pendingApprovalFromRecord`.

In `approval-selector.ts`, define stable choice shortcuts:

```typescript
const approvalShortcuts: Record<string, string> = {
	approve_once: "1",
	reject: "2",
	allow_session: "3",
	always_allow: "4",
};
```

Resolve numeric input by looking up the backend option whose choice maps to the pressed key; never use array index. Keep `a`/`y` mapped to `approve_once` and `r`/`n` mapped to `reject`. Render each list row as `${number}. ${label}` and build footer hints only from supplied options. Render `Always allow: <persistentRulePreview>` under the risk line when present.

- [ ] **Step 5: Run tests and commit**

```bash
uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/cli/node_tui/test_gateway.py -q
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
git add src/mycli/domain/runtime/gateway_contract.py src/mycli/cli/node_tui/gateway.py tests/unit/domain/runtime/test_gateway_contract.py tests/unit/cli/node_tui/test_gateway.py tui/mycli-shell/src/model.ts tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/src/components/approval-selector.ts tui/mycli-shell/test/runtime-state.test.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "feat: render persistent shell approval choice"
```

Expected: Python gateway tests, Node tests, and TypeScript typecheck pass.

## Task 7: Verify Compatibility And End-To-End Behavior

**Files:**

- Modify: `tests/integration/test_turn_service.py`
- Modify: `tests/integration/test_node_tui_gateway.py`
- Modify: `docs/superpowers/plans/2026-07-17-codex-style-persistent-shell-approvals-implementation.md`

- [ ] **Step 1: Add final compatibility and security regressions**

Add end-to-end tests proving:

1. A provider omitting `prefix_rule` sees only the existing actions.
2. A replayed legacy `Bash` call remains executable and never offers `always_allow`.
3. A resumed old pending-decision payload without proposal state renders normally.
4. A resumed new pending decision preserves `always_allow` and can persist the rule.
5. Project `ask` and `deny` rules suppress `always_allow` even when the model proposes a matching prefix.
6. Project `deny` still overrides a newly persisted user `allow`.
7. Traces and gateway events contain only pattern hash/count and the bounded preview, never proposal tokens as a command or any secret-bearing raw argument.
8. The persisted rule changes neither Shell output formatting, PTY behavior, yield behavior, nor background session behavior.

- [ ] **Step 2: Run focused end-to-end suites**

```bash
uv run pytest tests/integration/test_turn_service.py tests/integration/test_node_tui_gateway.py -k "approval or execpolicy" -q
```

Expected: all persistent, legacy, resume, and precedence scenarios pass.

- [ ] **Step 3: Run the full Python quality gate**

```bash
uv run pytest -q
uv run ruff check .
uv run mypy src/mycli
```

Expected: all Python tests, lint checks, and strict typing pass.

- [ ] **Step 4: Run the full Node quality gate**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all Node TUI tests and TypeScript checks pass.

- [ ] **Step 5: Verify repository scope and record final evidence**

Because this worktree already contains unrelated user changes, do not use whole-worktree `git diff --check`. Run:

```bash
git diff --check c5de1e9..HEAD -- . ':(exclude).codex/config.toml' ':(exclude)docs/superpowers/plans/2026-07-17-codex-style-unified-shell-runtime-implementation.md'
git status --short
git log --oneline -8
```

Expected: implementation commits contain no whitespace errors; `.codex/config.toml` and the pre-existing unified-shell plan modification remain uncommitted and untouched.

- [ ] **Step 6: Update this plan with exact verification counts and commit**

Append the observed Python pass/skip counts and Node pass count under `Final Verification Evidence`, then run:

```bash
git add tests/integration/test_turn_service.py tests/integration/test_node_tui_gateway.py docs/superpowers/plans/2026-07-17-codex-style-persistent-shell-approvals-implementation.md
git commit -m "test: verify persistent shell approvals end to end"
```

## Final Verification Evidence

- [x] Shell exposes optional `prefix_rule`; legacy `Bash` does not.
- [x] Only a validated narrow, non-sensitive, non-destructive prefix enables `Always allow`.
- [x] Stable choices remain `1` once, `2` reject, `3` session, `4` always.
- [x] Global writes target only `~/.mycli/rules/default.rules` and use a dedicated lock plus atomic replace.
- [x] Existing comments and rules are preserved; duplicate `allow` rules are not appended.
- [x] Write or refresh failures keep the suspended call pending and unexecuted.
- [x] A successful rule becomes effective in the current runtime before the call resumes once.
- [x] Project `ask`/`deny`, sandbox restrictions, and plan-mode precedence remain authoritative.
- [x] Old sessions, providers without proposals, and hidden legacy Shell aliases remain compatible.
- [x] Approval audit data contains only bounded metadata, never raw command or proposal tokens.
- [x] Full Python, Ruff, Mypy, Node test, and TypeScript gates pass.

Observed on 2026-07-17:

- `uv run pytest -q`: 2221 passed, 29 skipped.
- `uv run ruff check .`: passed.
- `uv run mypy src/mycli`: 338 source files passed.
- `npm --prefix tui/mycli-shell test`: 208 passed.
- `npm --prefix tui/mycli-shell run typecheck`: passed.
