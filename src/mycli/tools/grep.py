from __future__ import annotations

import os
from pathlib import Path
import subprocess
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolEvidence
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.path_utils import resolve_workspace_path


EXCLUDE_DIRS = [".git", "node_modules", "__pycache__", ".venv", "dist", "build"]


def grep(
    pattern: str,
    path: str | None = None,
    output_mode: str = "files_with_matches",
    include: str | None = None,
    context: int = 3,
    head_limit: int = 50,
    ignore_case: bool = False,
) -> dict[str, Any]:
    args = ["rg", "--no-heading", "--color", "never", "--with-filename"]

    for directory in EXCLUDE_DIRS:
        args.extend(["--glob", f"!{directory}"])

    if output_mode == "files_with_matches":
        args.append("--files-with-matches")
    elif output_mode == "content":
        args.extend(["-n", "-C", str(context)])
    else:
        return {"error": f"[Unsupported grep output_mode: {output_mode}]"}

    if include:
        args.extend(["--glob", include])
    if ignore_case:
        args.append("-i")

    args.extend(["--", pattern])
    if path:
        args.append(path)

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=os.getcwd(),
            check=False,
        )
    except FileNotFoundError:
        return {"error": "[ripgrep (rg) not installed. Install: brew install ripgrep]"}
    except subprocess.TimeoutExpired:
        return {"error": "[Grep timed out. Narrow your search path.]"}

    lines = result.stdout.splitlines()
    truncated = len(lines) > head_limit

    return {
        "matches": lines[:head_limit],
        "count": len(lines),
        "truncated": truncated,
        "mode": output_mode,
    }


class GrepTool:
    name = "Grep"
    spec = ToolSpec(
        name="Grep",
        description="Search files using ripgrep. Defaults to returning files with matches; use output_mode=content for matching lines.",
        parameters=(
            ToolParameter(name="pattern", type="string", required=True),
            ToolParameter(name="path", type="string", required=False),
            ToolParameter(name="output_mode", type="string", required=False),
            ToolParameter(name="include", type="string", required=False),
            ToolParameter(name="context", type="integer", required=False),
            ToolParameter(name="head_limit", type="integer", required=False),
            ToolParameter(name="ignore_case", type="boolean", required=False),
        ),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="read")

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        pattern = str(arguments.get("pattern") or arguments.get("query") or "")
        if not pattern:
            return ToolResult(success=False, summary="Failed to grep", error="Grep requires pattern.")

        raw_path = str(arguments.get("path", "."))
        try:
            search_path = resolve_workspace_path(self._workspace_root, raw_path)
        except ValueError as exc:
            return ToolResult(success=False, summary="Failed to grep", error=str(exc))

        payload = grep(
            pattern,
            path=str(search_path),
            output_mode=str(arguments.get("output_mode", "files_with_matches")),
            include=arguments.get("include") if isinstance(arguments.get("include"), str) else None,
            context=int(arguments.get("context", 3)),
            head_limit=int(arguments.get("head_limit", arguments.get("max_matches", 50))),
            ignore_case=bool(arguments.get("ignore_case", False)),
        )
        if "error" in payload:
            return ToolResult(
                success=False,
                summary=f"Failed to grep for {pattern}",
                error=str(payload["error"]),
                raw_payload=payload,
            )
        return ToolResult(
            success=True,
            summary=f"Found {payload['count']} matches for {pattern}",
            raw_payload={
                "query": pattern,
                "path": raw_path,
                "matches": payload["matches"],
                **payload,
            },
            evidence=self._evidence(pattern, payload.get("matches", [])),
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)

    def _evidence(self, pattern: str, matches: object) -> tuple[ToolEvidence, ...]:
        if not isinstance(matches, list):
            return ()
        evidence: list[ToolEvidence] = []
        for index, match in enumerate(matches[:8], start=1):
            if not isinstance(match, str):
                continue
            if ":" not in match:
                continue
            parts = match.split(":", 2)
            if len(parts) >= 3 and parts[1].isdigit():
                path, line_number, line = parts[0], int(parts[1]), parts[2]
                display_path = self._display_path(path)
                evidence.append(
                    ToolEvidence(
                        kind="search_match",
                        title=f'Match {index} for "{pattern}"',
                        path=display_path,
                        line_start=line_number,
                        line_end=line_number,
                        snippet=line,
                        metadata={"query": pattern},
                    )
                )
        return tuple(evidence)

    def _display_path(self, path: str) -> str:
        try:
            return str(Path(path).resolve().relative_to(self._workspace_root.resolve()))
        except ValueError:
            return path
