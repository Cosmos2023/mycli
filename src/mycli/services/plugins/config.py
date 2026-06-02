from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tomllib


@dataclass(slots=True, frozen=True)
class PluginEnablement:
    enabled: frozenset[str]
    disabled: frozenset[str]
    issues: tuple[str, ...] = ()

    def is_enabled(self, plugin_id: str) -> bool:
        return plugin_id in self.enabled and plugin_id not in self.disabled


def load_plugin_enablement(*, workspace_root: Path, home_dir: Path) -> PluginEnablement:
    enabled: set[str] = set()
    disabled: set[str] = set()
    issues: list[str] = []
    for label, path in (
        ("user", home_dir / ".config" / "mycli" / "config.toml"),
        ("repo", workspace_root / ".mycli" / "config.toml"),
    ):
        payload, issue = _read_toml(path)
        if issue:
            issues.append(f"{label}:{path.name}: {issue}")
            continue
        plugins = payload.get("plugins")
        if plugins is None:
            continue
        if not isinstance(plugins, dict):
            issues.append(f"{label}:{path.name}: plugins must be a table")
            continue
        enabled.update(_string_set(plugins.get("enabled")))
        disabled.update(_string_set(plugins.get("disabled")))
    return PluginEnablement(
        enabled=frozenset(enabled),
        disabled=frozenset(disabled),
        issues=tuple(issues),
    )


def _read_toml(path: Path) -> tuple[dict[str, object], str | None]:
    if not path.exists():
        return {}, None
    try:
        with path.open("rb") as handle:
            payload = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        return {}, f"not parseable: {exc.__class__.__name__}"
    return payload, None


def _string_set(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {item.strip() for item in value if isinstance(item, str) and item.strip()}
