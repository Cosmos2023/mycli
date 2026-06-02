from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile

from mycli.cli.main import main
from mycli.services.hooks import HookContext, HookManager, HookPoint, register_configured_hooks


def main_smoke() -> int:
    timestamp = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%SZ")
    with tempfile.TemporaryDirectory(prefix="mycli-hook-management-") as raw_root:
        root = Path(raw_root)
        workspace = root / "workspace"
        home = root / "home"
        (workspace / ".mycli").mkdir(parents=True)
        (home / ".mycli").mkdir(parents=True)
        marker = root / "hook-ran.jsonl"
        script = root / "hook.py"
        script.write_text(
            "\n".join(
                [
                    "import json, sys",
                    "from pathlib import Path",
                    "payload = json.load(sys.stdin)",
                    f"Path({str(marker)!r}).write_text(json.dumps(payload), encoding='utf-8')",
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
                            "id": "smoke-hook",
                            "hook_point": "pre_tool_use",
                            "command": ["python3", str(script)],
                            "matcher": {"tool_name": "Read"},
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        approve_output: list[str] = []
        approve_exit = main(
            ["hooks", "approve", "repo:smoke-hook:pre_tool_use", "--json"],
            cwd=workspace,
            home=home,
            env={},
            output_func=approve_output.append,
        )
        approved_execution = _execute_configured_hook(workspace=workspace, home=home)
        approved_marker_exists = marker.exists()
        marker.unlink(missing_ok=True)

        revoke_output: list[str] = []
        revoke_exit = main(
            ["hooks", "revoke", "repo:smoke-hook:pre_tool_use", "--json"],
            cwd=workspace,
            home=home,
            env={},
            output_func=revoke_output.append,
        )
        revoked_execution = _execute_configured_hook(workspace=workspace, home=home)
        revoked_marker_exists = marker.exists()

        report = {
            "scenario": "hook-management-smoke",
            "timestamp": timestamp,
            "approve_exit": approve_exit,
            "approve": json.loads(approve_output[0]) if approve_output else None,
            "approved_actions": [result.action.value for result in approved_execution],
            "approved_marker_exists": approved_marker_exists,
            "revoke_exit": revoke_exit,
            "revoke": json.loads(revoke_output[0]) if revoke_output else None,
            "revoked_actions": [result.action.value for result in revoked_execution],
            "revoked_marker_exists": revoked_marker_exists,
        }
        ok = (
            approve_exit == 0
            and approved_marker_exists
            and revoke_exit == 0
            and not revoked_marker_exists
            and report["approved_actions"] == ["allow"]
            and report["revoked_actions"] == ["error"]
        )
        report["ok"] = ok
        output_dir = Path(__file__).resolve().parent / "runs"
        output_dir.mkdir(parents=True, exist_ok=True)
        report_path = output_dir / f"hook-management-smoke-{timestamp}.json"
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
        print(f"[hook-management-smoke] report: {report_path}")
        print(f"[hook-management-smoke] ok={str(ok).lower()}")
        return 0 if ok else 1


def _execute_configured_hook(*, workspace: Path, home: Path):
    manager = HookManager()
    register_configured_hooks(
        manager=manager,
        workspace_root=workspace,
        home_dir=home,
        trace_service=None,
        session_id="hook-management-smoke",
    )
    return manager.execute(
        HookPoint.PRE_TOOL_USE,
        HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Read"),
    )


if __name__ == "__main__":
    raise SystemExit(main_smoke())
