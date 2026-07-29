from __future__ import annotations

import re
from typing import Protocol

from mycli.domain.runtime import ShellKind, ShellProfile
from mycli.tools.shell_command_policy import (
    ShellCommandClassification,
    ShellCommandDecision,
    classify_shell_argv,
    classify_shell_command,
)
from mycli.tools.shell_safety import (
    ShellRiskLevel,
    ShellSafetyAnalysis,
    analyze_shell_argv,
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
        return _analysis_from_classification(
            command,
            classify_shell_command(command, shell_kind=ShellKind.POWERSHELL),
            shell_label="PowerShell",
            destructive_heads=self._destructive_heads,
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
        return _analysis_from_classification(
            command,
            classify_shell_command(command, shell_kind=ShellKind.CMD),
            shell_label="CMD",
            destructive_heads=self._destructive_heads,
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


def analyze_shell_argv_for_profile(
    profile: ShellProfile,
    args: tuple[str, ...],
) -> ShellSafetyAnalysis:
    if profile.kind in {ShellKind.ZSH, ShellKind.BASH, ShellKind.SH}:
        return analyze_shell_argv(args)
    classification = classify_shell_argv(args, shell_kind=profile.kind)
    return _analysis_from_classification(
        " ".join(args),
        classification,
        shell_label="PowerShell" if profile.kind is ShellKind.POWERSHELL else "CMD",
        destructive_heads=(
            PowerShellSafetyAdapter._destructive_heads
            if profile.kind is ShellKind.POWERSHELL
            else CmdSafetyAdapter._destructive_heads
        ),
    )


def _analysis_from_classification(
    command: str,
    classification: ShellCommandClassification,
    *,
    shell_label: str,
    destructive_heads: set[str],
) -> ShellSafetyAnalysis:
    preview = _redact_preview(command)
    if classification.decision is ShellCommandDecision.SAFE:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.ALLOW,
            reason="Command allowed",
            preview=preview,
            command_pattern=_classification_pattern(classification),
        )
    destructive = next(
        (
            segment.words[0]
            for segment in classification.segments
            if segment.words and segment.words[0].casefold() in destructive_heads
        ),
        None,
    )
    if destructive is not None:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.CONFIRM,
            reason=f"{shell_label} command {destructive} requires confirmation",
            preview=preview,
            command_pattern=None,
        )
    return ShellSafetyAnalysis(
        risk_level=(
            ShellRiskLevel.DENY
            if classification.decision is ShellCommandDecision.INVALID
            and not classification.segments
            and not command.strip()
            else ShellRiskLevel.CONFIRM
        ),
        reason=f"{shell_label}: {classification.reason}",
        preview=preview,
        command_pattern=(
            classification.command_pattern
            if classification.decision is ShellCommandDecision.UNKNOWN
            else None
        ),
    )


def _classification_pattern(classification: ShellCommandClassification) -> str | None:
    if not classification.segments:
        return None
    words = classification.segments[0].words
    if not words:
        return None
    if words[0].casefold() == "git" and len(words) > 1:
        return f"git {words[1]}"
    return words[0]


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
    "analyze_shell_argv_for_profile",
    "analyze_shell_for_profile",
]
