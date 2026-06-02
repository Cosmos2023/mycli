from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mycli.services.plugins.config import PluginEnablement, load_plugin_enablement
from mycli.services.plugins.manifest import (
    PluginCandidate,
    PluginIssue,
    PluginSource,
    parse_plugin_manifest,
)


@dataclass(slots=True, frozen=True)
class PluginDiscovery:
    candidates: tuple[PluginCandidate, ...]
    selected: tuple[PluginCandidate, ...]
    issues: tuple[PluginIssue, ...]
    enablement: PluginEnablement


def discover_plugins(*, workspace_root: Path, home_dir: Path) -> PluginDiscovery:
    enablement = load_plugin_enablement(workspace_root=workspace_root, home_dir=home_dir)
    candidates: list[PluginCandidate] = []
    issues: list[PluginIssue] = []
    for source, root in (
        (PluginSource.REPO, workspace_root / ".mycli" / "plugins"),
        (PluginSource.USER, home_dir / ".mycli" / "plugins"),
    ):
        for path in _plugin_dirs(root):
            plugin_id = path.name
            manifest, manifest_issues = parse_plugin_manifest(
                plugin_id=plugin_id,
                source=source,
                path=path,
            )
            candidate = PluginCandidate(
                plugin_id=plugin_id,
                source=source,
                path=path,
                manifest_path=path / "plugin.yaml",
                module_path=path / "__init__.py",
                manifest=manifest,
                issues=manifest_issues,
            )
            candidates.append(candidate)
            issues.extend(manifest_issues)

    selected_by_id: dict[str, PluginCandidate] = {}
    duplicate_ids: set[str] = set()
    duplicate_names: dict[str, list[str]] = {}
    for candidate in candidates:
        existing = selected_by_id.get(candidate.plugin_id)
        if existing is not None:
            duplicate_ids.add(candidate.plugin_id)
            if _source_priority(candidate.source) >= _source_priority(existing.source):
                selected_by_id[candidate.plugin_id] = candidate
        else:
            selected_by_id[candidate.plugin_id] = candidate
        duplicate_names.setdefault(candidate.name, []).append(candidate.plugin_id)

    selected = tuple(
        selected_by_id[plugin_id]
        for plugin_id in sorted(selected_by_id)
    )
    duplicate_selected = tuple(
        _with_duplicate(candidate, duplicate_ids)
        for candidate in selected
    )
    for plugin_id in sorted(duplicate_ids):
        issues.append(PluginIssue(plugin_id, None, None, "duplicate plugin id; user source overrides repo"))
    for name, ids in sorted(duplicate_names.items()):
        unique_ids = sorted(set(ids))
        if len(unique_ids) > 1:
            issues.append(PluginIssue(
                ",".join(unique_ids),
                None,
                None,
                f"duplicate plugin name: {name}",
            ))
    for issue in enablement.issues:
        issues.append(PluginIssue("config", None, None, issue))
    return PluginDiscovery(
        candidates=tuple(candidates),
        selected=duplicate_selected,
        issues=tuple(issues),
        enablement=enablement,
    )


def _plugin_dirs(root: Path) -> tuple[Path, ...]:
    if not root.exists() or not root.is_dir():
        return ()
    return tuple(sorted(path for path in root.iterdir() if path.is_dir()))


def _source_priority(source: PluginSource) -> int:
    return 2 if source is PluginSource.USER else 1


def _with_duplicate(candidate: PluginCandidate, duplicate_ids: set[str]) -> PluginCandidate:
    if candidate.plugin_id not in duplicate_ids:
        return candidate
    return PluginCandidate(
        plugin_id=candidate.plugin_id,
        source=candidate.source,
        path=candidate.path,
        manifest_path=candidate.manifest_path,
        module_path=candidate.module_path,
        manifest=candidate.manifest,
        issues=candidate.issues,
        duplicate=True,
    )
