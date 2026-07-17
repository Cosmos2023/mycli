import pytest

from mycli.domain.runtime import ShellKind
from mycli.tools.shell_command_policy import (
    ShellCommandDecision,
    ShellParseKind,
    classify_shell_command,
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


@pytest.mark.parametrize(
    "command",
    [
        "cat README.md",
        "head -n 20 README.md",
        "tail -n +10 README.md",
        "ls -la",
        "pwd",
        "rg -n approval src",
        "sed -n 10,20p app.py",
        "git status --short",
        "git -C repo diff --stat",
        "find src -name '*.py'",
    ],
)
def test_posix_known_read_commands_are_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.BASH)

    assert result.decision is ShellCommandDecision.SAFE


@pytest.mark.parametrize(
    "command",
    [
        "python script.py",
        "npm install",
        "base64 -o output.txt input.txt",
        "find . -delete",
        "find . -exec rm {} ';'",
        "rg --pre processor pattern",
        "rg --search-zip pattern archive.zip",
        "sed -i s/a/b/ file.txt",
        "git branch new-branch",
    ],
)
def test_unknown_or_mutating_posix_commands_are_not_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.BASH)

    assert result.decision is not ShellCommandDecision.SAFE


@pytest.mark.parametrize(
    "command",
    [
        "cd src && cat app.py",
        "rg -n approval src | head -n 20",
        "false || git status --short",
        "pwd; ls -la",
        "bash -lc 'cd src && sed -n 1,20p app.py'",
        "zsh -lc 'pwd; git status --short'",
        "sh -lc 'cat README.md | tail -n 5'",
    ],
)
def test_all_safe_segments_and_plain_wrappers_are_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.BASH)

    assert result.decision is ShellCommandDecision.SAFE


def test_one_unknown_segment_makes_composed_command_unknown() -> None:
    result = classify_shell_command(
        "cat README.md && python script.py",
        shell_kind=ShellKind.BASH,
    )

    assert result.decision is ShellCommandDecision.UNKNOWN
    assert result.command_pattern == "python script.py"


@pytest.mark.parametrize(
    "command",
    [
        "git branch",
        "git branch --list 'feature/*'",
        "git branch --show-current",
    ],
)
def test_read_only_git_branch_forms_are_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.BASH)

    assert result.decision is ShellCommandDecision.SAFE


@pytest.mark.parametrize(
    "command",
    [
        "git branch feature/new",
        "git branch -D feature/old",
        "git -c core.pager=cat status",
        "git diff --output=changes.patch",
    ],
)
def test_mutating_or_externalized_git_forms_are_unknown(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.BASH)

    assert result.decision is ShellCommandDecision.UNKNOWN


@pytest.mark.parametrize(
    "command",
    [
        "Get-ChildItem -Force | Select-Object Name",
        "Get-Content README.md | Measure-Object -Line",
        "Get-Location; git status --short",
    ],
)
def test_powershell_plain_read_composition_is_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.POWERSHELL)

    assert result.decision is ShellCommandDecision.SAFE


@pytest.mark.parametrize(
    "command",
    [
        "$env:TEMP",
        "Get-Date > date.txt",
        "Get-ChildItem | Where-Object { $_.Length -gt 0 }",
        "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
    ],
)
def test_powershell_dynamic_or_mutating_composition_is_not_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.POWERSHELL)

    assert result.decision is not ShellCommandDecision.SAFE


def test_cmd_plain_read_composition_is_safe() -> None:
    result = classify_shell_command(
        "cd src && dir | findstr py",
        shell_kind=ShellKind.CMD,
    )

    assert result.decision is ShellCommandDecision.SAFE


@pytest.mark.parametrize(
    "command",
    [
        "echo %PATH%",
        "dir > files.txt",
        "dir & del /q output.txt",
    ],
)
def test_cmd_expansion_redirection_and_unknown_segments_are_not_safe(command: str) -> None:
    result = classify_shell_command(command, shell_kind=ShellKind.CMD)

    assert result.decision is not ShellCommandDecision.SAFE
