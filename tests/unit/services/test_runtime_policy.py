from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import PlanItem, PlanState, PlanStatus, ReasoningEffort, RuntimeBlock, StopReason
from mycli.domain.tools import ToolCall
from mycli.services.runtime_policy import RuntimePolicy


def _tool_message(
    *,
    tool_name: str,
    path: str | None,
    success: bool = True,
    text: str | None = None,
) -> Message:
    return Message(
        role="tool",
        content=text or f"Tool {tool_name}",
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=text or f"Tool {tool_name}",
                metadata={
                    "tool_name": tool_name,
                    "success": success,
                    "path": path,
                },
            ),
        ),
    )


def _assistant_tool_call(*, name: str, arguments: dict[str, object]) -> Message:
    return Message(
        role="assistant",
        content="",
        tool_calls=(
            ToolCall(
                name=name,
                arguments=arguments,
                reason="explore",
                call_id=f"call_{name}_{len(arguments)}",
            ),
        ),
    )


def test_runtime_policy_does_not_force_answer_for_readme_only_repo_analysis() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(
        session_id="demo",
        messages=[
            _tool_message(tool_name="list_directory", path="."),
            _tool_message(tool_name="read_file", path="README.md"),
        ],
    )

    decision = policy.evaluate(
        user_message="请分析这个仓库的入口文件和主要模块，给我一个简短总结。",
        conversation=conversation,
        step_index=1,
        configured_max_steps=6,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert decision.force_answer is False
    assert decision.stop_reason is None
    assert any("源码" in reminder or "配置" in reminder for reminder in decision.reminders)


def test_runtime_policy_allows_force_answer_after_structure_and_source_evidence() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(
        session_id="demo",
        messages=[
            _tool_message(tool_name="list_directory", path="."),
            _tool_message(tool_name="read_file", path="pyproject.toml"),
        ],
    )

    decision = policy.evaluate(
        user_message="请分析这个仓库的入口文件和主要模块，给我一个简短总结。",
        conversation=conversation,
        step_index=2,
        configured_max_steps=6,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert decision.force_answer is True
    assert any("confirmed evidence" in reminder.lower() or "确认" in reminder for reminder in decision.reminders)


def test_runtime_policy_stops_repeated_readme_exploration_near_budget() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(
        session_id="demo",
        messages=[
            Message(role="assistant", content="", tool_calls=()),
            _tool_message(tool_name="list_directory", path="."),
            _tool_message(tool_name="read_file", path="README.md"),
            _tool_message(tool_name="read_file", path="README.md"),
        ],
    )

    decision = policy.evaluate(
        user_message="请分析这个仓库的入口文件和主要模块，给我一个简短总结。",
        conversation=conversation,
        step_index=5,
        configured_max_steps=6,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert decision.force_answer is False
    assert any("README" in reminder or "range" in reminder.lower() for reminder in decision.reminders)
    assert decision.stop_reason is None or decision.stop_reason is StopReason.LOOP_DETECTED


def test_runtime_policy_derives_verification_profile_and_tracks_policy_state() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(
        session_id="demo",
        messages=[
            _tool_message(tool_name="search_text", path="log/model-events.jsonl"),
        ],
    )

    decision = policy.evaluate(
        user_message="请检查 turn context、runtime 和 trace 是否已经都接入了 capability activation。",
        conversation=conversation,
        step_index=0,
        configured_max_steps=6,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert decision.force_answer is False
    assert decision.profile_name == "source_first_verification"
    assert decision.policy_state["profile_name"] == "source_first_verification"
    assert decision.policy_state["evidence_status"] == "insufficient"
    assert decision.policy_state["path_bias"] == "source_first"


def test_runtime_policy_prefers_range_read_after_truncated_source_excerpt() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(
        session_id="demo",
        messages=[
            _tool_message(
                tool_name="read_file",
                path="src/mycli/application/runtime/agent_runtime.py",
                text=(
                    "Read src/mycli/application/runtime/agent_runtime.py\n"
                    "Evidence:\n"
                    "- [file_excerpt] src/mycli/application/runtime/agent_runtime.py:1-400\n"
                    "  snippet: from mycli ...\n"
                    "  note: excerpt truncated; use read_file_range for exact sections if needed."
                ),
            ),
            Message(
                role="assistant",
                content="",
                tool_calls=(),
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name="read_file",
                        tool_arguments={"path": "src/mycli/application/runtime/agent_runtime.py"},
                        call_id="call_repeat_read_same_file",
                    ),
                ),
            ),
        ],
    )

    decision = policy.evaluate(
        user_message="请检查 runtime 里 capability activation 是否已经接入 turn context。",
        conversation=conversation,
        step_index=1,
        configured_max_steps=6,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert any("read_file_range" in reminder for reminder in decision.reminders)
    assert decision.policy_state["truncation_status"] == "prefer_range_read"


def test_runtime_policy_warns_against_using_change_name_as_primary_query() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(session_id="demo", messages=[])

    decision = policy.evaluate(
        user_message="请检查 add-tool-exposure-router 这个 change 是否已经接入 turn context 和 trace。",
        conversation=conversation,
        step_index=0,
        configured_max_steps=6,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert decision.profile_name == "source_first_verification"
    assert any("change" in reminder.lower() or "proposal" in reminder.lower() for reminder in decision.reminders)


def test_runtime_policy_allows_wider_source_first_step_budget() -> None:
    policy = RuntimePolicy()

    budget = policy.step_budget(
        user_message="请检查 runtime 里 capability activation 是否已经接入 turn context。",
        configured_max_steps=100,
    )

    assert budget == 8


def test_runtime_policy_uses_soft_budget_with_compatibility_hard_limit() -> None:
    policy = RuntimePolicy()

    soft_budget = policy.step_budget(
        user_message="请帮我继续推进这个普通任务。",
        configured_max_steps=2,
    )
    hard_limit = policy.hard_step_limit(
        user_message="请帮我继续推进这个普通任务。",
        configured_max_steps=2,
    )

    assert soft_budget == 2
    assert hard_limit == 4


def test_runtime_policy_does_not_stop_after_three_repeated_tool_calls() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(
        session_id="demo",
        messages=[
            _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            _assistant_tool_call(name="list_directory", arguments={"path": "."}),
            _assistant_tool_call(name="list_directory", arguments={"path": "."}),
        ],
    )

    decision = policy.evaluate(
        user_message="请为这个项目安排一个今晚两小时的推进顺序。",
        conversation=conversation,
        step_index=2,
        configured_max_steps=8,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert decision.stop_reason is None
    assert any("repeating the same tool exploration" in reminder for reminder in decision.reminders)


def test_runtime_policy_marks_existing_plan_as_continue_existing() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(
        session_id="demo",
        messages=[
            Message(role="user", content="请继续推进"),
            _assistant_tool_call(
                name="update_plan",
                arguments={"items": [{"content": "检查日志", "status": "in_progress"}]},
            ),
        ],
    )
    plan_state = PlanState(
        items=(
            PlanItem(id="step-1", content="检查日志", status=PlanStatus.IN_PROGRESS),
            PlanItem(id="step-2", content="修复问题", status=PlanStatus.PENDING),
        )
    )

    decision = policy.evaluate(
        user_message="请继续推进",
        conversation=conversation,
        plan_state=plan_state,
        step_index=1,
        configured_max_steps=8,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert decision.stop_reason is None
    assert decision.policy_state["plan_status"] == "in_progress"
    assert decision.policy_state["planning_mode"] == "continue_existing"
    assert any("replanning" in reminder.lower() or "当前计划" in reminder for reminder in decision.reminders)


def test_runtime_policy_stops_repeated_replanning_when_plan_already_exists() -> None:
    policy = RuntimePolicy()
    conversation = Conversation(
        session_id="demo",
        messages=[
            Message(role="user", content="请继续推进"),
            _assistant_tool_call(
                name="update_plan",
                arguments={"items": [{"content": "检查日志", "status": "in_progress"}]},
            ),
            _assistant_tool_call(
                name="update_plan",
                arguments={"items": [{"content": "再重新规划", "status": "in_progress"}]},
            ),
        ],
    )
    plan_state = PlanState(
        items=(PlanItem(id="step-1", content="检查日志", status=PlanStatus.IN_PROGRESS),)
    )

    decision = policy.evaluate(
        user_message="请继续推进",
        conversation=conversation,
        plan_state=plan_state,
        step_index=2,
        configured_max_steps=8,
        configured_reasoning_effort=ReasoningEffort.MEDIUM,
    )

    assert decision.stop_reason is StopReason.LOOP_DETECTED
    assert decision.assistant_message is not None
    assert "replanning" in decision.assistant_message.lower()
