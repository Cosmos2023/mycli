from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.application.turn_service import TurnService
from mycli.cli.slash_command_dispatch import dispatch_backend_slash_command
from mycli.cli.slash_command_registry import (
    SlashCommandContext,
    SlashCommandSurface,
    resolve_slash_command,
)
from mycli.domain.runtime import AgentConfig
from mycli.services.diagnostics.doctor import DoctorService, DoctorStatus
from mycli.services.hooks import HookAllowlist, HookContext, HookManager, HookPoint
from mycli.services.hooks.builtin import permission_guard
from mycli.services.hooks.config import HookConfigRegistry
from mycli.services.hooks.setup import register_configured_hooks
from mycli.services.tracing import TraceService


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "evaluation" / "runs"


class FakeRuntime:
    def __init__(
        self,
        workspace_root: Path,
        home_dir: Path,
        hook_manager: HookManager,
    ) -> None:
        self._config = AgentConfig(workspace_root=workspace_root, session_id="hook-smoke")
        self._home_dir = home_dir
        self._hook_manager = hook_manager
        self._hook_config_discovery = HookConfigRegistry(
            workspace_root=workspace_root,
            home_dir=home_dir,
        ).discover()

    def inspect_hooks(self) -> tuple[str, ...]:
        lines = [snapshot.safe_line() for snapshot in self._hook_manager.snapshot()]
        allowlist = HookAllowlist(home_dir=self._home_dir)
        lines.extend(
            allowlist.status_for(spec).safe_line(spec)
            for spec in self._hook_config_discovery.hooks
        )
        return tuple(lines)


def _dispatch_cli_command(service: TurnService, command: str) -> tuple[str, ...]:
    context = SlashCommandContext(surface=SlashCommandSurface.CLI)
    invocation = resolve_slash_command(command, context)
    return dispatch_backend_slash_command(service, invocation).lines


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
        session_hook_script = root / "session_hook.py"
        session_marker = root / "session-hooks.jsonl"
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
        session_hook_script.write_text(
            "\n".join(
                [
                    "import json, os, sys",
                    "from pathlib import Path",
                    "payload = json.load(sys.stdin)",
                    f"Path({str(session_marker)!r}).open('a', encoding='utf-8').write(json.dumps({{'hook_point': payload['hook_point'], 'hook_id': os.environ['MYCLI_HOOK_ID']}}) + '\\n')",
                    "print(json.dumps({'action':'allow'}))",
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
                        },
                        {
                            "id": "session-start",
                            "hook_point": "session_start",
                            "command": ["python3", str(session_hook_script)],
                        },
                        {
                            "id": "session-end",
                            "hook_point": "session_end",
                            "command": ["python3", str(session_hook_script)],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        initial_discovery = HookConfigRegistry(
            workspace_root=workspace,
            home_dir=home,
        ).discover()
        blocked_hook_manager = HookManager()
        blocked_trace_service = TraceService(home_dir=home)
        blocked_discovery = register_configured_hooks(
            manager=blocked_hook_manager,
            workspace_root=workspace,
            home_dir=home,
            trace_service=blocked_trace_service,
            session_id="hook-smoke-blocked",
        )
        blocked_execution = blocked_hook_manager.execute_with_summary(
            HookPoint.PRE_TOOL_USE,
            HookContext(
                hook_point=HookPoint.PRE_TOOL_USE,
                tool_name="Write",
                tool_args={"path": "notes.txt", "content": "hello"},
                session_id="hook-smoke-blocked",
                metadata={"turn_id": "turn_blocked"},
            ),
        )
        HookAllowlist(home_dir=home).write_allowed(initial_discovery.hooks)
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
        hook_manager.execute_with_summary(
            HookPoint.SESSION_START,
            HookContext(
                hook_point=HookPoint.SESSION_START,
                session_id="hook-smoke",
                metadata={"turn_id": "session_start"},
            ),
        )
        hook_manager.execute_with_summary(
            HookPoint.SESSION_END,
            HookContext(
                hook_point=HookPoint.SESSION_END,
                session_id="hook-smoke",
                metadata={"turn_id": "session_end"},
            ),
        )

        service = TurnService(
            config=AgentConfig(workspace_root=workspace, session_id="hook-smoke"),
            home_dir=home,
            runtime=FakeRuntime(workspace, home, hook_manager),
        )
        slash_lines = _dispatch_cli_command(service, "/hooks")
        doctor = DoctorService(
            workspace_root=workspace,
            home_dir=home,
            env={},
            which=lambda _command: None,
            import_checker=lambda _module: False,
        ).run()
        doctor_hook = next(check for check in doctor.checks if check.name == "hooks")
        summaries = tuple(summary.safe_payload() for summary in execution.summaries)
        blocked_summaries = tuple(summary.safe_payload() for summary in blocked_execution.summaries)
        snapshots = tuple(snapshot.safe_line() for snapshot in hook_manager.snapshot())
        traces = tuple(event.to_dict() for event in trace_service.load("hook-smoke"))
        blocked_traces = tuple(
            event.to_dict()
            for event in blocked_trace_service.load("hook-smoke-blocked")
        )
        session_lines = (
            tuple(json.loads(line) for line in session_marker.read_text(encoding="utf-8").splitlines())
            if session_marker.exists()
            else ()
        )
        success = (
            [summary["action"] for summary in summaries if "action" in summary] == [
                "allow",
                "deny",
            ]
            and [summary["action"] for summary in blocked_summaries if "action" in summary] == [
                "error",
            ]
            and len(discovery.hooks) == 3
            and len(blocked_discovery.hooks) == 3
            and any("permission_guard" in line for line in slash_lines)
            and any("configured:repo:configured-deny-write" in line for line in slash_lines)
            and any(
                line.startswith("Pre tool use")
                and "configured:repo:configured-deny-write" in line
                and "deny" in line
                for line in slash_lines
            )
            and any(
                line.startswith("Configured:repo:configured deny write")
                and "allowed" in line
                and "matched" in line
                for line in slash_lines
            )
            and any(event["kind"] == "hook_execution" for event in traces)
            and any(
                event["kind"] == "hook_execution"
                and event["payload"].get("action") == "error"
                for event in blocked_traces
            )
            and [line["hook_point"] for line in session_lines] == ["session_start", "session_end"]
            and doctor_hook.status is DoctorStatus.OK
        )
        report.update(
            {
                "success": success,
                "checks": {
                    "initial_hooks": [hook.name for hook in initial_discovery.hooks],
                    "blocked_execution_summaries": blocked_summaries,
                    "execution_summaries": summaries,
                    "snapshots": snapshots,
                    "trace": traces,
                    "blocked_trace": blocked_traces,
                    "session_lines": session_lines,
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
