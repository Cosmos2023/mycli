from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.application.runtime.tools.tool_orchestrator import ToolOrchestrator
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.domain.tooling.calls import ToolCall
from mycli.services.diagnostics.doctor import DoctorService, DoctorStatus
from mycli.services.extensions import ExtensionManifestService
from mycli.services.skills import SkillRegistry, SkillToolContributionProvider
from mycli.services.tracing import TraceService
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_exposure_planner import ToolExposurePlanner


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "evaluation" / "runs"
SKILL_ROUTE = "skill_data_helper"
LEGACY_SKILL_ROUTE = "skill.data-helper"


def main() -> int:
    report = {
        "run_id": f"skill-smoke-{datetime.now(tz=UTC).strftime('%Y%m%dT%H%M%SZ')}",
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    with tempfile.TemporaryDirectory(prefix="mycli-skill-smoke-") as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        home = root / "home"
        builtin_root = root / "builtin"
        repo_root = workspace / ".mycli" / "skills"
        user_root = home / ".mycli" / "skills"
        _write_skill(builtin_root, "code-review", "Builtin review", "Builtin body")
        _write_skill(repo_root, "data-helper", "Analyze local CSV data", "Do not invent numbers.")
        user_root.mkdir(parents=True)
        (user_root / "broken.md").write_text("not frontmatter", encoding="utf-8")

        registry = SkillRegistry(builtin_root=builtin_root, user_root=user_root, repo_root=repo_root)
        diagnostics = registry.diagnostics()
        provider = SkillToolContributionProvider(registry)
        registrations = provider.provide(
            user_message="summarize csv",
            conversation=Conversation(session_id="skill-smoke"),
            plan_state=PlanState(),
        )
        manifest = ExtensionManifestService(contributed_tools=registrations).manifest()
        tool_registry = ToolRegistry(specs={}, executors={})
        contribution_registry = ToolContributionRegistry()
        orchestrator = ToolOrchestrator(
            session_id="skill-smoke",
            tool_registry=tool_registry,
            tool_exposure_planner=ToolExposurePlanner(tool_registry=tool_registry),
            contributed_tool_registry=contribution_registry,
            contributed_tool_providers=(provider,),
            trace_service=TraceService(root / "traces"),
            append_turn_item=lambda **_kwargs: None,
        )
        planned = orchestrator.plan_tool_exposure(
            user_message="summarize csv",
            conversation=Conversation(session_id="skill-smoke"),
            plan_state=PlanState(),
        )
        router = orchestrator.build_tool_router(planned)
        result = router.execute(
            ToolCall(
                name=SKILL_ROUTE,
                arguments={"reason": "Need CSV analysis guardrails"},
                reason="Skill smoke",
            ),
            exposure=planned.exposure,
        )
        legacy_result = router.execute(
            ToolCall(
                name=LEGACY_SKILL_ROUTE,
                arguments={"reason": "Legacy dotted route compatibility"},
                reason="Skill smoke legacy route",
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
        skill_check = next(check for check in doctor.checks if check.name == "skills")
        tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
        toolsets = {toolset["id"]: toolset for toolset in manifest["toolset_manifest"]["toolsets"]}
        report.update(
            {
                "success": (
                    diagnostics.loaded_count == 2
                    and diagnostics.issue_count == 1
                    and tools[SKILL_ROUTE]["source"] == "skill"
                    and SKILL_ROUTE in toolsets["external"]["tools"]
                    and result.success
                    and legacy_result.success
                    and result.summary == "Activated skill: data-helper"
                    and lifecycle == [
                        "declared",
                        "declared",
                        "exposed",
                        "exposed",
                        "invoked",
                        "completed",
                        "invoked",
                        "completed",
                    ]
                    and skill_check.status is DoctorStatus.WARNING
                    and "SECRET" not in (skill_check.detail or "")
                ),
                "checks": {
                    "loaded_count": diagnostics.loaded_count,
                    "issue_count": diagnostics.issue_count,
                    "manifest_source": tools[SKILL_ROUTE]["source"],
                    "route": SKILL_ROUTE,
                    "legacy_route": LEGACY_SKILL_ROUTE,
                    "toolset_sources": toolsets["external"]["sources"],
                    "runtime_summary": result.summary,
                    "legacy_runtime_summary": legacy_result.summary,
                    "lifecycle": lifecycle,
                    "doctor_status": skill_check.status.value,
                    "doctor_message": skill_check.message,
                    "doctor_detail": skill_check.detail,
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


def _write_skill(root: Path, name: str, description: str, body: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{name}.md").write_text(
        "---\n"
        f'name = "{name}"\n'
        f'description = "{description}"\n'
        'trigger_hints = ["data", "review"]\n'
        "---\n"
        f"{body}\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())
