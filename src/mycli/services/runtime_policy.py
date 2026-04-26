from __future__ import annotations

from collections.abc import Iterator
import json
from dataclasses import dataclass, field
from enum import StrEnum

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import PlanState, ReasoningEffort, RuntimeBlock, StopReason


OVERVIEW_HINTS = (
    "overview",
    "summary",
    "summarize",
    "summarise",
    "entrypoint",
    "entry file",
    "main module",
    "repo",
    "repository",
    "仓库",
    "入口",
    "模块",
    "简短总结",
    "总结",
    "概览",
)

REPO_ANALYSIS_SPECIFIC_HINTS = (
    "entrypoint",
    "entry file",
    "main module",
    "入口",
    "模块",
    "架构",
    "architecture",
    "how does this repo start",
    "how does this repository start",
)
REPO_ANALYSIS_TARGET_HINTS = ("repo", "repository", "仓库", "项目")
REPO_ANALYSIS_ACTION_HINTS = ("analyze", "analyse", "analysis", "分析", "inspect", "理解", "understand")

STRUCTURED_STAGE_CHECK_REPOSITORY = "正在检查仓库结构"
STRUCTURED_STAGE_LOCATE_ENTRYPOINTS = "正在定位入口与主要模块"
STRUCTURED_STAGE_VERIFY_SOURCE = "正在读取源码确认架构事实"
STRUCTURED_STAGE_VERIFY_IMPLEMENTATION = "正在验证实现接入路径"
STRUCTURED_STAGE_VERIFY_IMPLEMENTATION_SOURCE = "正在读取源码确认实现证据"
STRUCTURED_STAGE_DEBUGGING_TRIAGE = "正在定位失败路径"
STRUCTURED_STAGE_DEBUGGING_VERIFY = "正在验证根因证据"
STRUCTURED_STAGE_ANSWER_FROM_EVIDENCE = "已从确认的证据收口回答"

SOURCE_FIRST_MAX_STEPS = 8
REPEATED_TOOL_CALL_REROUTE_THRESHOLD = 3
REPEATED_TOOL_CALL_STOP_THRESHOLD = 4
REPEATED_FAILURE_STOP_THRESHOLD = 3
SOFT_BUDGET_COMPAT_EXTRA_STEPS = 2


class RuntimeDecisionProfile(StrEnum):
    GENERAL = "general"
    CONCISE_OVERVIEW = "concise_overview"
    SOURCE_FIRST_OVERVIEW = "source_first_overview"
    SOURCE_FIRST_VERIFICATION = "source_first_verification"
    FAILURE_INVESTIGATION = "failure_investigation"


@dataclass(slots=True, frozen=True)
class RuntimePolicyDecision:
    max_steps: int
    reasoning_effort: ReasoningEffort
    profile_name: str = RuntimeDecisionProfile.GENERAL.value
    policy_state: dict[str, object] = field(default_factory=dict)
    reminders: tuple[str, ...] = field(default_factory=tuple)
    force_answer: bool = False
    stop_reason: StopReason | None = None
    assistant_message: str | None = None


class RuntimePolicy:
    def step_budget(self, *, user_message: str, configured_max_steps: int) -> int:
        profile = self.infer_decision_profile(user_message)
        if profile in {
            RuntimeDecisionProfile.CONCISE_OVERVIEW,
            RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW,
            RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION,
            RuntimeDecisionProfile.FAILURE_INVESTIGATION,
        }:
            return max(4, min(configured_max_steps, SOURCE_FIRST_MAX_STEPS))
        return max(1, configured_max_steps)

    def hard_step_limit(self, *, user_message: str, configured_max_steps: int) -> int:
        soft_budget = self.step_budget(
            user_message=user_message,
            configured_max_steps=configured_max_steps,
        )
        return max(
            soft_budget + SOFT_BUDGET_COMPAT_EXTRA_STEPS,
            configured_max_steps + SOFT_BUDGET_COMPAT_EXTRA_STEPS,
        )

    def infer_decision_profile(self, user_message: str) -> RuntimeDecisionProfile:
        lowered = user_message.lower()
        debugging_hints = (
            "debug",
            "bug",
            "error",
            "exception",
            "failure",
            "failing",
            "排查",
            "定位",
            "错误",
            "异常",
            "失败",
            "报错",
        )
        implementation_audit_hints = (
            "verify",
            "verification",
            "audit",
            "implemented",
            "implementation",
            "integrated",
            "integration",
            "wired",
            "接入",
            "检查",
            "是否已经",
            "是否已",
            "turn context",
            "runtime",
            "trace",
            "capability activation",
        )
        if any(hint in lowered for hint in debugging_hints):
            return RuntimeDecisionProfile.FAILURE_INVESTIGATION
        if any(hint in lowered for hint in implementation_audit_hints):
            return RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION
        if self.is_repo_analysis_request(user_message):
            return RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW
        if self._is_overview_request(user_message):
            return RuntimeDecisionProfile.CONCISE_OVERVIEW
        return RuntimeDecisionProfile.GENERAL

    def evaluate(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState | None = None,
        step_index: int,
        configured_max_steps: int,
        configured_reasoning_effort: ReasoningEffort,
    ) -> RuntimePolicyDecision:
        current_plan_state = plan_state or PlanState()
        profile = self.infer_decision_profile(user_message)
        max_steps = self.step_budget(
            user_message=user_message,
            configured_max_steps=configured_max_steps,
        )
        repeated_count = self._max_repeated_tool_calls(conversation)
        repeated_recoverable_failures = self._has_repeated_recoverable_failures(conversation)
        reasoning_effort = self._select_reasoning_effort(
            profile=profile,
            conversation=conversation,
            step_index=step_index,
            max_steps=max_steps,
            repeated_count=repeated_count,
            repeated_recoverable_failures=repeated_recoverable_failures,
            configured_reasoning_effort=configured_reasoning_effort,
        )
        reminders: list[str] = []
        has_repeated_document_exploration = self._has_repeated_document_exploration(conversation)
        has_truncation_signal = self._has_truncation_signal(conversation)
        evidence_status = self._evidence_status(profile=profile, conversation=conversation)
        repeated_update_plan_calls = self._count_tool_calls_in_current_turn(
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
            "loop_stop"
            if repeated_count >= REPEATED_TOOL_CALL_STOP_THRESHOLD
            or (
                repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
                and repeated_recoverable_failures
            )
            else "reroute"
            if repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
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
            "budget_mode": "soft",
            "soft_budget": max_steps,
        }

        if repeated_update_plan_calls >= 2 and current_plan_state.items:
            return RuntimePolicyDecision(
                max_steps=max_steps,
                reasoning_effort=ReasoningEffort.HIGH,
                profile_name=profile.value,
                policy_state=policy_state,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    "I stopped due to repeated replanning without executing the current plan. "
                    "Continue the existing plan or narrow the request."
                ),
            )

        if repeated_count >= REPEATED_TOOL_CALL_STOP_THRESHOLD:
            return RuntimePolicyDecision(
                max_steps=max_steps,
                reasoning_effort=ReasoningEffort.HIGH,
                profile_name=profile.value,
                policy_state=policy_state,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    "I stopped due to repeated exploration without enough new evidence. "
                    "Please narrow the request or inspect a confirmed path."
                ),
            )

        if (
            repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
            and repeated_recoverable_failures
        ):
            return RuntimePolicyDecision(
                max_steps=max_steps,
                reasoning_effort=ReasoningEffort.HIGH,
                profile_name=profile.value,
                policy_state=policy_state,
                stop_reason=StopReason.LOOP_DETECTED,
                assistant_message=(
                    "I stopped due to repeated exploration of the same failing path without new evidence. "
                    "Please inspect a confirmed path or narrow the request."
                ),
            )

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
            if self._has_sufficient_repo_analysis_evidence(conversation):
                reminders.append(
                    "You already have confirmed evidence from repository structure and real source or config files. "
                    "Answer now from confirmed facts, and label any unverified statement as inference."
                )
                return RuntimePolicyDecision(
                    max_steps=max_steps,
                    reasoning_effort=ReasoningEffort.LOW,
                    profile_name=profile.value,
                    policy_state={**policy_state, "evidence_status": "sufficient"},
                    reminders=tuple(dict.fromkeys(reminders)),
                    force_answer=True,
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
            if step_index >= max_steps - 1:
                reminders.append(
                    "You are near the exploration budget. Summarize confirmed facts first, clearly mark inference, and name the missing files still not verified."
                )
            return RuntimePolicyDecision(
                max_steps=max_steps,
                reasoning_effort=reasoning_effort,
                profile_name=profile.value,
                policy_state=policy_state,
                reminders=tuple(dict.fromkeys(reminders)),
            )

        if profile is RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION:
            if self._has_sufficient_implementation_audit_evidence(conversation):
                reminders.append(
                    "You already have enough implementation evidence from confirmed source or config paths. Answer now, cite the verified layers, and label any gap as inference."
                )
                return RuntimePolicyDecision(
                    max_steps=max_steps,
                    reasoning_effort=ReasoningEffort.LOW,
                    profile_name=profile.value,
                    policy_state={**policy_state, "evidence_status": "sufficient"},
                    reminders=tuple(dict.fromkeys(reminders)),
                    force_answer=True,
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
            if step_index >= max_steps - 1:
                reminders.append(
                    "You are near the exploration budget. Summarize the verified implementation layers, then name the remaining unverified integration points."
                )
            return RuntimePolicyDecision(
                max_steps=max_steps,
                reasoning_effort=reasoning_effort,
                profile_name=profile.value,
                policy_state=policy_state,
                reminders=tuple(dict.fromkeys(reminders)),
            )

        if profile is RuntimeDecisionProfile.FAILURE_INVESTIGATION:
            if self._has_sufficient_debugging_evidence(conversation):
                reminders.append(
                    "You already have enough debugging evidence to explain the likely root cause. Answer now from confirmed failures and verified source paths, and mark any hypothesis as inference."
                )
                return RuntimePolicyDecision(
                    max_steps=max_steps,
                    reasoning_effort=ReasoningEffort.LOW,
                    profile_name=profile.value,
                    policy_state={**policy_state, "evidence_status": "sufficient"},
                    reminders=tuple(dict.fromkeys(reminders)),
                    force_answer=True,
                )
            reminders.append(
                "For debugging, prefer confirmed failing paths and the relevant source code before broad repository exploration."
            )
            if has_truncation_signal:
                reminders.append(
                    "A recent source excerpt was truncated. Use read_file_range on the suspected failure path before repeating full-file reads."
                )
            return RuntimePolicyDecision(
                max_steps=max_steps,
                reasoning_effort=reasoning_effort,
                profile_name=profile.value,
                policy_state=policy_state,
                reminders=tuple(dict.fromkeys(reminders)),
            )

        if profile is RuntimeDecisionProfile.CONCISE_OVERVIEW:
            if self._has_sufficient_overview_evidence(conversation):
                reminders.append(
                    "You already have enough evidence for a brief repository summary. Answer now from the confirmed evidence and avoid further tool calls unless a missing fact blocks the summary."
                )
                return RuntimePolicyDecision(
                    max_steps=max_steps,
                    reasoning_effort=ReasoningEffort.LOW,
                    profile_name=profile.value,
                    policy_state={**policy_state, "evidence_status": "sufficient"},
                    reminders=tuple(dict.fromkeys(reminders)),
                    force_answer=True,
                )
            return RuntimePolicyDecision(
                max_steps=max_steps,
                reasoning_effort=ReasoningEffort.LOW if step_index == 0 else ReasoningEffort.MEDIUM,
                profile_name=profile.value,
                policy_state=policy_state,
                reminders=tuple(dict.fromkeys(reminders)),
            )

        if step_index >= max_steps - 1:
            reminders.append(
                "You are near the exploration budget. Prefer a concise answer from the evidence already gathered."
            )

        return RuntimePolicyDecision(
            max_steps=max_steps,
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
        max_steps: int,
        repeated_count: int,
        repeated_recoverable_failures: bool,
        configured_reasoning_effort: ReasoningEffort,
    ) -> ReasoningEffort:
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW:
            if self._has_sufficient_repo_analysis_evidence(conversation):
                return ReasoningEffort.LOW
            if (
                repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
                or repeated_recoverable_failures
            ):
                return ReasoningEffort.HIGH
            if step_index >= max_steps - 1:
                return ReasoningEffort.HIGH
            return ReasoningEffort.MEDIUM
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION:
            if self._has_sufficient_implementation_audit_evidence(conversation):
                return ReasoningEffort.LOW
            if (
                repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
                or repeated_recoverable_failures
            ):
                return ReasoningEffort.HIGH
            return ReasoningEffort.MEDIUM
        if profile is RuntimeDecisionProfile.FAILURE_INVESTIGATION:
            if self._has_sufficient_debugging_evidence(conversation):
                return ReasoningEffort.LOW
            return ReasoningEffort.HIGH if step_index >= 1 else ReasoningEffort.MEDIUM
        if profile is RuntimeDecisionProfile.CONCISE_OVERVIEW:
            if self._has_sufficient_overview_evidence(conversation):
                return ReasoningEffort.LOW
            return ReasoningEffort.LOW if step_index == 0 else ReasoningEffort.MEDIUM
        if (
            repeated_count >= REPEATED_TOOL_CALL_REROUTE_THRESHOLD
            or repeated_recoverable_failures
        ):
            return ReasoningEffort.HIGH
        if step_index >= max_steps - 1:
            return ReasoningEffort.HIGH
        return configured_reasoning_effort

    def is_repo_analysis_request(self, user_message: str) -> bool:
        lowered = user_message.lower()
        return any(hint in lowered for hint in REPO_ANALYSIS_SPECIFIC_HINTS) or (
            any(hint in lowered for hint in REPO_ANALYSIS_TARGET_HINTS)
            and any(hint in lowered for hint in REPO_ANALYSIS_ACTION_HINTS)
        )

    def decision_stage_message(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        force_answer: bool,
    ) -> str | None:
        profile = self.infer_decision_profile(user_message)
        has_structure = self._has_structure_evidence(conversation)
        has_source_or_config = self._has_source_or_config_evidence(conversation)
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW:
            if force_answer or (has_structure and has_source_or_config):
                return STRUCTURED_STAGE_ANSWER_FROM_EVIDENCE
            if not has_structure:
                return STRUCTURED_STAGE_CHECK_REPOSITORY
            if not has_source_or_config:
                return STRUCTURED_STAGE_LOCATE_ENTRYPOINTS
            return STRUCTURED_STAGE_VERIFY_SOURCE
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION:
            if force_answer or self._has_sufficient_implementation_audit_evidence(conversation):
                return STRUCTURED_STAGE_ANSWER_FROM_EVIDENCE
            if not has_source_or_config:
                return STRUCTURED_STAGE_VERIFY_IMPLEMENTATION
            return STRUCTURED_STAGE_VERIFY_IMPLEMENTATION_SOURCE
        if profile is RuntimeDecisionProfile.FAILURE_INVESTIGATION:
            if force_answer or self._has_sufficient_debugging_evidence(conversation):
                return STRUCTURED_STAGE_ANSWER_FROM_EVIDENCE
            if not has_source_or_config:
                return STRUCTURED_STAGE_DEBUGGING_TRIAGE
            return STRUCTURED_STAGE_DEBUGGING_VERIFY
        return None

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
        lowered = user_message.lower()
        return any(hint in lowered for hint in OVERVIEW_HINTS)

    def _has_sufficient_overview_evidence(self, conversation: Conversation) -> bool:
        tool_names: set[str] = set()
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                tool_name = block.metadata.get("tool_name")
                if isinstance(tool_name, str) and block.metadata.get("success") is True:
                    tool_names.add(tool_name)
        return "list_directory" in tool_names and bool({"read_file", "read_file_range", "search_text"} & tool_names)

    def _has_sufficient_repo_analysis_evidence(self, conversation: Conversation) -> bool:
        return self._has_structure_evidence(conversation) and self._has_source_or_config_evidence(conversation)

    def _has_sufficient_implementation_audit_evidence(self, conversation: Conversation) -> bool:
        source_paths: set[str] = set()
        tool_names: set[str] = set()
        for block in self._iter_successful_tool_result_blocks(conversation):
            tool_name = block.metadata.get("tool_name")
            path = block.metadata.get("path")
            if isinstance(tool_name, str):
                tool_names.add(tool_name)
            if (
                isinstance(tool_name, str)
                and tool_name in {"read_file", "read_file_range"}
                and isinstance(path, str)
                and self._is_source_or_config_path(path.lower())
            ):
                source_paths.add(path.lower())
        return bool(source_paths) and (len(source_paths) >= 2 or "search_text" in tool_names)

    def _has_sufficient_debugging_evidence(self, conversation: Conversation) -> bool:
        has_failure = False
        has_source = False
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                if block.metadata.get("success") is False:
                    has_failure = True
                path = block.metadata.get("path")
                if (
                    block.metadata.get("success") is True
                    and isinstance(path, str)
                    and self._is_source_or_config_path(path.lower())
                    and block.metadata.get("tool_name") in {"read_file", "read_file_range"}
                ):
                    has_source = True
        return has_failure and has_source

    def _evidence_status(self, *, profile: RuntimeDecisionProfile, conversation: Conversation) -> str:
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW:
            return "sufficient" if self._has_sufficient_repo_analysis_evidence(conversation) else "insufficient"
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION:
            return "sufficient" if self._has_sufficient_implementation_audit_evidence(conversation) else "insufficient"
        if profile is RuntimeDecisionProfile.FAILURE_INVESTIGATION:
            return "sufficient" if self._has_sufficient_debugging_evidence(conversation) else "insufficient"
        if profile is RuntimeDecisionProfile.CONCISE_OVERVIEW:
            return "sufficient" if self._has_sufficient_overview_evidence(conversation) else "insufficient"
        return "unknown"

    def _has_structure_evidence(self, conversation: Conversation) -> bool:
        for block in self._iter_successful_tool_result_blocks(conversation):
            if block.metadata.get("tool_name") == "list_directory":
                return True
        return False

    def _has_source_or_config_evidence(self, conversation: Conversation) -> bool:
        for block in self._iter_successful_tool_result_blocks(conversation):
            tool_name = block.metadata.get("tool_name")
            path = block.metadata.get("path")
            if not isinstance(path, str) or not path:
                continue
            normalized_path = path.lower()
            if normalized_path.endswith("readme.md"):
                continue
            if tool_name in {"read_file", "read_file_range"} and self._is_source_or_config_path(normalized_path):
                return True
        return False

    def _has_repeated_document_exploration(self, conversation: Conversation) -> bool:
        document_reads: dict[str, int] = {}
        for block in self._iter_successful_tool_result_blocks(conversation):
            tool_name = block.metadata.get("tool_name")
            path = block.metadata.get("path")
            if tool_name not in {"read_file", "read_file_range"}:
                continue
            if not isinstance(path, str) or not path:
                continue
            normalized_path = path.lower()
            if not self._is_documentation_path(normalized_path):
                continue
            document_reads[normalized_path] = document_reads.get(normalized_path, 0) + 1
            if document_reads[normalized_path] >= 2:
                return True
        return False

    def _has_truncation_signal(self, conversation: Conversation) -> bool:
        for block in self._iter_successful_tool_result_blocks(conversation):
            if block.metadata.get("tool_name") not in {"read_file", "read_file_range"}:
                continue
            lowered = (block.text or "").lower()
            if "excerpt truncated" in lowered or "use read_file_range" in lowered:
                return True
        return False

    def _query_strategy_reminder(self, user_message: str) -> str | None:
        lowered = user_message.lower()
        if any(token in lowered for token in ("change", "proposal", "提案", "变更", "openspec")):
            return (
                "Do not use change or proposal names as the primary query. Search by runtime objects, module names, or confirmed integration points first."
            )
        return None

    def _iter_successful_tool_result_blocks(self, conversation: Conversation) -> Iterator[RuntimeBlock]:
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                if block.metadata.get("success") is not True:
                    continue
                yield block

    def _is_documentation_path(self, normalized_path: str) -> bool:
        return normalized_path.endswith("readme.md") or normalized_path.startswith("docs/")

    def _is_source_or_config_path(self, normalized_path: str) -> bool:
        return normalized_path.endswith(
            (
                ".py",
                ".toml",
                ".yaml",
                ".yml",
                ".json",
                ".ini",
                ".cfg",
                ".mdx",
                ".rs",
                ".ts",
                ".tsx",
                ".js",
            )
        )

    def _max_repeated_tool_calls(self, conversation: Conversation) -> int:
        signatures: dict[str, int] = {}
        max_count = 0
        for message in conversation.messages:
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                signature = json.dumps(
                    {"name": call.name, "arguments": call.arguments},
                    ensure_ascii=False,
                    sort_keys=True,
                )
                signatures[signature] = signatures.get(signature, 0) + 1
                max_count = max(max_count, signatures[signature])
        return max_count

    def _count_tool_calls_in_current_turn(
        self,
        *,
        conversation: Conversation,
        tool_name: str,
    ) -> int:
        count = 0
        for message in self._messages_in_current_turn(conversation):
            if message.role != "assistant":
                continue
            for call in message.tool_calls:
                if call.name == tool_name:
                    count += 1
        return count

    def _messages_in_current_turn(self, conversation: Conversation) -> tuple[Message, ...]:
        current_turn: list[Message] = []
        for message in reversed(conversation.messages):
            if message.role == "user":
                break
            current_turn.append(message)
        current_turn.reverse()
        return tuple(current_turn)

    def _has_repeated_recoverable_failures(self, conversation: Conversation) -> bool:
        signatures: dict[str, int] = {}
        for message in conversation.messages:
            if message.role != "tool":
                continue
            for block in message.blocks:
                if block.type != "tool_result":
                    continue
                if block.metadata.get("success") is not False:
                    continue
                signature = json.dumps(
                    {
                        "tool_name": block.metadata.get("tool_name"),
                        "path": block.metadata.get("path"),
                        "error_kind": block.metadata.get("error_kind"),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
                signatures[signature] = signatures.get(signature, 0) + 1
                if signatures[signature] >= REPEATED_FAILURE_STOP_THRESHOLD:
                    return True
        return False
