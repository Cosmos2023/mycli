from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.application.turn_service import TurnService
from mycli.cli.repl import build_command_handler
from mycli.domain.runtime import AgentConfig
from mycli.services.diagnostics.doctor import DoctorService, DoctorStatus
from mycli.services.hooks import HookAction, HookContext, HookManager, HookPoint, HookResult
from mycli.services.hooks.builtin import permission_guard


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
        workspace.mkdir()
        home.mkdir()

        hook_manager = HookManager()
        hook_manager.register(HookPoint.PRE_TOOL_USE, permission_guard)

        def deny_write(ctx: HookContext) -> HookResult:
            if ctx.tool_name == "Write":
                return HookResult(action=HookAction.DENY, message="blocked by hook smoke")
            return HookResult(action=HookAction.ALLOW)

        hook_manager.register(HookPoint.PRE_TOOL_USE, deny_write)
        execution = hook_manager.execute_with_summary(
            HookPoint.PRE_TOOL_USE,
            HookContext(
                hook_point=HookPoint.PRE_TOOL_USE,
                tool_name="Write",
                tool_args={"path": "notes.txt", "content": "hello"},
                session_id="hook-smoke",
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
        success = (
            [summary["action"] for summary in summaries if "action" in summary] == [
                "allow",
                "deny",
            ]
            and any("permission_guard" in line for line in slash_lines)
            and any("deny_write" in line and "denies=1" in line for line in slash_lines)
            and doctor_hook.status is DoctorStatus.OK
        )
        report.update(
            {
                "success": success,
                "checks": {
                    "execution_summaries": summaries,
                    "snapshots": snapshots,
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
