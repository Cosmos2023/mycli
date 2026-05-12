from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from mycli.domain.runtime import DecisionKind, RiskLevel
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.bash import derive_command_pattern


_SECRET_HINTS = ("secret", "token", "key", "password", "passwd", "pwd", "auth", "credential")
_VALUE_PREFIXES_TO_MASK = {
    "--token",
    "--password",
    "--secret",
    "--key",
    "--auth",
    "--credential",
    "-p",
    "-k",
    "-t",
}


def _contains_secret_hint(value: str) -> bool:
    lowered = value.lower()
    return any(hint in lowered for hint in _SECRET_HINTS)


def _redact_shell_preview(args: Iterable[str]) -> str:
    masked: list[str] = []
    mask_next = False
    for arg in args:
        if mask_next:
            masked.append("<redacted>")
            mask_next = False
            continue
        if "=" in arg:
            key, _, _ = arg.partition("=")
            if _contains_secret_hint(key):
                masked.append(f"{key}=<redacted>")
                continue
        normalized = arg.lower()
        if normalized in _VALUE_PREFIXES_TO_MASK:
            masked.append("<redacted>")
            mask_next = True
            continue
        if _contains_secret_hint(arg):
            masked.append("<redacted>")
            continue
        masked.append(arg)
    return " ".join(masked)


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
                args = command_value.split()
            elif isinstance(args_value, list) and args_value and all(
                isinstance(item, str) for item in args_value
            ):
                args = list(args_value)
            else:
                return ToolSafetyDecision(
                    kind=DecisionKind.DENY,
                    reason="Bash requires a non-empty command.",
                    preview="invalid shell call",
                )
            pattern = derive_command_pattern(args)
            preview = _redact_shell_preview(args)
            if pattern in {"git push", "git reset --hard", "rm -rf"}:
                return ToolSafetyDecision(
                    kind=DecisionKind.NEEDS_CHOICE,
                    reason=call.reason,
                    preview=preview,
                    command_pattern=pattern,
                )
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=preview,
                command_pattern=pattern,
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
