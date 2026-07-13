from __future__ import annotations

from pathlib import Path

from mycli.domain.runtime import ShellProfile
from mycli.tools.lint import lint


class WriteDiagnosticsService:
    """Runs bounded local diagnostics for files changed by structured writes."""

    def __init__(
        self,
        *,
        workspace_root: Path,
        shell_path: str | None = None,
        shell_profile: ShellProfile | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._shell_path = shell_path
        self._shell_profile = shell_profile

    def configure_shell_profile(self, shell_profile: ShellProfile) -> None:
        self._shell_profile = shell_profile

    def run(self, paths: tuple[str, ...]) -> dict[str, object]:
        if not paths:
            return {"diagnostics": [], "count": 0, "truncated": False}
        return lint(
            paths=paths,
            cwd=self._workspace_root,
            shell_path=self._shell_path,
            shell_profile=self._shell_profile,
        )
