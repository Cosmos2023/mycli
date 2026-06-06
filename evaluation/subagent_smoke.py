from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.application.runtime.subagents.service import SubAgentService
from mycli.cli.main import handle_subagents_command
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import BaselineFragment, ContextBaseline, PlanState
from mycli.domain.subagents import SubAgentResult
from mycli.services.diagnostics.doctor import DoctorService, DoctorStatus
from mycli.services.extensions import ExtensionManifestService
from mycli.services.subagents import SubAgentProfileRegistry, SubAgentToolContributionProvider
from mycli.tools.task import TaskTool


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "evaluation" / "runs"


class FakeChildLoop:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def run(self, **kwargs) -> SubAgentResult:
        self.calls.append(kwargs)
        return SubAgentResult(
            status="completed",
            report="profile completed",
            child_session_id=str(kwargs["child_session_id"]),
            tool_calls=1,
        )


def main() -> int:
    report = {
        "run_id": f"subagent-smoke-{datetime.now(tz=UTC).strftime('%Y%m%dT%H%M%SZ')}",
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    with tempfile.TemporaryDirectory(prefix="mycli-subagent-smoke-") as tmp:
        workspace = Path(tmp) / "workspace"
        home = Path(tmp) / "home"
        profile_dir = workspace / ".mycli" / "subagents"
        profile_dir.mkdir(parents=True)
        home.mkdir()
        _write_profiles(profile_dir)

        registry = SubAgentProfileRegistry(workspace_root=workspace, home_dir=home)
        discovery = registry.discover()
        list_output: list[str] = []
        inspect_output: list[str] = []
        list_code = handle_subagents_command(
            {"command": "subagents", "utility_args": ["list"], "json_output": True},
            cwd=workspace,
            home=home,
            output_func=list_output.append,
        )
        inspect_code = handle_subagents_command(
            {"command": "subagents", "utility_args": ["inspect", "analyst"], "json_output": True},
            cwd=workspace,
            home=home,
            output_func=inspect_output.append,
        )
        loop = FakeChildLoop()
        service = SubAgentService(
            session_id="smoke",
            turn_id_provider=lambda: "turn_1",
            parent_tool_names=lambda: ("Read", "Grep", "Bash", "Task"),
            child_loop=loop,
            profile_lookup=registry.get_profile,
            context_baseline_provider=lambda: ContextBaseline(
                thread_id="smoke",
                fragments=(
                    BaselineFragment(
                        id="developer:1",
                        kind="workspace_instructions",
                        title="Workspace",
                        content="Use repo-local docs and keep reports concise.",
                        source="smoke",
                    ),
                ),
            ),
            memory_fence_provider=lambda: "Preference: cite inspected files.",
            session_summary_provider=lambda: "Parent session is evaluating subagent fork context.",
        )
        task_result = TaskTool(service=service).execute(
            {
                "description": "Analyze docs",
                "agent_type": "analyst",
                "allowed_tools": ["Read", "Grep", "Bash"],
            }
        )
        disabled_result = TaskTool(service=service).execute(
            {
                "description": "Should fail",
                "agent_type": "disabled",
                "allowed_tools": ["Read"],
            }
        )
        provider = SubAgentToolContributionProvider(service=service, list_profiles=registry.list_profiles)
        manifest = ExtensionManifestService(
            contributed_tools=provider.provide(
                user_message="delegate",
                conversation=Conversation(session_id="smoke"),
                plan_state=PlanState(),
            )
        ).manifest()
        tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
        doctor_report = DoctorService(
            workspace_root=workspace,
            home_dir=home,
            env={},
            which=lambda _command: None,
            import_checker=lambda _module: False,
        ).run()
        subagent_check = next(check for check in doctor_report.checks if check.name == "subagents")
        listed = json.loads(list_output[0])
        inspected = json.loads(inspect_output[0])

        report.update(
            {
                "success": (
                    list_code == 0
                    and inspect_code == 0
                    and discovery.enabled_count >= 1
                    and listed["ok"] is True
                    and inspected["profile"]["profile_id"] == "analyst"
                    and task_result.success is True
                    and disabled_result.success is False
                    and loop.calls[0]["tool_names"] == ("Read", "Grep")
                    and loop.calls[0]["context_snapshot"].diagnostics["tool_count"] == 2
                    and task_result.raw_payload["trace"]["context"]["baseline_fragment_count"] == 1
                    and tools["subagent_analyst"]["source"] == "subagent"
                    and tools["subagent_analyst"]["risk_level"] == "medium"
                    and subagent_check.status is DoctorStatus.OK
                ),
                "checks": {
                    "list_code": list_code,
                    "inspect_code": inspect_code,
                    "enabled_count": discovery.enabled_count,
                    "task_success": task_result.success,
                    "task_summary": task_result.summary,
                    "disabled_success": disabled_result.success,
                    "tool_names": loop.calls[0]["tool_names"],
                    "context_diagnostics": task_result.raw_payload["trace"]["context"],
                    "manifest_source": tools["subagent_analyst"]["source"],
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


def _write_profiles(profile_dir: Path) -> None:
    profile_dir.joinpath("analyst.toml").write_text(
        "\n".join(
            [
                'id = "analyst"',
                'instruction = "Analyze docs safely."',
                'allowed_tools = ["Read", "Grep"]',
                'denied_tools = ["Bash"]',
                "enabled = true",
            ]
        ),
        encoding="utf-8",
    )
    profile_dir.joinpath("disabled.toml").write_text(
        "\n".join(
            [
                'id = "disabled"',
                'instruction = "Disabled profile."',
                'allowed_tools = ["Read"]',
                "enabled = false",
            ]
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())
