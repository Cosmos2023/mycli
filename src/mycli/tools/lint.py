from __future__ import annotations

import json
from pathlib import Path
import shlex
import subprocess
from typing import Any

from mycli.domain.runtime import ShellKind, ShellProfile
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.shell_resolver import detect_shell_profile


LintCommand = tuple[str, ...] | str
PROJECT_LINTERS: dict[str, list[LintCommand]] = {
    "pyproject.toml": [("ruff", "check", "--output-format", "json")],
    "setup.py": [("ruff", "check", "--output-format", "json")],
    "setup.cfg": [("ruff", "check", "--output-format", "json")],
    "package.json": [("npx", "eslint", "--format", "json", ".")],
    ".eslintrc.js": [("npx", "eslint", "--format", "json", ".")],
    ".eslintrc.json": [("npx", "eslint", "--format", "json", ".")],
    "Cargo.toml": [("cargo", "check", "--message-format", "json")],
    "go.mod": [("go", "vet", "./...")],
}

MAX_DIAGNOSTICS = 30


def lint(
    paths: str | tuple[str, ...] | None = None,
    *,
    cwd: Path | str | None = None,
    shell_path: str | None = None,
    shell_profile: ShellProfile | None = None,
) -> dict[str, Any]:
    root = Path.cwd() if cwd is None else Path(cwd)
    commands = _detect_linters(cwd=root)
    if not commands:
        return {"error": "[No linter detected for this project]"}

    all_diagnostics: list[dict[str, Any]] = []
    for command in commands:
        path_args = _path_args(paths)
        if isinstance(command, tuple):
            argv = [*command, *path_args]
        else:
            profile = shell_profile or detect_shell_profile(shell_path)
            script = command
            if path_args:
                script = f"{script} {_quote_script_args(path_args, profile.kind)}"
            argv = profile.exec_argv(script)
        try:
            result = subprocess.run(
                argv,
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


def _detect_linters(cwd: Path | str | None = None) -> list[LintCommand]:
    root = Path.cwd() if cwd is None else Path(cwd)
    for config_file, commands in PROJECT_LINTERS.items():
        if (root / config_file).exists():
            return commands
    return []


def _parse_output(command: LintCommand, output: str) -> list[dict[str, Any]]:
    command_text = command if isinstance(command, str) else " ".join(command)
    if "ruff" in command_text:
        return _parse_ruff(output)
    if "eslint" in command_text:
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
        self._shell_profile: ShellProfile | None = None

    def configure_shell_path(self, shell_path: str | None) -> None:
        self._shell_path = shell_path

    def configure_shell_profile(self, shell_profile: ShellProfile) -> None:
        self._shell_profile = shell_profile

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        paths = arguments.get("paths")
        payload = lint(
            paths=paths if isinstance(paths, str) else None,
            shell_path=self._shell_path,
            shell_profile=self._shell_profile,
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


def _path_args(paths: str | tuple[str, ...] | None) -> list[str]:
    if isinstance(paths, tuple):
        return [path for path in paths if path]
    if isinstance(paths, str) and paths.strip():
        return [paths.strip()]
    return []


def _quote_script_args(arguments: list[str], shell_kind: ShellKind) -> str:
    if shell_kind is ShellKind.POWERSHELL:
        return " ".join("'" + item.replace("'", "''") + "'" for item in arguments)
    if shell_kind is ShellKind.CMD:
        return subprocess.list2cmdline(arguments)
    return shlex.join(arguments)
