from __future__ import annotations

from pathlib import Path
import shlex

from mycli.tools.lint import lint


class WriteDiagnosticsService:
    """Runs bounded local diagnostics for files changed by structured writes."""

    def __init__(self, *, workspace_root: Path, shell_path: str | None = None) -> None:
        self._workspace_root = workspace_root
        self._shell_path = shell_path

    def run(self, paths: tuple[str, ...]) -> dict[str, object]:
        if not paths:
            return {"diagnostics": [], "count": 0, "truncated": False}
        quoted_paths = " ".join(shlex.quote(path) for path in paths)
        return lint(
            paths=quoted_paths,
            cwd=self._workspace_root,
            shell_path=self._shell_path,
        )
