from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePath, PureWindowsPath

from mycli.domain.runtime import (
    ExecPolicyDecision,
    ExecPolicyRuleSet,
    ShellKind,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.shell_command_policy import (
    ShellParseKind,
    ShellParseResult,
    is_known_safe_segment,
    parse_shell_argv,
    parse_shell_command,
)
from mycli.tools.shell_safety import shell_tokens_contain_sensitive_values


MAX_PATTERN_TOKENS = 16
MAX_PATTERN_TOKEN_CHARS = 256
MAX_PATTERN_TOTAL_CHARS = 512


@dataclass(slots=True, frozen=True)
class ExecPolicyProposalValidation:
    pattern: tuple[str, ...] | None = None
    rejection_reason: str | None = None


class ExecPolicyProposalValidator:
    def validate(
        self,
        *,
        call: ToolCall,
        shell_kind: ShellKind,
        rules: ExecPolicyRuleSet,
        approval_policy: str,
    ) -> ExecPolicyProposalValidation:
        if call.name != "Shell":
            return self._reject("legacy shell call")
        if approval_policy != "shell_command_analysis":
            return self._reject("approval source is not eligible")
        pattern = self._pattern(call.arguments.get("prefix_rule"))
        if pattern is None:
            return self._reject("invalid prefix proposal")
        if shell_tokens_contain_sensitive_values(pattern):
            return self._reject("sensitive prefix proposal")
        if self._is_broad(pattern, shell_kind=shell_kind):
            return self._reject("broad prefix proposal")
        if self._is_destructive(pattern, shell_kind=shell_kind):
            return self._reject("destructive prefix proposal")

        parsed = self._parse_call(call, shell_kind=shell_kind)
        if parsed.kind is not ShellParseKind.PLAIN:
            return self._reject("command is not plain shell syntax")
        eligible_segments = []
        for segment in parsed.segments:
            if segment.words[: len(pattern)] != pattern:
                continue
            match = rules.match(segment.words)
            if match is not None:
                if match.rule.decision in {
                    ExecPolicyDecision.ASK,
                    ExecPolicyDecision.DENY,
                }:
                    return self._reject("explicit policy blocks persistence")
                continue
            if not is_known_safe_segment(segment, shell_kind=shell_kind):
                eligible_segments.append(segment)
        if not eligible_segments:
            return self._reject("prefix does not match the segment awaiting approval")
        return ExecPolicyProposalValidation(pattern=pattern)

    @staticmethod
    def _pattern(value: object) -> tuple[str, ...] | None:
        if not isinstance(value, list) or not value:
            return None
        if not all(isinstance(token, str) and token.strip() for token in value):
            return None
        pattern = tuple(value)
        if len(pattern) > MAX_PATTERN_TOKENS:
            return None
        if any(len(token) > MAX_PATTERN_TOKEN_CHARS for token in pattern):
            return None
        if sum(len(token) for token in pattern) > MAX_PATTERN_TOTAL_CHARS:
            return None
        return pattern

    @staticmethod
    def _parse_call(call: ToolCall, *, shell_kind: ShellKind) -> ShellParseResult:
        args = call.arguments.get("args")
        if isinstance(args, list) and args and all(isinstance(item, str) for item in args):
            return parse_shell_argv(tuple(args), shell_kind=shell_kind)
        command = call.arguments.get("command")
        if isinstance(command, str) and command:
            return parse_shell_command(command, shell_kind=shell_kind)
        return ShellParseResult(ShellParseKind.INVALID, reason="empty command")

    @staticmethod
    def _executable(pattern: tuple[str, ...], *, shell_kind: ShellKind) -> str:
        if shell_kind in {ShellKind.POWERSHELL, ShellKind.CMD}:
            executable = PureWindowsPath(pattern[0]).name.casefold()
            return executable[:-4] if executable.endswith(".exe") else executable
        return PurePath(pattern[0]).name

    @staticmethod
    def _normalize(value: str, *, shell_kind: ShellKind) -> str:
        if shell_kind in {ShellKind.POWERSHELL, ShellKind.CMD}:
            return value.casefold()
        return value

    def _is_broad(self, pattern: tuple[str, ...], *, shell_kind: ShellKind) -> bool:
        executable = self._normalize(
            self._executable(pattern, shell_kind=shell_kind),
            shell_kind=shell_kind,
        )
        comparable = tuple(
            self._normalize(token, shell_kind=shell_kind) for token in pattern
        )
        if executable in {"env", "sudo", "osascript"}:
            return True
        if executable in {"python", "python3", "py"}:
            return len(pattern) == 1 or comparable[1:2] == ("-c",)
        if executable == "node":
            return len(pattern) == 1 or comparable[1:2] == ("-e",)
        if executable in {"bash", "sh", "zsh"}:
            return len(pattern) == 1 or comparable[1:2] in {("-c",), ("-lc",)}
        if executable in {"pwsh", "powershell"}:
            return len(pattern) == 1 or comparable[1:2] == ("-command",)
        return False

    def _is_destructive(
        self,
        pattern: tuple[str, ...],
        *,
        shell_kind: ShellKind,
    ) -> bool:
        executable = self._normalize(
            self._executable(pattern, shell_kind=shell_kind),
            shell_kind=shell_kind,
        )
        comparable = tuple(
            self._normalize(token, shell_kind=shell_kind) for token in pattern
        )
        if executable in {
            "rm",
            "rmdir",
            "del",
            "erase",
            "remove-item",
            "dd",
            "mkfs",
            "diskpart",
            "format",
            "clear-disk",
            "shutdown",
            "reboot",
            "halt",
            "poweroff",
        }:
            return True
        if executable == "git" and len(comparable) >= 2:
            if comparable[1] == "clean":
                return True
            if comparable[1:3] == ("reset", "--hard"):
                return True
            if comparable[1] == "push" and any(
                token in {"--force", "-f", "--force-with-lease"}
                for token in comparable[2:]
            ):
                return True
        return executable in {"chmod", "chown"} and any(
            token in {"-R", "-r", "--recursive"} for token in comparable[1:]
        )

    @staticmethod
    def _reject(reason: str) -> ExecPolicyProposalValidation:
        return ExecPolicyProposalValidation(rejection_reason=reason)
