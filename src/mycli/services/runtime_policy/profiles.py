from __future__ import annotations

from enum import StrEnum


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


class RuntimeDecisionProfile(StrEnum):
    GENERAL = "general"
    CONCISE_OVERVIEW = "concise_overview"
    SOURCE_FIRST_OVERVIEW = "source_first_overview"
    SOURCE_FIRST_VERIFICATION = "source_first_verification"
    FAILURE_INVESTIGATION = "failure_investigation"


class RuntimePolicyProfiler:
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
        if self.is_overview_request(user_message):
            return RuntimeDecisionProfile.CONCISE_OVERVIEW
        return RuntimeDecisionProfile.GENERAL

    def is_repo_analysis_request(self, user_message: str) -> bool:
        lowered = user_message.lower()
        return any(hint in lowered for hint in REPO_ANALYSIS_SPECIFIC_HINTS) or (
            any(hint in lowered for hint in REPO_ANALYSIS_TARGET_HINTS)
            and any(hint in lowered for hint in REPO_ANALYSIS_ACTION_HINTS)
        )

    def is_overview_request(self, user_message: str) -> bool:
        lowered = user_message.lower()
        return any(hint in lowered for hint in OVERVIEW_HINTS)
