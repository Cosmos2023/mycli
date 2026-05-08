from __future__ import annotations

from mycli.domain.conversation import Conversation
from mycli.services.runtime_policy.evidence import RuntimePolicyEvidence
from mycli.services.runtime_policy.profiles import (
    RuntimeDecisionProfile,
    RuntimePolicyProfiler,
)

STRUCTURED_STAGE_CHECK_REPOSITORY = "正在检查仓库结构"
STRUCTURED_STAGE_LOCATE_ENTRYPOINTS = "正在定位入口与主要模块"
STRUCTURED_STAGE_VERIFY_SOURCE = "正在读取源码确认架构事实"
STRUCTURED_STAGE_VERIFY_IMPLEMENTATION = "正在验证实现接入路径"
STRUCTURED_STAGE_VERIFY_IMPLEMENTATION_SOURCE = "正在读取源码确认实现证据"
STRUCTURED_STAGE_DEBUGGING_TRIAGE = "正在定位失败路径"
STRUCTURED_STAGE_DEBUGGING_VERIFY = "正在验证根因证据"
STRUCTURED_STAGE_ANSWER_FROM_EVIDENCE = "已从确认的证据收口回答"


class RuntimePolicyStagePlanner:
    def __init__(
        self,
        *,
        evidence: RuntimePolicyEvidence,
        profiler: RuntimePolicyProfiler,
    ) -> None:
        self._evidence = evidence
        self._profiler = profiler

    def decision_stage_message(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        force_answer: bool,
    ) -> str | None:
        profile = self._profiler.infer_decision_profile(user_message)
        has_structure = self._evidence.has_structure_evidence(conversation)
        has_source_or_config = self._evidence.has_source_or_config_evidence(conversation)
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_OVERVIEW:
            if force_answer or (has_structure and has_source_or_config):
                return STRUCTURED_STAGE_ANSWER_FROM_EVIDENCE
            if not has_structure:
                return STRUCTURED_STAGE_CHECK_REPOSITORY
            if not has_source_or_config:
                return STRUCTURED_STAGE_LOCATE_ENTRYPOINTS
            return STRUCTURED_STAGE_VERIFY_SOURCE
        if profile is RuntimeDecisionProfile.SOURCE_FIRST_VERIFICATION:
            if force_answer or self._evidence.has_sufficient_implementation_audit_evidence(
                conversation
            ):
                return STRUCTURED_STAGE_ANSWER_FROM_EVIDENCE
            if not has_source_or_config:
                return STRUCTURED_STAGE_VERIFY_IMPLEMENTATION
            return STRUCTURED_STAGE_VERIFY_IMPLEMENTATION_SOURCE
        if profile is RuntimeDecisionProfile.FAILURE_INVESTIGATION:
            if force_answer or self._evidence.has_sufficient_debugging_evidence(conversation):
                return STRUCTURED_STAGE_ANSWER_FROM_EVIDENCE
            if not has_source_or_config:
                return STRUCTURED_STAGE_DEBUGGING_TRIAGE
            return STRUCTURED_STAGE_DEBUGGING_VERIFY
        return None
