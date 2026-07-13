from __future__ import annotations

import json
from pathlib import Path
import sys

from mycli.domain.runtime import PowerShellEdition, ShellKind, ShellProfile
from mycli.services.hooks.allowlist import HookAllowlist, HookAllowlistEntry, command_digest
from mycli.services.hooks.config import ConfiguredHookSpec, HookConfigRegistry
from mycli.services.hooks.runner import ConfiguredHookCallback
from mycli.services.hooks.types import HookAction, HookContext, HookPoint
from mycli.tools.shell_resolver import ShellCommandConfig, ShellResolutionError


def test_string_hook_uses_resolved_bash(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.joinpath(".mycli").mkdir(parents=True)
    _write_json(
        workspace / ".mycli" / "hooks.json",
        {
            "hooks": [
                {
                    "id": "repo-command",
                    "hook_point": "pre_tool_use",
                    "command": "echo '{}'",
                }
            ]
        },
    )

    discovery = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=tmp_path / "home",
        shell_path="/custom/bash",
        shell_resolver=lambda path: ShellCommandConfig(Path(path or "")),
    ).discover()

    assert discovery.issues == ()
    assert discovery.hooks[0].command == ("/custom/bash", "-c", "echo '{}'")
    assert discovery.hooks[0].shell_kind is ShellKind.BASH


def test_string_hook_uses_active_powershell_profile(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.joinpath(".mycli").mkdir(parents=True)
    _write_json(
        workspace / ".mycli" / "hooks.json",
        {
            "hooks": [
                {
                    "id": "repo-command",
                    "hook_point": "pre_tool_use",
                    "command": "Get-Location",
                }
            ]
        },
    )
    profile = ShellProfile(
        ShellKind.POWERSHELL,
        Path("pwsh.exe"),
        PowerShellEdition.CORE,
    )

    hook = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=tmp_path / "home",
        shell_profile=profile,
    ).discover().hooks[0]

    assert hook.command == tuple(profile.exec_argv("Get-Location"))
    assert hook.shell_kind is ShellKind.POWERSHELL


def test_argv_hook_remains_direct_and_has_no_shell_kind(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.joinpath(".mycli").mkdir(parents=True)
    command = [sys.executable, "-c", "print('ok')"]
    _write_json(
        workspace / ".mycli" / "hooks.json",
        {
            "hooks": [
                {
                    "id": "argv-command",
                    "hook_point": "pre_tool_use",
                    "command": command,
                }
            ]
        },
    )

    hook = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=tmp_path / "home",
        shell_profile=ShellProfile(
            ShellKind.POWERSHELL,
            Path("pwsh.exe"),
            PowerShellEdition.CORE,
        ),
    ).discover().hooks[0]

    assert hook.command == tuple(command)
    assert hook.shell_kind is None


def test_hook_digest_changes_with_shell_kind() -> None:
    command = ("shell", "-c", "git status")

    assert command_digest(command, ShellKind.BASH) != command_digest(
        command,
        ShellKind.POWERSHELL,
    )


def test_string_hook_reports_shell_resolution_error(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.joinpath(".mycli").mkdir(parents=True)
    _write_json(
        workspace / ".mycli" / "hooks.json",
        {
            "hooks": [
                {
                    "id": "repo-command",
                    "hook_point": "pre_tool_use",
                    "command": "echo '{}'",
                }
            ]
        },
    )

    discovery = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=tmp_path / "home",
        shell_resolver=lambda _path: (_ for _ in ()).throw(
            ShellResolutionError("Install Git for Windows")
        ),
    ).discover()

    assert discovery.hooks == ()
    assert "Install Git for Windows" in discovery.issues[0].message


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
                    "command": [sys.executable, str(user_script)],
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
                    "command": [sys.executable, str(repo_script)],
                    "matcher": {"tool_name": "Read"},
                    "timeout_seconds": 3,
                    "working_directory": "config",
                    "env_policy": "inherit_safe",
                }
            ]
        },
    )

    discovery = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=home,
        shell_resolver=lambda _path: ShellCommandConfig(Path("/bin/bash")),
    ).discover()

    assert discovery.issues == ()
    assert [hook.name for hook in discovery.hooks] == [
        "configured:user:user-session",
        "configured:repo:repo-read",
    ]
    assert discovery.hooks[1].hook_point is HookPoint.PRE_TOOL_USE
    assert discovery.hooks[1].matches_tool("Read") is True
    assert discovery.hooks[1].matches_tool("Write") is False


def test_hook_config_registry_discovers_codex_grouped_hooks(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    home.mkdir()
    _write_json(
        workspace / ".mycli" / "hooks.json",
        {
            "PreToolUse": [
                {
                    "matcher": "^Bash$",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "echo '{}'",
                            "timeoutSec": 4,
                        }
                    ],
                }
            ],
            "UserPromptSubmit": [
                {
                    "matcher": "^ignored$",
                    "hooks": [{"type": "command", "command": "echo '{}'" }],
                }
            ],
            "Stop": [
                {"hooks": [{"type": "command", "command": "echo '{}'" }]}
            ],
        },
    )

    discovery = HookConfigRegistry(workspace_root=workspace, home_dir=home).discover()

    assert discovery.issues == ()
    assert [hook.hook_point for hook in discovery.hooks] == [
        HookPoint.PRE_TOOL_USE,
        HookPoint.USER_PROMPT_SUBMIT,
        HookPoint.STOP,
    ]
    assert discovery.hooks[0].matches(tool_name="Bash") is True
    assert discovery.hooks[0].matches(tool_name="Read") is False
    assert discovery.hooks[1].matches(tool_name="anything") is True
    assert discovery.hooks[0].command == ("/bin/bash", "-c", "echo '{}'")
    assert discovery.hooks[0].timeout_seconds == 4


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
    spec = _spec(tmp_path, command=[sys.executable, str(script)])
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
    spec = _spec(tmp_path, command=[sys.executable, str(slow_script)], timeout_seconds=0.01)
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
    spec = _spec(tmp_path, command=[sys.executable, str(script)])
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
    spec = _spec(tmp_path, command=[sys.executable, str(script)])
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
    spec = _spec(tmp_path, command=[sys.executable, str(script)])
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


def test_configured_hook_callback_parses_additional_contexts(tmp_path: Path) -> None:
    script = tmp_path / "post_context.py"
    script.write_text(
        "\n".join(
            [
                "import json",
                "print(json.dumps({",
                "  'action': 'allow',",
                "  'additional_contexts': ['Use this result; do not repeat the same call.']",
                "}))",
            ]
        ),
        encoding="utf-8",
    )
    spec = _spec(
        tmp_path,
        hook_point=HookPoint.POST_TOOL_USE,
        command=[sys.executable, str(script)],
    )
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((spec,))
    callback = ConfiguredHookCallback(
        spec=spec,
        workspace_root=tmp_path,
        monotonic=iter((1.0, 1.1)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
    )

    result = callback(HookContext(hook_point=HookPoint.POST_TOOL_USE, tool_name="Read"))

    assert result.action is HookAction.ALLOW
    assert result.additional_contexts == (
        "Use this result; do not repeat the same call.",
    )


def test_configured_hook_callback_parses_codex_additional_context(tmp_path: Path) -> None:
    script = tmp_path / "codex_post_context.py"
    script.write_text(
        "\n".join(
            [
                "import json",
                "print(json.dumps({",
                "  'hookSpecificOutput': {",
                "    'hookEventName': 'PostToolUse',",
                "    'additionalContext': 'Remember this tool result.'",
                "  }",
                "}))",
            ]
        ),
        encoding="utf-8",
    )
    spec = _spec(
        tmp_path,
        hook_point=HookPoint.POST_TOOL_USE,
        command=[sys.executable, str(script)],
    )
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((spec,))
    callback = ConfiguredHookCallback(
        spec=spec,
        workspace_root=tmp_path,
        monotonic=iter((1.0, 1.1)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
    )

    result = callback(HookContext(hook_point=HookPoint.POST_TOOL_USE, tool_name="Read"))

    assert result.action is HookAction.ALLOW
    assert result.additional_contexts == ("Remember this tool result.",)


def test_configured_hook_callback_maps_codex_block_and_exit_2(tmp_path: Path) -> None:
    block_script = tmp_path / "block.py"
    block_script.write_text(
        "import json\nprint(json.dumps({'decision':'block','reason':'slow down'}))\n",
        encoding="utf-8",
    )
    block_spec = _spec(
        tmp_path,
        hook_point=HookPoint.USER_PROMPT_SUBMIT,
        command=[sys.executable, str(block_script)],
    )
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((block_spec,))
    block_callback = ConfiguredHookCallback(
        spec=block_spec,
        workspace_root=tmp_path,
        monotonic=iter((1.0, 1.1)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
    )

    blocked = block_callback(HookContext(hook_point=HookPoint.USER_PROMPT_SUBMIT))

    assert blocked.action is HookAction.DENY
    assert blocked.message == "slow down"

    exit_script = tmp_path / "exit2.py"
    exit_script.write_text("import sys\nsys.stderr.write('do not stop')\nsys.exit(2)\n", encoding="utf-8")
    exit_spec = _spec(
        tmp_path,
        hook_point=HookPoint.STOP,
        command=[sys.executable, str(exit_script)],
    )
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((exit_spec,))
    exit_callback = ConfiguredHookCallback(
        spec=exit_spec,
        workspace_root=tmp_path,
        monotonic=iter((2.0, 2.1)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
    )

    exit_block = exit_callback(HookContext(hook_point=HookPoint.STOP))

    assert exit_block.action is HookAction.DENY
    assert exit_block.message == "do not stop"


def test_configured_hook_callback_plain_text_context_for_session_start(tmp_path: Path) -> None:
    script = tmp_path / "plain.py"
    script.write_text("print('load this session context')\n", encoding="utf-8")
    spec = _spec(
        tmp_path,
        hook_point=HookPoint.SESSION_START,
        command=[sys.executable, str(script)],
    )
    HookAllowlist(home_dir=tmp_path / "home").write_allowed((spec,))
    callback = ConfiguredHookCallback(
        spec=spec,
        workspace_root=tmp_path,
        monotonic=iter((1.0, 1.1)).__next__,
        allowlist_status=HookAllowlist(home_dir=tmp_path / "home").status_for,
    )

    result = callback(HookContext(hook_point=HookPoint.SESSION_START))

    assert result.action is HookAction.ALLOW
    assert result.additional_contexts == ("load this session context",)


def test_hook_allowlist_statuses_and_parse_issues(tmp_path: Path) -> None:
    home = tmp_path / "home"
    spec = _spec(tmp_path, command=[sys.executable, str(tmp_path / "hook.py")])
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
    hook_point: HookPoint = HookPoint.PRE_TOOL_USE,
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
                    "hook_point": hook_point.value,
                    "command": command,
                    "timeout_seconds": timeout_seconds,
                }
            ]
        },
    )
    discovery = HookConfigRegistry(workspace_root=tmp_path, home_dir=tmp_path / "home").discover()
    assert discovery.issues == ()
    return discovery.hooks[0]
