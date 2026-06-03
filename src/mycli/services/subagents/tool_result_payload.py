from __future__ import annotations

from mycli.domain.subagents import SubAgentResult


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
        "artifacts": subagent_tool_artifacts(result),
        "report": result.report,
        "content": result.report,
    }
