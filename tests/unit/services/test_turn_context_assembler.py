from __future__ import annotations

from pathlib import Path
import sys

from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.conversation import Message
from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.runtime import (
    AgentConfig,
    BaselineFragment,
    CanonicalTimelineDurability,
    CanonicalTimelineScope,
    CompactionRehydrationContext,
    ContextBaseline,
    ExecutionContext,
    HistoryItem,
    HistoryItemType,
    PlanItem,
    PlanState,
    PlanStatus,
    RehydratedFile,
    RuntimeEnvironmentContract,
    ShellBackendProfile,
    TurnContext,
    TurnContextSectionType,
    TurnContextSection,
    TurnContextCacheClass,
)
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.tools.base import ToolSpec


def test_turn_context_assembler_builds_deterministic_sections() -> None:
    assembler = TurnContextAssembler()
    turn_context = assembler.assemble(
        user_message="请分析这个仓库",
        context=ExecutionContext(
            config=AgentConfig(
                workspace_root=Path("/tmp/workspace"),
                session_id="demo",
                model="gpt-test",
                protocol="responses",
            ),
            memory_records=(
                MemoryRecord(
                    kind=MemoryKind.PROJECT,
                    key="repo",
                    value="This repo uses src layout.",
                ),
            ),
            tool_exposure=ToolExposure(
                direct=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("LS"),
                        kind=ToolExposureKind.DIRECT,
                        source=ToolRouteSource.REGISTRY,
                        spec=ToolSpec(name="LS", description="List directory"),
                    ),
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("Read"),
                        kind=ToolExposureKind.DIRECT,
                        source=ToolRouteSource.REGISTRY,
                        spec=ToolSpec(name="Read", description="Read file"),
                    ),
                ),
                deferred=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("Grep"),
                        kind=ToolExposureKind.DEFERRED,
                        source=ToolRouteSource.REGISTRY,
                        spec=ToolSpec(name="Grep", description="Search text"),
                    ),
                ),
                contributed=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("workspace_summary"),
                        kind=ToolExposureKind.CONTRIBUTED,
                        source=ToolRouteSource.RUNTIME,
                        spec=ToolSpec(name="workspace_summary", description="Summarize workspace"),
                    ),
                ),
            ),
            plan_state=PlanState(
                items=(
                    PlanItem(id="1", content="Inspect root", status=PlanStatus.IN_PROGRESS),
                ),
            ),
            conversation_messages=(
                Message(role="user", content="之前我让你看一下项目"),
                Message(role="assistant", content="我先检查结构"),
            ),
            conversation_summary="- user: asked for a repo summary",
            runtime_reminders=("Do not assume files exist.",),
        ),
        workspace_instructions="Follow AGENTS.md for repository conventions.",
    )

    assert [section.type for section in turn_context.sections] == [
        TurnContextSectionType.BASE_INSTRUCTIONS,
        TurnContextSectionType.COLLABORATION_MODE,
        TurnContextSectionType.WORKSPACE_INSTRUCTIONS,
        TurnContextSectionType.ENVIRONMENT_CONTEXT,
        TurnContextSectionType.CONVERSATION_CONTEXT,
        TurnContextSectionType.COMPACTION_REHYDRATION,
        TurnContextSectionType.MEMORY,
        TurnContextSectionType.PLAN,
        TurnContextSectionType.HOOK_CONTEXT,
        TurnContextSectionType.RUNTIME_REMINDERS,
        TurnContextSectionType.SKILL_CATALOG,
        TurnContextSectionType.TOOL_EXPOSURE,
        TurnContextSectionType.USER_REQUEST,
    ]
    workspace_section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.WORKSPACE_INSTRUCTIONS
    )
    collaboration_section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.COLLABORATION_MODE
    )
    assert workspace_section.enabled is True
    assert collaboration_section.content == "default"
    skill_catalog_section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.SKILL_CATALOG
    )
    tool_exposure_section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.TOOL_EXPOSURE
    )
    assert skill_catalog_section.enabled is False
    assert "Available tools: LS, Read, workspace_summary" in tool_exposure_section.content
    assert "1 deferred tool is available through ToolSearch." in tool_exposure_section.content
    assert "Direct tools:" not in tool_exposure_section.content
    assert "Deferred tools:" not in tool_exposure_section.content
    assert "Contributed tools:" not in tool_exposure_section.content
    assert "workspace_summary" in tool_exposure_section.content
    assert turn_context.debug_summary()["enabled_sections"] == [
        "base_instructions",
        "collaboration_mode",
        "workspace_instructions",
        "environment_context",
        "conversation_context",
        "memory",
        "plan",
        "runtime_reminders",
        "tool_exposure",
        "user_request",
    ]
    assert turn_context.debug_summary()["cache_classes"] == {
        "base_instructions": "static",
        "collaboration_mode": "static",
        "workspace_instructions": "static",
        "environment_context": "dynamic",
        "conversation_context": "dynamic",
        "compaction_rehydration": "dynamic",
        "memory": "dynamic",
        "plan": "dynamic",
        "hook_context": "ephemeral",
        "runtime_reminders": "ephemeral",
        "skill_catalog": "static",
        "tool_exposure": "static",
        "user_request": "ephemeral",
    }
    assert turn_context.debug_summary()["scopes"] == {
        "base_instructions": "transcript",
        "collaboration_mode": "session",
        "workspace_instructions": "transcript",
        "environment_context": "turn",
        "conversation_context": "turn",
        "compaction_rehydration": "turn",
        "memory": "transcript",
        "plan": "transcript",
        "hook_context": "turn",
        "runtime_reminders": "turn",
        "skill_catalog": "session",
        "tool_exposure": "session",
        "user_request": "transcript",
    }


def test_turn_context_assembler_keeps_empty_sections_but_marks_them_disabled() -> None:
    assembler = TurnContextAssembler()
    turn_context = assembler.assemble(
        user_message="hello",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
        ),
    )

    sections = {section.type: section for section in turn_context.sections}

    assert sections[TurnContextSectionType.WORKSPACE_INSTRUCTIONS].enabled is False
    assert sections[TurnContextSectionType.MEMORY].enabled is False
    assert sections[TurnContextSectionType.SKILL_CATALOG].enabled is False
    assert sections[TurnContextSectionType.TOOL_EXPOSURE].enabled is False
    assert sections[TurnContextSectionType.USER_REQUEST].enabled is True


def test_turn_context_assembler_renders_bounded_runtime_environment_contract() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="inspect runtime",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            runtime_environment=RuntimeEnvironmentContract(
                workspace_root=Path("/tmp/workspace"),
                writable_roots=(Path("/tmp/workspace"), Path("/tmp/workspace/.mycli/cache")),
                denied_read_roots=(Path("/tmp/workspace/.secrets"),),
                denied_read_globs=("**/.env",),
                filesystem="workspace_write",
                network="enabled",
                shell="restricted",
                approval_policy="safety_policy",
                command_policy="shell_safety_analysis",
                file_policy="workspace_boundary",
                tool_policy="tool_exposure",
                execpolicy_status="enabled",
                execpolicy_rule_count=2,
                execpolicy_sources=("project", "user"),
                shell_backend=ShellBackendProfile(
                    isolation=(
                        "macos_seatbelt"
                        if sys.platform == "darwin"
                        else "linux_bubblewrap"
                        if sys.platform.startswith("linux")
                        else "host_subprocess"
                    )
                ),
            ),
        ),
    )

    section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.ENVIRONMENT_CONTEXT
    )

    assert section.cache_class is TurnContextCacheClass.DYNAMIC
    assert section.metadata["execpolicy_status"] == "enabled"
    assert section.metadata["execpolicy_rule_count"] == 2
    assert section.metadata["writable_roots"] == [
        "/tmp/workspace",
        "/tmp/workspace/.mycli/cache",
    ]
    assert section.metadata["denied_read_roots"] == ["/tmp/workspace/.secrets"]
    assert section.metadata["denied_read_globs"] == ["**/.env"]
    assert "Runtime environment:" in section.content
    assert "- workspace_root: /tmp/workspace" in section.content
    assert "- writable_roots: /tmp/workspace, /tmp/workspace/.mycli/cache" in section.content
    assert "- denied_read_roots: 1" in section.content
    assert "- denied_read_globs: 1" in section.content
    assert "- filesystem: workspace_write" in section.content
    assert "- network: enabled" in section.content
    assert "- shell: restricted" in section.content
    assert "- shell_backend: local" in section.content
    expected_isolation = (
        "macos_seatbelt"
        if sys.platform == "darwin"
        else "linux_bubblewrap"
        if sys.platform.startswith("linux")
        else "host_subprocess"
    )
    assert f"- shell_backend_isolation: {expected_isolation}" in section.content
    assert "- approval_policy: safety_policy" in section.content
    assert "- command_policy: shell_safety_analysis" in section.content
    assert "- file_policy: workspace_boundary" in section.content
    assert "- tool_policy: tool_exposure" in section.content
    assert "- execpolicy: enabled" in section.content
    assert "- execpolicy_rule_count: 2" in section.content
    assert "- execpolicy_sources: project, user" in section.content
    assert "prefix_rule" not in section.content
    assert "git push" not in section.content
    assert "sk-do-not-print" not in section.content


def test_turn_context_assembler_renders_skill_catalog_section() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="review this",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            skill_catalog="Available skills:\n- code-review: Review code",
        ),
    )

    section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.SKILL_CATALOG
    )

    assert section.enabled is True
    assert section.source == "skill_registry"
    assert "code-review" in section.content


def test_turn_context_assembler_prefers_structured_tool_exposure_metadata() -> None:
    assembler = TurnContextAssembler()
    turn_context = assembler.assemble(
        user_message="inspect repo",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            tool_exposure=ToolExposure(
                direct=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("LS"),
                        kind=ToolExposureKind.DIRECT,
                        source=ToolRouteSource.REGISTRY,
                        spec=ToolSpec(name="LS", description="List directory"),
                    ),
                ),
                deferred=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("Bash"),
                        kind=ToolExposureKind.DEFERRED,
                        source=ToolRouteSource.REGISTRY,
                        spec=ToolSpec(name="Bash", description="Run shell"),
                    ),
                ),
                contributed=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("workspace_summary"),
                        kind=ToolExposureKind.CONTRIBUTED,
                        source=ToolRouteSource.RUNTIME,
                        spec=ToolSpec(name="workspace_summary", description="Workspace summary"),
                    ),
                ),
            ),
        ),
    )

    tool_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.TOOL_EXPOSURE
    )

    assert tool_section.enabled is True
    assert tool_section.metadata == {
        "tool_names": ["LS", "workspace_summary"],
        "deferred_tool_count": 1,
    }


def test_turn_context_assembler_renders_non_compaction_runtime_reminders() -> None:
    assembler = TurnContextAssembler()
    turn_context = assembler.assemble(
        user_message="请检查这个实现是否已经接入 runtime 和 trace",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            runtime_reminders=("Prefer source files before logs.",),
        ),
    )

    runtime_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.RUNTIME_REMINDERS
    )

    assert runtime_section.enabled is True
    assert runtime_section.durability is CanonicalTimelineDurability.PERSISTENT
    assert runtime_section.scope is CanonicalTimelineScope.TURN
    assert runtime_section.metadata == {}
    assert "Prefer source files before logs." in runtime_section.content


def test_instruction_contract_assembler_excludes_api_only_sections() -> None:
    assembler = InstructionContractAssembler()
    turn_context = TurnContext(
        user_message="continue",
        sections=(
            TurnContextSection(
                type=TurnContextSectionType.ENVIRONMENT_CONTEXT,
                title="Transport retry",
                content="request id req_123 should not reach model",
                durability=CanonicalTimelineDurability.API_ONLY,
                scope=CanonicalTimelineScope.REQUEST,
                cache_class=TurnContextCacheClass.EPHEMERAL,
            ),
            TurnContextSection(
                type=TurnContextSectionType.MEMORY,
                title="Memory",
                content="<memory-context>Stable API rule.</memory-context>",
                source="memory",
                durability=CanonicalTimelineDurability.PERSISTENT,
                scope=CanonicalTimelineScope.TRANSCRIPT,
                cache_class=TurnContextCacheClass.DYNAMIC,
            ),
        ),
    )

    contract = assembler.assemble(
        turn_context=turn_context,
        base_instructions="Stable system rules.",
        conversation_messages=(),
    )

    rendered_context = "\n".join(
        section.content for section in contract.contextual_user_sections
    )
    assert "request id req_123" not in rendered_context
    assert "Stable API rule" in rendered_context
    assert contract.contextual_user_sections[0].metadata["durability"] == "persistent"
    assert contract.contextual_user_sections[0].metadata["scope"] == "transcript"


def test_turn_context_assembler_excludes_compaction_rehydration_runtime_reminders() -> None:
    assembler = TurnContextAssembler()
    turn_context = assembler.assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            runtime_reminders=(
                "Turn budget is above 60%. Prefer shorter reasoning.",
                "[Compaction rehydration]\n"
                "Recent file snapshots are current disk content.\n\n"
                "### src/app.py\n"
                "```text\n"
                "print('ok')\n"
                "```",
                "Retrying after transient provider error.",
            ),
        ),
    )

    runtime_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.RUNTIME_REMINDERS
    )

    assert runtime_section.enabled is True
    assert "Compaction rehydration" not in runtime_section.content
    assert "src/app.py" not in runtime_section.content
    assert "Turn budget is above 60%" in runtime_section.content
    assert "transient provider error" in runtime_section.content


def test_turn_context_assembler_renders_added_tool_as_plain_tool() -> None:
    assembler = TurnContextAssembler()
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
    turn_context = assembler.assemble(
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

    tool_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.TOOL_EXPOSURE
    )

    assert tool_section.content == "Available tools: daily_brief"
    assert tool_section.metadata == {"tool_names": ["daily_brief"]}
    assert tool_section.cache_class is TurnContextCacheClass.STATIC


def test_turn_context_assembler_does_not_mirror_history_when_legacy_context_is_sparse() -> None:
    assembler = TurnContextAssembler()
    turn_context = assembler.assemble(
        user_message="继续处理这个会话",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            conversation_messages=(),
            conversation_summary=None,
            history_items=(
                HistoryItem(
                    id="hist_1",
                    thread_id="demo",
                    turn_id="turn_1",
                    type=HistoryItemType.USER_MESSAGE,
                    text="先检查仓库结构",
                ),
                HistoryItem(
                    id="hist_2",
                    thread_id="demo",
                    turn_id="turn_1",
                    type=HistoryItemType.ASSISTANT_MESSAGE,
                    text="我先看一下入口文件。",
                ),
            ),
            context_baseline=ContextBaseline(
                thread_id="demo",
                fragments=(
                    BaselineFragment(
                        id="workspace",
                        kind="workspace_instructions",
                        title="Workspace instructions",
                        content="Follow AGENTS.md and keep diffs focused.",
                    ),
                    BaselineFragment(
                        id="environment",
                        kind="environment_context",
                        title="Environment context",
                        content="Shell: zsh\nTimezone: Asia/Shanghai",
                    ),
                ),
            ),
        ),
    )

    workspace_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.WORKSPACE_INSTRUCTIONS
    )
    conversation_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.CONVERSATION_CONTEXT
    )
    environment_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.ENVIRONMENT_CONTEXT
    )

    assert workspace_section.enabled is True
    assert workspace_section.cache_class is TurnContextCacheClass.STATIC
    assert "<workspace-context>" in workspace_section.content
    assert "not the current user request" in workspace_section.content
    assert "Follow AGENTS.md" in workspace_section.content
    assert conversation_section.enabled is False
    assert conversation_section.content == ""
    assert "Timezone: Asia/Shanghai" in environment_section.content


def test_turn_context_assembler_rehydrates_replayable_memory_and_plan_from_baseline() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="继续 P5",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            context_baseline=ContextBaseline(
                thread_id="demo",
                fragments=(
                    BaselineFragment(
                        id="memory",
                        kind="memory",
                        title="Memory",
                        content="这是本轮召回的相关记忆。\nRemember the selected package boundary.",
                        source="memory",
                        metadata={
                            "durability": "persistent",
                            "scope": "transcript",
                            "replayable": True,
                        },
                    ),
                    BaselineFragment(
                        id="plan",
                        kind="plan",
                        title="Current plan",
                        content="这是本轮当前的计划状态。\nCurrent: finish canonical timeline P5.",
                        source="plan",
                        metadata={
                            "durability": "persistent",
                            "scope": "transcript",
                            "replayable": True,
                        },
                    ),
                ),
            ),
        ),
    )

    memory_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.MEMORY
    )
    plan_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.PLAN
    )

    assert memory_section.enabled is True
    assert "selected package boundary" in memory_section.content
    assert memory_section.metadata["source"] == "baseline"
    assert plan_section.enabled is True
    assert "finish canonical timeline P5" in plan_section.content
    assert plan_section.scope is CanonicalTimelineScope.TRANSCRIPT


def test_turn_context_assembler_keeps_conversation_summary_without_transcript_mirror() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            conversation_messages=(
                Message(
                    role="assistant",
                    content="Tool read_file: README.md",
                    blocks=(),
                ),
            ),
            conversation_summary="Derived from structured history.",
        ),
    )

    conversation_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.CONVERSATION_CONTEXT
    )

    assert conversation_section.enabled is True
    assert conversation_section.content == "Conversation summary: Derived from structured history."
    assert "assistant: Tool read_file: README.md" not in conversation_section.content
    assert "Recent conversation" not in conversation_section.content
    assert "Message(role=" not in conversation_section.content
    assert "RuntimeBlock(" not in conversation_section.content


def test_turn_context_assembler_does_not_recursively_duplicate_environment_baseline() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(
                workspace_root=Path("/tmp/workspace"),
                session_id="demo",
                model="deepseek-v4-flash",
                protocol="chat_completions",
            ),
            context_baseline=ContextBaseline(
                thread_id="demo",
                fragments=(
                    BaselineFragment(
                        id="environment",
                        kind="environment_context",
                        title="Environment context",
                        content=(
                            "这是本轮相关的环境事实。\n"
                            "Workspace root: /tmp/workspace\n"
                            "Workspace root: /tmp/workspace\n"
                            "Session id: demo"
                        ),
                    ),
                ),
            ),
        ),
    )

    environment_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.ENVIRONMENT_CONTEXT
    )

    assert environment_section.content.count("Workspace root: /tmp/workspace") == 1
    assert "这是本轮相关的环境事实。" not in environment_section.content
    assert "Session id:" not in environment_section.content


def test_turn_context_assembler_omits_low_value_runtime_identity_from_environment_text() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(
                workspace_root=Path("/tmp/workspace"),
                session_id="volatile-session",
                model="deepseek-v4-flash",
                protocol="chat_completions",
            ),
        ),
    )

    environment_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.ENVIRONMENT_CONTEXT
    )

    assert "Workspace root: /tmp/workspace" in environment_section.content
    assert "Session id:" not in environment_section.content
    assert "Model:" not in environment_section.content
    assert "Protocol:" not in environment_section.content


def test_turn_context_assembler_filters_memory_values_already_present_in_replay() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            conversation_messages=(
                Message(role="assistant", content="I found README.md and pyproject.toml."),
                Message(role="tool", content="Tool read_file: README content"),
            ),
            memory_records=(
                MemoryRecord(
                    kind=MemoryKind.SESSION_SUMMARY,
                    key="last_assistant",
                    value="I found README.md and pyproject.toml.",
                ),
                MemoryRecord(
                    kind=MemoryKind.PROJECT,
                    key="layout",
                    value="Project uses a src layout.",
                ),
            ),
        ),
    )

    memory_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.MEMORY
    )

    assert memory_section.enabled is True
    assert "<memory-context>" in memory_section.content
    assert "not new user input" in memory_section.content
    assert "Project uses a src layout." in memory_section.content
    assert "I found README.md and pyproject.toml." not in memory_section.content


def test_turn_context_assembler_fences_claude_style_file_memory() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            memory_records=(
                MemoryRecord(
                    kind=MemoryKind.FEEDBACK,
                    key="terse_replies.md",
                    value="Keep final replies short.\n\nMemory file: /tmp/memory/terse_replies.md",
                    tags=("file-memory", "terse_replies.md"),
                ),
            ),
        ),
    )

    memory_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.MEMORY
    )

    assert memory_section.enabled is True
    assert "<memory-context>" in memory_section.content
    assert "not new user input" in memory_section.content
    assert "feedback:terse_replies.md" in memory_section.content


def test_turn_context_assembler_disables_memory_when_all_records_are_replay_duplicates() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            history_items=(
                HistoryItem(
                    id="hist_1",
                    thread_id="demo",
                    turn_id="turn_1",
                    type=HistoryItemType.ASSISTANT_MESSAGE,
                    text="I already inspected src/mycli.",
                ),
            ),
            memory_records=(
                MemoryRecord(
                    kind=MemoryKind.SESSION_SUMMARY,
                    key="last_turn",
                    value="I already inspected src/mycli.",
                ),
            ),
        ),
    )

    memory_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.MEMORY
    )

    assert memory_section.enabled is False
    assert memory_section.content == ""


def test_turn_context_assembler_does_not_treat_command_results_as_model_history() -> None:
    command_text = "Tools should remain visible only in the TUI."
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            history_items=(
                HistoryItem(
                    id="command-1",
                    thread_id="demo",
                    turn_id="command-1",
                    type=HistoryItemType.COMMAND_RESULT,
                    text=command_text,
                    metadata={
                        "model_visible": False,
                        "display": {"title": "Private display metadata"},
                    },
                ),
            ),
            memory_records=(
                MemoryRecord(
                    kind=MemoryKind.SESSION_SUMMARY,
                    key="command-result-check",
                    value=command_text,
                ),
            ),
        ),
    )

    memory_section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.MEMORY
    )

    assert memory_section.enabled is True
    assert command_text in memory_section.content
    assert "Private display metadata" not in str(turn_context)


def test_turn_context_assembler_fences_compaction_rehydration() -> None:
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

    section = next(
        item
        for item in turn_context.sections
        if item.type is TurnContextSectionType.COMPACTION_REHYDRATION
    )

    assert section.enabled is True
    assert section.cache_class is TurnContextCacheClass.DYNAMIC
    assert "<compaction-rehydration>" in section.content
    assert "not the current user request" in section.content
    assert "src/app.py" in section.content


def test_turn_context_assembler_renders_plan_as_compact_action_state() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            plan_state=PlanState(
                items=(
                    PlanItem(
                        id="1",
                        content="Completed discovery step with lots of volatile evidence",
                        status=PlanStatus.COMPLETED,
                    ),
                    PlanItem(
                        id="2",
                        content="Implement compact volatile state rendering",
                        status=PlanStatus.IN_PROGRESS,
                    ),
                    PlanItem(
                        id="3",
                        content="Run focused tests",
                        status=PlanStatus.PENDING,
                    ),
                    PlanItem(
                        id="4",
                        content="Run full verification",
                        status=PlanStatus.PENDING,
                    ),
                ),
            ),
        ),
    )

    plan_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.PLAN
    )

    assert "Plan status: completed=1, in_progress=1, pending=2" in plan_section.content
    assert "Current: Implement compact volatile state rendering" in plan_section.content
    assert "Next:" in plan_section.content
    assert "Run focused tests" in plan_section.content
    assert "Completed discovery step with lots of volatile evidence" not in plan_section.content


def test_turn_context_assembler_renders_runtime_reminders_in_deterministic_order() -> None:
    first = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            runtime_reminders=(
                "first",
                "second",
            ),
        ),
    )
    second = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            runtime_reminders=(
                "first",
                "second",
            ),
        ),
    )

    first_section = next(
        section for section in first.sections if section.type is TurnContextSectionType.RUNTIME_REMINDERS
    )
    second_section = next(
        section for section in second.sections if section.type is TurnContextSectionType.RUNTIME_REMINDERS
    )

    assert first_section.content == second_section.content
    assert first_section.content.splitlines() == [
        "Runtime reminders:",
        "- first",
        "- second",
    ]


def test_turn_context_assembler_renders_added_tools_in_deterministic_order() -> None:
    first_descriptor = ToolContributionDescriptor(
        tool_id="runtime:z_tool:thread",
        display_name="z_tool",
        description="Z tool",
        route_key=ToolRouteKey.local("z_tool"),
        source=ToolContributionSource.RUNTIME,
        scope=ToolContributionScope.THREAD,
        lifecycle_state=ToolContributionLifecycleState.EXPOSED,
        spec=ToolSpec(name="z_tool", description="Z tool"),
    )
    second_descriptor = ToolContributionDescriptor(
        tool_id="runtime:a_tool:thread",
        display_name="a_tool",
        description="A tool",
        route_key=ToolRouteKey.local("a_tool"),
        source=ToolContributionSource.RUNTIME,
        scope=ToolContributionScope.THREAD,
        lifecycle_state=ToolContributionLifecycleState.EXPOSED,
        spec=ToolSpec(name="a_tool", description="A tool"),
    )

    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            tool_exposure=ToolExposure(
                contributed=(
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("z_tool"),
                        kind=ToolExposureKind.CONTRIBUTED,
                        source=ToolRouteSource.RUNTIME,
                        spec=first_descriptor.spec,
                        contributed_descriptor=first_descriptor,
                    ),
                    ToolExposureEntry(
                        route_key=ToolRouteKey.local("a_tool"),
                        kind=ToolExposureKind.CONTRIBUTED,
                        source=ToolRouteSource.RUNTIME,
                        spec=second_descriptor.spec,
                        contributed_descriptor=second_descriptor,
                    ),
                ),
            ),
        ),
    )

    tool_section = next(
        section for section in turn_context.sections if section.type is TurnContextSectionType.TOOL_EXPOSURE
    )

    assert tool_section.content.index("a_tool") < tool_section.content.index("z_tool")
    assert tool_section.metadata == {"tool_names": ["a_tool", "z_tool"]}


def test_turn_context_assembler_renders_compaction_rehydration_section() -> None:
    context = ExecutionContext(
        config=AgentConfig(workspace_root=Path("/tmp/workspace")),
        compaction_rehydration=CompactionRehydrationContext(
            files=(
                RehydratedFile(
                    path="src/app.py",
                    content="def answer():\n    return 42",
                    token_count=6,
                    truncated=False,
                ),
            )
        ),
    )

    turn_context = TurnContextAssembler().assemble(user_message="continue", context=context)
    section = next(
        item
        for item in turn_context.sections
        if item.type is TurnContextSectionType.COMPACTION_REHYDRATION
    )

    assert section.enabled is True
    assert "[Compaction file rehydration]" in section.content
    assert "src/app.py" in section.content


def test_turn_context_assembler_does_not_render_compaction_rehydration_from_runtime_reminders() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="continue",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            runtime_reminders=(
                "[Compaction rehydration]\n### src/app.py\n```text\nold path\n```",
            ),
        ),
    )

    runtime_section = next(
        section
        for section in turn_context.sections
        if section.type is TurnContextSectionType.RUNTIME_REMINDERS
    )

    assert runtime_section.enabled is False
