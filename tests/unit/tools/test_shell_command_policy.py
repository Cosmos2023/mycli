import pytest

from mycli.domain.runtime import ShellKind
from mycli.tools.shell_command_policy import (
    ShellParseKind,
    parse_shell_argv,
    parse_shell_command,
)


def test_posix_parser_splits_plain_control_operators_and_tracks_cd() -> None:
    parsed = parse_shell_command(
        "cd src && cat app.py | head -n 20",
        shell_kind=ShellKind.BASH,
    )

    assert parsed.kind is ShellParseKind.PLAIN
    assert [segment.words for segment in parsed.segments] == [
        ("cd", "src"),
        ("cat", "app.py"),
        ("head", "-n", "20"),
    ]
    assert [segment.operator_before for segment in parsed.segments] == [
        None,
        "&&",
        "|",
    ]
    assert [segment.effective_cwd for segment in parsed.segments] == [
        None,
        "src",
        "src",
    ]


def test_structured_argv_keeps_shell_metacharacters_literal() -> None:
    parsed = parse_shell_argv(
        ("echo", "a>b", "x&&y"),
        shell_kind=ShellKind.BASH,
    )

    assert parsed.kind is ShellParseKind.PLAIN
    assert parsed.segments[0].words == ("echo", "a>b", "x&&y")


@pytest.mark.parametrize(
    ("command", "reason"),
    [
        ("echo hello > out.txt", "redirection"),
        ("cat $(resolve-path)", "expansion"),
        ("cat <(generate-input)", "grouping"),
        ("NAME=value command", "assignment"),
        ("cat *.py", "wildcard"),
        ("sleep 1 &", "background"),
        ("for f in files; do cat $f; done", "shell keyword"),
    ],
)
def test_posix_parser_marks_unsupported_syntax_complex(
    command: str,
    reason: str,
) -> None:
    parsed = parse_shell_command(command, shell_kind=ShellKind.BASH)

    assert parsed.kind is ShellParseKind.COMPLEX
    assert parsed.reason == reason
