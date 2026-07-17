from __future__ import annotations

import pytest

from mycli.domain.runtime import (
    ExecPolicyDecision,
    ExecPolicyRule,
    ExecPolicyRuleSet,
    ExecPolicySource,
    ShellKind,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.services.execpolicy_proposals import ExecPolicyProposalValidator


def _call(
    command: str,
    proposal: object,
    *,
    name: str = "Shell",
) -> ToolCall:
    return ToolCall(
        name=name,
        arguments={"command": command, "prefix_rule": proposal},
        reason="run tests",
        call_id="call_shell_1",
    )


def _validate(
    command: str,
    proposal: object,
    *,
    shell_kind: ShellKind = ShellKind.BASH,
    rules: ExecPolicyRuleSet | None = None,
    approval_policy: str = "shell_command_analysis",
    name: str = "Shell",
):
    return ExecPolicyProposalValidator().validate(
        call=_call(command, proposal, name=name),
        shell_kind=shell_kind,
        rules=rules or ExecPolicyRuleSet(),
        approval_policy=approval_policy,
    )


def test_accepts_narrow_prefix_for_unknown_segment() -> None:
    result = _validate(
        "python -m pytest -q",
        ["python", "-m", "pytest"],
    )

    assert result.pattern == ("python", "-m", "pytest")
    assert result.rejection_reason is None


def test_accepts_only_the_unknown_segment_in_plain_composite() -> None:
    result = _validate(
        "pwd && python -m pytest -q",
        ["python", "-m", "pytest"],
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
    result = _validate(command, proposal)

    assert result.pattern is None
    assert result.rejection_reason


@pytest.mark.parametrize(
    ("command", "proposal"),
    [
        ("python script.py", ["python"]),
        ("/usr/bin/python3 -c pass", ["/usr/bin/python3", "-c"]),
        ("/usr/bin/python3.13 -c pass", ["/usr/bin/python3.13", "-c"]),
        ("node app.js", ["node"]),
        ("bash -lc make", ["bash", "-lc"]),
        ("sudo make install", ["sudo"]),
    ],
)
def test_rejects_broad_prefixes(command: str, proposal: object) -> None:
    result = _validate(command, proposal)

    assert result.pattern is None


@pytest.mark.parametrize(
    ("command", "proposal", "shell_kind"),
    [
        ("rm build.txt", ["rm"], ShellKind.BASH),
        ("git reset --hard HEAD", ["git", "reset", "--hard"], ShellKind.BASH),
        ("git clean -fd", ["git", "clean"], ShellKind.BASH),
        ("git push --force origin main", ["git", "push", "--force"], ShellKind.BASH),
        ("chmod -R 777 build", ["chmod", "-R"], ShellKind.BASH),
        (
            "Remove-Item -Recurse build",
            ["Remove-Item", "-Recurse"],
            ShellKind.POWERSHELL,
        ),
    ],
)
def test_rejects_destructive_prefixes(
    command: str,
    proposal: object,
    shell_kind: ShellKind,
) -> None:
    result = _validate(command, proposal, shell_kind=shell_kind)

    assert result.pattern is None


@pytest.mark.parametrize(
    ("command", "proposal"),
    [
        ("tool --token abc123", ["tool", "--token", "abc123"]),
        ("env API_KEY=abc tool", ["env", "API_KEY=abc"]),
        ("tool password=abc", ["tool", "password=abc"]),
        ("tool '<redacted>'", ["tool", "<redacted>"]),
    ],
)
def test_rejects_sensitive_prefixes(command: str, proposal: object) -> None:
    result = _validate(command, proposal)

    assert result.pattern is None


@pytest.mark.parametrize("decision", [ExecPolicyDecision.ASK, ExecPolicyDecision.DENY])
def test_rejects_explicit_project_ask_and_deny(decision: ExecPolicyDecision) -> None:
    rules = ExecPolicyRuleSet(
        rules=(
            ExecPolicyRule(
                source=ExecPolicySource.PROJECT,
                index=0,
                pattern=("python", "-m", "pytest"),
                decision=decision,
            ),
        )
    )

    result = _validate(
        "python -m pytest -q",
        ["python", "-m", "pytest"],
        rules=rules,
    )

    assert result.pattern is None


def test_rejects_ineligible_policy_source_and_legacy_alias() -> None:
    explicit_ask = _validate(
        "python -m pytest",
        ["python", "-m", "pytest"],
        approval_policy="execpolicy_prefix_rule",
    )
    legacy = _validate(
        "python -m pytest",
        ["python", "-m", "pytest"],
        name="Bash",
    )

    assert explicit_ask.pattern is None
    assert legacy.pattern is None


@pytest.mark.parametrize(
    "proposal",
    [
        ["tool", *(f"arg-{index}" for index in range(16))],
        ["tool", "x" * 257],
        ["tool", *("x" * 40 for _ in range(13))],
    ],
)
def test_rejects_oversized_proposals(proposal: list[str]) -> None:
    result = _validate(" ".join(proposal), proposal)

    assert result.pattern is None
