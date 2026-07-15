from __future__ import annotations

from mycli.domain.subagents import SubAgentResult
from mycli.domain.tooling.output import ToolModelOutput

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


def subagent_tool_model_output(
    *,
    profile: str,
    payload: dict[str, object],
    success: bool,
) -> ToolModelOutput:
    child_session_id = str(payload.get("child_session_id") or "")
    status = str(payload.get("status") or "unknown")
    tool_calls = payload.get("tool_calls")
    report = str(payload.get("report") or "")
    lines = [
        f"Sub-agent: {profile}",
        f"Child session: {child_session_id}",
        f"Status: {status}",
        f"Tool calls: {tool_calls if isinstance(tool_calls, int) else 0}",
    ]
    if report:
        lines.extend(("Report:", report))
    return ToolModelOutput.from_text("\n".join(lines), success=success)
