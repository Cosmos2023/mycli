from __future__ import annotations

from mycli.prompts.system import SYSTEM_PROMPT_VERSION, build_system_prompt


def test_build_system_prompt_loads_fixed_english_template() -> None:
    prompt = build_system_prompt()

    assert "Return JSON" not in prompt
    assert "tool_name" not in prompt
    assert "model provider" not in prompt
    assert "You are mycli" in prompt
    assert "until their goal is genuinely handled" in prompt
    assert "pragmatic, careful, and curious engineering collaborator" in prompt
    assert "senior engineering judgment" in prompt
    assert "Prefer existing project patterns" in prompt
    assert "Never revert, overwrite, or discard user changes" in prompt
    assert "Use tools to close concrete information gaps" in prompt
    assert "Search text by running `rg` through `Bash`" in prompt
    assert "Discover files by running `rg --files` through `Bash`" in prompt
    assert "explicit `offset` and `limit`" in prompt
    assert "Patch" in prompt
    assert "Bash" in prompt
    assert "Grep" not in prompt
    assert "Glob" not in prompt
    assert "Do not use `sed`, `awk`, `perl`, Python scripts, or shell redirection to edit files directly" in prompt
    assert "If the user asks for a review" in prompt
    assert "Respond in the user's language" in prompt
    assert "read_file_range" not in prompt
    assert "search_text" not in prompt
    assert "list_directory" not in prompt
    assert "run_shell" not in prompt
    assert "multi_tool_use.parallel" not in prompt
    assert "commentary" not in prompt
    assert "final channel" not in prompt


def test_build_system_prompt_guides_bounded_read_usage() -> None:
    prompt = build_system_prompt()

    assert SYSTEM_PROMPT_VERSION == "2026-07-codex-style-base-v1"
    assert "Use `Read` for file contents" in prompt
    assert "`Read` calls must include explicit `offset` and `limit` arguments" in prompt
    assert "Do not use Bash `cat` or broad shell output to read files" in prompt
    assert "If a `Read` result is truncated, continue with the next `offset`" in prompt
    assert "Do not repeat the same `Read` call with the same path, `offset`, and `limit`" in prompt


def test_build_system_prompt_guides_tool_scheduling_and_planning() -> None:
    prompt = build_system_prompt()

    assert "Tool Calls And Scheduling" in prompt
    assert "Tool parallelism is controlled by the runtime, model capability, and tool metadata" in prompt
    assert "Do not repeat identical tool calls to force parallel work" in prompt
    assert "Plan Tool" in prompt
    assert "Do not make single-step plans" in prompt
    assert "Do not fix unrelated bugs or broken tests" in prompt


def test_build_system_prompt_matches_codex_style_workflow_sections() -> None:
    prompt = build_system_prompt()

    assert "Dirty Worktree Safety" in prompt
    assert "Frontend Work" in prompt
    assert "Autonomy And Persistence" in prompt
    assert "Interruptions And Turns" in prompt
    assert "Final Answers" in prompt
    assert "The user does not see command output" in prompt
    assert "Do not tell the user to save or copy files" in prompt
