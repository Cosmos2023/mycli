from __future__ import annotations

from collections.abc import Callable

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import (
    ActivityEvent,
    AgentConfig,
    PlanState,
    ReasoningEffort,
    RuntimeTraceEvent,
    TurnItem,
    TurnItemType,
    TurnResponse,
)
from mycli.services.runtime_policy import RuntimePolicy
from mycli.services.tracing import TraceService


class RuntimePolicyCoordinator:
    def __init__(
        self,
        *,
        config: AgentConfig,
        runtime_policy: RuntimePolicy,
        trace_service: TraceService,
        append_turn_item: Callable[..., None],
    ) -> None:
        self._config = config
        self._runtime_policy = runtime_policy
        self._trace_service = trace_service
        self._append_turn_item = append_turn_item

    def set_config(self, config: AgentConfig) -> None:
        self._config = config

    def policy_decision(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        step_index: int,
    ) -> tuple[ReasoningEffort, tuple[str, ...], dict[str, object], bool, str | None, TurnResponse | None]:
        decision = self._runtime_policy.evaluate(
            user_message=user_message,
            conversation=conversation,
            plan_state=plan_state,
            step_index=step_index,
            configured_reasoning_effort=self._config.reasoning_effort,
        )
        stage_message = self._runtime_policy.decision_stage_message(
            user_message=user_message,
            conversation=conversation,
            force_answer=False,
        )
        return (
            self._config.reasoning_effort,
            (),
            decision.policy_state,
            False,
            stage_message,
            None,
        )

    def append_runtime_policy_activity(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        policy_state: dict[str, object],
    ) -> None:
        if not policy_state:
            return
        profile_name = policy_state.get("profile_name", "general")
        evidence_status = policy_state.get("evidence_status", "unknown")
        path_bias = policy_state.get("path_bias", "balanced")
        planning_mode = policy_state.get("planning_mode", "plan_if_needed")
        plan_status = policy_state.get("plan_status", "none")
        text = (
            "runtime policy "
            f"profile={profile_name} path_bias={path_bias} evidence={evidence_status} "
            f"planning={planning_mode} plan={plan_status}"
        )
        if (
            turn_items
            and turn_items[-1].type is TurnItemType.REASONING
            and turn_items[-1].text == text
        ):
            return
        activity_events.append(ActivityEvent(kind="runtime_policy", message=text))
        metadata = {"activity_kind": "planning", **dict(policy_state)}
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(type=TurnItemType.REASONING, text=text, metadata=metadata),
        )
        self._trace_service.append(
            self._config.session_id,
            RuntimeTraceEvent(
                kind="runtime_policy",
                turn_id=turn_id,
                payload=dict(policy_state),
            ),
        )

    def append_structured_repo_activity(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        stage_message: str | None,
    ) -> None:
        if not stage_message:
            return
        if (
            turn_items
            and turn_items[-1].type is TurnItemType.REASONING
            and turn_items[-1].text == stage_message
        ):
            return
        activity_events.append(ActivityEvent(kind="planning", message=stage_message))
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.REASONING,
                text=stage_message,
                metadata={"activity_kind": "planning"},
            ),
        )
