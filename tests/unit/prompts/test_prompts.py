from __future__ import annotations

from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt


def test_build_system_prompt_remains_protocol_agnostic() -> None:
    prompt = build_system_prompt()

    assert "Return JSON" not in prompt
    assert "tool_name" not in prompt
    assert "model provider" not in prompt
    assert "本地优先的个人助手 agent" in prompt
    assert "代码、文件、终端任务和日常工作" in prompt
    assert "持续推进，直到任务处理完成" in prompt
    assert "优先解决根因" in prompt
    assert "不要覆盖或回退用户修改" in prompt
    assert "在条件允许时验证重要工作" in prompt
    assert "批量读取" in prompt
    assert "重叠范围" in prompt
    assert "Read" in prompt
    assert "Grep" in prompt
    assert "pattern" in prompt
    assert "offset / limit" in prompt
    assert "Bash" in prompt
    assert "read_file_range" not in prompt
    assert "search_text" not in prompt
    assert "list_directory" not in prompt
    assert "run_shell" not in prompt
    assert "普通自然语言" in prompt


def test_build_react_prompt_stays_protocol_agnostic_and_prefers_specialized_tools() -> None:
    prompt = build_react_prompt()

    assert "Return JSON" not in prompt
    assert "tool_name" not in prompt
    assert "从当前用户请求和可见上下文出发" in prompt
    assert "如果你已经有足够信息可以帮助用户，就直接回答" in prompt
    assert "编辑文件或执行有影响的命令前，先检查相关上下文" in prompt
    assert "非简单任务优先使用 planning tool" in prompt
    assert "优先使用工作区专用工具" in prompt
    assert "Read, Grep, Glob, LS, Edit, Write" in prompt
    assert "批量读取相关文件" in prompt
    assert "Bash" in prompt
    assert "run_shell" not in prompt
    assert "read_file_range" not in prompt
