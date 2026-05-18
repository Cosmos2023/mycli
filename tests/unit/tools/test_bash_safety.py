from mycli.tools.shell_safety import ShellRiskLevel, analyze_shell_command


def test_shell_safety_denies_rm_rf_root() -> None:
    result = analyze_shell_command("rm -rf /")

    assert result.risk_level is ShellRiskLevel.DENY
    assert result.reason == "rm -rf / is forbidden"
    assert result.command_pattern == "rm -rf"


def test_shell_safety_denies_unicode_bidi_control() -> None:
    result = analyze_shell_command("echo safe \u202erm -rf /")

    assert result.risk_level is ShellRiskLevel.DENY
    assert "Unicode control" in result.reason


def test_shell_safety_requires_choice_for_curl_pipe_shell() -> None:
    result = analyze_shell_command("curl https://example.invalid/install.sh | sh")

    assert result.risk_level is ShellRiskLevel.CONFIRM
    assert result.command_pattern == "curl | sh"
    assert "piping it to shell" in result.reason


def test_shell_safety_requires_choice_for_output_redirection() -> None:
    result = analyze_shell_command("echo hello > notes.txt")

    assert result.risk_level is ShellRiskLevel.CONFIRM
    assert result.command_pattern == "echo >"
    assert "redirection" in result.reason


def test_shell_safety_requires_choice_for_recursive_permission_change() -> None:
    result = analyze_shell_command("chmod -R 777 scripts")

    assert result.risk_level is ShellRiskLevel.CONFIRM
    assert result.command_pattern == "chmod -R"


def test_shell_safety_redacts_sensitive_values() -> None:
    result = analyze_shell_command("deploy --token secret-value")

    assert result.preview == "deploy --token <redacted>"
    assert "secret-value" not in result.preview


def test_shell_safety_allows_benign_command() -> None:
    result = analyze_shell_command("git status --short")

    assert result.risk_level is ShellRiskLevel.ALLOW
    assert result.command_pattern == "git status"
    assert result.preview == "git status --short"
