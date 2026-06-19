from __future__ import annotations

from pathlib import Path

from mycli.services.subagents import (
    SubAgentManagementService,
    SubAgentProfileRegistry,
    diagnostics_from_discovery,
)


def test_subagent_profile_registry_loads_repo_profile_and_disabled_user_profile(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    repo_profiles = workspace / ".mycli" / "subagents"
    user_profiles = home / ".mycli" / "subagents"
    repo_profiles.mkdir(parents=True)
    user_profiles.mkdir(parents=True)
    user_profiles.joinpath("disabled.toml").write_text(
        "\n".join(
            [
                'id = "disabled"',
                'description = "Disabled"',
                'instruction = "Do nothing"',
                'allowed_tools = ["Read"]',
                "enabled = false",
            ]
        ),
        encoding="utf-8",
    )
    repo_profiles.joinpath("analyst.toml").write_text(
        "\n".join(
            [
                'id = "analyst"',
                'description = "Analyze safely"',
                'instruction = "Analyze the workspace."',
                'allowed_tools = ["Read", "Grep"]',
                'denied_tools = ["Bash"]',
                "enabled = true",
                "[budget]",
                "max_turns = 3",
            ]
        ),
        encoding="utf-8",
    )

    discovery = SubAgentProfileRegistry(workspace_root=workspace, home_dir=home).discover()

    records = {record.profile_id: record for record in discovery.records}
    assert records["analyst"].enabled is True
    assert records["analyst"].profile.default_tools == ("Read", "Grep")
    assert records["analyst"].profile.denied_tools == ("Bash",)
    assert records["analyst"].profile.budget.max_turns == 3
    assert records["disabled"].status == "disabled"
    assert "explore" in records
    assert discovery.get_enabled_profile("disabled") is None


def test_subagent_profile_registry_reports_malformed_profile(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "subagents"
    profiles.mkdir(parents=True)
    profiles.joinpath("broken.toml").write_text("enabled = true\n", encoding="utf-8")

    discovery = SubAgentProfileRegistry(workspace_root=workspace, home_dir=home).discover()

    broken = next(record for record in discovery.records if record.profile_id == "broken")
    assert broken.status == "failed"
    assert "instruction or system_prompt is required" in discovery.issues[0].safe_line()


def test_subagent_profile_registry_loads_claude_style_markdown_agent(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "agents"
    profiles.mkdir(parents=True)
    profiles.joinpath("security-reviewer.md").write_text(
        "\n".join(
            [
                "---",
                "name: security-reviewer",
                "description: Review security-sensitive changes.",
                "tools: Read, Grep, Glob, LS",
                "disallowedTools: Bash, Write",
                "model: gpt-5.4-mini",
                "maxTurns: 5",
                "---",
                "You are a security review sub-agent.",
                "Focus on concrete vulnerabilities and missing tests.",
            ]
        ),
        encoding="utf-8",
    )

    discovery = SubAgentProfileRegistry(workspace_root=workspace, home_dir=home).discover()

    record = next(record for record in discovery.records if record.profile_id == "security-reviewer")
    assert record.status == "enabled"
    assert record.description == "Review security-sensitive changes."
    assert record.source_path.endswith(".mycli/agents/security-reviewer.md")
    assert record.profile is not None
    assert record.profile.system_prompt == (
        "You are a security review sub-agent.\n"
        "Focus on concrete vulnerabilities and missing tests."
    )
    assert record.profile.default_tools == ("Read", "Grep", "Glob", "LS")
    assert record.profile.denied_tools == ("Bash", "Write")
    assert record.profile.model == "gpt-5.4-mini"
    assert record.profile.budget.max_turns == 5


def test_subagent_profile_registry_reports_malformed_markdown_agent(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "agents"
    profiles.mkdir(parents=True)
    profiles.joinpath("broken.md").write_text(
        "\n".join(
            [
                "---",
                "name: broken",
                "tools: Read",
                "---",
                "Do work.",
            ]
        ),
        encoding="utf-8",
    )

    discovery = SubAgentProfileRegistry(workspace_root=workspace, home_dir=home).discover()

    broken = next(record for record in discovery.records if record.profile_id == "broken")
    assert broken.status == "failed"
    assert "description is required" in discovery.issues[0].safe_line()


def test_subagent_diagnostics_reports_unknown_and_high_risk_tools(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "subagents"
    profiles.mkdir(parents=True)
    profiles.joinpath("risky.toml").write_text(
        "\n".join(
            [
                'id = "risky"',
                'instruction = "Run risky checks."',
                'allowed_tools = ["Read", "Bash", "MissingTool"]',
                'denied_tools = ["Task"]',
            ]
        ),
        encoding="utf-8",
    )

    discovery = SubAgentProfileRegistry(workspace_root=workspace, home_dir=home).discover()
    diagnostics = diagnostics_from_discovery(discovery, known_tools=("Read", "Bash"))

    assert diagnostics.issue_count >= 2
    assert any("high-risk tools" in issue for issue in diagnostics.issues)
    assert any("unknown tools" in issue for issue in diagnostics.issues)


def test_subagent_management_service_lists_and_inspects_profiles(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    profiles = workspace / ".mycli" / "subagents"
    profiles.mkdir(parents=True)
    profiles.joinpath("analyst.toml").write_text(
        "\n".join(
            [
                'id = "analyst"',
                'instruction = "Analyze the workspace."',
                'allowed_tools = ["Read"]',
            ]
        ),
        encoding="utf-8",
    )
    service = SubAgentManagementService(workspace_root=workspace, home_dir=home)

    listed = service.list_profiles()
    inspected = service.inspect_profile("analyst")

    assert listed.ok is True
    assert inspected.ok is True
    assert inspected.profile.profile_id == "analyst"
    assert inspected.profile.source_path.endswith(".mycli/subagents/analyst.toml")
