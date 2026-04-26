from __future__ import annotations

from pathlib import Path

from mycli.domain.runtime import (
    AgentConfig,
    ExecutionContext,
    TurnContextSectionType,
)
from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt
from mycli.services.context.turn_context_assembler import TurnContextAssembler


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
    assert "普通自然语言" in prompt


def test_build_react_prompt_stays_protocol_agnostic_and_prefers_specialized_tools() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="当前目录下都有哪些文件",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            available_tool_names=(
                "list_directory",
                "read_file_range",
                "append_file",
                "replace_in_file",
                "run_shell",
            ),
        ),
    )
    prompt = build_react_prompt(turn_context)

    assert "Return JSON" not in prompt
    assert "tool_name" not in prompt
    assert "从当前用户请求和可见上下文出发" in prompt
    assert "如果你已经有足够信息可以帮助用户，就直接回答" in prompt
    assert "编辑文件或执行有影响的命令前，先检查相关上下文" in prompt
    assert "非简单任务优先使用 planning tool" in prompt
    assert "优先使用专门的工作区工具，而不是 run_shell" in prompt
    assert "优先使用 rg 风格搜索和专门的文件编辑工具" in prompt
    assert "Available tools: list_directory, read_file_range, append_file, replace_in_file, run_shell" in prompt
    assert turn_context.sections[-1].type is TurnContextSectionType.USER_REQUEST


def test_build_react_prompt_adds_repo_analysis_fact_and_inference_contract() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="请分析这个仓库的入口文件和主要模块，给我一个简短总结。",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            available_tool_names=("list_directory", "search_text", "read_file_range"),
            runtime_policy_state={
                "profile_name": "source_first_overview",
                "path_bias": "source_first",
                "evidence_status": "insufficient",
            },
        ),
    )

    prompt = build_react_prompt(turn_context)

    assert "已确认事实" in prompt
    assert "推断" in prompt
    assert "源码或配置文件" in prompt


def test_build_react_prompt_adds_implementation_audit_contract_from_policy_state() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="请检查 turn context、runtime 和 trace 是否已经接入 capability activation。",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            available_tool_names=("search_text", "read_file_range"),
            runtime_reminders=("Prefer source files before logs.",),
            runtime_policy_state={
                "profile_name": "source_first_verification",
                "path_bias": "source_first",
                "evidence_status": "insufficient",
            },
        ),
    )

    prompt = build_react_prompt(turn_context)

    assert "验证型请求" in prompt
    assert "源码优先" in prompt
    assert "日志" in prompt or "model-raw" in prompt.lower()


def test_build_react_prompt_adds_plan_continuity_guidance_from_policy_state() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="继续做下去",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            available_tool_names=("update_plan", "read_file_range"),
            runtime_policy_state={
                "profile_name": "general",
                "path_bias": "balanced",
                "evidence_status": "unknown",
                "plan_status": "in_progress",
                "planning_mode": "continue_existing",
            },
        ),
    )

    prompt = build_react_prompt(turn_context)

    assert "已有进行中的计划时" in prompt
    assert "才重写整份计划" in prompt
