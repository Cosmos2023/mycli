from __future__ import annotations

from mycli.prompts.system import build_system_prompt


def test_build_system_prompt_loads_fixed_english_template() -> None:
    prompt = build_system_prompt()

    assert "Return JSON" not in prompt
    assert "tool_name" not in prompt
    assert "model provider" not in prompt
    assert "You are mycli" in prompt
    assert "until their goal is genuinely handled" in prompt
    assert "Bring senior engineering judgment" in prompt
    assert "Prefer existing project patterns" in prompt
    assert "Never revert, overwrite, or discard user changes" in prompt
    assert "Use tools to close specific information gaps" in prompt
    assert "rg --files" in prompt
    assert "explicit `offset` and `limit`" in prompt
    assert "Patch" in prompt
    assert "Bash" in prompt
    assert "Do not use `sed`, `awk`, `perl`, or Python shell scripts to modify files directly" in prompt
    assert "If the user asks for a review" in prompt
    assert "Respond in the user's language" in prompt
    assert "read_file_range" not in prompt
    assert "search_text" not in prompt
    assert "list_directory" not in prompt
    assert "run_shell" not in prompt
