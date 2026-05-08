from __future__ import annotations

from dataclasses import dataclass, field

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState, ReasoningEffort, StopReason
from mycli.services.runtime_policy.evidence import RuntimePolicyEvidence
from mycli.services.runtime_policy.profiles import (
    RuntimeDecisionProfile,
    RuntimePolicyProfiler,
)
from mycli.services.runtime_policy.signals import RuntimePolicySignals
from mycli.services.runtime_policy.stages import RuntimePolicyStagePlanner


REPEATED_TOOL_CALL_REROUTE_THRESHOLD = 3


@dataclass(slots=True, frozen=True)
class RuntimePolicyDecision:
    reasoning_effort: ReasoningEffort
    profile_name: str = RuntimeDecisionProfile.GENERAL.value
    policy_state: dict[str, object] = field(default_factory=dict)
    reminders: tuple[str, ...] = field(default_factory=tuple)
    force_answer: bool = False
    stop_reason: StopReason | None = None
    assistant_message: str | None = None


class RuntimePolicy:
    def __init__(
        self,
        *,
        evidence: RuntimePolicyEvidence | None = None,
        signals: RuntimePolicySignals | None = None,
        profiler: RuntimePolicyProfiler | None = None,
        stage_planner: RuntimePolicyStagePlanner | None = None,
    ) -> None:
        self._evidence = evidence or RuntimePolicyEvidence()
        self._signals = signals or RuntimePolicySignals()
        self._profiler = profiler or RuntimePolicyProfiler()
        self._stage_planner = stage_planner or RuntimePolicyStagePlanner(
            evidence=self._evidence,
            profiler=self._profiler,
        )

    def infer_decision_profile(self, user_message: str) -> RuntimeDecisionProfile:
        return self._profiler.infer_decision_profile(user_message)

    def evaluate(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState | None = None,
        step_index: int,
        configured_reasoning_effort: ReasoningEffort,
    ) -> RuntimePolicyDecision:
        current_plan_state = plan_state or PlanState()
        profile = self.infer_decision_profile(user_message)
        repeated_count = self._signals.max_repeated_tool_calls(conversation)
        repeated_recoverable_failures = self._signals.has_repeated_recoverable_failures(conversation)
        reasoning_effort = self._select_reasoning_effort(
            profile=profile,
            conversation=conversation,
            step_index=step_index,
            repeated_count=repeated_count,
            repeated_recoverable_failures=repeated_recoverable_failures,
            configured_reasoning_effort=configured_reasoning_effort,
        )
        reminders: list[str] = []
        has_repeated_document_exploration = self._evidence.has_repeated_document_exploration(conversation)
        has_truncation_signal = self._evidence.has_truncation_signal(conversation)
        evidence_status = self._evidence_status(profile=profile, conversation=conversation)
        repeated_update_plan_calls = self._signals.count_tool_calls_in_current_turn(
            conversation=conversation,
            tool_name="update_plan",
        )
        plan_status = self._plan_status(current_plan_state)
        planning_mode = self._planning_mode(current_plan_state)
        path_bias = (
            "source_first"
            if profile
            in {
                RuntimeDecisionProfile.CONCISE_OVERVIEW,
                RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW,
                RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION,
                RuntimeDecisionProfile.FAILURE_INVESTIGATION,
            }
            else "balanced"
        )
        repeat_status = (
            "reroute"
            if repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
            or repeated_recoverable_failures
            else "stable"
        )
        truncation_status = "prefer_range_read" if has_truncation_signal else "none"
        policy_state: dict[str, object] = {
            "profile_name": profile.value,
            "path_bias": path_bias,
            "evidence_status": evidence_status,
            "plan_status": plan_status,
            "planning_mode": planning_mode,
            "repeat_status": repeat_status,
            "truncation_status": truncation_status,
        }

        if repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD:
            reminders.append(
                "You are repeating the same tool exploration. Summarize what is already known or choose a different confirmed path."
            )
            if has_truncation_signal:
                reminders.append(
                    "A recent file excerpt was truncated. Prefer read_file_range on the confirmed path instead of repeating read_file."
                )
        if repeated_update_plan_calls >= 1 and current_plan_state.items:
            reminders.append(
                "Avoid repeated replanning when a usable plan already exists. Continue the current plan unless the user changed direction or the plan is blocked."
            )

        if profile is RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW:
            if self._evidence.has_sufficient_repo_analysis_evidence(conversation):
                reminders.append(
                    "Confirmed repository evidence is present from structure and real source or config files."
                )
                return RuntimePolicyDecision(
                    reasoning_effort=reasoning_effort,
                    profile_name=profile.value,
                    policy_state={**policy_state, "evidence_status": "sufficient"},
                    reminders=tuple(dict.fromkeys(reminders)),
                )

            reminders.append(
                "For repository analysis, do not rely on README alone. Verify real source or config files before summarizing, "
                "that is, read real 源码或配置 files before answering, and distinguish confirmed facts from inference."
            )
            reminders.append(
                "Prefer list_directory, search_text, and read_file_range to locate entrypoints and major modules before answering."
            )
            if has_repeated_document_exploration:
                reminders.append(
                    "You are overusing README.md or documentation. Switch to source/config files or use read_file_range on a targeted path."
                )
            return RuntimePolicyDecision(
                reasoning_effort=reasoning_effort,
                profile_name=profile.value,
                policy_state=policy_state,
                reminders=tuple(dict.fromkeys(reminders)),
            )

        if profile is RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION:
            if self._evidence.has_sufficient_implementation_audit_evidence(conversation):
                if has_truncation_signal:
                    reminders.append(
                        "You have source evidence, but a recent excerpt was truncated. Use read_file_range or targeted search on the confirmed path before concluding."
                    )
                    return RuntimePolicyDecision(
                        reasoning_effort=reasoning_effort,
                        profile_name=profile.value,
                        policy_state={**policy_state, "evidence_status": "needs_exact_excerpt"},
                        reminders=tuple(dict.fromkeys(reminders)),
                    )
                reminders.append(
                    "Confirmed implementation evidence is present from source or config paths."
                )
                return RuntimePolicyDecision(
                    reasoning_effort=reasoning_effort,
                    profile_name=profile.value,
                    policy_state={**policy_state, "evidence_status": "sufficient"},
                    reminders=tuple(dict.fromkeys(reminders)),
                )
            reminders.append(
                "For implementation audit, prefer source-first verification across the relevant runtime layers. Treat logs or model-raw files as supporting evidence, not the primary proof."
            )
            query_strategy_reminder = self._query_strategy_reminder(user_message)
            if query_strategy_reminder:
                reminders.append(query_strategy_reminder)
            reminders.append(
                "Verify integration claims in real source or config files before concluding that a capability is wired."
            )
            if has_truncation_signal:
                reminders.append(
                    "A recent source excerpt was truncated. Continue with read_file_range on the confirmed path before opening more broad reads."
                )
            return RuntimePolicyDecision(
                reasoning_effort=reasoning_effort,
                profile_name=profile.value,
                policy_state=policy_state,
                reminders=tuple(dict.fromkeys(reminders)),
            )

        if profile is RuntimeDecisionProfile.FAILURE_INVESTIGATION:
            if self._evidence.has_sufficient_debugging_evidence(conversation):
                reminders.append(
                    "Confirmed debugging evidence is present from failures and verified source paths."
                )
                return RuntimePolicyDecision(
                    reasoning_effort=reasoning_effort,
                    profile_name=profile.value,
                    policy_state={**policy_state, "evidence_status": "sufficient"},
                    reminders=tuple(dict.fromkeys(reminders)),
                )
            reminders.append(
                "For debugging, prefer confirmed failing paths and the relevant source code before broad repository exploration."
            )
            if has_truncation_signal:
                reminders.append(
                    "A recent source excerpt was truncated. Use read_file_range on the suspected failure path before repeating full-file reads."
                )
            return RuntimePolicyDecision(
                reasoning_effort=reasoning_effort,
                profile_name=profile.value,
                policy_state=policy_state,
                reminders=tuple(dict.fromkeys(reminders)),
            )

        if profile is RuntimeDecisionProfile.CONCISE_OVERVIEW:
            if self._evidence.has_sufficient_overview_evidence(conversation):
                reminders.append(
                    "Confirmed evidence is present for a brief repository summary."
                )
                return RuntimePolicyDecision(
                    reasoning_effort=reasoning_effort,
                    profile_name=profile.value,
                    policy_state={**policy_state, "evidence_status": "sufficient"},
                    reminders=tuple(dict.fromkeys(reminders)),
                )
            return RuntimePolicyDecision(
                reasoning_effort=ReasoningEffort.LOW if step_index == 0 else ReasoningEffort.MEDIUM,
                profile_name=profile.value,
                policy_state=policy_state,
                reminders=tuple(dict.fromkeys(reminders)),
            )

        return RuntimePolicyDecision(
            reasoning_effort=reasoning_effort,
            profile_name=profile.value,
            policy_state=policy_state,
            reminders=tuple(dict.fromkeys(reminders)),
        )

    def _plan_status(self, plan_state: PlanState) -> str:
        if not plan_state.items:
            return "none"
        if plan_state.current_in_progress_item_id() is not None:
            return "in_progress"
        return "pending"

    def _planning_mode(self, plan_state: PlanState) -> str:
        if plan_state.current_in_progress_item_id() is not None:
            return "continue_existing"
        if plan_state.items:
            return "reuse_existing"
        return "plan_if_needed"

    def _select_reasoning_effort(
        self,
        *,
        profile: RuntimeDecisionProfile,
        conversation: Conversation,
        step_index: int,
        repeated_count: int,
        repeated_recoverable_failures: bool,
        configured_reasoning_effort: ReasoningEffort,
    ) -> ReasoningEffort:
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW:
            if self._evidence.has_sufficient_repo_analysis_evidence(conversation):
                return ReasoningEffort.LOW
            if (
                repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
                or repeated_recoverable_failures
            ):
                return ReasoningEffort.HIGH
            return ReasoningEffort.MEDIUM
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION:
            if self._evidence.has_sufficient_implementation_audit_evidence(conversation):
                return ReasoningEffort.LOW
            if (
                repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
                or repeated_recoverable_failures
            ):
                return ReasoningEffort.HIGH
            return ReasoningEffort.MEDIUM
        if profile is RuntimeDecisionProfile.FAILURE_INVESTIGATION:
            if self._evidence.has_sufficient_debugging_evidence(conversation):
                return ReasoningEffort.LOW
            return ReasoningEffort.HIGH if step_index >= 1 else ReasoningEffort.MEDIUM
        if profile is RuntimeDecisionProfile.CONCISE_OVERVIEW:
            if self._evidence.has_sufficient_overview_evidence(conversation):
                return ReasoningEffort.LOW
            return ReasoningEffort.LOW if step_index == 0 else ReasoningEffort.MEDIUM
        if (
            repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
            or repeated_recoverable_failures
        ):
            return ReasoningEffort.HIGH
        return configured_reasoning_effort

    def is_repo_analysis_request(self, user_message: str) -> bool:
        return self._profiler.is_repo_analysis_request(user_message)

    def decision_stage_message(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        force_answer: bool,
    ) -> str | None:
        return self._stage_planner.decision_stage_message(
            user_message=user_message,
            conversation=conversation,
            force_answer=force_answer,
        )

    def repo_analysis_stage_message(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        force_answer: bool,
    ) -> str | None:
        return self.decision_stage_message(
            user_message=user_message,
            conversation=conversation,
            force_answer=force_answer,
        )

    def _is_overview_request(self, user_message: str) -> bool:
        return self._profiler.is_overview_request(user_message)

    def _evidence_status(self, *, profile: RuntimeDecisionProfile, conversation: Conversation) -> str:
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW:
            return "sufficient" if self._evidence.has_sufficient_repo_analysis_evidence(conversation) else "insufficient"
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION:
            return "sufficient" if self._evidence.has_sufficient_implementation_audit_evidence(conversation) else "insufficient"
        if profile is RuntimeDecisionProfile.FAILURE_INVESTIGATION:
            return "sufficient" if self._evidence.has_sufficient_debugging_evidence(conversation) else "insufficient"
        if profile is RuntimeDecisionProfile.CONCISE_OVERVIEW:
            return "sufficient" if self._evidence.has_sufficient_overview_evidence(conversation) else "insufficient"
        return "unknown"

    def _query_strategy_reminder(self, user_message: str) -> str | None:
        lowered = user_message.lower()
        if any(token in lowered for token in ("change", "proposal", "提案", "变更", "openspec")):
            return (
                "Do not use change or proposal names as the primary query. Search by runtime objects, module names, or confirmed integration points first."
            )
        return None
