from mycli.domain.tools import ToolCall
from mycli.services.approval.approval_service import ApprovalService


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


def test_approval_service_denies_rm_rf_root() -> None:
    service = ApprovalService()

    decision = service.evaluate(
        ToolCall(name="Bash", arguments={"command": "rm -rf /"}, reason="cleanup")
    )

    assert decision.denied_reason == "rm -rf / is forbidden"
    assert decision.pending_approval is None
