from __future__ import annotations

import re
from typing import Protocol

from mycli.domain.runtime import ShellKind, ShellProfile
from mycli.tools.shell_safety import (
    ShellRiskLevel,
    ShellSafetyAnalysis,
    analyze_shell_command,
)


class ShellSafetyAdapter(Protocol):
    def analyze(self, command: str) -> ShellSafetyAnalysis: ...


class PosixShellSafetyAdapter:
    def analyze(self, command: str) -> ShellSafetyAnalysis:
        return analyze_shell_command(command)


class PowerShellSafetyAdapter:
    _safe_heads = {"get-location", "get-date", "get-childitem", "test-path"}
    _destructive_heads = {
        "clear-content",
        "move-item",
        "new-item",
        "out-file",
        "remove-item",
        "rename-item",
        "restart-computer",
        "set-content",
        "set-item",
        "stop-computer",
        "stop-process",
    }

    def analyze(self, command: str) -> ShellSafetyAnalysis:
        parsed = _parse_windows_command(command, shell_kind=ShellKind.POWERSHELL)
        if isinstance(parsed, ShellSafetyAnalysis):
            return parsed
        words, has_operator = parsed
        if _has_powershell_expansion(command) or has_operator:
            return _confirm_ambiguous(command, "PowerShell expansion or composition requires confirmation")
        return _analyze_words(
            command,
            words,
            safe_heads=self._safe_heads,
            destructive_heads=self._destructive_heads,
            shell_label="PowerShell",
        )


class CmdSafetyAdapter:
    _safe_heads = {"cd", "dir", "echo", "type", "where"}
    _destructive_heads = {
        "copy",
        "del",
        "erase",
        "format",
        "move",
        "rd",
        "ren",
        "rename",
        "rmdir",
        "shutdown",
        "taskkill",
    }

    def analyze(self, command: str) -> ShellSafetyAnalysis:
        parsed = _parse_windows_command(command, shell_kind=ShellKind.CMD)
        if isinstance(parsed, ShellSafetyAnalysis):
            return parsed
        words, has_operator = parsed
        if "%" in command or has_operator:
            return _confirm_ambiguous(command, "CMD expansion or composition requires confirmation")
        return _analyze_words(
            command,
            words,
            safe_heads=self._safe_heads,
            destructive_heads=self._destructive_heads,
            shell_label="CMD",
        )


def analyze_shell_for_profile(
    profile: ShellProfile,
    command: str,
) -> ShellSafetyAnalysis:
    if profile.kind in {ShellKind.ZSH, ShellKind.BASH, ShellKind.SH}:
        return PosixShellSafetyAdapter().analyze(command)
    if profile.kind is ShellKind.POWERSHELL:
        return PowerShellSafetyAdapter().analyze(command)
    return CmdSafetyAdapter().analyze(command)


def _parse_windows_command(
    command: str,
    *,
    shell_kind: ShellKind,
) -> tuple[list[str], bool] | ShellSafetyAnalysis:
    stripped = command.strip()
    if not stripped:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.DENY,
            reason="Shell command cannot be empty",
            preview="",
            command_pattern="empty command",
        )

    words: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escaped = False
    has_operator = False
    escape_char = "`" if shell_kind is ShellKind.POWERSHELL else "^"
    for char in stripped:
        if escaped:
            current.append(char)
            escaped = False
            continue
        if char == escape_char:
            current.append(char)
            escaped = True
            continue
        if quote is not None:
            if char == quote:
                quote = None
            else:
                current.append(char)
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char.isspace():
            if current:
                words.append("".join(current))
                current = []
            continue
        if char in {"&", "|", ">", "<", ";"}:
            has_operator = True
        current.append(char)
    if quote is not None or escaped:
        return _confirm_ambiguous(stripped, "Shell parse error requires confirmation")
    if current:
        words.append("".join(current))
    if not words:
        return _confirm_ambiguous(stripped, "Shell parse error requires confirmation")
    return words, has_operator


def _analyze_words(
    command: str,
    words: list[str],
    *,
    safe_heads: set[str],
    destructive_heads: set[str],
    shell_label: str,
) -> ShellSafetyAnalysis:
    head = words[0].casefold()
    if head in destructive_heads:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.CONFIRM,
            reason=f"{shell_label} command {words[0]} requires confirmation",
            preview=_redact_preview(command),
            command_pattern=words[0],
        )
    if head == "git":
        return _analyze_git(command, words, shell_label=shell_label)
    if head in safe_heads:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.ALLOW,
            reason="Command allowed",
            preview=_redact_preview(command),
            command_pattern=words[0],
        )
    return _confirm_ambiguous(command, f"Unsupported {shell_label} command requires confirmation")


def _analyze_git(command: str, words: list[str], *, shell_label: str) -> ShellSafetyAnalysis:
    subcommand = words[1].casefold() if len(words) > 1 else ""
    pattern = f"git {words[1]}" if len(words) > 1 else "git"
    if subcommand in {"status", "diff", "log", "show"}:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.ALLOW,
            reason="Command allowed",
            preview=_redact_preview(command),
            command_pattern=pattern,
        )
    if subcommand in {"clean", "push", "reset", "restore", "checkout"}:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.CONFIRM,
            reason=f"{shell_label} git {subcommand} requires confirmation",
            preview=_redact_preview(command),
            command_pattern=pattern,
        )
    return _confirm_ambiguous(command, f"Unsupported {shell_label} git command requires confirmation")


def _confirm_ambiguous(command: str, reason: str) -> ShellSafetyAnalysis:
    return ShellSafetyAnalysis(
        risk_level=ShellRiskLevel.CONFIRM,
        reason=reason,
        preview=_redact_preview(command),
        command_pattern=None,
    )


def _has_powershell_expansion(command: str) -> bool:
    return any(marker in command for marker in ("$", "@(", "@{", "$(", "{", "}"))


def _redact_preview(command: str) -> str:
    return re.sub(
        r"(?i)(--?(?:token|password|secret|key|auth|credential)\s+)(\S+)",
        r"\1<redacted>",
        command.strip(),
    )


__all__ = [
    "CmdSafetyAdapter",
    "PosixShellSafetyAdapter",
    "PowerShellSafetyAdapter",
    "ShellSafetyAdapter",
    "analyze_shell_for_profile",
]
