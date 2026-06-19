from __future__ import annotations

import json
import tempfile
from pathlib import Path

from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.application.runtime.tools.tool_orchestrator import ToolOrchestrator
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.domain.subagents import SubAgentResult
from mycli.domain.tooling.calls import ToolCall
from mycli.services.subagents import SubAgentProfileRegistry, SubAgentToolContributionProvider
from mycli.services.tracing import TraceService
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_exposure_planner import ToolExposurePlanner


class ProbeSubAgentService:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
        mode: str = "sync",
    ) -> SubAgentResult:
        self.calls.append(
            {
                "description": description,
                "agent_type": agent_type,
                "allowed_tools": allowed_tools,
                "mode": mode,
            }
        )
        return SubAgentResult(
            status="running",
            report=f'<sub-agent-report agent="{agent_type}" status="running">probe</sub-agent-report>',
            child_session_id=f"probe:{agent_type}:child",
            tool_calls=0,
        )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mycli-subagent-probe-") as temp_dir:
        root = Path(temp_dir)
        workspace = root / "workspace"
        home = root / "home"
        agent_dir = workspace / ".mycli" / "agents"
        agent_dir.mkdir(parents=True)
        home.mkdir()
        agent_dir.joinpath("probe-reviewer.md").write_text(
            "\n".join(
                [
                    "---",
                    "name: probe-reviewer",
                    "description: Review probe changes.",
                    "tools: Read, Grep",
                    "maxTurns: 4",
                    "---",
                    "You review probe changes and report concise findings.",
                ]
            ),
            encoding="utf-8",
        )

        registry = SubAgentProfileRegistry(workspace_root=workspace, home_dir=home)
        discovery = registry.discover()
        profiles = registry.list_profiles()
        service = ProbeSubAgentService()
        provider = SubAgentToolContributionProvider(
            service=service,
            list_profiles=lambda: profiles,
        )
        tool_registry = ToolRegistry(specs={}, executors={})
        orchestrator = ToolOrchestrator(
            session_id="probe-session",
            tool_registry=tool_registry,
            tool_exposure_planner=ToolExposurePlanner(tool_registry=tool_registry),
            contributed_tool_registry=ToolContributionRegistry(),
            contributed_tool_providers=(provider,),
            trace_service=TraceService(root / "traces"),
            append_turn_item=lambda **_kwargs: None,
        )
        planned = orchestrator.plan_tool_exposure(
            user_message="probe custom subagent exposure",
            conversation=Conversation(session_id="probe-session"),
            plan_state=PlanState(),
        )
        registration = planned.contributed_tools.get("subagent_probe_reviewer")
        router = orchestrator.build_tool_router(planned)
        first_result = router.execute(
            ToolCall(
                name="subagent_probe_reviewer",
                arguments={
                    "description": "Review the probe profile path and report whether it is loaded.",
                    "allowed_tools": ["Read", "Grep"],
                },
                reason="Probe custom markdown subagent routing.",
            ),
            exposure=planned.exposure,
        )
        second_result = router.execute(
            ToolCall(
                name="subagent_explore",
                arguments={
                    "description": "Explore the probe workspace independently and summarize files.",
                    "allowed_tools": ["Read", "Glob"],
                },
                reason="Probe parallel-style builtin subagent routing.",
            ),
            exposure=planned.exposure,
        )
        profile_record = next(
            (record for record in discovery.records if record.profile_id == "probe-reviewer"),
            None,
        )
        description = registration.descriptor.spec.description if registration is not None else ""
        background_calls = [call for call in service.calls if call["mode"] == "background"]
        payload = {
            "ok": (
                registration is not None
                and profile_record is not None
                and not discovery.issues
                and first_result.success
                and second_result.success
                and len(background_calls) == 2
            ),
            "profile_loaded": profile_record is not None and profile_record.status == "enabled",
            "profile_source_path": profile_record.source_path if profile_record is not None else "",
            "tool_exposed": registration is not None,
            "tool_name": registration.descriptor.spec.name if registration is not None else "",
            "background_task_calls": len(background_calls),
            "guidance": {
                "background": "background" in description,
                "self_contained": "self-contained" in description,
            },
            "issues": [issue.safe_line() for issue in discovery.issues],
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
