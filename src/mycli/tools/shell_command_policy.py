from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import posixpath
from pathlib import PurePath, PureWindowsPath
import re
import sys
import ntpath

from mycli.domain.runtime import ShellKind


_PLAIN_POSIX_OPERATORS = frozenset({"&&", "||", ";", "|"})
_SHELL_KEYWORDS = frozenset(
    {
        "case",
        "do",
        "done",
        "elif",
        "else",
        "esac",
        "fi",
        "for",
        "function",
        "if",
        "in",
        "select",
        "then",
        "time",
        "until",
        "while",
    }
)
_ASSIGNMENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
_SED_PRINT_RE = re.compile(r"[0-9]+(?:,[0-9]+)?p")
_POSIX_DIRECT_SAFE = frozenset(
    {
        "cat",
        "cd",
        "cut",
        "echo",
        "expr",
        "false",
        "grep",
        "head",
        "id",
        "ls",
        "nl",
        "paste",
        "pwd",
        "rev",
        "seq",
        "stat",
        "tail",
        "tr",
        "true",
        "uname",
        "uniq",
        "wc",
        "which",
        "whoami",
    }
)
_POWERSHELL_DIRECT_SAFE = frozenset(
    {
        "get-childitem",
        "get-command",
        "get-content",
        "get-date",
        "get-location",
        "test-path",
    }
)
_POWERSHELL_LITERAL_PIPELINE_SAFE = frozenset(
    {"measure-object", "select-object", "sort-object"}
)
_CMD_DIRECT_SAFE = frozenset(
    {"cd", "dir", "echo", "find", "findstr", "type", "where"}
)


class ShellParseKind(StrEnum):
    PLAIN = "plain"
    COMPLEX = "complex"
    INVALID = "invalid"


class ShellCommandDecision(StrEnum):
    SAFE = "safe"
    UNKNOWN = "unknown"
    COMPLEX = "complex"
    INVALID = "invalid"


@dataclass(slots=True, frozen=True)
class ShellCommandSegment:
    words: tuple[str, ...]
    operator_before: str | None = None
    effective_cwd: str | None = None


@dataclass(slots=True, frozen=True)
class ShellParseResult:
    kind: ShellParseKind
    segments: tuple[ShellCommandSegment, ...] = ()
    reason: str | None = None


@dataclass(slots=True, frozen=True)
class ShellCommandClassification:
    decision: ShellCommandDecision
    reason: str
    segments: tuple[ShellCommandSegment, ...]
    command_pattern: str | None = None


@dataclass(slots=True, frozen=True)
class _ShellToken:
    value: str
    operator: bool = False
    quoted: bool = False


def parse_shell_command(command: str, *, shell_kind: ShellKind) -> ShellParseResult:
    if shell_kind in {ShellKind.BASH, ShellKind.ZSH, ShellKind.SH}:
        return _parse_posix(command)
    return _parse_windows(command, shell_kind=shell_kind)


def parse_shell_argv(
    args: tuple[str, ...],
    *,
    shell_kind: ShellKind,
) -> ShellParseResult:
    del shell_kind
    if not args or not args[0]:
        return ShellParseResult(ShellParseKind.INVALID, reason="empty command")
    return ShellParseResult(
        ShellParseKind.PLAIN,
        segments=(ShellCommandSegment(words=args),),
    )


def classify_shell_command(
    command: str,
    *,
    shell_kind: ShellKind,
    platform: str | None = None,
) -> ShellCommandClassification:
    parsed = parse_shell_command(command, shell_kind=shell_kind)
    return _classify_parsed(parsed, shell_kind=shell_kind, platform=platform)


def classify_shell_argv(
    args: tuple[str, ...],
    *,
    shell_kind: ShellKind,
    platform: str | None = None,
) -> ShellCommandClassification:
    parsed = parse_shell_argv(args, shell_kind=shell_kind)
    return _classify_parsed(parsed, shell_kind=shell_kind, platform=platform)


def is_known_safe_segment(
    segment: ShellCommandSegment,
    *,
    shell_kind: ShellKind,
    platform: str | None = None,
) -> bool:
    words = segment.words
    if not words:
        return False
    if shell_kind in {ShellKind.POWERSHELL, ShellKind.CMD}:
        return _is_known_safe_windows_segment(segment, shell_kind=shell_kind)
    executable = PurePath(words[0]).name
    if executable in _POSIX_DIRECT_SAFE:
        return True
    if (platform or sys.platform).startswith("linux") and executable in {"numfmt", "tac"}:
        return True
    validators = {
        "base64": _safe_base64,
        "find": _safe_find,
        "git": _safe_git,
        "rg": _safe_rg,
        "sed": _safe_sed,
    }
    validator = validators.get(executable)
    return validator(words) if validator is not None else False


def _is_known_safe_windows_segment(
    segment: ShellCommandSegment,
    *,
    shell_kind: ShellKind,
) -> bool:
    executable = PureWindowsPath(segment.words[0]).name.casefold()
    if executable.endswith(".exe"):
        executable = executable[:-4]
    if executable == "git":
        return _safe_git(("git", *segment.words[1:]))
    if executable == "rg":
        return _safe_rg(("rg", *segment.words[1:]))
    if shell_kind is ShellKind.POWERSHELL:
        if executable in _POWERSHELL_DIRECT_SAFE:
            return True
        return (
            executable in _POWERSHELL_LITERAL_PIPELINE_SAFE
            and segment.operator_before == "|"
        )
    return executable in _CMD_DIRECT_SAFE


def _classify_parsed(
    parsed: ShellParseResult,
    *,
    shell_kind: ShellKind,
    platform: str | None,
) -> ShellCommandClassification:
    if parsed.kind is ShellParseKind.INVALID:
        return ShellCommandClassification(
            ShellCommandDecision.INVALID,
            parsed.reason or "invalid shell command",
            parsed.segments,
        )
    if parsed.kind is ShellParseKind.COMPLEX:
        return ShellCommandClassification(
            ShellCommandDecision.COMPLEX,
            parsed.reason or "complex shell syntax requires approval",
            parsed.segments,
        )
    for segment in parsed.segments:
        if not is_known_safe_segment(
            segment,
            shell_kind=shell_kind,
            platform=platform,
        ):
            return ShellCommandClassification(
                ShellCommandDecision.UNKNOWN,
                f"Unknown command {segment.words[0]} requires approval",
                parsed.segments,
                command_pattern=" ".join(segment.words[:3]),
            )
    return ShellCommandClassification(
        ShellCommandDecision.SAFE,
        "Command allowed",
        parsed.segments,
    )


def _safe_base64(words: tuple[str, ...]) -> bool:
    return not any(
        arg in {"-o", "--output"}
        or arg.startswith("--output=")
        or (arg.startswith("-o") and arg != "-o")
        for arg in words[1:]
    )


def _safe_find(words: tuple[str, ...]) -> bool:
    forbidden = {
        "-delete",
        "-exec",
        "-execdir",
        "-fls",
        "-fprint",
        "-fprint0",
        "-fprintf",
        "-ok",
        "-okdir",
    }
    return not any(arg in forbidden for arg in words[1:])


def _safe_rg(words: tuple[str, ...]) -> bool:
    unsafe_without_value = {"--search-zip", "-z"}
    unsafe_with_value = {"--hostname-bin", "--pre"}
    return not any(
        arg in unsafe_without_value
        or any(
            arg == option or arg.startswith(f"{option}=")
            for option in unsafe_with_value
        )
        for arg in words[1:]
    )


def _safe_sed(words: tuple[str, ...]) -> bool:
    return (
        3 <= len(words) <= 4
        and words[1] == "-n"
        and _SED_PRINT_RE.fullmatch(words[2]) is not None
    )


def _safe_git(words: tuple[str, ...]) -> bool:
    index = 1
    while index < len(words):
        if words[index] == "-C" and index + 1 < len(words):
            index += 2
            continue
        if words[index] == "--no-pager":
            index += 1
            continue
        break
    if index >= len(words):
        return False
    subcommand = words[index].casefold()
    args = words[index + 1 :]
    if any(
        arg in {"--ext-diff", "--output", "--textconv"}
        or arg.startswith("--output=")
        for arg in args
    ):
        return False
    if subcommand in {"status", "log", "diff", "show"}:
        return True
    if subcommand != "branch":
        return False
    if not args:
        return True
    saw_list_form = False
    for arg in args:
        if arg in {
            "--all",
            "--list",
            "--remotes",
            "--show-current",
            "--verbose",
            "-a",
            "-l",
            "-r",
            "-v",
            "-vv",
        }:
            saw_list_form = True
            continue
        if arg.startswith("--format="):
            saw_list_form = True
            continue
        if saw_list_form and not arg.startswith("-"):
            continue
        return False
    return saw_list_form


def _parse_posix(command: str, *, allow_wrapper: bool = True) -> ShellParseResult:
    tokens, error = _tokenize_posix(command)
    if error is not None:
        return error
    if not tokens:
        return ShellParseResult(ShellParseKind.INVALID, reason="empty command")

    segments: list[ShellCommandSegment] = []
    words: list[str] = []
    operator_before: str | None = None
    effective_cwd: str | None = None
    leading_cd_chain = True

    for token in tokens:
        if not token.operator:
            if not words and _ASSIGNMENT_RE.match(token.value):
                return ShellParseResult(ShellParseKind.COMPLEX, reason="assignment")
            if not token.quoted and any(char in token.value for char in "*?["):
                return ShellParseResult(ShellParseKind.COMPLEX, reason="wildcard")
            words.append(token.value)
            continue
        if token.value not in _PLAIN_POSIX_OPERATORS:
            return ShellParseResult(ShellParseKind.COMPLEX, reason="unsupported operator")
        if not words:
            return ShellParseResult(ShellParseKind.INVALID, reason="empty command segment")
        segment = ShellCommandSegment(
            words=tuple(words),
            operator_before=operator_before,
            effective_cwd=effective_cwd,
        )
        if segment.words[0] in _SHELL_KEYWORDS:
            return ShellParseResult(ShellParseKind.COMPLEX, reason="shell keyword")
        segments.append(segment)
        if leading_cd_chain and token.value == "&&" and _is_literal_cd(segment.words):
            effective_cwd = _join_posix_cwd(effective_cwd, segment.words[1])
        else:
            leading_cd_chain = False
        words = []
        operator_before = token.value

    if not words:
        return ShellParseResult(ShellParseKind.INVALID, reason="empty command segment")
    final_segment = ShellCommandSegment(
        words=tuple(words),
        operator_before=operator_before,
        effective_cwd=effective_cwd,
    )
    if final_segment.words[0] in _SHELL_KEYWORDS:
        return ShellParseResult(ShellParseKind.COMPLEX, reason="shell keyword")
    segments.append(final_segment)
    result = ShellParseResult(ShellParseKind.PLAIN, segments=tuple(segments))
    if not allow_wrapper or len(result.segments) != 1:
        return result
    wrapper_words = result.segments[0].words
    if (
        len(wrapper_words) == 3
        and PurePath(wrapper_words[0]).name in {"bash", "sh", "zsh"}
        and wrapper_words[1] == "-lc"
    ):
        return _parse_posix(wrapper_words[2], allow_wrapper=False)
    return result


def _parse_windows(command: str, *, shell_kind: ShellKind) -> ShellParseResult:
    tokens, error = _tokenize_windows(command, shell_kind=shell_kind)
    if error is not None:
        return error
    if not tokens:
        return ShellParseResult(ShellParseKind.INVALID, reason="empty command")

    allowed_operators = {"&&", "||", "|"}
    if shell_kind is ShellKind.POWERSHELL:
        allowed_operators.add(";")
    else:
        allowed_operators.add("&")

    segments: list[ShellCommandSegment] = []
    words: list[str] = []
    operator_before: str | None = None
    effective_cwd: str | None = None
    leading_cd_chain = True

    for token in tokens:
        if not token.operator:
            words.append(token.value)
            continue
        if token.value not in allowed_operators:
            return ShellParseResult(ShellParseKind.COMPLEX, reason="unsupported operator")
        if not words:
            return ShellParseResult(ShellParseKind.INVALID, reason="empty command segment")
        segment = ShellCommandSegment(
            words=tuple(words),
            operator_before=operator_before,
            effective_cwd=effective_cwd,
        )
        segments.append(segment)
        if leading_cd_chain and token.value == "&&" and _is_literal_cd(segment.words):
            effective_cwd = _join_windows_cwd(effective_cwd, segment.words[1])
        else:
            leading_cd_chain = False
        words = []
        operator_before = token.value

    if not words:
        return ShellParseResult(ShellParseKind.INVALID, reason="empty command segment")
    segments.append(
        ShellCommandSegment(
            words=tuple(words),
            operator_before=operator_before,
            effective_cwd=effective_cwd,
        )
    )
    return ShellParseResult(ShellParseKind.PLAIN, segments=tuple(segments))


def _tokenize_windows(
    command: str,
    *,
    shell_kind: ShellKind,
) -> tuple[tuple[_ShellToken, ...], ShellParseResult | None]:
    stripped = command.strip()
    if not stripped:
        return (), ShellParseResult(ShellParseKind.INVALID, reason="empty command")

    tokens: list[_ShellToken] = []
    current: list[str] = []
    current_started = False
    current_quoted = False
    quote: str | None = None
    escaped = False
    escape_char = "`" if shell_kind is ShellKind.POWERSHELL else "^"
    index = 0

    def flush_word() -> None:
        nonlocal current_started, current_quoted
        if current_started:
            tokens.append(_ShellToken("".join(current), quoted=current_quoted))
            current.clear()
            current_started = False
            current_quoted = False

    while index < len(stripped):
        char = stripped[index]
        if escaped:
            current.append(char)
            current_started = True
            current_quoted = True
            escaped = False
            index += 1
            continue
        if char == escape_char:
            escaped = True
            index += 1
            continue
        if quote is not None:
            if char == quote:
                quote = None
            elif shell_kind is ShellKind.POWERSHELL and quote == '"' and char == "$":
                return (), ShellParseResult(ShellParseKind.COMPLEX, reason="expansion")
            elif shell_kind is ShellKind.CMD and char in {"%", "!"}:
                return (), ShellParseResult(ShellParseKind.COMPLEX, reason="expansion")
            else:
                current.append(char)
                current_started = True
                current_quoted = True
            index += 1
            continue
        if char in {"'", '"'}:
            quote = char
            current_started = True
            current_quoted = True
            index += 1
            continue
        if shell_kind is ShellKind.POWERSHELL and char in {"$", "@"}:
            return (), ShellParseResult(ShellParseKind.COMPLEX, reason="expansion")
        if shell_kind is ShellKind.CMD and char in {"%", "!"}:
            return (), ShellParseResult(ShellParseKind.COMPLEX, reason="expansion")
        if char.isspace():
            flush_word()
            index += 1
            continue
        if char in {"<", ">"}:
            return (), ShellParseResult(ShellParseKind.COMPLEX, reason="redirection")
        if char in {"(", ")", "{", "}"}:
            return (), ShellParseResult(ShellParseKind.COMPLEX, reason="grouping")
        if char in {"&", "|"}:
            flush_word()
            doubled = index + 1 < len(stripped) and stripped[index + 1] == char
            value = char * 2 if doubled else char
            if shell_kind is ShellKind.POWERSHELL and value == "&":
                return (), ShellParseResult(ShellParseKind.COMPLEX, reason="invocation")
            tokens.append(_ShellToken(value, operator=True))
            index += 2 if doubled else 1
            continue
        if char == ";" and shell_kind is ShellKind.POWERSHELL:
            flush_word()
            tokens.append(_ShellToken(char, operator=True))
            index += 1
            continue
        current.append(char)
        current_started = True
        index += 1

    if quote is not None or escaped:
        return (), ShellParseResult(ShellParseKind.INVALID, reason="malformed quoting")
    flush_word()
    return tuple(tokens), None


def _tokenize_posix(
    command: str,
) -> tuple[tuple[_ShellToken, ...], ShellParseResult | None]:
    stripped = command.strip()
    if not stripped:
        return (), ShellParseResult(ShellParseKind.INVALID, reason="empty command")
    first_word = re.match(r"([A-Za-z]+)\b", stripped)
    if first_word is not None and first_word.group(1) in _SHELL_KEYWORDS:
        return (), ShellParseResult(ShellParseKind.COMPLEX, reason="shell keyword")

    tokens: list[_ShellToken] = []
    current: list[str] = []
    current_started = False
    current_quoted = False
    quote: str | None = None
    escaped = False
    index = 0

    def flush_word() -> None:
        nonlocal current_started, current_quoted
        if current_started:
            tokens.append(_ShellToken("".join(current), quoted=current_quoted))
            current.clear()
            current_started = False
            current_quoted = False

    while index < len(stripped):
        char = stripped[index]
        if escaped:
            current.append(char)
            current_started = True
            current_quoted = True
            escaped = False
            index += 1
            continue
        if quote == "'":
            if char == "'":
                quote = None
            else:
                current.append(char)
                current_started = True
                current_quoted = True
            index += 1
            continue
        if quote == '"':
            if char == '"':
                quote = None
            elif char == "\\":
                escaped = True
            elif char in {"$", "`"}:
                return (), ShellParseResult(ShellParseKind.COMPLEX, reason="expansion")
            else:
                current.append(char)
                current_started = True
                current_quoted = True
            index += 1
            continue
        if char == "\\":
            escaped = True
            index += 1
            continue
        if char in {"'", '"'}:
            quote = char
            current_started = True
            current_quoted = True
            index += 1
            continue
        if char in {"$", "`"}:
            return (), ShellParseResult(ShellParseKind.COMPLEX, reason="expansion")
        if char.isspace():
            flush_word()
            index += 1
            continue
        if char in {"&", "|"}:
            flush_word()
            doubled = index + 1 < len(stripped) and stripped[index + 1] == char
            value = char * 2 if doubled else char
            if value == "&":
                return (), ShellParseResult(ShellParseKind.COMPLEX, reason="background")
            tokens.append(_ShellToken(value, operator=True))
            index += 2 if doubled else 1
            continue
        if char in {"<", ">"}:
            if index + 1 < len(stripped) and stripped[index + 1] == "(":
                return (), ShellParseResult(ShellParseKind.COMPLEX, reason="grouping")
            return (), ShellParseResult(ShellParseKind.COMPLEX, reason="redirection")
        if char in {"(", ")", "{", "}"}:
            return (), ShellParseResult(ShellParseKind.COMPLEX, reason="grouping")
        if char == ";":
            flush_word()
            tokens.append(_ShellToken(char, operator=True))
            index += 1
            continue
        current.append(char)
        current_started = True
        index += 1

    if quote is not None or escaped:
        return (), ShellParseResult(ShellParseKind.INVALID, reason="malformed quoting")
    flush_word()
    return tuple(tokens), None


def _is_literal_cd(words: tuple[str, ...]) -> bool:
    return len(words) == 2 and words[0] == "cd" and bool(words[1])


def _join_posix_cwd(current: str | None, target: str) -> str:
    if posixpath.isabs(target) or current is None:
        return posixpath.normpath(target)
    return posixpath.normpath(posixpath.join(current, target))


def _join_windows_cwd(current: str | None, target: str) -> str:
    if ntpath.isabs(target) or current is None:
        return ntpath.normpath(target)
    return ntpath.normpath(ntpath.join(current, target))


__all__ = [
    "ShellCommandClassification",
    "ShellCommandDecision",
    "ShellCommandSegment",
    "ShellParseKind",
    "ShellParseResult",
    "classify_shell_argv",
    "classify_shell_command",
    "is_known_safe_segment",
    "parse_shell_argv",
    "parse_shell_command",
]
