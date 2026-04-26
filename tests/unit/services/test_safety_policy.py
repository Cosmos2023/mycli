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


def test_safety_policy_auto_allows_benign_shell_command() -> None:
    decision = SafetyPolicy().evaluate(
        ToolCall(name="run_shell", arguments={"args": ["echo", "hello"]}, reason="greet")
    )
    assert decision.kind is DecisionKind.AUTO_ALLOW
    assert decision.command_pattern == "echo hello"
    assert decision.preview == "echo hello"


def test_safety_policy_redacts_sensitive_shell_args() -> None:
    decision = SafetyPolicy().evaluate(
        ToolCall(
            name="run_shell",
            arguments={"args": ["deploy", "--token", "supersecret"]},
            reason="deploy",
        )
    )
    assert decision.kind is DecisionKind.AUTO_ALLOW
    assert "<redacted>" in decision.preview
    assert "supersecret" not in decision.preview
