from __future__ import annotations

import json
import os
import subprocess
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


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


def lint(paths: str | None = None) -> dict[str, Any]:
    commands = _detect_linters()
    if not commands:
        return {"error": "[No linter detected for this project]"}

    all_diagnostics: list[dict[str, Any]] = []
    for command in commands:
        effective_command = f"{command} {paths}" if paths else command
        try:
            result = subprocess.run(
                effective_command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=os.getcwd(),
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


def _detect_linters() -> list[str]:
    root = os.getcwd()
    for config_file, commands in PROJECT_LINTERS.items():
        if os.path.exists(os.path.join(root, config_file)):
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
    )

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        paths = arguments.get("paths")
        payload = lint(paths=paths if isinstance(paths, str) else None)
        success = "error" not in payload
        return ToolResultV2(
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
        return self.execute(call.arguments).to_legacy()
