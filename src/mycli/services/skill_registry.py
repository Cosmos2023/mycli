from __future__ import annotations

from pathlib import Path
import textwrap

import tomllib

from mycli.domain.skills import SkillDefinition, SkillMetadata


class SkillRegistry:
    def __init__(self, builtin_root: Path, user_root: Path) -> None:
        self._metadata: dict[str, SkillMetadata] = {}
        self._load_directory(builtin_root)
        self._load_directory(user_root)

    def _load_directory(self, root: Path) -> None:
        if not root.exists():
            return
        for path in sorted(root.glob("*.md")):
            metadata = self._parse_metadata(path)
            self._metadata[metadata.name] = metadata

    def _split_skill_file(self, path: Path) -> tuple[str, dict[str, object], str]:
        raw_text = path.read_text(encoding="utf-8")
        _, frontmatter, body = raw_text.split("---", maxsplit=2)
        payload = tomllib.loads(frontmatter)
        return raw_text, payload, body

    def _coerce_trigger_hints(self, payload: dict[str, object]) -> tuple[str, ...]:
        raw_hints = payload.get("trigger_hints", [])
        if not isinstance(raw_hints, list):
            return ()
        return tuple(str(item) for item in raw_hints)

    def _coerce_dependencies(self, payload: dict[str, object], key: str) -> tuple[str, ...]:
        raw_values = payload.get(key, [])
        if not isinstance(raw_values, list):
            return ()
        return tuple(str(item) for item in raw_values)

    def _parse_metadata(self, path: Path) -> SkillMetadata:
        _, payload, _ = self._split_skill_file(path)
        return SkillMetadata(
            name=str(payload["name"]),
            description=str(payload["description"]),
            trigger_hints=self._coerce_trigger_hints(payload),
            source_path=str(path),
            env_dependencies=self._coerce_dependencies(payload, "env_dependencies"),
            workspace_dependencies=self._coerce_dependencies(payload, "workspace_dependencies"),
        )

    def load(self, name: str) -> SkillDefinition | None:
        metadata = self._metadata.get(name)
        if metadata is None:
            return None
        path = Path(metadata.source_path)
        _, payload, body = self._split_skill_file(path)
        return SkillDefinition(
            name=str(payload["name"]),
            description=str(payload["description"]),
            trigger_hints=self._coerce_trigger_hints(payload),
            body=textwrap.dedent(body).strip(),
            source_path=str(path),
            env_dependencies=self._coerce_dependencies(payload, "env_dependencies"),
            workspace_dependencies=self._coerce_dependencies(payload, "workspace_dependencies"),
        )

    def get(self, name: str) -> SkillDefinition | None:
        return self.load(name)

    def get_metadata(self, name: str) -> SkillMetadata | None:
        return self._metadata.get(name)

    def list_names(self) -> list[str]:
        return sorted(self._metadata)
