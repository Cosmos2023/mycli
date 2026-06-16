from __future__ import annotations

from mycli.domain.subagents import SubAgentResult

BACKGROUND_SUBAGENT_NOTIFICATION_GUIDANCE = (
    "The sub-agent is working in the background. You will be notified "
    "automatically when it completes via <task-notification>; do not call "
    "SubagentOutput to poll for progress unless the user explicitly asks."
)


def subagent_tool_artifacts(result: SubAgentResult) -> dict[str, object]:
    return {
        "subagent_report": result.report,
        "child_session_id": result.child_session_id,
        "context_diagnostics": dict(result.context_diagnostics),
    }


def subagent_tool_payload(
    *,
    profile: str,
    result: SubAgentResult,
) -> dict[str, object]:
    run_id = result.child_session_id
    report = result.report
    if result.status == "running":
        report = f"{result.report}\n\n{BACKGROUND_SUBAGENT_NOTIFICATION_GUIDANCE}"
    return {
        "kind": "sub_agent_report",
        "profile": profile,
        "run_id": run_id,
        "trace": {
            "run_id": run_id,
            "child_session_id": result.child_session_id,
            "status": result.status,
            "tool_calls": result.tool_calls,
            "context": dict(result.context_diagnostics),
        },
        "status": result.status,
        "child_session_id": result.child_session_id,
        "tool_calls": result.tool_calls,
        "artifacts": {
            **subagent_tool_artifacts(result),
            "subagent_report": report,
        },
        "report": report,
        "content": report,
    }
