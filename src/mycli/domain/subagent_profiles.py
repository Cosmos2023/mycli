from __future__ import annotations

from mycli.domain.subagents import SubAgentProfile


GLOBAL_CHILD_DENYLIST: tuple[str, ...] = (
    "Task",
    "AskUserQuestion",
    "enter_plan_mode",
    "exit_plan_mode",
    "EnterPlanMode",
    "ExitPlanMode",
)

_PROFILES: dict[str, SubAgentProfile] = {
    "executor": SubAgentProfile(
        name="executor",
        system_prompt=(
            "You are a bounded execution sub-agent. Make small scoped changes only. "
            "Return concise findings and changed paths. Do not ask the user questions."
        ),
        default_tools=("Read", "LS", "Lint"),
        denied_tools=GLOBAL_CHILD_DENYLIST,
    ),
    "explore": SubAgentProfile(
        name="explore",
        system_prompt=(
            "You are a read-only exploration sub-agent. Map files, symbols, and facts. "
            "Do not modify files or ask the user questions."
        ),
        default_tools=("Read", "LS"),
        denied_tools=GLOBAL_CHILD_DENYLIST,
    ),
    "review": SubAgentProfile(
        name="review",
        system_prompt=(
            "You are a code review sub-agent. Prioritize correctness, regressions, "
            "security, and missing tests. Do not modify files."
        ),
        default_tools=("Read", "LS", "Lint"),
        denied_tools=GLOBAL_CHILD_DENYLIST,
    ),
}


def get_sub_agent_profile(name: str) -> SubAgentProfile | None:
    return _PROFILES.get(name)


def list_sub_agent_profiles() -> list[SubAgentProfile]:
    return [_PROFILES[name] for name in sorted(_PROFILES)]


__all__ = ["GLOBAL_CHILD_DENYLIST", "get_sub_agent_profile", "list_sub_agent_profiles"]
