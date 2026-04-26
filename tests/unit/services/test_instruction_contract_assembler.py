from __future__ import annotations

from pathlib import Path

from mycli.domain.dynamic_tools import (
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.runtime import (
    AgentConfig,
    CapabilityActivation,
    CapabilityActivationDependencyStatus,
    CapabilityActivationSource,
    ExecutionContext,
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
            capability_activations=(
                CapabilityActivation(
                    name="repository-analysis",
                    description="Inspect repositories",
                    instructions="Inspect repositories before answering.",
                    source=CapabilityActivationSource.EXPLICIT_MENTION,
                    dependency_status=CapabilityActivationDependencyStatus.READY,
                    source_path="/tmp/skills/repository-analysis/SKILL.md",
                ),
            ),
            runtime_reminders=("Prefer source files before logs.",),
            runtime_policy_state={
                "profile_name": "source_first_verification",
                "path_bias": "source_first",
            },
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
        "runtime_policy",
        "tool_exposure",
    ]
    assert "本轮请遵循这组 runtime policy。" in contract.developer_sections[0].content
    assert "本轮只使用已暴露且可调用的工具" in contract.developer_sections[1].content
    assert [fragment.kind for fragment in contract.contextual_user_sections] == [
        "workspace_instructions",
        "environment_context",
        "capability_body",
        "user_request",
    ]
    assert contract.contextual_user_sections[0].include_in_memory is False
    assert "这是本轮的工作区/项目说明。" in contract.contextual_user_sections[0].content
    capability_fragment = next(
        fragment
        for fragment in contract.contextual_user_sections
        if fragment.kind == "capability_body"
    )
    assert "这是本轮可用的 capability。" in capability_fragment.content
    assert "repository-analysis" in capability_fragment.content
    assert "Inspect repositories before answering." in capability_fragment.content


def test_instruction_contract_assembler_moves_dynamic_tool_context_into_contextual_fragments() -> None:
    descriptor = DynamicToolDescriptor(
        tool_id="runtime:daily_brief:thread",
        display_name="daily_brief",
        description="Prepare a daily brief",
        route_key=ToolRouteKey.local("daily_brief"),
        source=DynamicToolSource.RUNTIME,
        scope=DynamicToolScope.THREAD,
        lifecycle_state=DynamicToolLifecycleState.EXPOSED,
        spec=ToolSpec(name="daily_brief", description="Prepare a daily brief"),
    )
    turn_context = TurnContextAssembler().assemble(
        user_message="help with my daily work",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            tool_exposure=ToolExposure(
                dynamic=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("daily_brief"),
                        kind=ToolExposureKind.DYNAMIC,
                        source=ToolRouteSource.RUNTIME,
                        spec=descriptor.spec,
                        dynamic_descriptor=descriptor,
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

    assert any(
        fragment.kind == "dynamic_tool_context"
        and "这是本轮可用的动态工具。" in fragment.content
        and "daily_brief" in fragment.content
        for fragment in contract.contextual_user_sections
    )
