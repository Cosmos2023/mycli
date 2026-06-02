from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mycli.services.hooks import HookManager
from mycli.services.plugins.manifest import PluginCandidate, PluginIssue, PluginLoadStatus
from mycli.services.plugins.runtime import load_enabled_plugins
from mycli.tools.registry import ToolRegistry


@dataclass(slots=True, frozen=True)
class PluginManagementRow:
    source: str
    plugin_id: str
    name: str
    version: str
    kind: str
    enabled: bool
    load_status: str
    provided_tools: tuple[str, ...]
    provided_hooks: tuple[str, ...]
    issues: tuple[str, ...]
    path: str

    def to_dict(self) -> dict[str, object]:
        return {
            "source": self.source,
            "plugin_id": self.plugin_id,
            "name": self.name,
            "version": self.version,
            "kind": self.kind,
            "enabled": self.enabled,
            "load_status": self.load_status,
            "provided_tools": list(self.provided_tools),
            "provided_hooks": list(self.provided_hooks),
            "issues": list(self.issues),
            "path": self.path,
        }


@dataclass(slots=True, frozen=True)
class PluginManagementResponse:
    ok: bool
    action: str
    message: str
    plugins: tuple[PluginManagementRow, ...] = ()
    plugin: PluginManagementRow | None = None
    issues: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "ok": self.ok,
            "action": self.action,
            "message": self.message,
            "plugins": [row.to_dict() for row in self.plugins],
            "issues": list(self.issues),
        }
        if self.plugin is not None:
            payload["plugin"] = self.plugin.to_dict()
        return payload


class PluginManagementService:
    def __init__(self, *, workspace_root: Path, home_dir: Path, env: dict[str, str]) -> None:
        self._workspace_root = workspace_root
        self._home_dir = home_dir
        self._env = env

    def list_plugins(self) -> PluginManagementResponse:
        rows, issues = self._rows()
        return PluginManagementResponse(
            ok=True,
            action="list",
            message=f"plugins: {len(rows)}",
            plugins=rows,
            issues=issues,
        )

    def inspect_plugin(self, plugin_id: str) -> PluginManagementResponse:
        rows, issues = self._rows()
        for row in rows:
            if row.plugin_id == plugin_id:
                return PluginManagementResponse(
                    ok=True,
                    action="inspect",
                    message=f"plugin: {plugin_id}",
                    plugin=row,
                    plugins=(row,),
                    issues=issues,
                )
        return PluginManagementResponse(
            ok=False,
            action="inspect",
            message=f"plugin not found: {plugin_id}",
            issues=issues,
        )

    def _rows(self) -> tuple[tuple[PluginManagementRow, ...], tuple[str, ...]]:
        state = load_enabled_plugins(
            workspace_root=self._workspace_root,
            home_dir=self._home_dir,
            hook_manager=HookManager(),
            tool_registry=ToolRegistry(workspace_root=self._workspace_root),
            env=self._env,
        )
        loaded_by_id = {item.plugin_id: item for item in state.loaded}
        rows = tuple(
            _row_for(
                candidate,
                enabled=state.discovery.enablement.is_enabled(candidate.plugin_id),
                load_status=(
                    loaded_by_id[candidate.plugin_id].status
                    if candidate.plugin_id in loaded_by_id
                    else PluginLoadStatus.DISCOVERED
                ),
                registered_tools=(
                    loaded_by_id[candidate.plugin_id].registered_tools
                    if candidate.plugin_id in loaded_by_id
                    else ()
                ),
                registered_hooks=(
                    loaded_by_id[candidate.plugin_id].registered_hooks
                    if candidate.plugin_id in loaded_by_id
                    else ()
                ),
                issues=tuple(candidate.issues)
                + (loaded_by_id[candidate.plugin_id].issues if candidate.plugin_id in loaded_by_id else ()),
            )
            for candidate in state.discovery.selected
        )
        issues = tuple(issue.safe_line() for issue in state.issues)
        return rows, issues


def _row_for(
    candidate: PluginCandidate,
    *,
    enabled: bool,
    load_status: PluginLoadStatus,
    registered_tools: tuple[str, ...],
    registered_hooks: tuple[str, ...],
    issues: tuple[PluginIssue, ...],
) -> PluginManagementRow:
    manifest = candidate.manifest
    manifest_tools = manifest.provides_tools if manifest is not None else ()
    manifest_hooks = manifest.provides_hooks if manifest is not None else ()
    return PluginManagementRow(
        source=candidate.source.value,
        plugin_id=candidate.plugin_id,
        name=manifest.name if manifest is not None else candidate.plugin_id,
        version=manifest.version if manifest is not None else "",
        kind=manifest.kind if manifest is not None else "unknown",
        enabled=enabled,
        load_status=load_status.value,
        provided_tools=tuple(sorted(set(manifest_tools) | set(registered_tools))),
        provided_hooks=tuple(sorted(set(manifest_hooks) | set(registered_hooks))),
        issues=tuple(issue.safe_line() for issue in issues),
        path=str(candidate.path),
    )
