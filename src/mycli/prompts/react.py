from __future__ import annotations

from mycli.domain.runtime import InstructionContract, InstructionFragmentKind, TurnContext
from mycli.prompts.system import build_system_prompt
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler


def build_react_prompt(
    contract_or_turn_context: InstructionContract | TurnContext,
    *,
    include_context_sections: bool = True,
    include_adaptive_guidance: bool = True,
) -> str:
    contract = _coerce_instruction_contract(contract_or_turn_context)
    rendered_sections = (
        f"{_render_contract_sections(contract)}\n"
        if include_context_sections
        else ""
    )
    runtime_policy_state = _runtime_policy_state(contract)
    adaptive_guidance = (
        _adaptive_guidance(runtime_policy_state) if include_adaptive_guidance else ""
    )
    guidance = "\n".join((
        "从当前用户请求和可见上下文出发。",
        "始终围绕当前用户请求推进，不要漂移到无关工作上。",
        "",
        "── 何时停止探索，直接回答 ──",
        "如果你已经有足够信息可以帮助用户，就直接回答——不要再调工具验证已知事实。",
        "连续 3 步没有获得实质性新信息 → 停止探索，基于已有证据回答。",
        "准备重复同一个工具调用 → 停止探索，你已经看过这个结果了。",
        '收到"你必须现在回答"的提示 → 立即停止所有工具调用，用普通文本回复。',
        "",
        "── 何时继续探索 ──",
        "信息确实不足以回答用户 → 选择最合适的单一工具动作。",
        "需要编辑文件但还没读过目标文件 → 先读再改。",
        "编辑文件或执行有影响的命令前，先检查相关上下文。",
        "任务明显需要多步推进 → 可以用 update_plan 规划，然后逐步执行。",
        "非简单任务优先使用 planning tool，避免边做边丢失目标。",
        "",
        "── 工具调用原则 ──",
        "每次工具调用必须直接服务于当前答案或下一步修改。工具不是步骤计数器。",
        "优先使用工作区专用工具（read_file, search_text, edit_file 等），而不是 run_shell。",
        "优先使用专门的工作区工具，而不是 run_shell。",
        "优先使用 rg 风格搜索和专门的文件编辑工具。",
        "在工具结果确认之前，不要假设文件、路径或状态一定存在。",
        "优先依据源码、配置文件、命令输出中的已验证事实。不能直接验证的内容标记为推断。",
        "对于代码实现类任务，源码和配置是真值，README 和文档是辅助。",
        adaptive_guidance,
        "不要在 assistant 文本里输出 JSON、工具 schema 或底层协议细节。",
        "决定当前最合适的下一步动作。",
    ))
    return rendered_sections + guidance


def _coerce_instruction_contract(
    contract_or_turn_context: InstructionContract | TurnContext,
) -> InstructionContract:
    if isinstance(contract_or_turn_context, InstructionContract):
        return contract_or_turn_context
    return InstructionContractAssembler().assemble(
        turn_context=contract_or_turn_context,
        base_instructions=build_system_prompt(),
        conversation_messages=(),
    )


def _render_contract_sections(contract: InstructionContract) -> str:
    rendered: list[str] = []
    if contract.developer_sections:
        rendered.append("开发者指令：")
        for section in contract.developer_sections:
            rendered.append(f"{section.title} ({section.kind}):\n{section.content}")
    if contract.contextual_user_sections:
        rendered.append("上下文化用户片段：")
        for section in contract.contextual_user_sections:
            rendered.append(f"{section.title} ({section.kind}):\n{section.content}")
    return "\n".join(rendered)


def _runtime_policy_state(contract: InstructionContract) -> dict[str, object]:
    for section in (*contract.developer_sections, *contract.contextual_user_sections):
        if str(section.kind) == InstructionFragmentKind.RUNTIME_POLICY.value:
            return section.metadata
    return {}


def _adaptive_guidance(runtime_policy_state: dict[str, object]) -> str:
    profile_name = str(runtime_policy_state.get("profile_name", ""))
    path_bias = str(runtime_policy_state.get("path_bias", ""))
    planning_mode = str(runtime_policy_state.get("planning_mode", ""))
    lines: list[str] = []
    if profile_name == "source_first_verification":
        lines.extend(
            [
                "对于验证型请求，先检查相关 runtime 层，再下结论。",
                "如果证据已经足够，就停止探索，并优先给出已验证的发现。",
            ]
        )
    elif profile_name == "failure_investigation":
        lines.extend(
            [
                "对于调试型请求，优先围绕已确认失败的路径，以及最可能的源码真值路径推进。",
                "如果你已经从已确认的证据中定位到可能的根因，就直接回答，并把剩余不确定部分标记为推断。",
            ]
        )
    elif profile_name == "source_first_overview":
        lines.extend(
            [
                "对于概览型请求，优先基于真实源码或配置文件中的已确认事实。",
                "如果探索预算快用完了，就先回答已确认事实，并点出仍未补齐的缺口。",
            ]
        )
    if path_bias == "source_first":
        lines.append(
            "采用源码优先策略：先看源码和配置路径，再看日志、model-raw 产物或宽泛文档。"
        )
    if planning_mode == "continue_existing":
        lines.append(
            "已有进行中的计划时，优先推进当前 in_progress 步骤；只有用户明确改方向，或当前计划已阻塞/失效时，才重写整份计划。"
        )
    elif planning_mode == "reuse_existing":
        lines.append(
            "已有计划但当前没有进行中步骤时，优先复用并轻量调整现有计划；不要为了形式而反复调用 planning tool 重建整份计划。"
        )
    elif planning_mode == "plan_if_needed":
        lines.append(
            "当前没有现成计划时，只有在任务明显需要多步推进、且规划能真正降低风险或混乱时，再使用 planning tool。"
        )
    if not lines:
        return ""
    return "\n".join(lines) + "\n"
