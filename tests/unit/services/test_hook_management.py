from __future__ import annotations

import json
from pathlib import Path

from mycli.services.hooks.allowlist import HookAllowlist, HookAllowlistEntry, command_digest
from mycli.services.hooks.config import HookConfigRegistry
from mycli.services.hooks.management import HookManagementService


def test_hook_management_lists_configured_hooks_with_safe_metadata(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    script = tmp_path / "hook.py"
    _write_repo_hooks(
        workspace,
        [
            {
                "id": "format-check",
                "hook_point": "pre_tool_use",
                "command": ["python3", str(script), "--secret", "sk-hidden"],
                "timeout_seconds": 3,
                "working_directory": "config",
                "env_policy": "inherit_safe",
            }
        ],
    )

    response = HookManagementService(workspace_root=workspace, home_dir=home).list_hooks()

    assert response.ok is True
    assert len(response.hooks) == 1
    row = response.hooks[0]
    assert row.identity == "repo:format-check:pre_tool_use"
    assert row.source == "repo"
    assert row.hook_id == "format-check"
    assert row.hook_point == "pre_tool_use"
    assert row.timeout_seconds == 3
    assert row.working_directory == "config"
    assert row.env_policy == "inherit_safe"
    assert row.allowlist_status == "not_allowed"
    assert row.allowlist_reason == "allowlist_missing"
    assert row.command_digest.startswith("sha256:")
    assert "sk-hidden" not in json.dumps(response.to_dict())


def test_hook_management_inspects_and_json_serializes(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_repo_hooks(
        workspace,
        [{"id": "audit", "hook_point": "post_tool_use", "command": ["python3", "audit.py"]}],
    )

    response = HookManagementService(workspace_root=workspace, home_dir=home).inspect_hook(
        "repo:audit:post_tool_use"
    )

    assert response.ok is True
    payload = response.to_dict()
    assert payload["hook"]["identity"] == "repo:audit:post_tool_use"  # type: ignore[index]
    assert payload["hooks"][0]["identity"] == "repo:audit:post_tool_use"  # type: ignore[index]


def test_hook_management_approve_writes_or_updates_matching_allowlist_entry(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_repo_hooks(
        workspace,
        [{"id": "audit", "hook_point": "post_tool_use", "command": ["python3", "audit.py"]}],
    )
    discovery = HookConfigRegistry(workspace_root=workspace, home_dir=home).discover()
    spec = discovery.hooks[0]
    allowlist_path = home / ".mycli" / "hook-allowlist.json"
    allowlist_path.write_text(
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

    response = HookManagementService(workspace_root=workspace, home_dir=home).approve_hook(
        "repo:audit:post_tool_use"
    )

    assert response.ok is True
    assert response.hook is not None
    assert response.hook.allowlist_status == "allowed"
    payload = json.loads(allowlist_path.read_text(encoding="utf-8"))
    assert len(payload["allowed"]) == 1
    assert payload["allowed"][0]["command_digest"] == command_digest(spec.command)


def test_hook_management_revoke_removes_only_matching_allowlist_entry(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_repo_hooks(
        workspace,
        [
            {"id": "audit", "hook_point": "post_tool_use", "command": ["python3", "audit.py"]},
            {"id": "guard", "hook_point": "pre_tool_use", "command": ["python3", "guard.py"]},
        ],
    )
    discovery = HookConfigRegistry(workspace_root=workspace, home_dir=home).discover()
    HookAllowlist(home_dir=home).write_allowed(discovery.hooks)

    response = HookManagementService(workspace_root=workspace, home_dir=home).revoke_hook(
        "repo:audit:post_tool_use"
    )

    assert response.ok is True
    assert response.removed is True
    allowlist = HookAllowlist(home_dir=home)
    assert allowlist.status_for(discovery.hooks[0]).allowed is False
    assert allowlist.status_for(discovery.hooks[1]).allowed is True


def test_hook_management_revoke_missing_entry_succeeds_for_existing_hook(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_repo_hooks(
        workspace,
        [{"id": "audit", "hook_point": "post_tool_use", "command": ["python3", "audit.py"]}],
    )

    response = HookManagementService(workspace_root=workspace, home_dir=home).revoke_hook(
        "repo:audit:post_tool_use"
    )

    assert response.ok is True
    assert response.removed is False


def test_hook_management_reports_bad_config_in_list(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    (workspace / ".mycli" / "hooks.json").write_text("{bad", encoding="utf-8")

    response = HookManagementService(workspace_root=workspace, home_dir=home).list_hooks()

    assert response.ok is True
    assert response.hooks == ()
    assert response.config_issues
    assert "not parseable" in response.config_issues[0]


def test_hook_management_digest_mismatch_visible(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)
    _write_repo_hooks(
        workspace,
        [{"id": "audit", "hook_point": "post_tool_use", "command": ["python3", "audit.py"]}],
    )
    discovery = HookConfigRegistry(workspace_root=workspace, home_dir=home).discover()
    spec = discovery.hooks[0]
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

    row = HookManagementService(workspace_root=workspace, home_dir=home).list_hooks().hooks[0]

    assert row.allowlist_status == "not_allowed"
    assert row.allowlist_reason == "entry_missing_or_digest_mismatch"


def test_hook_management_rejects_builtin_like_identity(tmp_path: Path) -> None:
    workspace, home = _workspace_home(tmp_path)

    response = HookManagementService(workspace_root=workspace, home_dir=home).approve_hook(
        "builtin:permission_guard:pre_tool_use"
    )

    assert response.ok is False
    assert "not found" in response.message


def _workspace_home(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    (workspace / ".mycli").mkdir(parents=True)
    (home / ".mycli").mkdir(parents=True)
    return workspace, home


def _write_repo_hooks(workspace: Path, hooks: list[dict[str, object]]) -> None:
    (workspace / ".mycli" / "hooks.json").write_text(
        json.dumps({"hooks": hooks}),
        encoding="utf-8",
    )
