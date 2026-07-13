from pathlib import Path

from mycli.domain.runtime import (
    PowerShellEdition,
    SessionCommandAllowance,
    ShellKind,
    ShellProfile,
)
from mycli.domain.tools import ToolCall
from mycli.services.approval.approval_service import ApprovalService
from mycli.services.safety_policy import SafetyPolicy


def test_approval_service_suspends_git_push_with_command_pattern() -> None:
    service = ApprovalService()

    decision = service.evaluate(
        ToolCall(
            name="run_shell",
            arguments={"args": ["git", "push", "origin", "main"]},
            reason="publish branch",
        )
    )

    assert decision.pending_approval is not None
    assert decision.pending_approval.command_pattern == "git push"
    assert decision.pending_approval.reason == "git push requires confirmation."
    assert decision.safety_metadata == {
        "tool_name": "run_shell",
        "canonical_tool_name": "Shell",
        "risk_level": "high",
        "decision_kind": "needs_choice",
        "policy": "shell_command_analysis",
        "command_pattern": "git push",
    }


def test_approval_service_denies_rm_rf_root() -> None:
    service = ApprovalService()

    decision = service.evaluate(
        ToolCall(name="Bash", arguments={"command": "rm -rf /"}, reason="cleanup")
    )

    assert decision.denied_reason == "rm -rf / is forbidden"
    assert decision.pending_approval is None
    assert decision.safety_metadata is not None
    assert decision.safety_metadata["policy"] == "shell_command_analysis"
    assert decision.safety_metadata["decision_kind"] == "deny"
    assert decision.safety_metadata["command_pattern"] == "rm -rf"


def test_approval_service_denies_even_when_session_allowance_matches() -> None:
    service = ApprovalService(
        session_allowances=(SessionCommandAllowance(command_pattern="rm -rf /"),)
    )

    outcome = service.evaluate(
        ToolCall(
            name="Bash",
            arguments={"command": "rm -rf /"},
            reason="cleanup",
        )
    )

    assert outcome.denied_reason is not None
    assert outcome.auto_approved is False


def test_approval_service_marks_session_allowance_auto_approval() -> None:
    service = ApprovalService(
        session_allowances=(SessionCommandAllowance(command_pattern="git push"),)
    )

    outcome = service.evaluate(
        ToolCall(
            name="Bash",
            arguments={"command": "git push origin main"},
            reason="publish branch",
            call_id="call_push_1",
        )
    )

    assert outcome.auto_approved is True
    assert outcome.auto_approved_by == "session_allowance"
    assert outcome.command_pattern == "git push"
    assert outcome.reason == "git push requires confirmation."
    assert outcome.safety_metadata == {
        "tool_name": "Bash",
        "canonical_tool_name": "Shell",
        "risk_level": "high",
        "decision_kind": "needs_choice",
        "policy": "shell_command_analysis",
        "command_pattern": "git push",
    }


def test_session_allowance_matches_only_same_shell_kind() -> None:
    service = ApprovalService(
        safety_policy=SafetyPolicy(
            shell_profile=ShellProfile(
                ShellKind.POWERSHELL,
                Path("pwsh.exe"),
                PowerShellEdition.CORE,
            )
        ),
        session_allowances=(
            SessionCommandAllowance(
                command_pattern="git push",
                shell_kind=ShellKind.BASH,
            ),
        ),
    )

    outcome = service.evaluate(
        ToolCall(
            name="Shell",
            arguments={"command": "git push origin main"},
            reason="publish branch",
        )
    )

    assert outcome.auto_approved_by != "session_allowance"
    assert outcome.pending_approval is not None


def test_approval_service_suspends_medium_risk_write_when_strict() -> None:
    service = ApprovalService(
        safety_policy=SafetyPolicy(auto_approve_medium=False),
    )

    outcome = service.evaluate(
        ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "hello"},
            reason="write file",
            call_id="call_write_1",
        )
    )

    assert outcome.pending_approval is not None
    assert outcome.pending_approval.command_pattern is None
    assert outcome.pending_approval.preview == "notes.txt"
    assert outcome.pending_approval.metadata["content_preview"] == "hello"
    assert outcome.safety_metadata == {
        "tool_name": "Write",
        "canonical_tool_name": "Write",
        "risk_level": "medium",
        "decision_kind": "needs_choice",
        "policy": "medium_risk_requires_approval",
        "content_preview": "hello",
        "content_line_count": 1,
        "content_chars": 5,
        "content_truncated": False,
    }
