from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from mycli.domain.runtime import DecisionKind, RiskLevel
from mycli.domain.tools import ToolCall
from mycli.tools.run_shell import derive_command_pattern


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
        if call.name in {
            "list_directory",
            "read_file",
            "read_file_range",
            "search_text",
            "git_status",
            "git_diff",
            "git_log",
            "update_plan",
        }:
            return RiskLevel.LOW
        if call.name in {
            "append_file",
            "create_file",
            "mkdir",
            "move_path",
            "delete_path",
            "replace_in_file",
            "edit_file",
        }:
            return RiskLevel.MEDIUM
        if call.name == "run_shell":
            return RiskLevel.HIGH
        return RiskLevel.HIGH

    def evaluate(self, call: ToolCall) -> ToolSafetyDecision:
        if call.name in {
            "list_directory",
            "read_file",
            "read_file_range",
            "search_text",
            "git_status",
            "git_diff",
            "git_log",
            "update_plan",
        }:
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=call.name,
            )
        if call.name in {
            "append_file",
            "create_file",
            "mkdir",
            "move_path",
            "delete_path",
            "replace_in_file",
            "edit_file",
        }:
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=str(
                    call.arguments.get("path")
                    or call.arguments.get("source")
                    or call.arguments.get("destination")
                    or ""
                ),
            )
        if call.name == "run_shell":
            args_value = call.arguments.get("args")
            if not isinstance(args_value, list) or not args_value or not all(
                isinstance(item, str) for item in args_value
            ):
                return ToolSafetyDecision(
                    kind=DecisionKind.DENY,
                    reason="run_shell requires a non-empty args list.",
                    preview="invalid shell call",
                )
            args = list(args_value)
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
