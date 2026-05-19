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

    confirm_reason = _confirm_reason(args, stripped)
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
    if _is_recursive_rm(args):
        return "rm -rf"
    if _is_pipe_to_shell(args, command):
        downloader = args[0] if args and args[0] in {"curl", "wget"} else "shell"
        shell_name = _shell_after_pipe(args, command) or "sh"
        return f"{downloader} | {shell_name}"
    if _has_redirection(args, command):
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
    return _DEDICATED_TOOL_HINTS.get(args[0])


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
        if _looks_like_env_secret_assignment(arg):
            key, _, _value = arg.partition("=")
            redacted.append(f"{key}=<redacted>")
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


def _looks_like_env_secret_assignment(value: str) -> bool:
    if "=" not in value:
        return False
    key, _, _rest = value.partition("=")
    return key.isupper() and _contains_sensitive_hint(key)


def _is_rm_rf_root(args: list[str]) -> bool:
    if len(args) < 2 or args[0] != "rm":
        return False
    flags, remaining = _split_rm_flags(args[1:])
    return remaining == ["/"] and {"r", "f"}.issubset(flags)


def _is_recursive_rm(args: list[str]) -> bool:
    if len(args) < 2 or args[0] != "rm":
        return False
    flags, _remaining = _split_rm_flags(args[1:])
    return "r" in flags


def _split_rm_flags(args: list[str]) -> tuple[set[str], list[str]]:
    flags: set[str] = set()
    remaining: list[str] = []
    parsing_flags = True
    for arg in args:
        if parsing_flags and arg == "--":
            parsing_flags = False
            continue
        if parsing_flags and arg.startswith("-") and arg != "-":
            normalized = arg[2:] if arg.startswith("--") else arg[1:]
            for flag in normalized:
                flags.add(flag)
            continue
        parsing_flags = False
        remaining.append(arg)
    return flags, remaining


def _command_has_compact_pipe_to_shell(command: str, args: list[str]) -> bool:
    if not args or args[0] not in {"curl", "wget"}:
        return False
    compact = "".join(_unquoted_shell_text(command).split())
    return any(f"|{shell_name}" in compact for shell_name in _SHELL_INTERPRETERS)


def _command_has_compact_redirection(command: str) -> bool:
    compact = "".join(_unquoted_shell_text(command).split())
    return "2>" in compact or ">>" in compact or ">" in compact


def _command_has_compact_chaining(command: str) -> bool:
    compact = "".join(_unquoted_shell_text(command).split())
    return "&&" in compact or "||" in compact or ";" in compact


def _unquoted_shell_text(command: str) -> str:
    result: list[str] = []
    quote: str | None = None
    escaped = False
    for char in command:
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote is not None:
            if char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        result.append(char)
    return "".join(result)


def _is_fork_bomb(command: str) -> bool:
    collapsed = "".join(command.split())
    return collapsed == ":(){:|:&};:"


def _confirm_reason(args: list[str], command: str) -> str | None:
    if _is_pipe_to_shell(args, command):
        return f"Downloading a script with {args[0]} and piping it to shell requires confirmation"
    if _has_redirection(args, command):
        return "Shell output redirection requires confirmation"
    if len(args) >= 2 and args[0] in {"chmod", "chown"} and args[1] == "-R":
        return f"{args[0]} -R requires confirmation"
    if args and args[0] == "sudo":
        return "sudo requires confirmation"
    if args and args[0] == "dd":
        return "dd requires confirmation"
    if _is_recursive_rm(args):
        return "recursive rm requires confirmation"
    if args[:3] == ["git", "reset", "--hard"]:
        return "git reset --hard requires confirmation"
    if _is_force_push(args):
        return "git push --force requires confirmation"
    if args[:2] == ["git", "push"]:
        return "git push requires confirmation."
    if any(token in _CHAIN_TOKENS for token in args) or _command_has_compact_chaining(command):
        return "shell command chaining requires confirmation"
    return None


def _is_pipe_to_shell(args: list[str], command: str | None = None) -> bool:
    if not args or args[0] not in {"curl", "wget"}:
        return False
    return _shell_after_pipe(args, command) is not None


def _shell_after_pipe(args: list[str], command: str | None = None) -> str | None:
    for index, token in enumerate(args):
        if token != "|" or index + 1 >= len(args):
            continue
        shell_command = args[index + 1]
        if shell_command in _SHELL_INTERPRETERS:
            return shell_command
    if command is not None and _command_has_compact_pipe_to_shell(command, args):
        compact = "".join(command.split())
        for shell_name in _SHELL_INTERPRETERS:
            if f"|{shell_name}" in compact:
                return shell_name
    return None


def _has_redirection(args: list[str], command: str | None = None) -> bool:
    if any(token in _REDIRECTION_TOKENS for token in args):
        return True
    return bool(command and _command_has_compact_redirection(command))


def _is_force_push(args: list[str]) -> bool:
    if len(args) < 2 or args[:2] != ["git", "push"]:
        return False
    return any(token in {"--force", "-f", "--force-with-lease"} for token in args[2:])
