from __future__ import annotations

from dataclasses import dataclass
import shlex

from mycli.domain.runtime import DecisionKind, RiskLevel
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.shell_safety import ShellRiskLevel, analyze_shell_command


@dataclass(slots=True, frozen=True)
class ToolSafetyDecision:
    kind: DecisionKind
    reason: str
    preview: str
    command_pattern: str | None = None


class SafetyPolicy:
    def classify(self, call: ToolCall) -> RiskLevel:
        name = _canonical_tool_name(call.name)
        if name in {
            "Read",
            "Grep",
            "Glob",
            "LS",
            "WebSearch",
            "WebFetch",
            "Lint",
            "AskUserQuestion",
            "Plan",
            "EnterPlanMode",
            "ExitPlanMode",
            "Skill",
        }:
            return RiskLevel.LOW
        if name in {"Edit", "Write", "KillShell"}:
            return RiskLevel.MEDIUM
        if name == "Bash":
            return RiskLevel.HIGH
        return RiskLevel.HIGH

    def evaluate(self, call: ToolCall) -> ToolSafetyDecision:
        name = _canonical_tool_name(call.name)
        if name in {
            "Read",
            "Grep",
            "Glob",
            "LS",
            "WebSearch",
            "WebFetch",
            "Lint",
            "AskUserQuestion",
            "Plan",
            "EnterPlanMode",
            "ExitPlanMode",
            "Skill",
        }:
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=name,
            )
        if name in {"Edit", "Write", "KillShell"}:
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=str(
                    call.arguments.get("file_path")
                    or call.arguments.get("path")
                    or call.arguments.get("source")
                    or call.arguments.get("destination")
                    or call.arguments.get("shell_id")
                    or ""
                ),
            )
        if name == "Bash":
            command_value = call.arguments.get("command")
            args_value = call.arguments.get("args")
            if isinstance(command_value, str) and command_value:
                command = command_value
            elif isinstance(args_value, list) and args_value and all(
                isinstance(item, str) for item in args_value
            ):
                command = shlex.join(args_value)
            else:
                return ToolSafetyDecision(
                    kind=DecisionKind.DENY,
                    reason="Bash requires a non-empty command.",
                    preview="invalid shell call",
                )
            analysis = analyze_shell_command(command)
            if analysis.risk_level is ShellRiskLevel.DENY:
                return ToolSafetyDecision(
                    kind=DecisionKind.DENY,
                    reason=analysis.reason,
                    preview=analysis.preview,
                )
            if analysis.risk_level is ShellRiskLevel.CONFIRM:
                return ToolSafetyDecision(
                    kind=DecisionKind.NEEDS_CHOICE,
                    reason=analysis.reason,
                    preview=analysis.preview,
                    command_pattern=analysis.command_pattern,
                )
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=analysis.preview,
                command_pattern=analysis.command_pattern,
            )
        return ToolSafetyDecision(
            kind=DecisionKind.DENY,
            reason="Unsupported tool.",
            preview=call.name,
        )


def _canonical_tool_name(name: str) -> str:
    return {
        "read_file": "Read",
        "read_file_range": "Read",
        "edit_file": "Edit",
        "write_file": "Write",
        "search_text": "Grep",
        "list_directory": "LS",
        "run_shell": "Bash",
        "update_plan": "Plan",
    }.get(name, name)
