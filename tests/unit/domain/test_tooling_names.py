from __future__ import annotations

from mycli.domain.tooling.names import provider_safe_tool_name


def test_provider_safe_tool_name_joins_route_parts_with_underscores() -> None:
    assert provider_safe_tool_name("skill", "code-review") == "skill_code_review"
    assert provider_safe_tool_name("subagent", "explore") == "subagent_explore"
    assert provider_safe_tool_name("mcp", "local", "echo") == "mcp_local_echo"


def test_provider_safe_tool_name_strips_provider_unsafe_characters() -> None:
    assert provider_safe_tool_name("mcp", "github.remote", "search/code") == "mcp_github_remote_search_code"
    assert provider_safe_tool_name("  ", "...") == "tool"


def test_provider_safe_tool_name_bounds_long_names_with_hash_suffix() -> None:
    safe_name = provider_safe_tool_name("mcp", "server" * 20, "tool" * 20)

    assert len(safe_name) == 64
    assert safe_name.startswith("mcp_serverserver")
    assert safe_name[-9] == "_"
