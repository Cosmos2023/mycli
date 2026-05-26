from __future__ import annotations

from pathlib import Path

from mycli.domain.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.runtime import (
    AgentConfig,
    CompactionRehydrationContext,
    ExecutionContext,
    PlanItem,
    PlanState,
    PlanStatus,
    RehydratedFile,
)
from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.tools.base import ToolSpec


def test_instruction_contract_assembler_layers_turn_context_into_base_developer_and_contextual_fragments() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="inspect this repo with $repository-analysis",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            skill_catalog="Available skills:\n- code-review: Review code",
            runtime_reminders=("Prefer source files before logs.",),
            tool_exposure=ToolExposure(
                direct=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("list_directory"),
                        kind=ToolExposureKind.DIRECT,
                        source=ToolRouteSource.REGISTRY,
                        spec=ToolSpec(name="list_directory", description="List directory"),
                    ),
                ),
            ),
        ),
        workspace_instructions="Follow workspace conventions.",
    )

    contract = InstructionContractAssembler().assemble(
        turn_context=turn_context,
        base_instructions="You are mycli.",
        conversation_messages=(),
    )

    assert contract.base_instructions == "You are mycli."
    assert [section.kind for section in contract.developer_sections] == [
        "tool_exposure",
    ]
    assert "本轮只使用已暴露且可调用的工具" in contract.developer_sections[0].content
    assert "所有工具都属于同一个平等工具集" in contract.developer_sections[0].content
    assert "direct/deferred" not in contract.developer_sections[0].content
    assert "动态工具" not in contract.developer_sections[0].content
    assert [fragment.kind for fragment in contract.contextual_user_sections] == [
        "workspace_instructions",
        "environment_context",
        "skill_catalog",
    ]
    assert contract.current_user_request == "inspect this repo with $repository-analysis"
    assert contract.contextual_user_sections[0].include_in_memory is False
    assert "这是本轮的工作区/项目说明。" in contract.contextual_user_sections[0].content
    skill_catalog_fragment = next(
        fragment
        for fragment in contract.contextual_user_sections
        if fragment.kind == "skill_catalog"
    )
    assert "调用 Skill 工具" in skill_catalog_fragment.content
    assert "code-review" in skill_catalog_fragment.content


def test_instruction_contract_assembler_keeps_added_tools_inside_plain_toolset() -> None:
    descriptor = ToolContributionDescriptor(
        tool_id="runtime:daily_brief:thread",
        display_name="daily_brief",
        description="Prepare a daily brief",
        route_key=ToolRouteKey.local("daily_brief"),
        source=ToolContributionSource.RUNTIME,
        scope=ToolContributionScope.THREAD,
        lifecycle_state=ToolContributionLifecycleState.EXPOSED,
        spec=ToolSpec(name="daily_brief", description="Prepare a daily brief"),
    )
    turn_context = TurnContextAssembler().assemble(
        user_message="help with my daily work",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            tool_exposure=ToolExposure(
                contributed=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("daily_brief"),
                        kind=ToolExposureKind.CONTRIBUTED,
                        source=ToolRouteSource.RUNTIME,
                        spec=descriptor.spec,
                        contributed_descriptor=descriptor,
                    ),
                ),
            ),
        ),
    )

    contract = InstructionContractAssembler().assemble(
        turn_context=turn_context,
        base_instructions="You are mycli.",
        conversation_messages=(),
    )

    assert not any(
        "动态工具" in fragment.content or "Contributed tool" in fragment.content
        for fragment in contract.contextual_user_sections
    )
    tool_fragment = next(
        fragment
        for fragment in contract.developer_sections
        if fragment.kind == "tool_exposure"
    )
    assert "Available tools: daily_brief" in tool_fragment.content
    assert "动态工具" not in tool_fragment.content


def test_instruction_contract_assembler_emits_compaction_rehydration_fragment() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            compaction_rehydration=CompactionRehydrationContext(
                files=(
                    RehydratedFile(
                        path="src/app.py",
                        content="print('ok')",
                        token_count=3,
                        truncated=False,
                    ),
                )
            ),
        ),
    )

    contract = InstructionContractAssembler().assemble(
        turn_context=turn_context,
        base_instructions="Base",
        conversation_messages=(),
    )

    fragment = next(
        item
        for item in contract.contextual_user_sections
        if item.kind == "compaction_rehydration"
    )
    assert fragment.include_in_memory is False
    assert "[Compaction file rehydration]" in fragment.content


def test_instruction_contract_keeps_plan_separate_from_compaction_rehydration() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            plan_state=PlanState(
                items=(
                    PlanItem(
                        id="plan_1",
                        content="Finish the implementation",
                        status=PlanStatus.IN_PROGRESS,
                    ),
                )
            ),
            compaction_rehydration=CompactionRehydrationContext(
                files=(
                    RehydratedFile(
                        path="src/app.py",
                        content="print('ok')",
                        token_count=3,
                        truncated=False,
                    ),
                )
            ),
        ),
    )

    contract = InstructionContractAssembler().assemble(
        turn_context=turn_context,
        base_instructions="Base",
        conversation_messages=(),
    )

    plan_fragment = next(item for item in contract.contextual_user_sections if item.kind == "plan")
    rehydration_fragment = next(
        item
        for item in contract.contextual_user_sections
        if item.kind == "compaction_rehydration"
    )

    assert "Finish the implementation" in plan_fragment.content
    assert "Finish the implementation" not in rehydration_fragment.content
    assert "src/app.py" in rehydration_fragment.content
