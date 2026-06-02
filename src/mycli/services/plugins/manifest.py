from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

import yaml  # type: ignore[import-untyped]


class PluginSource(StrEnum):
    USER = "user"
    REPO = "repo"


class PluginLoadStatus(StrEnum):
    DISCOVERED = "discovered"
    DISABLED = "disabled"
    LOADED = "loaded"
    ERROR = "error"


@dataclass(slots=True, frozen=True)
class PluginManifest:
    plugin_id: str
    name: str
    version: str = ""
    description: str = ""
    kind: str = "standalone"
    provides_tools: tuple[str, ...] = ()
    provides_hooks: tuple[str, ...] = ()
    requires_env: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "plugin_id": self.plugin_id,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "kind": self.kind,
            "provides_tools": list(self.provides_tools),
            "provides_hooks": list(self.provides_hooks),
            "requires_env": list(self.requires_env),
        }


@dataclass(slots=True, frozen=True)
class PluginIssue:
    plugin_id: str
    source: PluginSource | None
    path: Path | None
    message: str

    def safe_line(self) -> str:
        source = self.source.value if self.source is not None else "unknown"
        location = self.path.name if self.path is not None else "plugins"
        return f"{source}:{self.plugin_id}:{location}: {_safe_message(self.message)}"


@dataclass(slots=True, frozen=True)
class PluginCandidate:
    plugin_id: str
    source: PluginSource
    path: Path
    manifest_path: Path
    module_path: Path
    manifest: PluginManifest | None
    issues: tuple[PluginIssue, ...] = ()
    duplicate: bool = False

    @property
    def name(self) -> str:
        return self.manifest.name if self.manifest is not None else self.plugin_id


def parse_plugin_manifest(*, plugin_id: str, source: PluginSource, path: Path) -> tuple[PluginManifest | None, tuple[PluginIssue, ...]]:
    manifest_path = path / "plugin.yaml"
    if not manifest_path.exists():
        return None, (PluginIssue(plugin_id, source, manifest_path, "plugin.yaml missing"),)
    try:
        payload = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        return None, (PluginIssue(plugin_id, source, manifest_path, f"manifest not parseable: {exc.__class__.__name__}"),)
    if not isinstance(payload, dict):
        return None, (PluginIssue(plugin_id, source, manifest_path, "manifest root must be an object"),)
    name = _string(payload.get("name")) or plugin_id
    version = _string(payload.get("version")) or ""
    description = _string(payload.get("description")) or ""
    kind = _string(payload.get("kind")) or "standalone"
    provides_tools = _string_tuple(payload.get("provides_tools"))
    provides_hooks = _string_tuple(payload.get("provides_hooks"))
    requires_env = _requires_env(payload.get("requires_env"))
    issues: list[PluginIssue] = []
    for key, value in (
        ("provides_tools", payload.get("provides_tools")),
        ("provides_hooks", payload.get("provides_hooks")),
        ("requires_env", payload.get("requires_env")),
    ):
        if value is not None and not isinstance(value, list):
            issues.append(PluginIssue(plugin_id, source, manifest_path, f"{key} must be a list"))
    module_path = path / "__init__.py"
    if not module_path.exists():
        issues.append(PluginIssue(plugin_id, source, module_path, "__init__.py missing"))
    manifest = PluginManifest(
        plugin_id=plugin_id,
        name=name,
        version=version,
        description=description,
        kind=kind,
        provides_tools=provides_tools,
        provides_hooks=provides_hooks,
        requires_env=requires_env,
    )
    return manifest, tuple(issues)


def _string(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _string_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item.strip() for item in value if isinstance(item, str) and item.strip())


def _requires_env(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    names: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            names.append(item.strip())
        elif isinstance(item, dict):
            name = item.get("name")
            if isinstance(name, str) and name.strip():
                names.append(name.strip())
    return tuple(names)


def _safe_message(message: str) -> str:
    normalized = " ".join(message.split())
    lowered = normalized.lower()
    if lowered.startswith("missing required env:"):
        return normalized[:180]
    if any(part in lowered for part in ("api_key", "apikey", "token", "secret", "password", "bearer ")):
        return "redacted"
    return normalized[:180]
