from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from mycli.domain.tools import ToolCall, ToolEvidence, ToolResult
from mycli.infrastructure.shell_adapter import run_command
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import resolve_workspace_path


class SearchTextTool:
    name = "search_text"
    spec = ToolSpec(
        name="search_text",
        description="Search UTF-8 text files in the workspace with rg-style filters.",
        parameters=(
            ToolParameter(name="query", type="string", required=True),
            ToolParameter(name="path", type="string", required=False),
            ToolParameter(name="glob", type="string", required=False),
            ToolParameter(name="case_sensitive", type="boolean", required=False),
            ToolParameter(name="max_matches", type="integer", required=False),
        ),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        try:
            query = str(arguments["query"])
            if not query:
                raise ValueError("search_text requires a non-empty query.")
            search_root = resolve_workspace_path(
                self._workspace_root,
                str(arguments.get("path", ".")),
            )
            if not search_root.exists():
                raise ValueError("Search path does not exist.")
            glob_pattern = str(arguments.get("glob", "*"))
            case_sensitive = bool(arguments.get("case_sensitive", False))
            max_matches = int(arguments.get("max_matches", 200))
            if max_matches < 1:
                raise ValueError("max_matches must be at least 1.")
        except (KeyError, ValueError) as exc:
            return ToolResultV2(
                success=False,
                summary="Failed to search text",
                error=str(exc),
            )

        rg_binary = shutil.which("rg")
        if rg_binary:
            result = self._search_with_rg(
                query=query,
                search_root=search_root,
                glob_pattern=glob_pattern,
                case_sensitive=case_sensitive,
                max_matches=max_matches,
            )
            if result is not None:
                return result

        matches = self._search_with_python(
            query=query,
            search_root=search_root,
            glob_pattern=glob_pattern,
            case_sensitive=case_sensitive,
            max_matches=max_matches,
        )
        return ToolResultV2(
            success=True,
            summary=f"Found {len(matches)} matches for {query}",
            raw_payload={
                "matches": matches,
                "query": query,
                "path": str(arguments.get("path", ".")),
                "glob": glob_pattern,
                "case_sensitive": case_sensitive,
                "max_matches": max_matches,
            },
            evidence=self._build_match_evidence(
                matches=matches,
                query=query,
                glob_pattern=glob_pattern,
                case_sensitive=case_sensitive,
            ),
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()

    def _search_with_rg(
        self,
        *,
        query: str,
        search_root: Path,
        glob_pattern: str,
        case_sensitive: bool,
        max_matches: int,
    ) -> ToolResultV2 | None:
        args = ["rg", "-n", "--no-heading", "--color", "never", "-m", str(max_matches)]
        args.append("--case-sensitive" if case_sensitive else "--ignore-case")
        if glob_pattern != "*":
            args.extend(["-g", glob_pattern])
        try:
            scope_arg = str(search_root.relative_to(self._workspace_root))
        except ValueError:
            scope_arg = str(search_root)
        if not scope_arg:
            scope_arg = "."
        args.extend([query, scope_arg])

        completed = run_command(args, cwd=self._workspace_root)
        if completed.returncode not in (0, 1):
            return None

        matches: list[dict[str, object]] = []
        for line in completed.stdout.splitlines():
            parts = line.split(":", 2)
            path_part: str
            line_number_part: str
            content: str
            if len(parts) == 3:
                path_part, line_number_part, content = parts
            elif len(parts) == 2 and search_root.is_file():
                path_part = str(search_root.relative_to(self._workspace_root))
                line_number_part, content = parts
            else:
                continue
            try:
                line_number = int(line_number_part)
            except ValueError:
                continue
            matches.append(
                {
                    "path": self._normalize_match_path(path_part),
                    "line_number": line_number,
                    "line": content,
                }
            )

        return ToolResultV2(
            success=True,
            summary=f"Found {len(matches)} matches for {query}",
            raw_payload={
                "matches": matches,
                "query": query,
                "path": scope_arg,
                "glob": glob_pattern,
                "case_sensitive": case_sensitive,
                "max_matches": max_matches,
            },
            evidence=self._build_match_evidence(
                matches=matches,
                query=query,
                glob_pattern=glob_pattern,
                case_sensitive=case_sensitive,
            ),
        )

    def _build_match_evidence(
        self,
        *,
        matches: list[dict[str, object]],
        query: str,
        glob_pattern: str,
        case_sensitive: bool,
    ) -> tuple[ToolEvidence, ...]:
        evidence: list[ToolEvidence] = []
        for index, match in enumerate(matches[:8], start=1):
            path = match.get("path")
            line_number = match.get("line_number")
            line = match.get("line")
            if not isinstance(path, str):
                continue
            if not isinstance(line_number, int):
                continue
            if not isinstance(line, str):
                continue
            evidence.append(
                ToolEvidence(
                    kind="search_match",
                    title=f'Match {index} for "{query}"',
                    path=path,
                    line_start=line_number,
                    line_end=line_number,
                    snippet=line,
                    metadata={
                        "query": query,
                        "glob": glob_pattern,
                        "case_sensitive": case_sensitive,
                    },
                )
            )
        return tuple(evidence)

    def _search_with_python(
        self,
        *,
        query: str,
        search_root: Path,
        glob_pattern: str,
        case_sensitive: bool,
        max_matches: int,
    ) -> list[dict[str, object]]:
        needle = query if case_sensitive else query.lower()
        matches: list[dict[str, object]] = []
        for path in self._iter_search_paths(search_root=search_root, glob_pattern=glob_pattern):
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for line_number, line in enumerate(text.splitlines(), start=1):
                haystack = line if case_sensitive else line.lower()
                if needle not in haystack:
                    continue
                matches.append(
                    {
                        "path": str(path.relative_to(self._workspace_root)),
                        "line_number": line_number,
                        "line": line,
                    }
                )
                if len(matches) >= max_matches:
                    return matches
        return matches

    def _normalize_match_path(self, path_part: str) -> str:
        if path_part.startswith("./"):
            return path_part[2:]
        try:
            path = Path(path_part)
            if not path.is_absolute():
                return path_part
            return str(path.relative_to(self._workspace_root))
        except ValueError:
            return path_part

    def _iter_search_paths(self, *, search_root: Path, glob_pattern: str) -> list[Path]:
        if search_root.is_file():
            if search_root.match(glob_pattern):
                return [search_root]
            return []
        return [path for path in search_root.rglob(glob_pattern) if path.is_file()]
