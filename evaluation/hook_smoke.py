from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.application.turn_service import TurnService
from mycli.cli.repl import build_command_handler
from mycli.domain.runtime import AgentConfig
from mycli.services.diagnostics.doctor import DoctorService, DoctorStatus
from mycli.services.hooks import HookContext, HookManager, HookPoint
from mycli.services.hooks.builtin import permission_guard
from mycli.services.hooks.setup import register_configured_hooks
from mycli.services.tracing import TraceService


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "evaluation" / "runs"


class FakeRuntime:
    def __init__(self, workspace_root: Path, hook_manager: HookManager) -> None:
        self._config = AgentConfig(workspace_root=workspace_root, session_id="hook-smoke")
        self._hook_manager = hook_manager

    def inspect_hooks(self) -> tuple[str, ...]:
        return tuple(snapshot.safe_line() for snapshot in self._hook_manager.snapshot())


def main() -> int:
    report: dict[str, object] = {
        "run_id": f"hook-smoke-{datetime.now(tz=UTC).strftime('%Y%m%dT%H%M%SZ')}",
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    with tempfile.TemporaryDirectory(prefix="mycli-hook-smoke-") as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        home = root / "home"
        workspace.joinpath(".mycli").mkdir(parents=True)
        home.mkdir()
        hook_script = root / "configured_hook.py"
        hook_script.write_text(
            "\n".join(
                [
                    "import json, sys",
                    "payload = json.load(sys.stdin)",
                    "if payload.get('tool_name') == 'Write':",
                    "    print(json.dumps({'action':'deny','message':'configured block'}))",
                    "else:",
                    "    print(json.dumps({'action':'allow'}))",
                ]
            ),
            encoding="utf-8",
        )
        (workspace / ".mycli" / "hooks.json").write_text(
            json.dumps(
                {
                    "hooks": [
                        {
                            "id": "configured-deny-write",
                            "hook_point": "pre_tool_use",
                            "command": ["python3", str(hook_script)],
                            "matcher": {"tool_name": "Write"},
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        hook_manager = HookManager()
        hook_manager.register(HookPoint.PRE_TOOL_USE, permission_guard)

        trace_service = TraceService(home_dir=home)
        discovery = register_configured_hooks(
            manager=hook_manager,
            workspace_root=workspace,
            home_dir=home,
            trace_service=trace_service,
            session_id="hook-smoke",
        )
        execution = hook_manager.execute_with_summary(
            HookPoint.PRE_TOOL_USE,
            HookContext(
                hook_point=HookPoint.PRE_TOOL_USE,
                tool_name="Write",
                tool_args={"path": "notes.txt", "content": "hello"},
                session_id="hook-smoke",
                metadata={"turn_id": "turn_1"},
            ),
        )

        service = TurnService(
            config=AgentConfig(workspace_root=workspace, session_id="hook-smoke"),
            home_dir=home,
            runtime=FakeRuntime(workspace, hook_manager),
        )
        slash_lines = tuple(build_command_handler(service)("/hooks"))
        doctor = DoctorService(
            workspace_root=workspace,
            home_dir=home,
            env={},
            which=lambda _command: None,
            import_checker=lambda _module: False,
        ).run()
        doctor_hook = next(check for check in doctor.checks if check.name == "hooks")
        summaries = tuple(summary.safe_payload() for summary in execution.summaries)
        snapshots = tuple(snapshot.safe_line() for snapshot in hook_manager.snapshot())
        traces = tuple(event.to_dict() for event in trace_service.load("hook-smoke"))
        success = (
            [summary["action"] for summary in summaries if "action" in summary] == [
                "allow",
                "deny",
            ]
            and len(discovery.hooks) == 1
            and any("permission_guard" in line for line in slash_lines)
            and any("configured:repo:configured-deny-write" in line for line in slash_lines)
            and any("configured:repo:configured-deny-write" in line and "denies=1" in line for line in slash_lines)
            and any(event["kind"] == "hook_execution" for event in traces)
            and doctor_hook.status is DoctorStatus.OK
        )
        report.update(
            {
                "success": success,
                "checks": {
                    "execution_summaries": summaries,
                    "snapshots": snapshots,
                    "trace": traces,
                    "slash_lines": slash_lines,
                    "doctor_status": doctor_hook.status.value,
                    "doctor_message": doctor_hook.message,
                    "doctor_detail": doctor_hook.detail,
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
