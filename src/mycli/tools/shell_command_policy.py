from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import posixpath
import re

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


class ShellParseKind(StrEnum):
    PLAIN = "plain"
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
class _ShellToken:
    value: str
    operator: bool = False
    quoted: bool = False


def parse_shell_command(command: str, *, shell_kind: ShellKind) -> ShellParseResult:
    if shell_kind in {ShellKind.BASH, ShellKind.ZSH, ShellKind.SH}:
        return _parse_posix(command)
    return ShellParseResult(
        ShellParseKind.COMPLEX,
        reason=f"{shell_kind.value} parsing is not available",
    )


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


def _parse_posix(command: str) -> ShellParseResult:
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
    return ShellParseResult(ShellParseKind.PLAIN, segments=tuple(segments))


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


__all__ = [
    "ShellCommandSegment",
    "ShellParseKind",
    "ShellParseResult",
    "parse_shell_argv",
    "parse_shell_command",
]
