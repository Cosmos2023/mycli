# Codex-Style Shell Approval Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mycli a Codex-style positive Shell safelist so only structurally simple, known-safe commands run automatically while unknown or complex commands require approval.

**Architecture:** Add a pure `shell_command_policy` module that parses Shell calls into independent segments and classifies known-safe commands per shell profile. Keep dangerous-pattern detection and preview redaction in `shell_safety`, then update `RuntimePolicyGate` to apply `prefix_rule` decisions per parsed segment before falling back to the safelist and approval service.

**Tech Stack:** Python 3.12, frozen dataclasses, `StrEnum`, `shlex`, existing mycli runtime policy types, Pytest, Ruff, Mypy, Node TUI regression tests.

---

## File Map

- Create `src/mycli/tools/shell_command_policy.py`: typed conservative parser, command segmentation, shell-specific safelists, argument-sensitive validators, and whole-command classification.
- Create `tests/unit/tools/test_shell_command_policy.py`: parser and safelist unit coverage for POSIX, PowerShell, CMD, wrappers, composition, and complex syntax.
- Modify `src/mycli/tools/shell_safety.py`: retain hard-deny checks, dangerous-pattern reasons, redaction, and command-pattern derivation; use the positive classifier for the unmatched fallback.
- Modify `src/mycli/tools/shell_safety_adapters.py`: delegate shell-profile parsing and safe-command classification to the new module while retaining shell-specific dangerous-command reasons.
- Modify `src/mycli/services/approval/safety_policy.py`: pass structured argv without changing its literal semantics and convert unknown/complex classifications into pending approval.
- Modify `src/mycli/application/runtime/tools/runtime_policy.py`: evaluate execpolicy rules per parsed segment and prevent an allowed prefix from approving later segments.
- Modify `tests/unit/tools/test_bash_safety.py`: replace blanket chaining expectations with strict safe/unknown behavior.
- Modify `tests/unit/tools/test_shell_safety_adapters.py`: verify cross-platform positive safelists and conservative composition.
- Modify `tests/unit/services/test_safety_policy.py`: verify unknown POSIX commands now require approval and safe commands remain automatic.
- Modify `tests/unit/services/test_approval_service.py`: verify session allowances apply only to eligible simple commands.
- Run `tests/unit/domain/runtime/test_execpolicy.py` unchanged as a compatibility check for rule matching and source precedence.
- Modify `tests/unit/application/test_tool_policy_runtime.py`: verify sandbox precedence and per-segment execpolicy decisions.
- Modify `tests/unit/application/test_tool_execution_service.py`: exercise actual execution, approval suspension, bounded traces, and explicit allow behavior.
- Modify `tests/unit/application/test_agent_runtime.py`: verify approval suspension and resume still execute exactly once.

## Decision Invariants

Every task must preserve these invariants:

```text
sandbox or plan-mode deny
  > explicit segment deny
  > explicit segment ask / unknown / complex
  > explicit segment allow / built-in safe
```

- Structured `args` are one literal command; characters such as `>` inside an argv item are data, not shell syntax.
- String `command` values are parsed conservatively.
- A composed call is auto-allowed only when every segment is explicitly allowed or built-in safe.
- Parse failure and unsupported syntax require approval and never fall back to permissive execution.
- Raw command text never enters runtime-policy traces.

### Task 1: Typed POSIX Command Parser

**Files:**
- Create: `src/mycli/tools/shell_command_policy.py`
- Create: `tests/unit/tools/test_shell_command_policy.py`

- [ ] **Step 1: Write failing tests for plain POSIX segmentation and structured argv**

```python
from mycli.domain.runtime import ShellKind
from mycli.tools.shell_command_policy import (
    ShellParseKind,
    parse_shell_argv,
    parse_shell_command,
)


def test_posix_parser_splits_plain_control_operators_and_tracks_cd() -> None:
    parsed = parse_shell_command(
        "cd src && cat app.py | head -n 20",
        shell_kind=ShellKind.BASH,
    )

    assert parsed.kind is ShellParseKind.PLAIN
    assert [segment.words for segment in parsed.segments] == [
        ("cd", "src"),
        ("cat", "app.py"),
        ("head", "-n", "20"),
    ]
    assert [segment.operator_before for segment in parsed.segments] == [None, "&&", "|"]
    assert [segment.effective_cwd for segment in parsed.segments] == [None, "src", "src"]


def test_structured_argv_keeps_shell_metacharacters_literal() -> None:
    parsed = parse_shell_argv(
        ("echo", "a>b", "x&&y"),
        shell_kind=ShellKind.BASH,
    )

    assert parsed.kind is ShellParseKind.PLAIN
    assert parsed.segments[0].words == ("echo", "a>b", "x&&y")
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_command_policy.py -q
```

Expected: collection fails because `mycli.tools.shell_command_policy` does not exist.

- [ ] **Step 3: Add immutable parse types and a conservative POSIX tokenizer**

Implement these public types and entry points:

```python
class ShellParseKind(StrEnum):
    PLAIN = "plain"
    COMPLEX = "complex"
    INVALID = "invalid"


@dataclass(slots=True, frozen=True)
class ShellCommandSegment:
    words: tuple[str, ...]
    operator_before: str | None = None
    effective_cwd: str | None = None


@dataclass(slots=True, frozen=True)
class ShellParseResult:
    kind: ShellParseKind
    segments: tuple[ShellCommandSegment, ...] = ()
    reason: str | None = None


def parse_shell_command(command: str, *, shell_kind: ShellKind) -> ShellParseResult:
    if shell_kind in {ShellKind.BASH, ShellKind.ZSH, ShellKind.SH}:
        return _parse_posix(command)
    if shell_kind is ShellKind.POWERSHELL:
        return _parse_powershell(command)
    return _parse_cmd(command)


def parse_shell_argv(args: tuple[str, ...], *, shell_kind: ShellKind) -> ShellParseResult:
    if not args or not args[0]:
        return ShellParseResult(ShellParseKind.INVALID, reason="empty command")
    return ShellParseResult(
        ShellParseKind.PLAIN,
        segments=(ShellCommandSegment(words=args),),
    )
```

Implement a small lexical scanner that emits private `_ShellToken(value, quoted)` records so quoted `;`, `|`, `>`, and wildcard characters remain ordinary word content. Follow POSIX single-quote, double-quote, and backslash rules without performing expansion. Accept only unquoted `&&`, `||`, `;`, and `|` as separators. Return `COMPLEX` for unquoted redirection, standalone `&`, grouping, substitutions, expansion, assignments, wildcards, heredocs, and shell keywords. Return `INVALID` for malformed quotes, empty segments, or an empty command.

Track only a leading sequence of literal `cd <path> &&` segments. Normalize accumulated paths with `posixpath.normpath`; do not resolve against the host filesystem and do not rewrite the executed command.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_command_policy.py -q
```

Expected: all parser tests pass.

- [ ] **Step 5: Add complex-syntax regression cases**

```python
import pytest


@pytest.mark.parametrize(
    ("command", "reason"),
    [
        ("echo hello > out.txt", "redirection"),
        ("cat $(resolve-path)", "expansion"),
        ("cat <(generate-input)", "grouping"),
        ("NAME=value command", "assignment"),
        ("cat *.py", "wildcard"),
        ("sleep 1 &", "background"),
        ("for f in files; do cat $f; done", "shell keyword"),
    ],
)
def test_posix_parser_marks_unsupported_syntax_complex(command: str, reason: str) -> None:
    parsed = parse_shell_command(command, shell_kind=ShellKind.BASH)

    assert parsed.kind is ShellParseKind.COMPLEX
    assert parsed.reason == reason
```

- [ ] **Step 6: Run the focused parser suite**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_command_policy.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit the parser**

```bash
git add src/mycli/tools/shell_command_policy.py tests/unit/tools/test_shell_command_policy.py
git commit -m "feat: parse shell commands into safe policy segments"
```

### Task 2: POSIX Positive Safelist

**Files:**
- Modify: `src/mycli/tools/shell_command_policy.py`
- Modify: `tests/unit/tools/test_shell_command_policy.py`

- [ ] **Step 1: Write failing tests for direct and argument-sensitive safe commands**

```python
from mycli.tools.shell_command_policy import (
    ShellCommandDecision,
    classify_shell_command,
)


@pytest.mark.parametrize(
    "command",
    [
        "cat README.md",
        "head -n 20 README.md",
        "tail -n +10 README.md",
        "ls -la",
        "pwd",
        "rg -n approval src",
        "sed -n 10,20p app.py",
        "git status --short",
        "git -C repo diff --stat",
        "find src -name '*.py'",
    ],
)
def test_posix_known_read_commands_are_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.BASH)
    assert result.decision is ShellCommandDecision.SAFE


@pytest.mark.parametrize(
    "command",
    [
        "python script.py",
        "npm install",
        "base64 -o output.txt input.txt",
        "find . -delete",
        "find . -exec rm {} ';'",
        "rg --pre processor pattern",
        "rg --search-zip pattern archive.zip",
        "sed -i s/a/b/ file.txt",
        "git branch new-branch",
    ],
)
def test_unknown_or_mutating_posix_commands_are_not_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.BASH)
    assert result.decision is not ShellCommandDecision.SAFE
```

- [ ] **Step 2: Run the safelist tests and verify RED**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_command_policy.py -q
```

Expected: tests fail because `classify_shell_command` and `ShellCommandDecision` are missing.

- [ ] **Step 3: Implement direct-command and argument-sensitive validators**

Add these public result types:

```python
class ShellCommandDecision(StrEnum):
    SAFE = "safe"
    UNKNOWN = "unknown"
    COMPLEX = "complex"
    INVALID = "invalid"


@dataclass(slots=True, frozen=True)
class ShellCommandClassification:
    decision: ShellCommandDecision
    reason: str
    segments: tuple[ShellCommandSegment, ...]
    command_pattern: str | None = None
```

Implement `classify_shell_command()` and `classify_shell_argv()` by parsing first, then requiring every segment to satisfy the public `is_known_safe_segment()` helper. `RuntimePolicyGate` will reuse this helper in Task 5 so execpolicy and approval classification cannot drift.

Use this exact direct POSIX set:

```python
_POSIX_DIRECT_SAFE = frozenset(
    {
        "cat", "cd", "cut", "echo", "expr", "false", "grep", "head",
        "id", "ls", "nl", "paste", "pwd", "rev", "seq", "stat", "tail",
        "tr", "true", "uname", "uniq", "wc", "which", "whoami",
    }
)
```

Normalize executables with `PurePath(words[0]).name`, map `zsh` wrappers to POSIX handling, and add Linux-only `numfmt` and `tac` when the injected platform string starts with `linux`.

Implement dedicated validators with the same restrictions documented in the spec:

```python
def _safe_base64(words: tuple[str, ...]) -> bool:
    return not any(
        arg in {"-o", "--output"}
        or arg.startswith("--output=")
        or (arg.startswith("-o") and arg != "-o")
        for arg in words[1:]
    )


def _safe_find(words: tuple[str, ...]) -> bool:
    forbidden = {
        "-exec", "-execdir", "-ok", "-okdir", "-delete",
        "-fls", "-fprint", "-fprint0", "-fprintf",
    }
    return not any(arg in forbidden for arg in words[1:])
```

Add explicit validators for `rg`, `sed`, and Git:

```python
def _safe_rg(words: tuple[str, ...]) -> bool:
    unsafe_without_value = {"--search-zip", "-z"}
    unsafe_with_value = {"--pre", "--hostname-bin"}
    return not any(
        arg in unsafe_without_value
        or any(arg == option or arg.startswith(f"{option}=") for option in unsafe_with_value)
        for arg in words[1:]
    )


def _safe_sed(words: tuple[str, ...]) -> bool:
    return (
        3 <= len(words) <= 4
        and words[1] == "-n"
        and re.fullmatch(r"[0-9]+(?:,[0-9]+)?p", words[2]) is not None
    )


def _safe_git(words: tuple[str, ...]) -> bool:
    index = 1
    while index < len(words):
        if words[index] == "-C" and index + 1 < len(words):
            index += 2
            continue
        if words[index] == "--no-pager":
            index += 1
            continue
        break
    if index >= len(words):
        return False
    subcommand = words[index]
    args = words[index + 1 :]
    if any(
        arg in {"--ext-diff", "--textconv", "--output"}
        or arg.startswith("--output=")
        for arg in args
    ):
        return False
    if subcommand in {"status", "log", "diff", "show"}:
        return True
    if subcommand != "branch":
        return False
    if not args:
        return True
    return all(
        arg in {
            "--list", "-l", "--show-current", "-a", "--all", "-r",
            "--remotes", "-v", "-vv", "--verbose",
        }
        or arg.startswith("--format=")
        for arg in args
    )
```

Reject every Git global option other than the explicitly handled `-C <directory>` and `--no-pager` forms. This excludes configuration injection and external-helper execution while accepting `git -C repo diff --stat`.

- [ ] **Step 4: Run safelist tests and verify GREEN**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_command_policy.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Add safe composition and wrapper tests**

```python
@pytest.mark.parametrize(
    "command",
    [
        "cd src && cat app.py",
        "rg -n approval src | head -n 20",
        "false || git status --short",
        "pwd; ls -la",
        "bash -lc 'cd src && sed -n 1,20p app.py'",
    ],
)
def test_all_safe_segments_and_plain_wrappers_are_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.BASH)
    assert result.decision is ShellCommandDecision.SAFE


def test_one_unknown_segment_makes_composed_command_unknown() -> None:
    result = classify_shell_command(
        "cat README.md && python script.py",
        shell_kind=ShellKind.BASH,
    )
    assert result.decision is ShellCommandDecision.UNKNOWN
    assert result.command_pattern == "python script.py"
```

Lower only `bash|zsh|sh -lc <literal-script>` wrappers whose inner body parses as plain syntax. Reject nested wrappers, missing script bodies, additional interpreter flags, and dynamic script bodies as `COMPLEX` or `UNKNOWN`.

- [ ] **Step 6: Run focused tests and commit POSIX classification**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_command_policy.py -q
```

Expected: all tests pass.

Commit:

```bash
git add src/mycli/tools/shell_command_policy.py tests/unit/tools/test_shell_command_policy.py
git commit -m "feat: classify known-safe POSIX shell commands"
```

### Task 3: PowerShell And CMD Positive Safelists

**Files:**
- Modify: `src/mycli/tools/shell_command_policy.py`
- Modify: `tests/unit/tools/test_shell_command_policy.py`
- Modify: `tests/unit/tools/test_shell_safety_adapters.py`

- [ ] **Step 1: Write failing PowerShell and CMD composition tests**

```python
@pytest.mark.parametrize(
    "command",
    [
        "Get-ChildItem -Force | Select-Object Name",
        "Get-Content README.md | Measure-Object -Line",
        "Get-Location; git status --short",
    ],
)
def test_powershell_plain_read_composition_is_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.POWERSHELL)
    assert result.decision is ShellCommandDecision.SAFE


@pytest.mark.parametrize(
    "command",
    [
        "$env:TEMP",
        "Get-Date > date.txt",
        "Get-ChildItem | Where-Object { $_.Length -gt 0 }",
        "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
    ],
)
def test_powershell_dynamic_or_mutating_composition_is_not_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.POWERSHELL)
    assert result.decision is not ShellCommandDecision.SAFE


def test_cmd_plain_read_composition_is_safe() -> None:
    result = classify_shell_command("cd src && dir | findstr py", shell_kind=ShellKind.CMD)
    assert result.decision is ShellCommandDecision.SAFE
```

- [ ] **Step 2: Run Windows classifier tests and verify RED**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_command_policy.py tests/unit/tools/test_shell_safety_adapters.py -q
```

Expected: new composition tests fail because Windows parsing still classifies operators as complex or unsupported.

- [ ] **Step 3: Implement conservative Windows segmentation and safelists**

For PowerShell, retain quote provenance while tokenizing literal words and split only unquoted `|`, `;`, `&&`, and `||`. Mark expansion markers outside single-quoted strings, `@(`, `@{`, `$(`, script blocks, redirection, splatting, the invocation operator, and malformed quotes as complex.

Use these direct safe commands, compared case-insensitively:

```python
_POWERSHELL_DIRECT_SAFE = frozenset(
    {
        "get-location", "get-date", "get-childitem", "get-content",
        "get-command", "test-path",
    }
)
_POWERSHELL_LITERAL_PIPELINE_SAFE = frozenset(
    {"select-object", "sort-object", "measure-object"}
)
```

Allow the pipeline-safe set only when all arguments are literal words and no argument contains a script block or expression. Do not safelist `Where-Object` or `ForEach-Object`. Reuse POSIX native validators for `rg` and Git after case-insensitive executable basename normalization.

For CMD, split plain `&`, `&&`, `||`, and `|`; safelist `cd`, `dir`, `echo`, `type`, `where`, `find`, `findstr`, safe native commands, and read-only Git. Mark `%`, `!`, redirection, grouped commands, and malformed quotes as complex.

- [ ] **Step 4: Run Windows tests and verify GREEN**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_command_policy.py tests/unit/tools/test_shell_safety_adapters.py -q
```

Expected: all tests pass on macOS/Linux without invoking Windows executables.

- [ ] **Step 5: Commit cross-platform classification**

```bash
git add src/mycli/tools/shell_command_policy.py tests/unit/tools/test_shell_command_policy.py tests/unit/tools/test_shell_safety_adapters.py
git commit -m "feat: classify safe Windows shell commands"
```

### Task 4: Strict Approval Fallback And Existing Safety Reasons

**Files:**
- Modify: `src/mycli/tools/shell_safety.py`
- Modify: `src/mycli/tools/shell_safety_adapters.py`
- Modify: `src/mycli/services/approval/safety_policy.py`
- Modify: `tests/unit/tools/test_bash_safety.py`
- Modify: `tests/unit/tools/test_shell_safety_adapters.py`
- Modify: `tests/unit/services/test_safety_policy.py`

- [ ] **Step 1: Change tests to require approval for unknown POSIX commands**

```python
def test_safety_policy_requires_choice_for_unknown_shell_command() -> None:
    decision = SafetyPolicy().evaluate(
        ToolCall(
            name="Bash",
            arguments={"command": "deploy --token supersecret"},
            reason="deploy",
        )
    )

    assert decision.kind is DecisionKind.NEEDS_CHOICE
    assert decision.command_pattern == "deploy --token <redacted>"
    assert "<redacted>" in decision.preview
    assert "supersecret" not in decision.preview


def test_safety_policy_allows_composed_known_safe_commands() -> None:
    decision = SafetyPolicy().evaluate(
        ToolCall(
            name="Shell",
            arguments={"command": "cd src && cat app.py | head -n 20"},
            reason="inspect",
        )
    )
    assert decision.kind is DecisionKind.AUTO_ALLOW
```

Update the old `test_safety_policy_redacts_sensitive_shell_args` expectation from `AUTO_ALLOW` to `NEEDS_CHOICE`. Replace blanket chaining tests with one safe-chain test and one mixed safe/unknown approval test.

- [ ] **Step 2: Run safety tests and verify RED**

Run:

```bash
uv run pytest tests/unit/tools/test_bash_safety.py tests/unit/tools/test_shell_safety_adapters.py tests/unit/services/test_safety_policy.py -q
```

Expected: unknown POSIX commands are still auto-allowed and safe chaining is still rejected.

- [ ] **Step 3: Integrate positive classification into Shell safety analysis**

Refactor `analyze_shell_command()` so its order is:

```python
if empty_or_unicode_control:
    return deny_result
if root_recursive_delete_or_fork_bomb:
    return deny_result
if explicit_dangerous_pattern:
    return confirm_result
classification = classify_shell_command(command, shell_kind=ShellKind.BASH)
if classification.decision is ShellCommandDecision.SAFE:
    return allow_result
return ShellSafetyAnalysis(
    risk_level=ShellRiskLevel.CONFIRM,
    reason=classification.reason,
    preview=redacted_preview,
    command_pattern=classification.command_pattern,
)
```

Remove `_CHAIN_TOKENS` and the blanket chaining branch from `_confirm_reason`. Keep specific reasons for download-to-shell, redirection, recursive `rm`, recursive permission changes, `sudo`, `dd`, Git reset, and Git push.

Update the PowerShell and CMD adapters to consume `classify_shell_command()` rather than maintaining separate permissive or blanket-composition logic. Keep their destructive-head reason mapping for approval messages.

In `SafetyPolicy.evaluate`, call a new `analyze_shell_argv_for_profile(profile, tuple(args))` path for structured `args` instead of converting argv into an executable shell string. Continue using the string path for `command`.

Before storing an unknown command pattern in `ShellSafetyAnalysis`, pass its words through the existing `redact_shell_preview()` logic. Complex and invalid classifications receive `command_pattern=None`, preventing persistent or session allowances from matching ambiguous syntax.

- [ ] **Step 4: Run safety tests and verify GREEN**

Run:

```bash
uv run pytest tests/unit/tools/test_bash_safety.py tests/unit/tools/test_shell_safety_adapters.py tests/unit/services/test_safety_policy.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Verify structured argv remains literal**

Run:

```bash
uv run pytest tests/unit/services/test_safety_policy.py::test_safety_policy_auto_allows_literal_special_chars_in_args -q
```

Expected: PASS; `args=["echo", "a>b"]` remains safe.

- [ ] **Step 6: Commit strict unmatched-command approval**

```bash
git add src/mycli/tools/shell_safety.py src/mycli/tools/shell_safety_adapters.py src/mycli/services/approval/safety_policy.py tests/unit/tools/test_bash_safety.py tests/unit/tools/test_shell_safety_adapters.py tests/unit/services/test_safety_policy.py
git commit -m "feat: require approval for unknown shell commands"
```

### Task 5: Per-Segment Execpolicy Evaluation

**Files:**
- Modify: `src/mycli/application/runtime/tools/runtime_policy.py`
- Modify: `tests/unit/application/test_tool_policy_runtime.py`

- [ ] **Step 1: Write failing tests for mixed rules and safe fallbacks**

Add a gate helper that accepts an `ExecPolicyRuleSet`, then cover these outcomes:

```python
def _shell_gate(workspace_root: Path, *, rule: ExecPolicyRule) -> RuntimePolicyGate:
    return RuntimePolicyGate(
        approval_service=ApprovalService(SafetyPolicy(workspace_root=workspace_root)),
        workspace_root=workspace_root,
        execpolicy_rules=ExecPolicyRuleSet(rules=(rule,)),
    )


def test_allow_rule_for_first_segment_does_not_allow_unknown_second_segment(tmp_path: Path) -> None:
    gate = _shell_gate(
        tmp_path,
        rule=ExecPolicyRule(
            source=ExecPolicySource.PROJECT,
            index=0,
            pattern=("cat",),
            decision=ExecPolicyDecision.ALLOW,
        ),
    )
    decision = gate.decide(
        ToolCall(
            name="Shell",
            arguments={"command": "cat README.md && python script.py"},
            reason="inspect then run",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )
    assert decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL


def test_allow_rule_and_safe_fallback_allow_every_segment(tmp_path: Path) -> None:
    gate = _shell_gate(
        tmp_path,
        rule=ExecPolicyRule(
            source=ExecPolicySource.PROJECT,
            index=0,
            pattern=("python", "-m", "pytest"),
            decision=ExecPolicyDecision.ALLOW,
        ),
    )
    decision = gate.decide(
        ToolCall(
            name="Shell",
            arguments={"command": "python -m pytest -q && git status --short"},
            reason="test then inspect",
        ),
        effect_profile=ToolEffectProfile(process=True),
    )
    assert decision.kind is ToolRuntimeDecisionKind.ALLOWED
```

Also add tests where a second-segment `deny` denies the whole call and a second-segment `ask` requests approval.

- [ ] **Step 2: Run runtime-policy tests and verify RED**

Run:

```bash
uv run pytest tests/unit/application/test_tool_policy_runtime.py tests/unit/domain/runtime/test_execpolicy.py -q
```

Expected: the first-prefix `allow` test incorrectly returns `ALLOWED`, demonstrating the existing whole-call prefix bug.

- [ ] **Step 3: Parse Shell calls once for execpolicy evaluation**

Replace `_shell_command_args()` with a helper that respects structured argv and the active shell profile:

```python
def _parse_shell_call(self, call: ToolCall) -> ShellParseResult:
    shell_kind = self._shell_profile.kind if self._shell_profile else ShellKind.BASH
    args = call.arguments.get("args")
    if isinstance(args, list) and args and all(isinstance(item, str) for item in args):
        return parse_shell_argv(tuple(args), shell_kind=shell_kind)
    command = call.arguments.get("command")
    if isinstance(command, str) and command:
        return parse_shell_command(command, shell_kind=shell_kind)
    return ShellParseResult(ShellParseKind.INVALID, reason="empty command")
```

Evaluate each plain segment in command order:

```python
first_allow: ExecPolicyMatch | None = None
for segment in parsed.segments:
    match = self._execpolicy_rules.match(segment.words)
    if match is None:
        if not is_known_safe_segment(segment, shell_kind=shell_kind):
            return None
        continue
    if match.rule.decision is ExecPolicyDecision.DENY:
        return ToolRuntimeDecision.from_execpolicy_match(
            tool_call=call,
            match=match,
            sandbox=sandbox,
            effect=effect,
        )
    if match.rule.decision is ExecPolicyDecision.ASK:
        return ToolRuntimeDecision.from_execpolicy_match(
            tool_call=call,
            match=match,
            sandbox=sandbox,
            effect=effect,
        )
    first_allow = first_allow or match
return (
    ToolRuntimeDecision.from_execpolicy_match(
        tool_call=call,
        match=first_allow,
        sandbox=sandbox,
        effect=effect,
    )
    if first_allow is not None
    else None
)
```

For `COMPLEX` or `INVALID`, return `None` so strict safety analysis requests approval or denies the malformed call. Do not match prefix rules against partially parsed text.

Keep `ToolRuntimeDecision.from_execpolicy_match()` unchanged and bounded. For an allowed composed call, trace only the first decisive explicit allow match through the existing rule hash, source, index, pattern length, and argument count fields; never include segment words.

- [ ] **Step 4: Run runtime-policy tests and verify GREEN**

Run:

```bash
uv run pytest tests/unit/application/test_tool_policy_runtime.py tests/unit/domain/runtime/test_execpolicy.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Verify sandbox and plan mode still precede rules**

Add or retain assertions that read-only sandbox and plan-mode decisions return before `_execpolicy_decision`, even with an explicit `allow` rule.

Run:

```bash
uv run pytest tests/unit/application/test_tool_policy_runtime.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit per-segment rules**

```bash
git add src/mycli/application/runtime/tools/runtime_policy.py tests/unit/application/test_tool_policy_runtime.py
git commit -m "fix: evaluate shell execpolicy per command segment"
```

### Task 6: Session Allowances And Execution Integration

**Files:**
- Modify: `src/mycli/services/approval/approval_service.py`
- Modify: `tests/unit/services/test_approval_service.py`
- Modify: `tests/unit/application/test_tool_execution_service.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing session-allowance eligibility tests**

```python
def test_session_allowance_approves_matching_simple_unknown_command() -> None:
    service = ApprovalService(
        session_allowances=(
            SessionCommandAllowance(command_pattern="python script.py"),
        )
    )
    outcome = service.evaluate(
        ToolCall(
            name="Shell",
            arguments={"command": "python script.py"},
            reason="run script",
        )
    )
    assert outcome.auto_approved_by == "session_allowance"


def test_complex_command_does_not_match_session_allowance() -> None:
    service = ApprovalService(
        session_allowances=(
            SessionCommandAllowance(command_pattern="echo >"),
        )
    )
    outcome = service.evaluate(
        ToolCall(
            name="Shell",
            arguments={"command": "echo hello > output.txt"},
            reason="write",
        )
    )
    assert outcome.auto_approved is False
    assert outcome.pending_approval is not None
```

- [ ] **Step 2: Run approval tests and verify RED**

Run:

```bash
uv run pytest tests/unit/services/test_approval_service.py -q
```

Expected: at least one new eligibility assertion fails under the old command-pattern behavior.

- [ ] **Step 3: Make only simple unknown classifications session-eligible**

Ensure `ShellSafetyAnalysis.command_pattern` is `None` for `COMPLEX` and `INVALID` parse results. Keep a redacted, bounded command pattern for a single unknown segment. Continue checking shell kind in `_matches_session_allowance()`.

Retain the existing `DENY` check before session allowances:

```python
safety = self._safety_policy.evaluate(call)
if safety.kind is DecisionKind.DENY:
    return ApprovalOutcome(denied_reason=safety.reason, safety_metadata=safety.metadata)
if self._matches_session_allowance(call, safety.command_pattern):
    return ApprovalOutcome(
        auto_approved=True,
        auto_approved_by="session_allowance",
        command_pattern=safety.command_pattern,
        reason=safety.reason,
        safety_metadata=safety.metadata,
    )
```

- [ ] **Step 4: Add execution-service regressions**

Cover the real execution boundary:

```python
def test_unknown_shell_command_suspends_before_tool_execution(tmp_path: Path) -> None:
    service, fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        policy_gate=RuntimePolicyGate(
            approval_service=ApprovalService(SafetyPolicy(workspace_root=tmp_path)),
        ),
    )
    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="Shell",
            arguments={"command": "python script.py"},
            reason="run",
            call_id="call_shell_unknown",
        ),
        tool_router=service._test_router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_unknown",
        activity_events=[],
        turn_items=[],
    )
    assert fake_tool.seen_arguments == []
```

Retain the existing explicit Python `allow` execution test and add a composed explicit-allow plus safe-fallback execution case. Assert trace payloads contain the existing decision and hashed rule metadata but no raw command or secret token.

- [ ] **Step 5: Run approval and execution integration tests**

Run:

```bash
uv run pytest tests/unit/services/test_approval_service.py tests/unit/application/test_tool_execution_service.py tests/unit/application/test_agent_runtime.py -q
```

Expected: all tests pass, including approval resume exactly once.

- [ ] **Step 6: Commit allowance and execution integration**

```bash
git add src/mycli/services/approval/approval_service.py tests/unit/services/test_approval_service.py tests/unit/application/test_tool_execution_service.py tests/unit/application/test_agent_runtime.py
git commit -m "test: verify strict shell approval integration"
```

### Task 7: Full Verification And Compatibility Audit

**Files:**
- Modify only files required to fix failures caused by this feature.

- [ ] **Step 1: Run all focused policy suites together**

```bash
uv run pytest \
  tests/unit/tools/test_shell_command_policy.py \
  tests/unit/tools/test_bash_safety.py \
  tests/unit/tools/test_shell_safety_adapters.py \
  tests/unit/services/test_safety_policy.py \
  tests/unit/services/test_approval_service.py \
  tests/unit/domain/runtime/test_execpolicy.py \
  tests/unit/application/test_tool_policy_runtime.py \
  tests/unit/application/test_tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py \
  -q
```

Expected: all focused tests pass.

- [ ] **Step 2: Run Python quality gates**

```bash
uv run ruff check .
uv run mypy src
```

Expected: Ruff reports no violations and Mypy reports success.

- [ ] **Step 3: Run the full Python suite**

```bash
uv run pytest -q
```

Expected: the full suite passes. Existing platform skips remain skips; no new unexpected skips or warnings are introduced.

- [ ] **Step 4: Run Node TUI regressions**

```bash
cd coding-agent
npm run typecheck
npm test
```

Expected: TypeScript passes and all Node TUI tests pass. No TUI source changes should be necessary because approval and Shell lifecycle event contracts remain unchanged.

- [ ] **Step 5: Audit diff and policy traces**

```bash
git diff --check
git status --short
git diff --stat HEAD~6..HEAD
```

Expected: no whitespace errors; only planned source, test, spec, and plan files appear. Confirm `.codex/config.toml` and the pre-existing unified-shell implementation-plan edits remain uncommitted and untouched.

- [ ] **Step 6: Commit any verification-only corrections**

Only when Step 2 through Step 4 required a compatibility correction:

```bash
git add \
  src/mycli/tools/shell_command_policy.py \
  src/mycli/tools/shell_safety.py \
  src/mycli/tools/shell_safety_adapters.py \
  src/mycli/services/approval/safety_policy.py \
  src/mycli/services/approval/approval_service.py \
  src/mycli/application/runtime/tools/runtime_policy.py \
  tests/unit/tools/test_shell_command_policy.py \
  tests/unit/tools/test_bash_safety.py \
  tests/unit/tools/test_shell_safety_adapters.py \
  tests/unit/services/test_safety_policy.py \
  tests/unit/services/test_approval_service.py \
  tests/unit/application/test_tool_policy_runtime.py \
  tests/unit/application/test_tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py
git commit -m "fix: preserve shell approval compatibility"
```

If no correction was needed, do not create an empty commit.

## Completion Criteria

- Safe POSIX, PowerShell, and CMD commands auto-run only when every segment is proven safe or explicitly allowed.
- Unknown and complex commands produce a pending approval instead of permissive execution.
- Explicit `allow`, `ask`, and `deny` rules operate per segment with existing source precedence.
- Sandbox and plan-mode restrictions remain stronger than execpolicy and safelist decisions.
- Session allowances remain shell-scoped and cannot approve malformed, complex, or denied calls.
- Runtime traces remain bounded and exclude raw commands.
- Unified Shell execution, background sessions, `WriteStdin`, live TUI output, and resume behavior remain unchanged.
- Focused tests, full Python tests, Ruff, Mypy, TypeScript, and Node tests all pass.
