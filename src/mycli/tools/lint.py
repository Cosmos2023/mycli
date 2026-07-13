from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any, Callable

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.shell_resolver import ShellCommandConfig, resolve_shell


PROJECT_LINTERS = {
    "pyproject.toml": ["ruff check --output-format json"],
    "setup.py": ["ruff check --output-format json"],
    "setup.cfg": ["ruff check --output-format json"],
    "package.json": ["npx eslint --format json . 2>/dev/null"],
    ".eslintrc.js": ["npx eslint --format json . 2>/dev/null"],
    ".eslintrc.json": ["npx eslint --format json . 2>/dev/null"],
    "Cargo.toml": ["cargo check --message-format json 2>&1"],
    "go.mod": ["go vet ./..."],
}

MAX_DIAGNOSTICS = 30


def lint(
    paths: str | None = None,
    *,
    cwd: Path | str | None = None,
    shell_path: str | None = None,
    shell_resolver: Callable[[str | None], ShellCommandConfig] = resolve_shell,
) -> dict[str, Any]:
    root = Path.cwd() if cwd is None else Path(cwd)
    commands = _detect_linters(cwd=root)
    if not commands:
        return {"error": "[No linter detected for this project]"}

    all_diagnostics: list[dict[str, Any]] = []
    shell = shell_resolver(shell_path)
    for command in commands:
        effective_command = f"{command} {paths}" if paths else command
        try:
            result = subprocess.run(
                [str(shell.executable), *shell.args, effective_command],
                capture_output=True,
                text=True,
                timeout=60,
                cwd=root,
                check=False,
            )
        except subprocess.TimeoutExpired:
            continue
        except OSError:
            continue

        output = result.stdout or result.stderr
        all_diagnostics.extend(_parse_output(command, output))

    truncated = len(all_diagnostics) > MAX_DIAGNOSTICS
    return {
        "diagnostics": all_diagnostics[:MAX_DIAGNOSTICS],
        "count": len(all_diagnostics),
        "truncated": truncated,
    }


def _detect_linters(cwd: Path | str | None = None) -> list[str]:
    root = Path.cwd() if cwd is None else Path(cwd)
    for config_file, commands in PROJECT_LINTERS.items():
        if (root / config_file).exists():
            return commands
    return []


def _parse_output(command: str, output: str) -> list[dict[str, Any]]:
    if "ruff" in command:
        return _parse_ruff(output)
    if "eslint" in command:
        return _parse_eslint(output)
    return [{"raw": output[:500]}] if output else []


def _parse_ruff(output: str) -> list[dict[str, Any]]:
    try:
        diagnostics = json.loads(output)
    except json.JSONDecodeError:
        return []

    return [
        {
            "file": diagnostic.get("filename", ""),
            "line": diagnostic.get("location", {}).get("row", 0),
            "column": diagnostic.get("location", {}).get("column", 0),
            "message": diagnostic.get("message", ""),
            "rule": diagnostic.get("code", ""),
        }
        for diagnostic in diagnostics
    ]


def _parse_eslint(output: str) -> list[dict[str, Any]]:
    try:
        files = json.loads(output)
    except json.JSONDecodeError:
        return []

    results: list[dict[str, Any]] = []
    for file_diagnostic in files:
        for message in file_diagnostic.get("messages", []):
            results.append(
                {
                    "file": file_diagnostic.get("filePath", ""),
                    "line": message.get("line", 0),
                    "column": message.get("column", 0),
                    "message": message.get("message", ""),
                    "rule": message.get("ruleId", ""),
                }
            )
    return results


class LintTool:
    name = "Lint"
    spec = ToolSpec(
        name="Lint",
        description="Run the detected project linter and return bounded diagnostics.",
        parameters=(ToolParameter(name="paths", type="string", required=False),),
        risk_level="low",
        supports_parallel_tool_calls=True,
    )

    def __init__(self) -> None:
        self._shell_path: str | None = None

    def configure_shell_path(self, shell_path: str | None) -> None:
        self._shell_path = shell_path

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        paths = arguments.get("paths")
        payload = lint(
            paths=paths if isinstance(paths, str) else None,
            shell_path=self._shell_path,
        )
        success = "error" not in payload
        return ToolResult(
            success=success,
            summary=(
                f"Found {payload.get('count', 0)} lint diagnostic(s)"
                if success
                else "Failed to lint"
            ),
            error=str(payload["error"]) if "error" in payload else None,
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
