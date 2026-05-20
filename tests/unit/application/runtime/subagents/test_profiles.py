from mycli.application.runtime.subagents.profiles import (
    get_sub_agent_profile,
    list_sub_agent_profiles,
)


def test_builtin_profiles_are_stable_and_conservative() -> None:
    profiles = list_sub_agent_profiles()

    assert [profile.name for profile in profiles] == ["executor", "explore", "review"]
    assert get_sub_agent_profile("explore").default_tools == ("Read", "Grep", "Glob", "LS")
    assert get_sub_agent_profile("review").default_tools == (
        "Read",
        "Grep",
        "Glob",
        "LS",
        "Lint",
    )
    assert "Bash" not in get_sub_agent_profile("executor").default_tools
    assert "Task" in get_sub_agent_profile("executor").denied_tools


def test_unknown_profile_returns_none() -> None:
    assert get_sub_agent_profile("missing") is None
