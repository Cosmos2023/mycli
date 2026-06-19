from __future__ import annotations

from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt


def test_build_system_prompt_remains_protocol_agnostic() -> None:
    prompt = build_system_prompt()

    assert "Return JSON" not in prompt
    assert "tool_name" not in prompt
    assert "model provider" not in prompt
    assert "运行在用户本地机器上的 coding agent" in prompt
    assert "用户的目标被真正处理好" in prompt
    assert "能在当前回合完成实现、验证和结果说明时，就完成闭环" in prompt
    assert "优先复用仓库已有模式" in prompt
    assert "NEVER 覆盖、回滚或重置你没有做出的用户改动" in prompt
    assert "批量读取" in prompt
    assert "重叠范围" in prompt
    assert "rg -n -C 3" in prompt
    assert "rg --files" in prompt
    assert "nl -ba" in prompt
    assert "Read" in prompt
    assert "offset / limit" in prompt
    assert "Patch" in prompt
    assert "Bash" in prompt
    assert "无界输出大文件" in prompt
    assert "NEVER 用 Bash 执行 sed/awk/perl/python 脚本来修改文件" in prompt
    assert "read_file_range" not in prompt
    assert "search_text" not in prompt
    assert "list_directory" not in prompt
    assert "run_shell" not in prompt
    assert "纯自然语言" in prompt


def test_build_react_prompt_stays_protocol_agnostic_and_prefers_rg_discovery() -> None:
    prompt = build_react_prompt()

    assert "Return JSON" not in prompt
    assert "tool_name" not in prompt
    assert "从当前用户请求和可见上下文出发" in prompt
    assert "如果你已经有足够信息可以帮助用户，就直接回答" in prompt
    assert "编辑文件或执行有影响的命令前，先检查相关上下文" in prompt
    assert "非简单任务优先使用 planning tool" in prompt
    assert "rg / rg --files" in prompt
    assert "精读文件" in prompt
    assert "修改文件必须使用 Edit / Patch / Write" in prompt
    assert "批量读取相关文件" in prompt
    assert "Bash" in prompt
    assert "run_shell" not in prompt
    assert "read_file_range" not in prompt
