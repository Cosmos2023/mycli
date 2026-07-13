from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mycli.services.hooks.allowlist import HookAllowlist, command_digest
from mycli.services.hooks.config import (
    ConfiguredHookSpec,
    HookConfigDiscovery,
    HookConfigIssue,
    HookConfigRegistry,
)
from mycli.services.hooks.types import HookPoint


@dataclass(slots=True, frozen=True)
class HookManagementRow:
    source: str
    hook_id: str
    hook_point: str
    identity: str
    enabled: bool
    timeout_seconds: float
    working_directory: str
    env_policy: str
    command_digest: str
    allowlist_status: str
    allowlist_reason: str
    config_path: str
    config_issues: tuple[str, ...]
    allowlist_issues: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "source": self.source,
            "hook_id": self.hook_id,
            "hook_point": self.hook_point,
            "identity": self.identity,
            "enabled": self.enabled,
            "timeout_seconds": self.timeout_seconds,
            "working_directory": self.working_directory,
            "env_policy": self.env_policy,
            "command_digest": self.command_digest,
            "allowlist_status": self.allowlist_status,
            "allowlist_reason": self.allowlist_reason,
            "config_path": self.config_path,
            "config_issues": list(self.config_issues),
            "allowlist_issues": list(self.allowlist_issues),
        }


@dataclass(slots=True, frozen=True)
class HookManagementResponse:
    ok: bool
    action: str
    message: str
    hooks: tuple[HookManagementRow, ...] = ()
    hook: HookManagementRow | None = None
    config_issues: tuple[str, ...] = ()
    allowlist_issues: tuple[str, ...] = ()
    removed: bool | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "ok": self.ok,
            "action": self.action,
            "message": self.message,
            "hooks": [row.to_dict() for row in self.hooks],
            "config_issues": list(self.config_issues),
            "allowlist_issues": list(self.allowlist_issues),
        }
        if self.hook is not None:
            payload["hook"] = self.hook.to_dict()
        if self.removed is not None:
            payload["removed"] = self.removed
        return payload


class HookManagementService:
    def __init__(
        self,
        *,
        workspace_root: Path,
        home_dir: Path,
        shell_path: str | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._home_dir = home_dir
        self._shell_path = shell_path

    def list_hooks(self) -> HookManagementResponse:
        discovery, allowlist = self._load()
        rows = self._rows(discovery.hooks, discovery.issues, allowlist)
        return HookManagementResponse(
            ok=True,
            action="list",
            message=f"configured hooks: {len(rows)}",
            hooks=rows,
            config_issues=_safe_config_issues(discovery.issues),
            allowlist_issues=allowlist.issues,
        )

    def inspect_hook(self, identity: str) -> HookManagementResponse:
        discovery, allowlist = self._load()
        spec = self._resolve(discovery.hooks, identity)
        if spec is None:
            return HookManagementResponse(
                ok=False,
                action="inspect",
                message=f"configured hook not found: {identity}",
                config_issues=_safe_config_issues(discovery.issues),
                allowlist_issues=allowlist.issues,
            )
        row = self._row(spec, discovery.issues, allowlist)
        return HookManagementResponse(
            ok=True,
            action="inspect",
            message=f"configured hook: {row.identity}",
            hook=row,
            hooks=(row,),
            config_issues=_safe_config_issues(discovery.issues),
            allowlist_issues=allowlist.issues,
        )

    def approve_hook(self, identity: str) -> HookManagementResponse:
        discovery, allowlist = self._load()
        spec = self._resolve(discovery.hooks, identity)
        if spec is None:
            return HookManagementResponse(
                ok=False,
                action="approve",
                message=f"configured hook not found: {identity}",
                config_issues=_safe_config_issues(discovery.issues),
                allowlist_issues=allowlist.issues,
            )
        if allowlist.issues:
            return HookManagementResponse(
                ok=False,
                action="approve",
                message="allowlist cannot be written until parse issues are fixed",
                hook=self._row(spec, discovery.issues, allowlist),
                config_issues=_safe_config_issues(discovery.issues),
                allowlist_issues=allowlist.issues,
            )
        try:
            allowlist.approve(spec)
        except (OSError, ValueError) as exc:
            return HookManagementResponse(
                ok=False,
                action="approve",
                message=f"allowlist write failed: {exc}",
                hook=self._row(spec, discovery.issues, allowlist),
                config_issues=_safe_config_issues(discovery.issues),
                allowlist_issues=allowlist.issues,
            )
        refreshed = HookAllowlist(home_dir=self._home_dir)
        row = self._row(spec, discovery.issues, refreshed)
        return HookManagementResponse(
            ok=True,
            action="approve",
            message=f"approved {row.identity}",
            hook=row,
            hooks=(row,),
            config_issues=_safe_config_issues(discovery.issues),
            allowlist_issues=refreshed.issues,
        )

    def revoke_hook(self, identity: str) -> HookManagementResponse:
        discovery, allowlist = self._load()
        spec = self._resolve(discovery.hooks, identity)
        if spec is None:
            return HookManagementResponse(
                ok=False,
                action="revoke",
                message=f"configured hook not found: {identity}",
                config_issues=_safe_config_issues(discovery.issues),
                allowlist_issues=allowlist.issues,
            )
        if allowlist.issues:
            return HookManagementResponse(
                ok=False,
                action="revoke",
                message="allowlist cannot be written until parse issues are fixed",
                hook=self._row(spec, discovery.issues, allowlist),
                config_issues=_safe_config_issues(discovery.issues),
                allowlist_issues=allowlist.issues,
            )
        try:
            removed = allowlist.revoke(spec)
        except (OSError, ValueError) as exc:
            return HookManagementResponse(
                ok=False,
                action="revoke",
                message=f"allowlist write failed: {exc}",
                hook=self._row(spec, discovery.issues, allowlist),
                config_issues=_safe_config_issues(discovery.issues),
                allowlist_issues=allowlist.issues,
            )
        refreshed = HookAllowlist(home_dir=self._home_dir)
        row = self._row(spec, discovery.issues, refreshed)
        return HookManagementResponse(
            ok=True,
            action="revoke",
            message=f"revoked {row.identity}" if removed else f"not approved {row.identity}",
            hook=row,
            hooks=(row,),
            config_issues=_safe_config_issues(discovery.issues),
            allowlist_issues=refreshed.issues,
            removed=removed,
        )

    def _load(self) -> tuple[HookConfigDiscovery, HookAllowlist]:
        discovery = HookConfigRegistry(
            workspace_root=self._workspace_root,
            home_dir=self._home_dir,
            shell_path=self._shell_path,
        ).discover()
        return discovery, HookAllowlist(home_dir=self._home_dir)

    def _rows(
        self,
        specs: tuple[ConfiguredHookSpec, ...],
        issues: tuple[HookConfigIssue, ...],
        allowlist: HookAllowlist,
    ) -> tuple[HookManagementRow, ...]:
        return tuple(self._row(spec, issues, allowlist) for spec in specs)

    def _row(
        self,
        spec: ConfiguredHookSpec,
        issues: tuple[HookConfigIssue, ...],
        allowlist: HookAllowlist,
    ) -> HookManagementRow:
        status = allowlist.status_for(spec)
        return HookManagementRow(
            source=spec.source.value,
            hook_id=spec.hook_id,
            hook_point=spec.hook_point.value,
            identity=hook_identity(spec),
            enabled=spec.enabled,
            timeout_seconds=spec.timeout_seconds,
            working_directory=spec.working_directory.value,
            env_policy=spec.env_policy.value,
            command_digest=command_digest(spec.command),
            allowlist_status="allowed" if status.allowed else "not_allowed",
            allowlist_reason=status.reason,
            config_path=str(spec.source_path or ""),
            config_issues=tuple(
                issue.safe_line()
                for issue in issues
                if spec.source_path is not None and issue.path == spec.source_path
            ),
            allowlist_issues=allowlist.issues,
        )

    def _resolve(
        self,
        specs: tuple[ConfiguredHookSpec, ...],
        identity: str,
    ) -> ConfiguredHookSpec | None:
        parsed = parse_hook_identity(identity)
        if parsed is None:
            return None
        source, hook_id, hook_point = parsed
        for spec in specs:
            if (
                spec.source.value == source
                and spec.hook_id == hook_id
                and spec.hook_point is hook_point
            ):
                return spec
        return None


def hook_identity(spec: ConfiguredHookSpec) -> str:
    return f"{spec.source.value}:{spec.hook_id}:{spec.hook_point.value}"


def parse_hook_identity(identity: str) -> tuple[str, str, HookPoint] | None:
    parts = identity.split(":")
    if len(parts) != 3:
        return None
    source, hook_id, hook_point_value = (part.strip() for part in parts)
    if source not in {"repo", "user"} or not hook_id:
        return None
    try:
        hook_point = HookPoint(hook_point_value)
    except ValueError:
        return None
    return source, hook_id, hook_point


def _safe_config_issues(issues: tuple[HookConfigIssue, ...]) -> tuple[str, ...]:
    return tuple(issue.safe_line() for issue in issues)
