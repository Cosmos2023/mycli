from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
import textwrap

import tomllib

from mycli.domain.skills import SkillDefinition, SkillMetadata


@dataclass(frozen=True, slots=True)
class SkillDirectory:
    root: Path
    source_kind: str


@dataclass(frozen=True, slots=True)
class SkillDiagnosticIssue:
    kind: str
    source_kind: str
    path_label: str
    message: str
    skill_name: str | None = None

    def safe_summary(self) -> str:
        prefix = f"{self.kind}:{self.path_label}"
        if self.skill_name:
            prefix = f"{prefix}:{self.skill_name}"
        return f"{prefix}:{self.message}"


@dataclass(frozen=True, slots=True)
class SkillRegistryDiagnostics:
    directory_count: int
    discovered_count: int
    loaded_count: int
    duplicate_count: int
    issue_count: int
    source_counts: tuple[tuple[str, int], ...]
    issues: tuple[SkillDiagnosticIssue, ...]

    @property
    def warning_count(self) -> int:
        return self.issue_count + self.duplicate_count

    def safe_detail(self, *, limit: int = 5) -> str:
        details = [f"{source}={count}" for source, count in self.source_counts]
        details.extend(issue.safe_summary() for issue in self.issues[:limit])
        if len(self.issues) > limit:
            details.append("...")
        return ", ".join(details)


class SkillRegistry:
    def __init__(
        self,
        builtin_root: Path,
        user_root: Path,
        *,
        shared_repo_root: Path | None = None,
        repo_root: Path | None = None,
    ) -> None:
        self._metadata: dict[str, SkillMetadata] = {}
        self._issues: list[SkillDiagnosticIssue] = []
        self._duplicates: dict[str, list[SkillMetadata]] = defaultdict(list)
        self._directories = (
            SkillDirectory(builtin_root, "builtin"),
            SkillDirectory(user_root, "user"),
            *(
                (SkillDirectory(shared_repo_root, "shared_repo"),)
                if shared_repo_root is not None
                else ()
            ),
            *((SkillDirectory(repo_root, "repo"),) if repo_root is not None else ()),
        )
        for directory in self._directories:
            self._load_directory(directory)

    def _load_directory(self, directory: SkillDirectory) -> None:
        root = directory.root
        if not root.exists():
            return
        for path in self._skill_paths(root):
            try:
                metadata = self._parse_metadata(path, source_kind=directory.source_kind)
            except Exception as exc:
                self._issues.append(
                    SkillDiagnosticIssue(
                        kind="invalid_skill",
                        source_kind=directory.source_kind,
                        path_label=path.name,
                        message=type(exc).__name__,
                    )
                )
                continue
            if metadata.name in self._metadata:
                self._duplicates[metadata.name].append(self._metadata[metadata.name])
                self._duplicates[metadata.name].append(metadata)
            self._metadata[metadata.name] = metadata

    def _skill_paths(self, root: Path) -> tuple[Path, ...]:
        return (
            *sorted(root.glob("*.md")),
            *sorted(root.glob("*/SKILL.md")),
        )

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

    def _parse_metadata(self, path: Path, *, source_kind: str) -> SkillMetadata:
        _, payload, _ = self._split_skill_file(path)
        name = str(payload["name"]).strip()
        description = str(payload["description"]).strip()
        if not name:
            raise ValueError("skill name cannot be blank")
        if not description:
            raise ValueError("skill description cannot be blank")
        return SkillMetadata(
            name=name,
            description=description,
            trigger_hints=self._coerce_trigger_hints(payload),
            source_path=str(path),
            source_kind=source_kind,
            env_dependencies=self._coerce_dependencies(payload, "env_dependencies"),
            workspace_dependencies=self._coerce_dependencies(payload, "workspace_dependencies"),
            guardrails=self._coerce_dependencies(payload, "guardrails"),
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
            source_kind=metadata.source_kind,
            env_dependencies=self._coerce_dependencies(payload, "env_dependencies"),
            workspace_dependencies=self._coerce_dependencies(payload, "workspace_dependencies"),
            guardrails=self._coerce_dependencies(payload, "guardrails"),
        )

    def get(self, name: str) -> SkillDefinition | None:
        return self.load(name)

    def get_metadata(self, name: str) -> SkillMetadata | None:
        return self._metadata.get(name)

    def list_names(self) -> list[str]:
        return sorted(self._metadata)

    def list_metadata(self) -> tuple[SkillMetadata, ...]:
        return tuple(self._metadata[name] for name in self.list_names())

    def diagnostics(self) -> SkillRegistryDiagnostics:
        source_counts = Counter(metadata.source_kind for metadata in self._metadata.values())
        duplicate_names = {
            name: {metadata.source_path for metadata in values}
            for name, values in self._duplicates.items()
        }
        duplicate_issues = tuple(
            SkillDiagnosticIssue(
                kind="duplicate_skill",
                source_kind="mixed",
                path_label=name,
                message=f"{len(paths)} definitions",
                skill_name=name,
            )
            for name, paths in sorted(duplicate_names.items())
        )
        issues = (*duplicate_issues, *self._issues)
        return SkillRegistryDiagnostics(
            directory_count=len(self._directories),
            discovered_count=len(self._metadata) + sum(len(paths) - 1 for paths in duplicate_names.values()),
            loaded_count=len(self._metadata),
            duplicate_count=len(duplicate_issues),
            issue_count=len(self._issues),
            source_counts=tuple(sorted(source_counts.items())),
            issues=issues,
        )
