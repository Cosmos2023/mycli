from __future__ import annotations

import json
from pathlib import Path

from mycli.services.hooks.allowlist import HookAllowlist, HookAllowlistEntry, command_digest
from mycli.services.hooks.config import ConfiguredHookSpec, HookConfigRegistry
from mycli.services.hooks.runner import ConfiguredHookCallback
from mycli.services.hooks.types import HookAction, HookContext, HookPoint


def test_hook_config_registry_discovers_repo_and_user_hooks(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.joinpath(".mycli").mkdir(parents=True)
    user_script = tmp_path / "user.py"
    repo_script = tmp_path / "repo.py"
    _write_json(
        home / ".mycli" / "hooks.json",
        {
            "hooks": [
                {
                    "id": "user-session",
                    "hook_point": "session_start",
                    "command": ["python3", str(user_script)],
                }
            ]
        },
    )
    _write_json(
        workspace / ".mycli" / "hooks.json",
        {
            "hooks": [
                {
                    "id": "repo-read",
                    "hook_point": "pre_tool_use",
                    "command": ["python3", str(repo_script)],
                    "matcher": {"tool_name": "Read"},
                    "timeout_seconds": 3,
                    "working_directory": "config",
                    "env_policy": "inherit_safe",
                }
            ]
        },
    )

    discovery = HookConfigRegistry(workspace_root=workspace, home_dir=home).discover()

    assert discovery.issues == ()
    assert [hook.name for hook in discovery.hooks] == [
        "configured:user:user-session",
        "configured:repo:repo-read",
    ]
    assert discovery.hooks[1].hook_point is HookPoint.PRE_TOOL_USE
    assert discovery.hooks[1].matches_tool("Read") is True
    assert discovery.hooks[1].matches_tool("Write") is False


def test_hook_config_registry_reports_invalid_config(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.mkdir()
    (workspace / ".mycli" / "hooks.json").write_text("{bad json", encoding="utf-8")

    discovery = HookConfigRegistry(workspace_root=workspace, home_dir=home).discover()

    assert discovery.hooks == ()
    assert len(discovery.issues) == 1
    assert "not parseable" in discovery.issues[0].safe_line()


def test_configured_hook_callback_maps_allow_deny_modify_and_trace(tmp_path: Path) -> None:
    script = tmp_path / "hook.py"
    script.write_text(
        "\n".join(
            [
                "import json, sys",
                "payload = json.load(sys.stdin)",
                "if payload['tool_name'] == 'Write':",
                "    print(json.dumps({'action': 'deny', 'message': 'blocked'}))",
                "elif payload['tool_name'] == 'Read':",
                "    print(json.dumps({'action': 'modify', 'modified_args': {'path': 'changed.md'}}))",
                "else:",
                "    print(json.dumps({'action': 'allow'}))",
            ]
        ),
        encoding="utf-8",
    )
    spec = _spec(tmp_path, command=["python3", str(script)])
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((spec,))
    traces = []
    callback = ConfiguredHookCallback(
        spec=spec,
        workspace_root=tmp_path,
        monotonic=iter((10.0, 10.1, 10.2, 10.3, 10.4, 10.5)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
        trace_sink=lambda ctx, summary: traces.append(summary.safe_payload()),
    )

    denied = callback(HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Write"))
    modified = callback(HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Read"))
    allowed = callback(HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Bash"))

    assert denied.action is HookAction.DENY
    assert denied.message == "blocked"
    assert modified.action is HookAction.MODIFY
    assert modified.modified_args == {"path": "changed.md"}
    assert allowed.action is HookAction.ALLOW
    assert [trace["action"] for trace in traces] == ["deny", "modify", "allow"]
    assert all(str(trace["execution_id"]).startswith("hookexec_") for trace in traces)
    assert all("stdout" not in trace for trace in traces)


def test_configured_hook_callback_timeout_and_error_do_not_deny(tmp_path: Path) -> None:
    slow_script = tmp_path / "slow.py"
    slow_script.write_text("import time\ntime.sleep(1)\n", encoding="utf-8")
    spec = _spec(tmp_path, command=["python3", str(slow_script)], timeout_seconds=0.01)
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((spec,))
    traces = []
    callback = ConfiguredHookCallback(
        spec=spec,
        workspace_root=tmp_path,
        monotonic=iter((1.0, 1.2)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
        trace_sink=lambda ctx, summary: traces.append(summary.safe_payload()),
    )

    result = callback(HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Read"))

    assert result.action is HookAction.ERROR
    assert traces[0]["status"] == "error"
    assert traces[0]["action"] == "error"
    assert traces[0]["message"] == "timeout"


def test_configured_hook_callback_nonzero_exit_maps_to_error(tmp_path: Path) -> None:
    script = tmp_path / "fail.py"
    script.write_text(
        "import sys\nprint('api_key=sk-secret')\nsys.exit(7)\n",
        encoding="utf-8",
    )
    spec = _spec(tmp_path, command=["python3", str(script)])
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((spec,))
    traces = []
    callback = ConfiguredHookCallback(
        spec=spec,
        workspace_root=tmp_path,
        monotonic=iter((1.0, 1.1)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
        trace_sink=lambda ctx, summary: traces.append(summary.safe_payload()),
    )

    result = callback(HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Read"))

    assert result.action is HookAction.ERROR
    assert result.message == "configured hook failed"
    assert traces[0]["status"] == "error"
    assert traces[0]["action"] == "error"
    assert traces[0]["exit_code"] == 7
    assert traces[0]["message"] == "redacted"


def test_configured_hook_callback_requires_allowlist_before_execution(tmp_path: Path) -> None:
    marker = tmp_path / "executed.txt"
    script = tmp_path / "hook.py"
    script.write_text(
        "\n".join(
            [
                "import json",
                f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
                "print(json.dumps({'action':'deny','message':'should not run'}))",
            ]
        ),
        encoding="utf-8",
    )
    spec = _spec(tmp_path, command=["python3", str(script)])
    traces = []
    callback = ConfiguredHookCallback(
        spec=spec,
        workspace_root=tmp_path,
        monotonic=iter((1.0, 1.1)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
        trace_sink=lambda ctx, summary: traces.append(summary.safe_payload()),
    )

    result = callback(HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Read"))

    assert result.action is HookAction.ERROR
    assert result.message == "configured hook not allowlisted"
    assert not marker.exists()
    assert traces[0]["status"] == "error"
    assert traces[0]["action"] == "error"
    assert traces[0]["message"] == "not allowlisted: allowlist_missing"


def test_configured_hook_callback_redacts_secret_messages(tmp_path: Path) -> None:
    script = tmp_path / "secret.py"
    script.write_text(
        "import json\nprint(json.dumps({'action':'deny','message':'api_key=sk-secret'}))\n",
        encoding="utf-8",
    )
    spec = _spec(tmp_path, command=["python3", str(script)])
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((spec,))
    traces = []
    callback = ConfiguredHookCallback(
        spec=spec,
        workspace_root=tmp_path,
        monotonic=iter((1.0, 1.1)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
        trace_sink=lambda ctx, summary: traces.append(summary.safe_payload()),
    )

    result = callback(HookContext(hook_point=HookPoint.PRE_TOOL_USE, tool_name="Read"))

    assert result.action is HookAction.DENY
    assert result.message == "redacted"
    assert traces[0]["message"] == "redacted"


def test_hook_allowlist_statuses_and_parse_issues(tmp_path: Path) -> None:
    home = tmp_path / "home"
    spec = _spec(tmp_path, command=["python3", str(tmp_path / "hook.py")])
    allowlist = HookAllowlist(home_dir=home)

    missing = allowlist.status_for(spec)
    assert missing.allowed is False
    assert missing.reason == "allowlist_missing"
    assert missing.digest == command_digest(spec.command)

    allowlist.write_allowed((spec,))
    matched = HookAllowlist(home_dir=home).status_for(spec)
    assert matched.allowed is True
    assert matched.reason == "matched"

    (home / ".mycli" / "hook-allowlist.json").write_text(
        json.dumps(
            {
                "allowed": [
                    HookAllowlistEntry(
                        source=spec.source,
                        hook_id=spec.hook_id,
                        hook_point=spec.hook_point,
                        command_digest="sha256:" + "0" * 64,
                    ).to_dict()
                ]
            }
        ),
        encoding="utf-8",
    )
    mismatch = HookAllowlist(home_dir=home).status_for(spec)
    assert mismatch.allowed is False
    assert mismatch.reason == "entry_missing_or_digest_mismatch"

    (home / ".mycli" / "hook-allowlist.json").write_text("{bad", encoding="utf-8")
    malformed = HookAllowlist(home_dir=home)
    assert malformed.issues
    assert malformed.status_for(spec).reason == "entry_missing_or_digest_mismatch"


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _spec(
    tmp_path: Path,
    *,
    command: list[str],
    timeout_seconds: float = 2.0,
) -> ConfiguredHookSpec:
    config_dir = tmp_path / ".mycli"
    config_dir.mkdir(exist_ok=True)
    config = config_dir / "hooks.json"
    _write_json(
        config,
        {
            "hooks": [
                {
                    "id": "demo",
                    "hook_point": "pre_tool_use",
                    "command": command,
                    "timeout_seconds": timeout_seconds,
                }
            ]
        },
    )
    discovery = HookConfigRegistry(workspace_root=tmp_path, home_dir=tmp_path / "home").discover()
    assert discovery.issues == ()
    return discovery.hooks[0]
