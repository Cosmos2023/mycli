from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import unicodedata


_MAX_CONTEXT_CHARS = 24_000
_TRUNCATION_MARKER = "\n[context file truncated]\n"
_CONTROL_CATEGORIES = frozenset({"Cc", "Cf"})
_SAFE_CONTROL_CHARS = frozenset({"\n", "\r", "\t"})
_INJECTION_PATTERNS = (
    re.compile(r"(?i)\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b"),
    re.compile(r"(?i)\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b"),
    re.compile(r"(?i)\boverride\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|instructions)\b"),
    re.compile(r"(?i)\breveal\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|instructions)\b"),
)
_SOURCE_GROUPS = (
    (".mycli", (".mycli.md", "MYCLI.md"), True),
    ("agents", ("AGENTS.md", "agents.md"), False),
    ("claude", ("CLAUDE.md", "claude.md"), False),
    ("cursor", (".cursorrules",), False),
)


@dataclass(frozen=True, slots=True)
class ContextFileDiagnostics:
    selected_source: str | None
    path: str | None
    search_roots: tuple[str, ...]
    truncated: bool
    original_length: int
    rendered_length: int
    blocked: bool
    issues: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "selected_source": self.selected_source,
            "path": self.path,
            "search_roots": self.search_roots,
            "truncated": self.truncated,
            "original_length": self.original_length,
            "rendered_length": self.rendered_length,
            "blocked": self.blocked,
            "issues": self.issues,
        }


@dataclass(frozen=True, slots=True)
class LoadedContextFile:
    content: str
    diagnostics: ContextFileDiagnostics


class ContextFileLoader:
    def __init__(self, *, max_chars: int = _MAX_CONTEXT_CHARS) -> None:
        self._max_chars = max(0, max_chars)

    def load(self, *, workspace_root: Path, cwd: Path | None = None) -> LoadedContextFile:
        root = workspace_root.resolve()
        start = (cwd or root).resolve()
        if not _is_relative_to(start, root):
            start = root
        search_roots = _search_roots(start=start, workspace_root=root)
        issues: list[str] = []

        for source, names, upward in _SOURCE_GROUPS:
            roots = search_roots if upward else tuple(dict.fromkeys((start, root)))
            for directory in roots:
                for name in names:
                    path = directory / name
                    if not path.is_file():
                        continue
                    try:
                        raw_content = path.read_text(encoding="utf-8")
                    except UnicodeDecodeError:
                        raw_content = path.read_text(encoding="utf-8", errors="replace")
                        issues.append("decode_replacement")
                    except OSError as exc:
                        return LoadedContextFile(
                            content="",
                            diagnostics=ContextFileDiagnostics(
                                selected_source=source,
                                path=str(path),
                                search_roots=tuple(str(item) for item in search_roots),
                                truncated=False,
                                original_length=0,
                                rendered_length=0,
                                blocked=True,
                                issues=(f"read_error:{exc.__class__.__name__}",),
                            ),
                        )
                    return self._loaded(
                        source=source,
                        path=path,
                        search_roots=search_roots,
                        raw_content=raw_content,
                        issues=tuple(issues),
                    )

        return LoadedContextFile(
            content="",
            diagnostics=ContextFileDiagnostics(
                selected_source=None,
                path=None,
                search_roots=tuple(str(item) for item in search_roots),
                truncated=False,
                original_length=0,
                rendered_length=0,
                blocked=False,
                issues=(),
            ),
        )

    def _loaded(
        self,
        *,
        source: str,
        path: Path,
        search_roots: tuple[Path, ...],
        raw_content: str,
        issues: tuple[str, ...],
    ) -> LoadedContextFile:
        scan_issues = _scan_context_content(raw_content)
        original_length = len(raw_content)
        if scan_issues:
            rendered = (
                "[Project context file blocked]\n"
                "The selected context file was not injected because it contains "
                "obvious instruction-hijack or invisible-control content."
            )
            return LoadedContextFile(
                content=rendered,
                diagnostics=ContextFileDiagnostics(
                    selected_source=source,
                    path=str(path),
                    search_roots=tuple(str(item) for item in search_roots),
                    truncated=False,
                    original_length=original_length,
                    rendered_length=len(rendered),
                    blocked=True,
                    issues=(*issues, *scan_issues),
                ),
            )

        rendered, truncated = _truncate_middle(raw_content.strip(), self._max_chars)
        return LoadedContextFile(
            content=rendered,
            diagnostics=ContextFileDiagnostics(
                selected_source=source,
                path=str(path),
                search_roots=tuple(str(item) for item in search_roots),
                truncated=truncated,
                original_length=original_length,
                rendered_length=len(rendered),
                blocked=False,
                issues=issues,
            ),
        )


def _search_roots(*, start: Path, workspace_root: Path) -> tuple[Path, ...]:
    git_root = _git_root(start) or _git_root(workspace_root)
    boundary = git_root if git_root and _is_relative_to(workspace_root, git_root) else workspace_root
    roots: list[Path] = []
    current = start
    while True:
        roots.append(current)
        if current == boundary or current == current.parent:
            break
        if not _is_relative_to(current.parent, boundary):
            break
        current = current.parent
    if workspace_root not in roots:
        roots.append(workspace_root)
    return tuple(dict.fromkeys(roots))


def _git_root(path: Path) -> Path | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    if not value:
        return None
    return Path(value).resolve()


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _scan_context_content(content: str) -> tuple[str, ...]:
    issues: list[str] = []
    for pattern in _INJECTION_PATTERNS:
        if pattern.search(content):
            issues.append("instruction_hijack_phrase")
            break
    if any(
        character not in _SAFE_CONTROL_CHARS
        and unicodedata.category(character) in _CONTROL_CATEGORIES
        for character in content
    ):
        issues.append("invisible_control_character")
    return tuple(issues)


def _truncate_middle(content: str, max_chars: int) -> tuple[str, bool]:
    if max_chars <= 0 or len(content) <= max_chars:
        return content, False
    marker = _TRUNCATION_MARKER
    keep = max(0, max_chars - len(marker))
    head = keep // 2
    tail = keep - head
    return f"{content[:head]}{marker}{content[-tail:]}", True
