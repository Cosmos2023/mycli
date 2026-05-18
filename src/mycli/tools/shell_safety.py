from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import shlex
import unicodedata


_SENSITIVE_VALUE_FLAGS = {
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
_SENSITIVE_KEY_HINTS = (
    "secret",
    "token",
    "key",
    "password",
    "passwd",
    "pwd",
    "auth",
    "credential",
)
_BIDI_AND_CONTROL_CODEPOINTS = {
    "\u202a",
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
    "\u200e",
    "\u200f",
    "\u061c",
}
_DEDICATED_TOOL_HINTS = {
    "cat": "Read",
    "head": "Read",
    "tail": "Read",
    "grep": "Grep",
    "rg": "Grep",
    "ls": "LS",
    "find": "Glob",
}
_SHELL_INTERPRETERS = {"sh", "bash", "zsh"}
_REDIRECTION_TOKENS = {">", ">>", "2>"}
_CHAIN_TOKENS = {"&&", "||", ";"}


class ShellRiskLevel(StrEnum):
    ALLOW = "allow"
    CONFIRM = "confirm"
    DENY = "deny"


@dataclass(slots=True, frozen=True)
class ShellSafetyAnalysis:
    risk_level: ShellRiskLevel
    reason: str
    preview: str
    command_pattern: str
    reroute_tool: str | None = None
    reroute_reason: str | None = None


def analyze_shell_command(command: str) -> ShellSafetyAnalysis:
    stripped = command.strip()
    if not stripped:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.DENY,
            reason="Shell command cannot be empty",
            preview="",
            command_pattern="empty command",
        )

    unicode_control = _find_unicode_control(stripped)
    if unicode_control is not None:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.DENY,
            reason=f"Unicode control character {unicode_control} is not allowed",
            preview=stripped,
            command_pattern="unicode control",
        )

    try:
        args = shlex.split(stripped)
    except ValueError as exc:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.DENY,
            reason=f"Shell parse error: {exc}",
            preview=stripped,
            command_pattern="parse error",
        )

    if not args:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.DENY,
            reason="Shell command cannot be empty",
            preview="",
            command_pattern="empty command",
        )

    preview = redact_shell_preview(args)
    pattern = derive_command_pattern(args, stripped)
    reroute_tool = dedicated_tool_for_command(args)
    reroute_reason = (
        f"Use the dedicated {reroute_tool} tool instead of Bash for this command."
        if reroute_tool is not None
        else None
    )

    if _is_rm_rf_root(args):
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.DENY,
            reason="rm -rf / is forbidden",
            preview=preview,
            command_pattern="rm -rf",
            reroute_tool=reroute_tool,
            reroute_reason=reroute_reason,
        )

    if _is_fork_bomb(stripped):
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.DENY,
            reason="Fork bomb pattern is forbidden",
            preview=preview,
            command_pattern="fork bomb",
            reroute_tool=reroute_tool,
            reroute_reason=reroute_reason,
        )

    confirm_reason = _confirm_reason(args)
    if confirm_reason is not None:
        return ShellSafetyAnalysis(
            risk_level=ShellRiskLevel.CONFIRM,
            reason=confirm_reason,
            preview=preview,
            command_pattern=pattern,
            reroute_tool=reroute_tool,
            reroute_reason=reroute_reason,
        )

    return ShellSafetyAnalysis(
        risk_level=ShellRiskLevel.ALLOW,
        reason="Command allowed",
        preview=preview,
        command_pattern=pattern,
        reroute_tool=reroute_tool,
        reroute_reason=reroute_reason,
    )


def derive_command_pattern(args: list[str], command: str | None = None) -> str:
    if not args:
        return "empty command"
    if args[:2] == ["git", "status"]:
        return "git status"
    if args[:3] == ["git", "reset", "--hard"]:
        return "git reset --hard"
    if args[:2] == ["git", "push"]:
        return "git push"
    if args[:2] == ["rm", "-rf"]:
        return "rm -rf"
    if _is_pipe_to_shell(args):
        downloader = args[0] if args and args[0] in {"curl", "wget"} else "shell"
        shell_name = _shell_after_pipe(args) or "sh"
        return f"{downloader} | {shell_name}"
    if _has_redirection(args):
        return f"{args[0]} >"
    if len(args) >= 2 and args[0] in {"chmod", "chown"} and args[1] == "-R":
        return f"{args[0]} -R"
    if args[0] == "sudo":
        return "sudo"
    if args[0] == "dd":
        return "dd"
    if len(args) >= 3 and args[0] == "python" and args[1].endswith(".py"):
        return " ".join(args[:3])
    if args[0] == "bash" and command:
        return "bash"
    return " ".join(args[: min(3, len(args))])


def dedicated_tool_for_command(args: list[str]) -> str | None:
    if not args:
        return None
    command = args[0]
    if command == "sed" and len(args) >= 2 and args[1] == "-n":
        return None
    return _DEDICATED_TOOL_HINTS.get(command)


def redact_shell_preview(args: list[str]) -> str:
    redacted: list[str] = []
    mask_next = False
    for arg in args:
        lowered = arg.lower()
        if mask_next:
            redacted.append("<redacted>")
            mask_next = False
            continue
        if lowered in _SENSITIVE_VALUE_FLAGS:
            redacted.append(arg)
            mask_next = True
            continue
        if "=" in arg:
            key, _, _value = arg.partition("=")
            if _contains_sensitive_hint(key):
                redacted.append(f"{key}=<redacted>")
                continue
        if _contains_sensitive_hint(arg):
            redacted.append("<redacted>")
            continue
        redacted.append(arg)
    return " ".join(redacted)


def _find_unicode_control(command: str) -> str | None:
    for char in command:
        if char in _BIDI_AND_CONTROL_CODEPOINTS:
            return f"U+{ord(char):04X}"
        if unicodedata.category(char) == "Cf":
            return f"U+{ord(char):04X}"
    return None


def _contains_sensitive_hint(value: str) -> bool:
    lowered = value.lower()
    return any(hint in lowered for hint in _SENSITIVE_KEY_HINTS)


def _is_rm_rf_root(args: list[str]) -> bool:
    if len(args) < 3 or args[0] != "rm":
        return False
    normalized_flags = args[1].replace("--", "-")
    return normalized_flags in {"-rf", "-fr"} and args[2] == "/"


def _is_fork_bomb(command: str) -> bool:
    collapsed = "".join(command.split())
    return collapsed == ":(){:|:&};:"


def _confirm_reason(args: list[str]) -> str | None:
    if _is_pipe_to_shell(args):
        return f"Downloading a script with {args[0]} and piping it to shell requires confirmation"
    if _has_redirection(args):
        return "Shell output redirection requires confirmation"
    if len(args) >= 2 and args[0] in {"chmod", "chown"} and args[1] == "-R":
        return f"{args[0]} -R requires confirmation"
    if args and args[0] == "sudo":
        return "sudo requires confirmation"
    if args and args[0] == "dd":
        return "dd requires confirmation"
    if len(args) >= 2 and args[0] == "rm" and args[1] in {"-r", "-rf", "-fr"}:
        return "recursive rm requires confirmation"
    if args[:3] == ["git", "reset", "--hard"]:
        return "git reset --hard requires confirmation"
    if _is_force_push(args):
        return "git push --force requires confirmation"
    if any(token in _CHAIN_TOKENS for token in args):
        return "shell command chaining requires confirmation"
    return None


def _is_pipe_to_shell(args: list[str]) -> bool:
    if len(args) < 3 or args[0] not in {"curl", "wget"}:
        return False
    return "|" in args and _shell_after_pipe(args) is not None


def _shell_after_pipe(args: list[str]) -> str | None:
    for index, token in enumerate(args):
        if token != "|" or index + 1 >= len(args):
            continue
        command = args[index + 1]
        if command in _SHELL_INTERPRETERS:
            return command
    return None


def _has_redirection(args: list[str]) -> bool:
    return any(token in _REDIRECTION_TOKENS for token in args)


def _is_force_push(args: list[str]) -> bool:
    if len(args) < 2 or args[:2] != ["git", "push"]:
        return False
    return any(token in {"--force", "-f", "--force-with-lease"} for token in args[2:])
