from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.application.runtime.tools.tool_orchestrator import ToolOrchestrator
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.domain.subagents import SubAgentResult
from mycli.domain.tooling.calls import ToolCall
from mycli.services.diagnostics.doctor import DoctorService, DoctorStatus
from mycli.services.extensions import ExtensionManifestService
from mycli.services.subagents import SubAgentToolContributionProvider
from mycli.services.tracing import TraceService
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_exposure_planner import ToolExposurePlanner


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "evaluation" / "runs"


class FakeSubAgentService:
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
            status="completed",
            report=(
                f'<sub-agent-report agent="{agent_type}" status="completed" '
                'child_session_id="subagent-smoke:sub:turn_1:abcd1234">ok</sub-agent-report>'
            ),
            child_session_id="subagent-smoke:sub:turn_1:abcd1234",
            tool_calls=1,
        )


def main() -> int:
    report = {
        "run_id": f"subagent-smoke-{datetime.now(tz=UTC).strftime('%Y%m%dT%H%M%SZ')}",
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    with tempfile.TemporaryDirectory(prefix="mycli-subagent-smoke-") as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        home = root / "home"
        workspace.mkdir()
        home.mkdir()

        service = FakeSubAgentService()
        provider = SubAgentToolContributionProvider(service=service)
        registrations = provider.provide(
            user_message="map docs",
            conversation=Conversation(session_id="subagent-smoke"),
            plan_state=PlanState(),
        )
        manifest = ExtensionManifestService(contributed_tools=registrations).manifest()
        tool_registry = ToolRegistry(specs={}, executors={})
        contribution_registry = ToolContributionRegistry()
        orchestrator = ToolOrchestrator(
            session_id="subagent-smoke",
            tool_registry=tool_registry,
            tool_exposure_planner=ToolExposurePlanner(tool_registry=tool_registry),
            contributed_tool_registry=contribution_registry,
            contributed_tool_providers=(provider,),
            trace_service=TraceService(root / "traces"),
            append_turn_item=lambda **_kwargs: None,
        )
        planned = orchestrator.plan_tool_exposure(
            user_message="map docs",
            conversation=Conversation(session_id="subagent-smoke"),
            plan_state=PlanState(),
        )
        router = orchestrator.build_tool_router(planned)
        result = router.execute(
            ToolCall(
                name="subagent.explore",
                arguments={
                    "description": "Map docs and tests",
                    "allowed_tools": ["Read", "Grep"],
                },
                reason="Subagent smoke",
            ),
            exposure=planned.exposure,
        )
        lifecycle = [event.state.value for event in (*planned.lifecycle_events, *router.pop_lifecycle_events())]
        doctor = DoctorService(
            workspace_root=workspace,
            home_dir=home,
            env={},
            which=lambda _command: None,
            import_checker=lambda _module: False,
        ).run()
        subagent_check = next(check for check in doctor.checks if check.name == "subagents")
        tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
        toolsets = {toolset["id"]: toolset for toolset in manifest["toolset_manifest"]["toolsets"]}
        report.update(
            {
                "success": (
                    tools["subagent.explore"]["source"] == "subagent"
                    and "subagent.explore" in toolsets["external"]["tools"]
                    and result.success
                    and result.summary == "Sub-agent explore completed with status completed."
                    and service.calls
                    and service.calls[0]["agent_type"] == "explore"
                    and lifecycle
                    == [
                        "declared",
                        "declared",
                        "declared",
                        "exposed",
                        "exposed",
                        "exposed",
                        "invoked",
                        "completed",
                    ]
                    and subagent_check.status is DoctorStatus.OK
                    and "3 profiles" in subagent_check.message
                    and "Map docs and tests" not in (subagent_check.detail or "")
                ),
                "checks": {
                    "manifest_source": tools["subagent.explore"]["source"],
                    "route": "subagent.explore",
                    "toolset_sources": toolsets["external"]["sources"],
                    "runtime_summary": result.summary,
                    "service_call": service.calls[0] if service.calls else {},
                    "lifecycle": lifecycle,
                    "doctor_status": subagent_check.status.value,
                    "doctor_message": subagent_check.message,
                    "doctor_detail": subagent_check.detail,
                },
            }
        )

    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    output_path = RUNS_ROOT / f"{report['run_id']}.json"
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(output_path)
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
