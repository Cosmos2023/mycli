from __future__ import annotations

from pathlib import Path

from mycli.domain.tools import ToolCall, ToolResult
from mycli.infrastructure.shell_adapter import run_command
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


class RunShellTool:
    name = "run_shell"
    spec = ToolSpec(
        name="run_shell",
        description="Run a shell command in the workspace using a structured args list.",
        parameters=(
            ToolParameter(
                name="args",
                type="array",
                required=True,
                items_schema={"type": "string"},
            ),
        ),
        risk_level="high",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        args_value = arguments.get("args")
        if not isinstance(args_value, list) or not args_value or not all(
            isinstance(item, str) for item in args_value
        ):
            return ToolResultV2(
                success=False,
                summary="Invalid shell arguments",
                error="run_shell requires a non-empty 'args' list of strings.",
            )
        args = list(args_value)
        try:
            completed = run_command(args=args, cwd=self._workspace_root)
        except FileNotFoundError as exc:
            return ToolResultV2(
                success=False,
                summary="Shell command could not be started",
                error=str(exc),
            )
        return ToolResultV2(
            success=completed.returncode == 0,
            summary=f"Command exited with {completed.returncode}",
            raw_payload={"stdout": completed.stdout, "stderr": completed.stderr},
            error=None if completed.returncode == 0 else completed.stderr,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()


def derive_command_pattern(args: list[str]) -> str:
    if args[:3] == ["git", "reset", "--hard"]:
        return "git reset --hard"
    if args[:2] == ["git", "push"]:
        return "git push"
    if args[:2] == ["rm", "-rf"]:
        return "rm -rf"
    if len(args) >= 3 and args[0] == "python" and args[1].endswith(".py"):
        return " ".join(args[:3])
    return " ".join(args[: min(3, len(args))])
